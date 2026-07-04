/**
 * Story Sb7f458-2 mock テスト (ターミナルタブのエッジ / エラーケース)。
 * page.route で /api/* を、page.routeWebSocket で WS /api/terminal をモックする
 * (gui-spec-Sb7f458-2.json 参照)。
 * 受け入れ条件の本検証 (実シェル対話) は terminal.e2e.spec.ts (実サーバー) が行う。
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

test('[MOCK] サーバー側で無効 (env 未設定) — タブに理由と有効化手順が出て WS 接続を試みない', async ({
  page,
}) => {
  let wsAttempted = false;
  await page.routeWebSocket('**/api/terminal', (ws) => {
    wsAttempted = true;
    ws.close();
  });
  await openApp(page, { enabled: false, reason: 'terminal_env_not_set' });

  await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('tab-terminal')).toHaveAttribute('aria-selected', 'true');

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
  await page.getByTestId('tab-terminal').click();

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
  await page.getByTestId('tab-terminal').click();

  const disabled = page.getByTestId('terminal-disabled');
  await expect(disabled).toBeVisible();
  await expect(disabled).toContainText('サーバーに接続できません');

  // health が回復したら再試行で接続できる (route は後勝ちで上書き)
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

test('[MOCK] 接続 → サーバー切断で再接続バー → 再接続ボタンで新セッション', async ({ page }) => {
  const sockets: import('@playwright/test').WebSocketRoute[] = [];
  await page.routeWebSocket('**/api/terminal', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify({ type: 'output', data: `mock-session-${String(sockets.length)}\r\n` }));
  });
  await openApp(page, { enabled: true, reason: null, cmd: 'claude' });
  await page.getByTestId('tab-terminal').click();

  // タブラベルに health のコマンド名が反映される (prototype: ターミナル — claude)
  await expect(page.getByTestId('tab-terminal')).toContainText('ターミナル — claude');
  await expect(page.getByTestId('terminal')).toContainText('mock-session-1');
  await expect(page.getByTestId('terminal-reconnect-bar')).toBeHidden();

  // サーバー側から切断 → 再接続バー
  sockets[0]?.close();
  await expect(page.getByTestId('terminal-reconnect-bar')).toBeVisible();
  await expect(page.getByTestId('terminal-reconnect-bar')).toContainText('切断されました');

  // 再接続で新しい WS セッションが張られ、バーが消える
  await page.getByTestId('terminal-reconnect').click();
  await expect(page.getByTestId('terminal-reconnect-bar')).toBeHidden();
  await expect(page.getByTestId('terminal')).toContainText('mock-session-2');
  expect(sockets.length).toBe(2);
});

test('[MOCK] タブ切替 — aria-selected が同期し、エディタへ戻れる', async ({ page }) => {
  await page.routeWebSocket('**/api/terminal', (ws) => {
    ws.send(JSON.stringify({ type: 'output', data: 'mock-shell\r\n' }));
  });
  await openApp(page, { enabled: true, reason: null, cmd: 'claude' });

  await expect(page.getByTestId('tab-editor')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-terminal')).toHaveAttribute('aria-selected', 'false');

  await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('tab-terminal')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-editor')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('terminal')).toBeVisible();

  await page.getByTestId('tab-editor').click();
  await expect(page.getByTestId('tab-editor')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('terminal')).toBeHidden();
});
