/**
 * 右サイドバーのドラッグリサイズ (mock)。
 * 左端ハンドル (right-sidebar-resizer) をドラッグして .panel 幅が変わることを検証する。
 * page.route で /api/* をモックし、フロントの振る舞いだけを見る。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const JOURNAL_PATH = 'journals/2026/07/2026-07-13.md';

async function openApp(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: '2026-07-13', tags: [], folder: 'journals/2026/07' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(
      json({
        date: '2026-07-13',
        path: JOURNAL_PATH,
        content: '# ジャーナル\n\n本文。\n',
        frontmatter: null,
        body: '# ジャーナル\n\n本文。\n',
        created: false,
        mtime: 1000,
      }),
    );
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文。');
  return unexpected;
}

async function panelWidth(page: Page): Promise<number> {
  const box = await page.getByTestId('right-sidebar').boundingBox();
  if (box === null) throw new Error('right-sidebar has no bounding box');
  return box.width;
}

async function dragResizer(page: Page, dx: number): Promise<void> {
  const handle = page.getByTestId('right-sidebar-resizer');
  const box = await handle.boundingBox();
  if (box === null) throw new Error('resizer has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 8 });
  await page.mouse.up();
}

test('[MOCK-RESIZE] ハンドルを左へドラッグすると右サイドバーが広がる', async ({ page }) => {
  const unexpected = await openApp(page);

  const before = await panelWidth(page);
  // 左へ 120px ドラッグ (右サイドバーは右端固定なので左方向で広がる)
  await dragResizer(page, -120);
  const after = await panelWidth(page);

  // 概ね 120px 広がる (ドラッグ精度の許容込みで > 80px)
  expect(after).toBeGreaterThan(before + 80);
  expect(unexpected).toEqual([]);
});

test('[MOCK-RESIZE] 右へ大きくドラッグしても最小幅で頭打ちになる', async ({ page }) => {
  const unexpected = await openApp(page);

  await dragResizer(page, 400); // 右へ大きく = 縮める方向
  const width = await panelWidth(page);

  // 最小幅 (RS_MIN_WIDTH=240) 付近で頭打ち。240 を大きく下回らない。
  expect(width).toBeGreaterThanOrEqual(235);
  expect(width).toBeLessThan(300);
  expect(unexpected).toEqual([]);
});
