import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HealthResponse } from '@loamium/shared';
import { DqlParseError, HiddenVaultPathError, JournalDateError, VaultPathError } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { AppEnv } from './http.js';
import { notesRoutes } from './routes/notes.js';
import { journalRoutes } from './routes/journal.js';
import { searchRoutes } from './routes/search.js';
import { filesRoutes } from './routes/files.js';
import { propertyTypesRoutes } from './routes/property-types.js';
import { templatesRoutes } from './routes/templates.js';
import { smartFoldersRoutes } from './routes/smart-folders.js';
import { commandsRoutes } from './routes/commands.js';
import { agentRoutes } from './routes/agent.js';
import { settingsRoutes } from './routes/settings.js';
import { auditMiddleware } from './audit.js';
import { permissionMiddleware } from './permissions.js';
import { indexSyncMiddleware } from './indexSync.js';
import { loadAgentConfig } from './agent-service.js';
import type { VaultIndex } from './noteIndex.js';

export function createApp(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * グローバルエラーハンドラ — ルートで捕捉されなかった例外のバックストップ。
   *
   * ルートは既知のドメインエラーを個別に catch して 4xx を返している。
   * ここに到達するのは (a) ルートが catch しなかった未想定エラー、または
   * (b) ルートが `throw err` で再送出したドメインエラー (実装漏れの保険)。
   *
   * マッピング表:
   *   VaultPathError (HiddenVaultPathError 以外) → 400 invalid_path
   *   HiddenVaultPathError                       → 404 not_found  (存在を隠す)
   *   JournalDateError                           → 400 invalid_date
   *   DqlParseError                              → 400 query_syntax
   *   HTTPException (Hono 内部)                  → status そのまま
   *   それ以外                                   → 500 internal_error (詳細は stderr のみ)
   *
   * 注: レスポンスボディにスタック/内部情報は含めない (観測性は stderr ログで確保)。
   */
  app.onError((err, c) => {
    const method = c.req.method;
    const path = c.req.path;
    const name = err instanceof Error ? err.name : 'UnknownError';
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? message) : String(err);

    // HTTPException はステータスをそのまま尊重し、詳細ログは残す
    if (err instanceof HTTPException) {
      console.error(
        `[loamium] ${method} ${path} → ${err.status} HTTPException: ${message}\n${stack}`,
      );
      const body: { error: string; message: string } = {
        error: 'http_error',
        message: err.message,
      };
      return c.json(body, err.status);
    }

    // HiddenVaultPathError は VaultPathError のサブクラスなので先に判定する
    if (err instanceof HiddenVaultPathError) {
      console.error(`[loamium] ${method} ${path} → 404 ${name}: ${message}\n${stack}`);
      return c.json({ error: 'not_found', message }, 404);
    }

    if (err instanceof VaultPathError) {
      console.error(`[loamium] ${method} ${path} → 400 ${name}: ${message}\n${stack}`);
      return c.json({ error: 'invalid_path', message }, 400);
    }

    if (err instanceof JournalDateError) {
      console.error(`[loamium] ${method} ${path} → 400 ${name}: ${message}\n${stack}`);
      return c.json({ error: 'invalid_date', message }, 400);
    }

    if (err instanceof DqlParseError) {
      console.error(`[loamium] ${method} ${path} → 400 ${name}: ${message}\n${stack}`);
      return c.json({ error: 'query_syntax', message }, 400);
    }

    // 未想定エラー — スタックを stderr に記録し、詳細はレスポンスに含めない
    console.error(`[loamium] ${method} ${path} → 500 ${name}: ${message}\n${stack}`);
    return c.json({ error: 'internal_error', message: 'internal server error' }, 500);
  });

  // GET /api/settings/system は settingsRoutes (Sa10026-5) が提供する。
  // (Sa10026-8 の暫定インラインハンドラは重複のため統合時に撤去)

  app.get('/api/health', async (c) => {
    // エージェント設定の有無を確認する (遅延読込 — 毎回ファイルを読む)
    const agentResult = await loadAgentConfig(config.vaultRoot);
    const res: HealthResponse = {
      status: 'ok',
      mode: config.mode,
      agent: agentResult.ok
        ? { enabled: true, reason: null }
        : { enabled: false, reason: agentResult.reason },
    };
    return c.json(res);
  });

  // 監査ログが権限チェックを包む (403 拒否も result: denied で記録される)。
  // indexSync は書き込み成功後にインデックスを即時更新する (write-through)。
  app.use('/api/*', auditMiddleware(config));
  app.use('/api/*', permissionMiddleware(config));
  app.use('/api/*', indexSyncMiddleware(index));

  // searchRoutes の GET /api/notes (一覧) は notesRoutes の /api/notes/{path} と
  // プレフィックスが異なるため衝突しない (先に登録して明確化)
  app.route('/', searchRoutes(index));
  app.route('/', journalRoutes(config));
  app.route('/', notesRoutes(config, index));
  // files: GET 配信/一覧 (S9e5ca4-2, Sf53ad6) + POST アップロード/リネーム + DELETE (Sf53ad6)
  app.route('/', filesRoutes(config, index));
  // 意味型スキーマ配信 (GET /api/property-types — S87f4b7-2)。読み取り専用
  app.route('/', propertyTypesRoutes(config));
  // 汎用テンプレート (GET /api/templates 一覧 + POST instantiate — S89a350-2)
  app.route('/', templatesRoutes(config));
  // スマートフォルダ定義 CRUD・解決 (S32940c-2)
  app.route('/', smartFoldersRoutes(config, index));
  // スマートコマンド定義一覧 (Sd22b1f-1)
  app.route('/', commandsRoutes(config));
  // エージェント (S53409d-3) — 権限・監査はルート内で管理
  app.route('/', agentRoutes(config, index));
  // 設定 API (Sa10026-5) — agent ツールには公開しない (Sa10026-6 で allowlist 除外)
  app.route('/', settingsRoutes(config));

  return app;
}
