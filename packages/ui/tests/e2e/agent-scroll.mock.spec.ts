/**
 * Story Sfa11c0-3: Agent チャットの条件付き追従スクロール + 「一番下へ」ボタン。
 *
 * 回帰テスト: 以前はスクロールリスナの useEffect が deps=[] だったため、
 * health 未取得の初回マウント時 (status='unconfigured' で agent-messages 未描画) に
 * リスナが張られず、その後 status='ready' になってもコンテナ出現時に張り直されず、
 * 条件付き追従も「一番下へ」ボタンも一切動作しなかった。deps=[status] で修正。
 *
 * ここでは:
 *   - 多数メッセージを復元してコンテナをオーバーフローさせる
 *   - 上へスクロールすると「一番下へ」ボタンが出る (isAtBottom=false)
 *   - ボタンで最下部へ戻ると消える (isAtBottom=true)
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const SESSION_ID = 'ses-scroll-mock-1';

// コンテナをオーバーフローさせる十分な数のメッセージ
const MANY_MESSAGES = Array.from({ length: 40 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `メッセージ ${String(i)} — スクロール検証用の本文テキスト。`,
  tools: [] as unknown[],
}));

async function bootWithHistory(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  // health は非同期解決 (初回マウント時は null → status='unconfigured')。deps=[status] 修正の要。
  await page.route('**/api/health', (route) =>
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: true, reason: null } }),
    ),
  );
  await page.route('**/api/notes', (route) => void route.fulfill(json({ notes: [] })));
  await page.route('**/api/agent/sessions', (route) =>
    void route.fulfill(json({ sessions: [{ id: SESSION_ID, title: 'スクロール検証', updatedAt: Date.now() }] })),
  );
  await page.route(`**/api/agent/sessions/${SESSION_ID}`, (route) =>
    void route.fulfill(json({ id: SESSION_ID, messages: MANY_MESSAGES, effectivePermissions: ['read'] })),
  );
  // マウント時に currentSessionId を復元させる
  await page.addInitScript((id) => {
    window.localStorage.setItem('loamium.agent.currentSessionId', id);
  }, SESSION_ID);
  return unexpected;
}

test('[MOCK] 上へスクロールで「一番下へ」ボタンが出て、押すと最下部へ戻り消える (Sfa11c0-3)', async ({
  page,
}) => {
  const unexpected = await bootWithHistory(page);
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('right-tab-agent').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();

  // 復元メッセージが描画される
  await expect(page.getByTestId('agent-msg-user').first()).toContainText('メッセージ 0');

  const messages = page.getByTestId('agent-messages');
  // コンテナが十分オーバーフローしていること (スクロール余地)
  await expect
    .poll(() => messages.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(200);

  // タブ表示後、初期は最下部へ追従している (先頭で固まらない) → ボタンは出ない
  await expect
    .poll(() => messages.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(90);
  await expect(page.getByTestId('agent-scroll-to-bottom')).toHaveCount(0);

  // 上へスクロール → isAtBottom=false でボタンが出る (リスナが張られていること)
  await messages.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByTestId('agent-scroll-to-bottom')).toBeVisible();

  // ボタンで最下部へ戻ると消える
  await page.getByTestId('agent-scroll-to-bottom').click();
  await expect(page.getByTestId('agent-scroll-to-bottom')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});
