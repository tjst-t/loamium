/**
 * mock テスト共通ヘルパー (page.route ベース)。
 * モックの形は packages/server/src/routes/*.ts の実レスポンス構造に一致させること。
 */
import type { Page, Route } from '@playwright/test';

export function json(body: unknown, status = 200): Parameters<Route['fulfill']>[0] {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

export interface PutBody {
  content: string;
  baseMtime?: number;
}

/**
 * 予期しない API 呼び出しを検出する catch-all。
 * 各テストはこれを最初に登録し (Playwright の route は後勝ち)、
 * テスト末尾で戻り値の配列が空であることを検証する。
 */
export async function installCatchAll(page: Page): Promise<string[]> {
  const unexpected: string[] = [];
  await page.route('**/api/**', (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    void route.fulfill(json({ error: 'unmocked', message: 'unmocked endpoint in mock test' }, 500));
  });
  // GET /api/backlinks はノートを開くたびに飛ぶ定常呼び出し (S6fbf45-2 パネル)。
  // 既定は空で応答する。バックリンクを検証するテストは後から自前の route を
  // 登録すれば上書きできる (Playwright の route は後勝ち)。
  await page.route('**/api/backlinks*', (route) => {
    const url = new URL(route.request().url());
    void route.fulfill(json({ path: url.searchParams.get('path') ?? '', backlinks: [] }));
  });
  // GET /api/notes/{path}/meta (S11493d-1/2 インフォパネル) も定常呼び出し。
  // 既定は空のメタで応答する。メタを検証するテストは後から自前の route で上書きする。
  // NOTE: path には '/' が含まれる (例: journals/2026/07/2026-07-10.md) のため ** を使う。
  await page.route('**/api/notes/**/meta', (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/');
    // /api/notes/{path}/meta → path は segments[3..-2] を '/' で結合
    const pathParts = segments.slice(3, -1).map(decodeURIComponent);
    const notePath = pathParts.join('/');
    void route.fulfill(
      json({
        path: notePath,
        headings: [],
        outgoingLinks: [],
        tags: [],
        frontmatter: null,
        mtime: Date.now(),
        wordCount: 0,
        charCount: 0,
      }),
    );
  });
  // GET /api/files (添付一覧) も起動時の定常呼び出し (Sf53ad6-2 ツリー)。既定は空。
  // 末尾スラッシュ無しの一覧 URL のみ対象 (/api/files/{path} 配信には効かない)。
  await page.route('**/api/files', (route) => {
    void route.fulfill(json({ files: [] }));
  });
  // GET /api/system-files (system/ 設定ファイル一覧 — Sa10026-9 #1) も起動時の定常呼び出し。
  // 既定は空リスト。system/ ツリーを検証するテストは後から自前の route で上書きする。
  await page.route('**/api/system-files', (route) => {
    void route.fulfill(json({ files: [] }));
  });
  // GET /api/property-types (意味型スキーマ — S87f4b7-2) も起動時の定常呼び出し。
  // 既定は空 {} (ヒューリスティックのみ)。JSON定義を検証するテストは後から上書きする。
  await page.route('**/api/property-types', (route) => {
    void route.fulfill(json({ types: {} }));
  });
  // GET /api/tags (タグ候補ソース — S45fa45) も起動時の定常呼び出し。既定は空。
  // タグ補完を検証するテストは後から自前の route を登録して上書きする。
  await page.route('**/api/tags', (route) => {
    void route.fulfill(json({ tags: [] }));
  });
  // GET /api/property-keys (キーファースト候補ソース — Sd13ab1-2) も起動時の定常呼び出し。
  // 既定は空。vault 横断サジェストを検証するテストは後から自前の route で上書きする。
  await page.route('**/api/property-keys', (route) => {
    void route.fulfill(json({ keys: [] }));
  });
  // GET /api/health (モード確認 — S8086d9-2 BookmarkStar)。
  // 既定は full モード・エージェント未設定。モードを変えるテストは後から自前の route で上書きする。
  await page.route('**/api/health', (route) => {
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }),
    );
  });
  // GET /api/journal は起動時の定常呼び出し (App が今日のジャーナルを開く)。
  // 既定は空内容の今日のエントリ。エディタを検証するテストは後から自前の route で上書きする。
  await page.route('**/api/journal', (route) => {
    void route.fulfill(
      json({
        date: '2026-07-11',
        path: 'journals/2026/07/2026-07-11.md',
        content: '',
        frontmatter: null,
        body: '',
        created: false,
        mtime: 1000,
      }),
    );
  });
  // GET /api/commands (スマートコマンド一覧 — Sde7a63-3)。
  // 既定は空リスト。スマートコマンドを検証するテストは後から自前の route で上書きする。
  await page.route('**/api/commands', (route) => {
    void route.fulfill(json({ commands: [] }));
  });
  // GET/PUT /api/settings/system (アプリ全体設定 — Sa10026-3/-5/-8/-7)。
  // 既定は defaultFolder:'' (設定なし)。defaultFolder を検証するテストは後から上書きする。
  await page.route('**/api/settings/system', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(
        json({ settings: { theme: 'system', defaultFolder: '', journalTemplate: 'system/templates/journal.md', showSystemFolder: false } }),
      );
    } else if (method === 'PUT') {
      const body = route.request().postDataJSON() as { settings: Record<string, unknown> };
      void route.fulfill(json({ settings: body.settings }));
    } else {
      void route.fallback();
    }
  });
  // GET/PUT /api/settings/agent/connection (Sa10026-7 エージェント接続設定)。
  await page.route('**/api/settings/agent/connection', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ connection: {
        api: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        apiKeyRef: '$ANTHROPIC_API_KEY',
      } }));
    } else if (method === 'PUT') {
      void route.fulfill(json({ ok: true }));
    } else {
      void route.fallback();
    }
  });
  // POST /api/settings/agent/connection/test (Sa10026-7 接続テスト)。
  await page.route('**/api/settings/agent/connection/test', (route) => {
    void route.fulfill(json({ ok: true, model: 'claude-sonnet-4-6', latencyMs: 210 }));
  });
  // GET /api/settings/agent/models (Sa10026-7 モデル一覧)。
  await page.route('**/api/settings/agent/models', (route) => {
    void route.fulfill(json({ models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'], source: 'api' }));
  });
  // GET/PUT /api/settings/agent/permissions (Sa10026-7 エージェント権限)。
  await page.route('**/api/settings/agent/permissions', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ permissions: { value: 'full', effective: ['notes:write', 'notes:read'] } }));
    } else if (method === 'PUT') {
      void route.fulfill(json({ ok: true }));
    } else {
      void route.fallback();
    }
  });
  // GET/PUT /api/settings/agent/privacy (Sa10026-7 プライバシー deny-list)。
  await page.route('**/api/settings/agent/privacy', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ deny: ['private/**', 'secrets/**'] }));
    } else if (method === 'PUT') {
      // 実サーバーに合わせ、保存後の deny-list をそのまま返す ({ deny })。
      const body = route.request().postDataJSON() as { deny: string[] };
      void route.fulfill(json({ deny: body.deny }));
    } else {
      void route.fallback();
    }
  });
  return unexpected;
}
