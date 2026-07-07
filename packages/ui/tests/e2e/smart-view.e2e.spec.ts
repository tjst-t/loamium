/**
 * Story S8086d9-1 E2E — サイドバーの物理/スマート ビュー切替 + スマートフォルダ描画。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実サーバー → 実ファイルシステム。
 * 依存: Sprint S32940c(smart-folders / 解決 API・DQL 拡張)が実装済みであること。
 * 一意プレフィックス (sv-e2e) で共有 vault の他テストと衝突しないようにする。
 * smart-folders.json は vault グローバルなので beforeEach で設定し afterEach で空に戻す
 * (playwright.config は workers:1 / fullyParallel:false なので直列実行が保証される)。
 */
import { test, expect, type Locator } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();
const ROOT = 'sv-e2e';

function encodePath(rel: string): string {
  return rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

async function putNote(rel: string, content: string): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/notes/${encodePath(rel)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

async function putSmartFolders(config: unknown): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/smart-folders`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  expect(res.ok).toBe(true);
}

async function expandFolder(folder: Locator): Promise<void> {
  if ((await folder.getAttribute('aria-expanded')) !== 'true') {
    await folder.click();
  }
}

test.describe('smart view (物理/スマート切替 + 描画)', () => {
  test.beforeEach(async () => {
    await putNote(`${ROOT}/alpha.md`, '# Alpha\n\n本文アルファ\n');
    await putNote(`${ROOT}/beta.md`, '# Beta\n\n本文ベータ\n');
    await putNote(`${ROOT}/pinned.md`, '# Pinned\n\nインデックス本文\n');
    await putSmartFolders({
      version: 1,
      items: [
        { kind: 'query', id: 'sv-folder', name: 'SVフォルダ', icon: 'star', dql: `LIST FROM "${ROOT}" SORT file.name ASC` },
        { kind: 'pin', id: 'sv-pin', name: 'SVピン', icon: 'inbox', path: `${ROOT}/pinned.md` },
      ],
    });
  });

  test.afterEach(async () => {
    await putSmartFolders({ version: 1, items: [] });
  });

  test('[AC-S8086d9-1-1] トグルで物理↔スマートを切替でき、localStorage に永続する', async ({ page }) => {
    await page.goto(state().uiUrl);
    await expect(page.getByTestId('file-tree')).toBeVisible();

    // スマートへ切替
    await page.getByTestId('sidebar-view-smart').click();
    await expect(page.getByTestId('smart-view')).toBeVisible();
    await expect(page.getByTestId('file-tree')).toBeHidden();

    // リロードしてもスマートのまま (localStorage 永続)
    await page.reload();
    await expect(page.getByTestId('smart-view')).toBeVisible();

    // 物理へ戻すと永続する
    await page.getByTestId('sidebar-view-physical').click();
    await expect(page.getByTestId('file-tree')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('file-tree')).toBeVisible();
  });

  test('[AC-S8086d9-1-2] query 要素は展開で解決結果を表示、pin 要素は葉として表示', async ({ page }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();

    const folder = page.locator('[data-testid="smart-folder"][data-id="sv-folder"]');
    await expect(folder).toBeVisible();
    await expandFolder(folder);

    await expect(page.locator(`[data-testid="smart-note"][data-path="${ROOT}/alpha.md"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="smart-note"][data-path="${ROOT}/beta.md"]`)).toBeVisible();

    // pin は葉として直接表示 (フォルダに包まない)
    await expect(page.locator(`[data-testid="smart-pin"][data-path="${ROOT}/pinned.md"]`)).toBeVisible();
  });

  test('[AC-S8086d9-1-3] 各要素にカスタムアイコンが描画される', async ({ page }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();

    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sv-folder"] [data-testid="smart-folder-icon"]'),
    ).toHaveAttribute('data-icon', 'star');
    await expect(
      page.locator('[data-testid="smart-pin"][data-id="sv-pin"] [data-testid="smart-folder-icon"]'),
    ).toHaveAttribute('data-icon', 'inbox');
  });

  test('[AC-S8086d9-1-4] 一覧のノート/ピンをクリックすると開く', async ({ page }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();

    const folder = page.locator('[data-testid="smart-folder"][data-id="sv-folder"]');
    await expandFolder(folder);
    await page.locator(`[data-testid="smart-note"][data-path="${ROOT}/alpha.md"]`).click();
    await expect(page.getByTestId('editor')).toContainText('本文アルファ');
    await expect(page).toHaveURL(/\/n\/sv-e2e\/alpha$/);

    // pin クリックでも開く
    await page.locator(`[data-testid="smart-pin"][data-path="${ROOT}/pinned.md"]`).click();
    await expect(page.getByTestId('editor')).toContainText('インデックス本文');
    await expect(page).toHaveURL(/\/n\/sv-e2e\/pinned$/);
  });

  test('[AC-S8086d9-1-5] 物理ビューは従来どおり (回帰なし)', async ({ page }) => {
    await page.goto(state().uiUrl);
    // 既定は物理ビュー: file-tree が見え、作成した sv-e2e ノートがツリーに出る
    await expect(page.getByTestId('file-tree')).toBeVisible();
    await expect(page.locator(`[data-testid="tree-item"][data-path="${ROOT}/alpha.md"]`)).toBeVisible();
    // 物理ツリーからノートを開ける (従来の /n/{path} ルーティング)
    await page.locator(`[data-testid="tree-item"][data-path="${ROOT}/beta.md"]`).click();
    await expect(page.getByTestId('editor')).toContainText('本文ベータ');
  });
});
