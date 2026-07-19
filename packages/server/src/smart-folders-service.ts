/**
 * スマートフォルダ定義の読み書き・解決サービス層 (ADR-0016 / Sc4b9d1-1)。
 *
 * ADR-0016 契約: スマートフォルダの CRUD・解決ロジックは Hono ハンドラに密結合させず、
 * REST (routes/smart-folders.ts) と agent ツール (agent-smartfolder-tools.ts) の双方から
 * 呼べる純関数として置く。エージェント専用の直接ファイル走査・独自フォーマットは新設しない。
 *
 * 正本 (POST-Sa10026-2):
 *   - system/smart-folders/*.yaml (per-file YAML) — query items
 *   - .loamium/smart-folders.json (pin-only JSON) — pin items
 *
 * ここに集約する純関数:
 *   - readSmartFoldersConfig  : GET /api/smart-folders と同一の readConfig 経路
 *                               (listSystemSmartFolders + pin JSON マージ)。
 *   - writeSmartFoldersConfig : PUT /api/smart-folders と同一の YAML 直列化・pin JSON 同期。
 *   - serializeSmartFolderYaml: 単一 query item → 純 YAML テキスト (PUT と同一直列化)。
 *   - resolveSmartFolderNotes : GET /api/smart-folders/{id}/notes と同一の
 *                               query→executeQuery / pin→フォルダ解決ロジック。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  DqlParseError,
  executeQuery,
  normalizeVaultFilePath,
  parseQuery,
  smartViewConfigSchema,
  toLf,
  VaultPathError,
  type NoteMeta,
  type SmartViewConfig,
  type SmartViewItem,
  type SmartViewQueryItem,
} from '@loamium/shared';
import {
  deleteSystemSmartFolder,
  listSystemSmartFolders,
  writeSystemSmartFolder,
} from './system-store.js';
import type { VaultIndex } from './noteIndex.js';
import { DqlQueryCache, computeQueryHash } from './dql-cache.js';

// ---- pin-only JSON (.loamium/smart-folders.json) --------------------------------

/** .loamium/smart-folders.json のパスを返す。 */
function legacyJsonPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.loamium', 'smart-folders.json');
}

/**
 * .loamium/smart-folders.json を読む。
 * 未作成 / 壊れた JSON / スキーマ不一致 → 空フォールバック。
 * すべての用途 (フォールバック・pin 読み込み) で共用する。
 */
async function readLegacyConfig(vaultRoot: string): Promise<SmartViewConfig> {
  const file = legacyJsonPath(vaultRoot);
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    const parsed = smartViewConfigSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    console.error(
      `[loamium] smart-folders.json schema mismatch, falling back to empty: ${parsed.error.message}`,
    );
  } catch (err) {
    const isEnoent =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isEnoent) {
      console.error(
        `[loamium] failed to read smart-folders.json, falling back to empty: ${String(err)}`,
      );
    }
  }
  return { version: 1, items: [] };
}

/**
 * .loamium/smart-folders.json に設定を書き込む。
 * LF 正規化・2-space indent。
 */
async function writeLegacyConfig(vaultRoot: string, cfg: SmartViewConfig): Promise<void> {
  const file = legacyJsonPath(vaultRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const content = toLf(JSON.stringify(cfg, null, 2)) + '\n';
  await writeFile(file, content, 'utf8');
}

// ---- system/ + JSON マージ読み込み ----------------------------------------------

/**
 * system/smart-folders/*.yaml (query) と .loamium/smart-folders.json (pin) を
 * マージして SmartViewConfig を返す。
 *
 * - system/ に query があれば正本として使用し、JSON から pin items のみ追加する。
 * - system/ が空の場合: JSON から全体をフォールバック (移行前後方互換)。
 *
 * [AC-Sa10026-2-2]: system/ が正本、pin は JSON に別途保持。
 */
export async function readSmartFoldersConfig(vaultRoot: string): Promise<SmartViewConfig> {
  const defs = await listSystemSmartFolders(vaultRoot);

  if (defs.length > 0) {
    // system/ に query 定義あり → system/ から query items を組み立て
    const queryItems: SmartViewItem[] = defs.map((def) => ({
      kind: 'query' as const,
      id: def.id,
      name: def.title,
      ...(def.icon !== undefined ? { icon: def.icon } : {}),
      dql: def.query,
    }));

    // JSON から pin items のみ取得してマージ
    const legacyCfg = await readLegacyConfig(vaultRoot);
    const pinItems = legacyCfg.items.filter((i) => i.kind === 'pin');

    // query を先に並べ、その後 pin (PUT 順序保持)
    const items: SmartViewItem[] = [...queryItems, ...pinItems];
    return { version: 1, items };
  }

  // system/ が空 → 旧 JSON から全体フォールバック (移行前 / 空 vault)
  return readLegacyConfig(vaultRoot);
}

// ---- YAML 直列化 (query item) ---------------------------------------------------

/**
 * 単一の query item を PUT /api/smart-folders と同一形式の純 YAML テキストへ直列化する。
 * - query: DQL 文字列 (必須)
 * - title: name が空でなければ書く
 * - icon : icon が未指定/空でなければ書く
 * lineWidth:0 で折り返しを抑止する。
 */
export function serializeSmartFolderYaml(item: SmartViewQueryItem): string {
  const yamlObj: Record<string, unknown> = {
    query: item.dql,
  };
  if (item.name !== '') {
    yamlObj.title = item.name;
  }
  if (item.icon !== undefined && item.icon !== '') {
    yamlObj.icon = item.icon;
  }
  return stringifyYaml(yamlObj, { lineWidth: 0 });
}

/**
 * SmartViewConfig 全体を正本へ書き込む (PUT /api/smart-folders と同一挙動)。
 *
 * 前提: items は既に正規化済み (pin.path は NFC 正規化済み) — 呼び出し側が検証する。
 *   - query items → system/smart-folders/*.yaml (serializeSmartFolderYaml)
 *   - 新規リストに含まれない既存 query 定義は system/ から削除
 *   - pin items → .loamium/smart-folders.json (常に pin 状態と同期)
 */
export async function writeSmartFoldersConfig(
  vaultRoot: string,
  items: SmartViewConfig['items'],
): Promise<void> {
  const existingDefs = await listSystemSmartFolders(vaultRoot);
  const newQueryIds = new Set(items.filter((i) => i.kind === 'query').map((i) => i.id));

  // 削除: 新規リストに含まれない query 定義を system/ から消す
  for (const def of existingDefs) {
    if (!newQueryIds.has(def.id)) {
      await deleteSystemSmartFolder(vaultRoot, def.id);
    }
  }

  // 書き込み / 更新: query → system/ YAML
  for (const item of items) {
    if (item.kind !== 'query') continue;
    await writeSystemSmartFolder(vaultRoot, item.id, serializeSmartFolderYaml(item));
  }

  // pin items → .loamium/smart-folders.json (pin-only JSON)
  // query items がない場合も含めて、常に JSON を pin 状態と同期する
  const pinItems = items.filter((i) => i.kind === 'pin');
  const pinCfg: SmartViewConfig = { version: 1, items: pinItems };
  await writeLegacyConfig(vaultRoot, pinCfg);
}

// ---- notes 解決 -----------------------------------------------------------------

/** notes 解決の結果 (DQL 構文エラーは呼び出し側でハンドリングできるよう明示 union)。 */
export type ResolveNotesResult =
  | { ok: true; notes: NoteMeta[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'dql_error'; message: string };

/**
 * item.id のスマートフォルダを解決し、含まれるノートの NoteMeta 一覧を返す
 * (GET /api/smart-folders/{id}/notes と同一ロジック)。
 *
 * - query: parseQuery → executeQuery で結果パスを得て、重複排除・順序保持して NoteMeta 化。
 *   保存済み DQL が不正なら { ok:false, reason:'dql_error' }。
 *   cache が指定されていれば queryHash 一致時にキャッシュヒットを返す。
 * - pin  : ノート単体 → 1 件、フォルダ → 配下ノート (パス昇順)。キャッシュ不使用。
 * - id 不明 → { ok:false, reason:'not_found' }。
 *
 * index は PrivacyFilteredIndex でも VaultIndex でも受けられるよう
 * listNotes / queryNotes を要求する。ADR-0018 privacy deny を適用したい場合、
 * 呼び出し側 (agent) は deny 除外済みの queryNotes / listNotes を渡すこと。
 */
export async function resolveSmartFolderNotes(
  vaultRoot: string,
  index: Pick<VaultIndex, 'listNotes' | 'queryNotes'>,
  id: string,
  cache?: DqlQueryCache,
): Promise<ResolveNotesResult> {
  const cfg = await readSmartFoldersConfig(vaultRoot);
  const item = cfg.items.find((i) => i.id === id);
  if (item === undefined) {
    return { ok: false, reason: 'not_found' };
  }

  // path → NoteMeta のルックアップマップ (index.listNotes() ベース)
  const noteMetaMap = new Map<string, NoteMeta>();
  for (const n of index.listNotes()) {
    noteMetaMap.set(n.path, n);
  }

  if (item.kind === 'query') {
    const queryHash = computeQueryHash(item.dql);

    // キャッシュヒット確認 (query kind のみ。pin kind はキャッシュ不使用)
    if (cache !== undefined) {
      const cached = cache.get(id, queryHash);
      if (cached !== null) {
        return { ok: true, notes: cached };
      }
    }

    let queryResult;
    try {
      queryResult = executeQuery(parseQuery(item.dql), index.queryNotes());
    } catch (err) {
      if (err instanceof DqlParseError) {
        return { ok: false, reason: 'dql_error', message: err.message };
      }
      throw err;
    }
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const row of queryResult.results as { path: string }[]) {
      if (!seen.has(row.path)) {
        seen.add(row.path);
        ordered.push(row.path);
      }
    }
    const notes = ordered.flatMap((p) => {
      const meta = noteMetaMap.get(p);
      return meta !== undefined ? [meta] : [];
    });

    // キャッシュに書き込む (deps は結果ノートのパス集合)
    if (cache !== undefined) {
      const deps = new Set(ordered);
      cache.set(id, notes, deps, queryHash);
    }

    return { ok: true, notes };
  }

  // pin: ノートまたはフォルダを解決 (後方互換)
  const meta = noteMetaMap.get(item.path);
  if (meta !== undefined) {
    return { ok: true, notes: [meta] };
  }
  const folderPath = item.path;
  const folderNotes: NoteMeta[] = [];
  for (const n of noteMetaMap.values()) {
    if (n.folder === folderPath || n.folder.startsWith(folderPath + '/')) {
      folderNotes.push(n);
    }
  }
  folderNotes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, notes: folderNotes };
}

// ---- pin.path 正規化 ------------------------------------------------------------

/** pin.path 正規化の結果。 */
export type NormalizePinsResult =
  | { ok: true; items: SmartViewConfig['items'] }
  | { ok: false; id: string; message: string };

/**
 * SmartViewConfig の pin items の path を NFC 正規化 (normalizeVaultFilePath) する
 * (PUT /api/smart-folders と同一の前処理)。query items はそのまま通す。
 * 検証に失敗した pin があれば { ok:false, id, message } を返す。
 */
export function normalizePinPaths(items: SmartViewConfig['items']): NormalizePinsResult {
  const out: SmartViewConfig['items'] = [];
  for (const item of items) {
    if (item.kind === 'pin') {
      let normalized: string;
      try {
        normalized = normalizeVaultFilePath(item.path);
      } catch (err) {
        const msg = err instanceof VaultPathError ? err.message : String(err);
        return { ok: false, id: item.id, message: msg };
      }
      out.push({ ...item, path: normalized });
    } else {
      out.push(item);
    }
  }
  return { ok: true, items: out };
}
