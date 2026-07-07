/**
 * Story S8086d9-2 mock テスト (スターのエラー/エッジ/リクエスト検証)。
 * page.route で全 /api/* をモックする (gui-spec-S8086d9-2.json 参照)。
 * 受け入れ条件の本検証は bookmark-star.e2e.spec.ts (実サーバー) が行う。
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
    void route.fulfill(json({ status: 'ok', mode, terminal: { enabled: false, reason: null } })),
  );
  await page.route('**/api/notes', (route) =>
    void route.fulfill(json({ notes: [{ path: NOTE_PATH, title: 'Target', tags: [], folder: ROOT }] })),
  );
  await page.route(`**/api/notes/${ROOT}/target.md`, (route) => void route.fulfill(json(noteResponse(frontmatter))));
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

test('[MOCK] スター: 未ブックマークのクリックは set{bookmark:true} を送る', async ({ page }) => {
  const unexpected = await bootNote(page, null);
  let captured: { set?: Record<string, unknown>; unset?: string[] } | null = null;
  await page.route(`**/api/notes/${ROOT}/target.md/properties`, (route) => {
    captured = route.request().postDataJSON() as typeof captured;
    void route.fulfill(json({ path: NOTE_PATH, frontmatter: { bookmark: true } }));
  });
  await page.goto(openNoteUrl());
  await page.getByTestId('bookmark-star').click();
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
  expect(captured).not.toBeNull();
  expect(captured?.set?.bookmark).toBe(true);
  expect(unexpected).toEqual([]);
});

test('[MOCK] スター: ブックマーク済のクリックは unset[bookmark] を送る', async ({ page }) => {
  const unexpected = await bootNote(page, { bookmark: true });
  let captured: { set?: Record<string, unknown>; unset?: string[] } | null = null;
  await page.route(`**/api/notes/${ROOT}/target.md/properties`, (route) => {
    captured = route.request().postDataJSON() as typeof captured;
    void route.fulfill(json({ path: NOTE_PATH, frontmatter: null }));
  });
  await page.goto(openNoteUrl());
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
  await page.getByTestId('bookmark-star').click();
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'false');
  expect(captured).not.toBeNull();
  expect(captured?.unset).toContain('bookmark');
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

test('[MOCK] スター: 書込失敗(500)は楽観更新をロールバックしノートは操作継続可能', async ({ page }) => {
  const unexpected = await bootNote(page, null);
  await page.route(`**/api/notes/${ROOT}/target.md/properties`, (route) =>
    void route.fulfill(json({ error: 'internal', message: 'boom' }, 500)),
  );
  await page.goto(openNoteUrl());
  await page.getByTestId('bookmark-star').click();
  // 失敗 → 元の未ブックマーク状態に戻る
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'false');
  await expect(page.getByTestId('editor')).toContainText('本文ターゲット');
  expect(unexpected).toEqual([]);
});
