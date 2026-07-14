/**
 * スマートフォルダ定義 CRUD・解決 (S32940c-2, Sa10026-2-2)。
 *
 * POST-Sa10026-2 正本: system/smart-folders/*.yaml (per-file YAML) for query items
 *                      .loamium/smart-folders.json (pin-only JSON) for pin items
 *
 * GET  /api/smart-folders             → system/ (query) + JSON (pin) をマージして返す
 * PUT  /api/smart-folders             → query → system/ per-file YAML, pin → JSON
 * GET  /api/smart-folders/{id}/notes  → { notes: NoteMeta[] } (query→executeQuery, pin→1件)
 *
 * 後方互換:
 *   - system/smart-folders/ が空 かつ .loamium/smart-folders.json に全アイテムがある場合、
 *     旧 JSON から全体をフォールバック read する (移行前 / 空 vault)。
 *   - Sa10026-2 移行後: query は system/ 正本、pin は JSON に別途保持。
 *
 * 書き込み系: 監査ログ (op: 'smart-folders.write')、read-only/append-only は 403。
 * ADR-0010 (Sa10026-2): system/ が query の正本、pin は JSON に保持。
 */
import { Hono } from 'hono';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { toLf } from '@loamium/shared';
import {
  DqlParseError,
  executeQuery,
  normalizeVaultFilePath,
  parseQuery,
  smartViewConfigSchema,
  VaultPathError,
  type NoteMeta,
  type SmartViewConfig,
  type SmartViewItem,
  type SmartFoldersResolveResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import type { VaultIndex } from '../noteIndex.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import {
  listSystemSmartFolders,
  writeSystemSmartFolder,
  deleteSystemSmartFolder,
} from '../system-store.js';

// ---- JSON 読み書き (pin items 用) ----

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

// ---- system/ + JSON マージ読み込み ----

/**
 * system/smart-folders/*.yaml (query) と .loamium/smart-folders.json (pin) を
 * マージして SmartViewConfig を返す。
 *
 * - system/ に query があれば正本として使用し、JSON から pin items のみ追加する。
 * - system/ が空の場合: JSON から全体をフォールバック (移行前後方互換)。
 *
 * [AC-Sa10026-2-2]: system/ が正本、pin は JSON に別途保持。
 */
async function readConfig(vaultRoot: string): Promise<SmartViewConfig> {
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

export function smartFoldersRoutes(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- GET /api/smart-folders -----------------------------------------------
  app.get('/api/smart-folders', async (c) => {
    const cfg = await readConfig(config.vaultRoot);
    return c.json(cfg);
  });

  // ---- PUT /api/smart-folders -----------------------------------------------
  app.put('/api/smart-folders', async (c) => {
    setAudit(c, 'smart-folders.write', 'system/smart-folders/');

    const body = await parseBody(c, smartViewConfigSchema);
    if (!body.ok) return body.response;

    // pin.path を正規化 (NFC)
    const normalizedItems: SmartViewConfig['items'] = [];
    for (const item of body.data.items) {
      if (item.kind === 'pin') {
        let normalized: string;
        try {
          normalized = normalizeVaultFilePath(item.path);
        } catch (err) {
          const msg = err instanceof VaultPathError ? err.message : String(err);
          return errorJson(c, 400, 'invalid_path', `pin "${item.id}": ${msg}`);
        }
        normalizedItems.push({ ...item, path: normalized });
      } else {
        normalizedItems.push(item);
      }
    }

    const cfg: SmartViewConfig = { version: body.data.version, items: normalizedItems };

    // query items → system/ per-file YAML
    // pin items → .loamium/smart-folders.json
    const existingDefs = await listSystemSmartFolders(config.vaultRoot);
    const newQueryIds = new Set(
      normalizedItems.filter((i) => i.kind === 'query').map((i) => i.id),
    );

    // 削除: 新規リストに含まれない query 定義を system/ から消す
    for (const def of existingDefs) {
      if (!newQueryIds.has(def.id)) {
        await deleteSystemSmartFolder(config.vaultRoot, def.id);
      }
    }

    // 書き込み / 更新: query → system/ YAML
    for (const item of normalizedItems) {
      if (item.kind !== 'query') continue;

      const yamlObj: Record<string, unknown> = {
        query: item.dql,
      };
      if (item.name !== '') {
        yamlObj.title = item.name;
      }
      if (item.icon !== undefined && item.icon !== '') {
        yamlObj.icon = item.icon;
      }
      const yamlText = stringifyYaml(yamlObj, { lineWidth: 0 });
      await writeSystemSmartFolder(config.vaultRoot, item.id, yamlText);
    }

    // pin items → .loamium/smart-folders.json (pin-only JSON)
    // query items がない場合も含めて、常に JSON を pin 状態と同期する
    const pinItems = normalizedItems.filter((i) => i.kind === 'pin');
    const pinCfg: SmartViewConfig = { version: 1, items: pinItems };
    await writeLegacyConfig(config.vaultRoot, pinCfg);

    return c.json(cfg);
  });

  // ---- GET /api/smart-folders/{id}/notes ------------------------------------
  app.get('/api/smart-folders/:id/notes', async (c) => {
    const id = c.req.param('id');
    const cfg = await readConfig(config.vaultRoot);

    const item = cfg.items.find((i) => i.id === id);
    if (item === undefined) {
      return errorJson(c, 404, 'not_found', `smart folder "${id}" not found`);
    }

    // path → NoteMeta のルックアップマップ (index.listNotes() ベース)
    const noteMetaMap = new Map<string, NoteMeta>();
    for (const n of index.listNotes()) {
      noteMetaMap.set(n.path, n);
    }

    let notes: NoteMeta[];

    if (item.kind === 'query') {
      // DQL でフィルタ・ソート・LIMIT して結果パスを得る
      let queryResult;
      try {
        queryResult = executeQuery(parseQuery(item.dql), index.queryNotes());
      } catch (err) {
        if (err instanceof DqlParseError) {
          return errorJson(c, 500, 'dql_error', `stored dql is invalid: ${err.message}`);
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
      notes = ordered.flatMap((p) => {
        const meta = noteMetaMap.get(p);
        return meta !== undefined ? [meta] : [];
      });
    } else {
      // pin: ノートまたはフォルダを解決 (後方互換)
      const meta = noteMetaMap.get(item.path);
      if (meta !== undefined) {
        notes = [meta];
      } else {
        const folderPath = item.path;
        const folderNotes: NoteMeta[] = [];
        for (const n of noteMetaMap.values()) {
          if (n.folder === folderPath || n.folder.startsWith(folderPath + '/')) {
            folderNotes.push(n);
          }
        }
        folderNotes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        notes = folderNotes;
      }
    }

    const res: SmartFoldersResolveResponse = { notes };
    return c.json(res);
  });

  return app;
}
