/**
 * [S5e0206-2] Web 有効化の漏洩リスク警告 UI mock テスト。
 *
 * fetch を page.route でモックし、UI 単体の挙動を検証する:
 *   - web トグル off では agent-web-warning が無い。
 *   - web トグルを on にすると警告が表示される (AC-S5e0206-2-1)。
 *   - full プリセットを選ぶと web が入り警告が出る。
 *   - web トグルの「(未実装)」注記が除去されている (AC-S5e0206-2-2)。
 *
 * mock 手法は agent-permissions.mock.spec.ts を踏襲。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const SESSION_A = 'ses-web-a';

/** エージェント有効・セッション一覧空でブート。 */
async function bootAgent(page: Page): Promise<{ unexpected: string[] }> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/health', (route) =>
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: true, reason: null } }),
    ),
  );
  await page.route('**/api/notes', (route) => void route.fulfill(json({ notes: [] })));

  await page.route('**/api/agent/sessions', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      void route.fulfill(json({ id: SESSION_A }));
    } else {
      void route.fulfill(json({ sessions: [] }));
    }
  });

  return { unexpected };
}

async function openAgentPane(page: Page): Promise<void> {
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('right-tab-agent').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();
}

/** 権限ボタンを押してポップオーバーを開く。 */
async function openPermPopover(page: Page): Promise<void> {
  await page.getByTestId('agent-perm-button').click();
  await expect(page.getByTestId('agent-perm-popover')).toBeVisible();
}

// ---------------------------------------------------------------------------
// [AC-S5e0206-2-1] web トグル off では警告なし / on で警告表示
// ---------------------------------------------------------------------------
test('[MOCK-WEB-warning] web トグル off では警告なし・on で漏洩リスク警告が表示される', async ({
  page,
}) => {
  const { unexpected } = await bootAgent(page);
  await openAgentPane(page);
  await openPermPopover(page);

  // 既定は read-only (web off)。ポップオーバー内トグルは常時表示。
  await expect(page.getByTestId('agent-perm-toggle-web')).toHaveAttribute('data-checked', 'false');
  // web off なので警告は無い
  await expect(page.getByTestId('agent-web-warning')).toHaveCount(0);

  // web トグルを on にする → 警告が出る
  await page.getByTestId('agent-perm-toggle-web').click();
  await expect(page.getByTestId('agent-perm-toggle-web')).toHaveAttribute('data-checked', 'true');
  await expect(page.getByTestId('agent-web-warning')).toBeVisible();
  await expect(page.getByTestId('agent-web-warning')).toContainText('プロンプトインジェクション');
  await expect(page.getByTestId('agent-web-warning')).toContainText('外部へ送信される');

  // web トグルを off に戻す → 警告が消える
  await page.getByTestId('agent-perm-toggle-web').click();
  await expect(page.getByTestId('agent-web-warning')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// [AC-S5e0206-2-1] full プリセットで web が入り警告が出る
// ---------------------------------------------------------------------------
test('[MOCK-WEB-full] full プリセットを選ぶと web が入り警告が出る', async ({ page }) => {
  const { unexpected } = await bootAgent(page);
  await openAgentPane(page);
  await openPermPopover(page);

  await expect(page.getByTestId('agent-web-warning')).toHaveCount(0);

  // full プリセット → web を含む全ケーパビリティが ON
  await page.getByTestId('agent-perm-preset-full').click();
  await expect(page.getByTestId('agent-perm-popover')).toHaveAttribute('data-preset', 'full');
  await expect(page.getByTestId('agent-web-warning')).toBeVisible();

  // read-only プリセットに戻すと web off → 警告消える
  await page.getByTestId('agent-perm-preset-read-only').click();
  await expect(page.getByTestId('agent-web-warning')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// [AC-S5e0206-2-2] web トグルに「(未実装)」注記が無い
// ---------------------------------------------------------------------------
test('[MOCK-WEB-no-unimpl] web トグルの「(未実装)」注記が除去されている', async ({ page }) => {
  const { unexpected } = await bootAgent(page);
  await openAgentPane(page);
  await openPermPopover(page);

  await expect(page.getByTestId('agent-perm-toggle-web')).toBeVisible();
  await expect(page.getByTestId('agent-perm-toggle-web')).not.toContainText('未実装');

  expect(unexpected).toEqual([]);
});
