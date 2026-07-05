/**
 * Story S79c210-3 mock テスト — WS close code による UI 文言の区別。
 *
 * ターミナルの Origin 拒否 (WS close 1008) は「セッション終了・子プロセス停止」ではなく
 * 「このオリジンは許可されていません…」と表示し、正常 exit (1000) とは別文言にする
 * (AC-S79c210-3-2)。実ブラウザは常に same-origin (loopback=許可) を送るため 1008 を
 * 実発生させられない。よって WS を page.routeWebSocket でモックし、サーバーが返す
 * close code (1008 / 1000) を出し分けて UI の区別を検証する (実 WS の許可/拒否は
 * tests/acceptance/terminal.spec.ts [AC-S79c210-3-1] が本番モードで担保)。
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

async function openApp(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('ジャーナル本文。\n')));
  });
  await page.route('**/api/health', (route) => {
    void route.fulfill(
      json({
        status: 'ok',
        mode: 'full',
        terminal: { enabled: true, reason: null, cmd: 'claude' },
      }),
    );
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('ジャーナル本文');
  return unexpected;
}

test('[AC-S79c210-3-2] Origin 拒否 (WS 1008) は許可オリジンの案内を出し、正常終了バーは出さない', async ({
  page,
}) => {
  // サーバーの CSWSH Origin 検査に相当: 接続直後に policy code 1008 で閉じる
  await page.routeWebSocket('**/api/terminal', (ws) => {
    ws.close({ code: 1008, reason: 'origin not allowed' });
  });
  await openApp(page);

  await page.getByTestId('right-tab-claude').click();
  await expect(page.getByTestId('right-tab-claude')).toHaveAttribute('aria-selected', 'true');

  // origin-denied 状態になり、許可オリジンの案内が出る
  await expect(page.getByTestId('claude-panel')).toHaveAttribute(
    'data-terminal-status',
    'origin-denied',
  );
  const denied = page.getByTestId('terminal-origin-denied');
  await expect(denied).toBeVisible();
  await expect(denied).toContainText('このオリジンは許可されていません');
  await expect(denied).toContainText('localhost');
  await expect(denied).toContainText('LOAMIUM_TERMINAL_ALLOWED_ORIGINS');

  // 正常終了の文言 (セッションが終了しました) は出ない — 誤表示バグの回帰防止
  await expect(page.getByTestId('terminal-reconnect-bar')).toBeHidden();
});

test('[AC-S79c210-3-2] 正常 exit (WS 1000) はセッション終了バーを出し、Origin 拒否文言は出さない', async ({
  page,
}) => {
  await page.routeWebSocket('**/api/terminal', (ws) => {
    ws.send(JSON.stringify({ type: 'output', data: 'mock-shell\r\n' }));
    // プロセスが自ら終了: exit 通知 → 正常クローズ (1000)
    ws.send(JSON.stringify({ type: 'exit', exitCode: 0 }));
    ws.close({ code: 1000, reason: 'process exited' });
  });
  await openApp(page);

  await page.getByTestId('right-tab-claude').click();

  // 正常終了バーが出る (「セッションが終了しました」)
  const bar = page.getByTestId('terminal-reconnect-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('セッションが終了しました');

  // Origin 拒否の文言・状態にはならない
  await expect(page.getByTestId('terminal-origin-denied')).toBeHidden();
  await expect(page.getByTestId('claude-panel')).toHaveAttribute(
    'data-terminal-status',
    'disconnected',
  );
});
