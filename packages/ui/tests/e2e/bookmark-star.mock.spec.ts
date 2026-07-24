/**
 * Story S8086d9-2 mock テスト (スターのエッジ + バッファ編集検証)。
 * ★ は **開いているエディタのバッファ** の frontmatter を編集する (ディスク直書きしない)。
 * page.route で全 /api/* をモックする。受け入れ条件の本検証は
 * bookmark-star.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const ROOT = 'bm-mock';
const NOTE_PATH = `${ROOT}/target.md`;
const BODY = '# Target\n\n本文ターゲット\n';

function noteResponse(frontmatter: Record<string, unknown> | null): Record<string, unknown> {
  const fmBlock = frontmatter
    ? `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${String(v)}`).join('\n')}\n---\n`
    : '';
  return { path: NOTE_PATH, content: fmBlock + BODY, frontmatter, body: BODY, mtime: 1000 };
}

async function bootNote(
  page: Page,
  frontmatter: Record<string, unknown> | null,
  mode: 'full' | 'read-only' | 'append-only' = 'full',
): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) =>
    void route.fulfill(json({ status: 'ok', mode })),
  );
  await page.route('**/api/notes', (route) =>
    void route.fulfill(json({ notes: [{ path: NOTE_PATH, title: 'Target', tags: [], folder: ROOT }] })),
  );
  await page.route(`**/api/notes/${ROOT}/target.md`, (route) => {
    // PUT = 自動保存。バッファ編集の永続化を受け止める (競合しないダミー応答)。
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: NOTE_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fulfill(json(noteResponse(frontmatter)));
  });
  return unexpected;
}

function openNoteUrl(): string {
  return `${readHarnessState().uiUrl}/n/${ROOT}/target`;
}

test('[MOCK] スター: bookmark 無しは枠のみ、常時表示される', async ({ page }) => {
  const unexpected = await bootNote(page, null);
  await page.goto(openNoteUrl());
  await expect(page.getByTestId('editor')).toContainText('本文ターゲット');
  const star = page.getByTestId('bookmark-star');
  await expect(star).toBeVisible();
  await expect(star).toHaveAttribute('data-bookmarked', 'false');
  expect(unexpected).toEqual([]);
});

test('[MOCK] スター: frontmatter.bookmark=true は塗り表示', async ({ page }) => {
  const unexpected = await bootNote(page, { bookmark: true });
  await page.goto(openNoteUrl());
  await expect(page.getByTestId('editor')).toContainText('本文ターゲット');
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
  expect(unexpected).toEqual([]);
});

test('[MOCK] スター: クリックでバッファ frontmatter に bookmark を追加する (ディスク直書きしない)', async ({ page }) => {
  const unexpected = await bootNote(page, null);
  await page.goto(openNoteUrl());
  await expect(page.getByTestId('editor')).toContainText('本文ターゲット');
  // frontmatter 無し → プロパティパネルは無い
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);

  await page.getByTestId('bookmark-star').click();
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
  // バッファに frontmatter が追加された証拠: プロパティパネルが現れる
  await expect(page.getByTestId('properties-widget')).toBeVisible({ timeout: 5000 });
  // /properties への out-of-band 書き込みは発生しない (発生すれば unexpected に載る)
  expect(unexpected).toEqual([]);
});

test('[MOCK] スター: クリックでバッファ frontmatter から bookmark を除去する', async ({ page }) => {
  const unexpected = await bootNote(page, { bookmark: true });
  await page.goto(openNoteUrl());
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
  await expect(page.getByTestId('properties-widget')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('bookmark-star').click();
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'false');
  // bookmark のみの frontmatter → 除去でブロックごと消える → プロパティパネルが消える
  await expect(page.getByTestId('properties-widget')).toHaveCount(0, { timeout: 5000 });
  expect(unexpected).toEqual([]);
});

test('[MOCK] スター: read-only モードでは無効化される', async ({ page }) => {
  const unexpected = await bootNote(page, null, 'read-only');
  await page.goto(openNoteUrl());
  await expect(page.getByTestId('editor')).toContainText('本文ターゲット');
  const star = page.getByTestId('bookmark-star');
  await expect(star).toBeVisible();
  await expect(star).toHaveAttribute('aria-disabled', 'true');
  expect(unexpected).toEqual([]);
});
