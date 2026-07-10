/**
 * Story Sf1a90a-2 mock テスト — 右サイドバー Claude のエッジ / エラーケース。
 * page.route で /api/* を、page.routeWebSocket で WS /api/terminal をモックする。
 * 受け入れ条件の本検証 (実シェル双方向 I/O) は claude-sidebar.e2e.spec.ts が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime: 1000,
  };
}

interface TerminalFlag {
  enabled: boolean;
  reason: 'terminal_env_not_set' | 'mode_not_full' | null;
  cmd?: string;
}

async function openApp(page: Page, terminal: TerminalFlag | 'health_error'): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('ジャーナル本文。\n')));
  });
  await page.route('**/api/health', (route) => {
    if (terminal === 'health_error') {
      void route.fulfill(json({ error: 'internal', message: 'boom' }, 500));
    } else {
      void route.fulfill(json({ status: 'ok', mode: 'full', terminal }));
    }
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('ジャーナル本文');
  return unexpected;
}

test('[MOCK] サーバー側で無効 (env 未設定) — Claude タブに理由と有効化手順が出て WS 接続を試みない', async ({
  page,
}) => {
  let wsAttempted = false;
  await page.routeWebSocket('**/api/terminal', (ws) => {
    wsAttempted = true;
    ws.close();
  });
  await openApp(page, { enabled: false, reason: 'terminal_env_not_set' });

  await page.getByTestId('right-tab-claude').click();
  await expect(page.getByTestId('right-tab-claude')).toHaveAttribute('aria-selected', 'true');

  const claude = page.getByTestId('claude-panel');
  await expect(claude).toHaveAttribute('data-terminal-status', 'disabled');
  const disabled = page.getByTestId('terminal-disabled');
  await expect(disabled).toBeVisible();
  await expect(disabled).toContainText('デフォルト無効');
  await expect(disabled).toContainText('LOAMIUM_TERMINAL=1');
  await expect(disabled).toContainText('LOAMIUM_MODE=full');
  await expect(disabled).toContainText('LOAMIUM_TERMINAL 未設定');
  await expect(page.getByTestId('terminal')).toBeHidden();
  expect(wsAttempted).toBe(false);
});

test('[MOCK] サーバー側で無効 (mode_not_full) — full モードが必要な旨が表示される', async ({
  page,
}) => {
  await openApp(page, { enabled: false, reason: 'mode_not_full' });
  await page.getByTestId('right-tab-claude').click();

  const disabled = page.getByTestId('terminal-disabled');
  await expect(disabled).toBeVisible();
  await expect(disabled).toContainText('full ではありません');
  await expect(disabled).toContainText('LOAMIUM_TERMINAL=1');
});

test('[MOCK] health 取得失敗 — 再試行ボタンから復帰できる', async ({ page }) => {
  await page.routeWebSocket('**/api/terminal', (ws) => {
    ws.send(JSON.stringify({ type: 'output', data: 'mock-shell-ready\r\n' }));
  });
  await openApp(page, 'health_error');
  await page.getByTestId('right-tab-claude').click();

  const disabled = page.getByTestId('terminal-disabled');
  await expect(disabled).toBeVisible();
  await expect(disabled).toContainText('サーバーに接続できません');

  await page.route('**/api/health', (route) => {
    void route.fulfill(
      json({
        status: 'ok',
        mode: 'full',
        terminal: { enabled: true, reason: null, cmd: 'claude' },
      }),
    );
  });
  await disabled.getByRole('button', { name: '再試行' }).click();
  await expect(page.getByTestId('terminal')).toBeVisible();
  await expect(page.getByTestId('terminal')).toContainText('mock-shell-ready');
});

test('[MOCK] 接続 → サーバー切断で再接続バー(終了コード) → 再接続で新セッション', async ({ page }) => {
  const sockets: import('@playwright/test').WebSocketRoute[] = [];
  await page.routeWebSocket('**/api/terminal', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify({ type: 'output', data: `mock-session-${String(sockets.length)}\r\n` }));
  });
  await openApp(page, { enabled: true, reason: null, cmd: 'claude' });
  await page.getByTestId('right-tab-claude').click();

  await expect(page.getByTestId('claude-panel')).toHaveAttribute(
    'data-terminal-status',
    'connected',
  );
  await expect(page.getByTestId('terminal')).toContainText('mock-session-1');
  await expect(page.getByTestId('terminal-reconnect-bar')).toBeHidden();

  // サーバー側から exit(コード 3) を送ってから切断 → 再接続バーに終了コード
  sockets[0]?.send(JSON.stringify({ type: 'exit', exitCode: 3 }));
  sockets[0]?.close();
  await expect(page.getByTestId('terminal-reconnect-bar')).toBeVisible();
  await expect(page.getByTestId('terminal-reconnect-bar')).toContainText('終了コード 3');

  await page.getByTestId('terminal-reconnect').click();
  await expect(page.getByTestId('terminal-reconnect-bar')).toBeHidden();
  await expect(page.getByTestId('terminal')).toContainText('mock-session-2');
  expect(sockets.length).toBe(2);
});

test('[MOCK] トグル — aria-selected が同期し、バックリンクへ戻れる', async ({ page }) => {
  await page.routeWebSocket('**/api/terminal', (ws) => {
    ws.send(JSON.stringify({ type: 'output', data: 'mock-shell\r\n' }));
  });
  await openApp(page, { enabled: true, reason: null, cmd: 'claude' });

  // 既定はインフォ表示 (S11493d-2: right-tab-backlinks → right-tab-info)
  await expect(page.getByTestId('right-tab-info')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('right-tab-claude')).toHaveAttribute('aria-selected', 'false');
  // S11493d-2: backlink-panel → info-panel
  await expect(page.getByTestId('info-panel')).toBeVisible();

  await page.getByTestId('right-tab-claude').click();
  await expect(page.getByTestId('right-tab-claude')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('right-tab-info')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('terminal')).toBeVisible();

  await page.getByTestId('right-tab-info').click();
  await expect(page.getByTestId('right-tab-info')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('info-panel')).toBeVisible();
  await expect(page.getByTestId('terminal')).toBeHidden();
});
