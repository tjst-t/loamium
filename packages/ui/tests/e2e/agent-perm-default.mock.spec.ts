/**
 * Sfa11c0 後続: Agent 新規セッションの既定権限を Agent ページ(権限ポップオーバー)から
 * 保存する。プリセットだけでなくカスタム集合も agentDefaultCapabilities として保存できる。
 *
 * 検証:
 *   - ポップオーバーに「この権限を新規セッションの既定にする」ボタンがある
 *   - 押すと PUT /api/settings/system に agentDefaultCapabilities が送られる
 *   - 保存後はボタンが「設定済み」表示になる
 *   - カスタム集合(プリセット非一致)でも保存できる
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const SESSION_ID = 'ses-perm-default-1';

// 初期 system settings (Agent 既定なし → read-only 相当)
const BASE_SETTINGS = {
  theme: 'system',
  defaultFolder: '',
  journalTemplate: 'system/templates/journal.md',
  showSystemFolder: false,
};

async function boot(page: Page): Promise<{ unexpected: string[]; puts: Record<string, unknown>[] }> {
  const unexpected = await installCatchAll(page);
  const puts: Record<string, unknown>[] = [];
  await page.route('**/api/health', (route) =>
    void route.fulfill(json({ status: 'ok', mode: 'full', agent: { enabled: true, reason: null } })),
  );
  await page.route('**/api/notes', (route) => void route.fulfill(json({ notes: [] })));
  await page.route('**/api/agent/sessions', (route) => {
    if (route.request().method() === 'POST') {
      void route.fulfill(json({ id: SESSION_ID }));
    } else {
      void route.fulfill(json({ sessions: [] }));
    }
  });
  await page.route(`**/api/agent/sessions/${SESSION_ID}`, (route) =>
    void route.fulfill(json({ id: SESSION_ID, messages: [] })),
  );
  // settings GET/PUT
  await page.route('**/api/settings/system', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { settings?: Record<string, unknown> };
      const merged = body.settings ?? {};
      puts.push(merged);
      void route.fulfill(json({ settings: merged }));
    } else {
      void route.fulfill(json({ settings: BASE_SETTINGS }));
    }
  });
  return { unexpected, puts };
}

async function openAgentPane(page: Page): Promise<void> {
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('right-tab-agent').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();
}

test('[MOCK] 権限ポップオーバーからカスタム集合を新規セッションの既定として保存できる', async ({
  page,
}) => {
  const { unexpected, puts } = await boot(page);
  await openAgentPane(page);

  await page.getByTestId('agent-perm-button').click();
  await expect(page.getByTestId('agent-perm-popover')).toBeVisible();

  // 既定 (read-only) からカスタム集合を作る: note_create を追加でトグル ON
  await page.getByTestId('agent-perm-toggle-note_create').click();
  // プリセット非一致 = カスタム
  await expect(page.getByTestId('agent-perm-popover')).toHaveAttribute('data-preset', 'custom');

  // 既定にする
  const setDefault = page.getByTestId('agent-perm-set-default');
  await expect(setDefault).toBeEnabled();
  await setDefault.click();

  // PUT に agentDefaultCapabilities が入っている
  await expect.poll(() => puts.length).toBeGreaterThan(0);
  const last = puts[puts.length - 1] as { agentDefaultCapabilities?: unknown };
  expect(Array.isArray(last.agentDefaultCapabilities)).toBe(true);
  expect(last.agentDefaultCapabilities).toContain('note_create');
  expect(last.agentDefaultCapabilities).toContain('read');

  // 保存後は「設定済み」表示 (押せない)
  await expect(setDefault).toContainText('設定済み');
  await expect(setDefault).toBeDisabled();

  expect(unexpected).toEqual([]);
});
