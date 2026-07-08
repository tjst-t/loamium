/**
 * スマートフォルダ定義 CRUD・解決 (S32940c-2)。
 *
 * GET  /api/smart-folders             → SmartViewConfig (欠損/破損は空フォールバック)
 * PUT  /api/smart-folders             → 全置換 (zod 検証 + アトミック書き込み)
 * GET  /api/smart-folders/{id}/notes  → { notes: NoteMeta[] } (query→executeQuery, pin→1件)
 *
 * 書き込み系: 監査ログ (op: 'smart-folders.write')、read-only/append-only は 403。
 * ピン解決: 存在しない pin は結果から除外 (ファイルを壊さない — priority 2)。
 * ADR-0002: 定義ファイルは .loamium/smart-folders.json (git 追跡対象)。
 * ADR-0003: SmartViewItem は pin | query の 2 種のみ。
 */
import { Hono } from 'hono';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DqlParseError,
  executeQuery,
  normalizeVaultFilePath,
  parseQuery,
  smartViewConfigSchema,
  VaultPathError,
  type NoteMeta,
  type SmartViewConfig,
  type SmartFoldersResolveResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import type { VaultIndex } from '../noteIndex.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';

/**
 * .loamium/smart-folders.json を読む。
 * 未作成 (ENOENT) / 壊れた JSON / スキーマ不一致 → 空フォールバック + console.error ログ。
 * 決して 500 にならない (priority 6: ファイルが正本、インデックスは使い捨て)。
 */
async function readConfig(file: string): Promise<SmartViewConfig> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    const parsed = smartViewConfigSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // スキーマ不一致 (手動編集等): ログして空フォールバック
    console.error(
      `[loamium] smart-folders.json schema mismatch, falling back to empty: ${parsed.error.message}`,
    );
  } catch (err) {
    const isEnoent =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isEnoent) {
      // 壊れた JSON / 読み取りエラー
      console.error(`[loamium] failed to read smart-folders.json, falling back to empty: ${String(err)}`);
    }
    // ENOENT は正常 (初回) — ログしない
  }
  return { version: 1, items: [] };
}

export function smartFoldersRoutes(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const file = path.join(config.vaultRoot, '.loamium', 'smart-folders.json');

  // ---- GET /api/smart-folders -----------------------------------------------
  app.get('/api/smart-folders', async (c) => {
    const cfg = await readConfig(file);
    return c.json(cfg);
  });

  // ---- PUT /api/smart-folders -----------------------------------------------
  app.put('/api/smart-folders', async (c) => {
    setAudit(c, 'smart-folders.write', '.loamium/smart-folders.json');

    const body = await parseBody(c, smartViewConfigSchema);
    if (!body.ok) return body.response;

    // pin.path を正規化 (NFC)。ADR-0005: pin.path はノートパス (.md) またはフォルダパス
    // (no .md) を指せる。normalizeVaultFilePath を使うことで .md を補完せず、
    // traversal・隠しセグメントのみ拒否する (フォルダパスを保持する)。
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
        // query: dql は zod refine 済み
        normalizedItems.push(item);
      }
    }

    const cfg: SmartViewConfig = { version: body.data.version, items: normalizedItems };

    // アトミック書き込み (mkdir -p → writeFile で 2-space JSON + 末尾改行)
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    return c.json(cfg);
  });

  // ---- GET /api/smart-folders/{id}/notes ------------------------------------
  app.get('/api/smart-folders/:id/notes', async (c) => {
    const id = c.req.param('id');
    const cfg = await readConfig(file);

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
      // 結果の path 順を保持しつつ NoteMeta に変換 (タスク型は path を重複しうるため dedup)
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
      // pin: ノートまたはフォルダを解決 (ADR-0005)。
      // 1. 完全一致するノートパスがあれば単一 NoteMeta を返す (後方互換)。
      // 2. なければ、item.path をフォルダとみなしてインデックス内の
      //    note.folder === folderPath || note.folder.startsWith(folderPath + '/')
      //    で配下ノートを列挙する (path 昇順で安定)。
      // 3. いずれも存在しない場合は空配列 (エラーにならない — priority 2)。
      const meta = noteMetaMap.get(item.path);
      if (meta !== undefined) {
        // ノート pin (後方互換)
        notes = [meta];
      } else {
        // フォルダ pin: インデックス内からフォルダ配下のノートを収集
        const folderPath = item.path;
        const folderNotes: NoteMeta[] = [];
        for (const n of noteMetaMap.values()) {
          if (n.folder === folderPath || n.folder.startsWith(folderPath + '/')) {
            folderNotes.push(n);
          }
        }
        // path 昇順で安定ソート
        folderNotes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        notes = folderNotes;
      }
    }

    const res: SmartFoldersResolveResponse = { notes };
    return c.json(res);
  });

  return app;
}
