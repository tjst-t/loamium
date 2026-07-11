import { Hono } from 'hono';
import type { HealthResponse } from '@loamium/shared';
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
import { auditMiddleware } from './audit.js';
import { permissionMiddleware } from './permissions.js';
import { indexSyncMiddleware } from './indexSync.js';
import type { VaultIndex } from './noteIndex.js';

export function createApp(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/health', (c) => {
    // terminal は機能フラグ (Sb7f458-2) — UI が無効理由の表示・WS 接続可否の判定に使う。
    // cmd は有効時のみ返す (無効サーバーの構成情報は最小限に)
    const res: HealthResponse = {
      status: 'ok',
      mode: config.mode,
      terminal: {
        enabled: config.terminal.enabled,
        reason: config.terminal.reason,
        ...(config.terminal.enabled ? { cmd: config.terminal.cmd } : {}),
      },
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

  return app;
}
