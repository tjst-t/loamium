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

type PropReq = { set?: Record<string, unknown>; unset?: string[] };

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
  const captured: { value: PropReq | null } = { value: null };
  await page.route(`**/api/notes/${ROOT}/target.md/properties`, (route) => {
    captured.value = route.request().postDataJSON() as PropReq;
    void route.fulfill(json({ path: NOTE_PATH, frontmatter: { bookmark: true } }));
  });
  await page.goto(openNoteUrl());
  await page.getByTestId('bookmark-star').click();
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
  expect(captured.value).not.toBeNull();
  expect(captured.value?.set?.bookmark).toBe(true);
  expect(unexpected).toEqual([]);
});

test('[MOCK] スター: ブックマーク済のクリックは unset[bookmark] を送る', async ({ page }) => {
  const unexpected = await bootNote(page, { bookmark: true });
  const captured: { value: PropReq | null } = { value: null };
  await page.route(`**/api/notes/${ROOT}/target.md/properties`, (route) => {
    captured.value = route.request().postDataJSON() as PropReq;
    void route.fulfill(json({ path: NOTE_PATH, frontmatter: null }));
  });
  await page.goto(openNoteUrl());
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
  await page.getByTestId('bookmark-star').click();
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'false');
  expect(captured.value).not.toBeNull();
  expect(captured.value?.unset).toContain('bookmark');
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

test('[MOCK] スター: ブックマーク成功後にエディタが再取得されプロパティパネルに bookmark が現れる', async ({ page }) => {
  // bootNote は呼ばず、このテスト専用でモック全体を組み立てる
  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) =>
    void route.fulfill(json({ status: 'ok', mode: 'full', terminal: { enabled: false, reason: null } })),
  );
  await page.route('**/api/notes', (route) =>
    void route.fulfill(json({ notes: [{ path: NOTE_PATH, title: 'Target', tags: [], folder: ROOT }] })),
  );

  // getNote の呼び出しを順番管理: 初回=frontmatter なし、2回目以降=bookmark:true
  let getNoteCallCount = 0;
  await page.route(`**/api/notes/${ROOT}/target.md`, (route) => {
    getNoteCallCount++;
    const fm = getNoteCallCount === 1 ? null : { bookmark: true };
    void route.fulfill(json(noteResponse(fm)));
  });
  await page.route(`**/api/notes/${ROOT}/target.md/properties`, (route) => {
    void route.fulfill(json({ path: NOTE_PATH, frontmatter: { bookmark: true } }));
  });

  await page.goto(openNoteUrl());
  await expect(page.getByTestId('editor')).toContainText('本文ターゲット');
  // 初期状態: frontmatter なし → プロパティパネルは存在しない
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);

  await page.getByTestId('bookmark-star').click();
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
  // onChanged → getNote → setOpenDoc → エディタが bookmark:true frontmatter 付きで更新される
  // → プロパティパネルが現れる (これが editor content 同期の証拠)
  await expect(page.getByTestId('properties-widget')).toBeVisible({ timeout: 5000 });
  expect(unexpected).toEqual([]);
});

test('[MOCK] スター: ブックマーク解除後にエディタが再取得されプロパティパネルが消える', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) =>
    void route.fulfill(json({ status: 'ok', mode: 'full', terminal: { enabled: false, reason: null } })),
  );
  await page.route('**/api/notes', (route) =>
    void route.fulfill(json({ notes: [{ path: NOTE_PATH, title: 'Target', tags: [], folder: ROOT }] })),
  );

  // 初回取得はブックマーク済み、2回目以降はなし
  let getNoteCallCount = 0;
  await page.route(`**/api/notes/${ROOT}/target.md`, (route) => {
    getNoteCallCount++;
    const fm = getNoteCallCount === 1 ? { bookmark: true } : null;
    void route.fulfill(json(noteResponse(fm)));
  });
  await page.route(`**/api/notes/${ROOT}/target.md/properties`, (route) => {
    void route.fulfill(json({ path: NOTE_PATH, frontmatter: null }));
  });

  await page.goto(openNoteUrl());
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
  // 初期状態: bookmark:true frontmatter → プロパティパネルが表示されている
  await expect(page.getByTestId('properties-widget')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('bookmark-star').click();
  await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'false');
  // onChanged → getNote → setOpenDoc → frontmatter なしで更新 → プロパティパネルが消える
  await expect(page.getByTestId('properties-widget')).toHaveCount(0, { timeout: 5000 });
  expect(unexpected).toEqual([]);
});
