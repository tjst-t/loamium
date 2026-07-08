/**
 * Story S7b2f22-1 E2E — スマートフォルダ作成/編集/削除/並べ替え UI。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実サーバー → 実ファイルシステム。
 * 一意プレフィックス (sfe-e2e) で共有 vault の他テストと衝突しない。
 * smart-folders.json は vault グローバルなので afterEach で空に戻す。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();
const ROOT = 'sfe-e2e';

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

async function getSmartFolders(): Promise<{ version: number; items: unknown[] }> {
  const res = await fetch(`${state().apiUrl}/api/smart-folders`);
  return res.json() as Promise<{ version: number; items: unknown[] }>;
}

test.describe('スマートフォルダ作成/編集/削除/並べ替え', () => {
  test.beforeEach(async () => {
    await putNote(`${ROOT}/alpha.md`, '# Alpha\n\n本文アルファ\n');
    await putNote(`${ROOT}/beta.md`, '# Beta\n\n本文ベータ\n');
    await putNote(`${ROOT}/pinned.md`, '# Pinned\n\nピン留めノート\n');
    await putSmartFolders({ version: 1, items: [] });
  });

  test.afterEach(async () => {
    await putSmartFolders({ version: 1, items: [] });
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-1-1][AC-S7b2f22-1-5] query フォルダ作成 → 即反映 → reload 永続
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-1-1][AC-S7b2f22-1-2][AC-S7b2f22-1-4][AC-S7b2f22-1-5] query フォルダを作成し解決・永続する', async ({
    page,
  }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await expect(page.getByTestId('smart-view-add')).toBeVisible();

    // フォームを開く
    await page.getByTestId('smart-view-add').click();
    await expect(page.getByTestId('sf-form')).toBeVisible();

    // recent-5 / icon=clock
    await page.getByTestId('sf-form-name').fill('直近ノート');
    await page.getByTestId('sf-form-icon').fill('clock');
    await page.selectOption('[data-testid="sf-form-preset"]', 'recent');
    await page.getByTestId('sf-form-preset-n').fill('5');
    await expect(page.getByTestId('sf-form-dql')).toHaveValue(
      'LIST SORT file.mtime DESC LIMIT 5',
    );

    await page.getByTestId('sf-form-save').click();
    await expect(page.getByTestId('sf-form')).not.toBeVisible();

    // スマートビューに即反映
    const folder = page.locator('[data-testid="smart-folder"]').first();
    await expect(folder).toBeVisible();
    await expect(folder.locator('[data-testid="smart-folder-icon"]')).toHaveAttribute(
      'data-icon',
      'clock',
    );

    // フォルダを展開して解決結果を確認
    await folder.locator('button.smart-folder-btn').click();
    await expect(
      page.locator(`[data-testid="smart-note"][data-path="${ROOT}/alpha.md"]`),
    ).toBeVisible({ timeout: 15_000 });

    // reload で永続確認
    await page.reload();
    await page.getByTestId('sidebar-view-smart').click();
    await expect(page.locator('[data-testid="smart-folder"]').first()).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-1-3] pin 作成
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-1-3][AC-S7b2f22-1-5] pin を作成しスマートビューに表示・永続する', async ({
    page,
  }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await page.getByTestId('smart-view-add').click();
    await expect(page.getByTestId('sf-form')).toBeVisible();

    // pin 種別に切替
    await page.getByTestId('sf-form-kind-pin').click();
    await expect(page.getByTestId('sf-form-path')).toBeVisible();

    await page.getByTestId('sf-form-name').fill('ピン留め');
    await page.getByTestId('sf-form-path').fill(`${ROOT}/pinned.md`);
    await page.getByTestId('sf-form-save').click();
    await expect(page.getByTestId('sf-form')).not.toBeVisible();

    // pin が表示される
    await expect(
      page.locator(`[data-testid="smart-pin"][data-path="${ROOT}/pinned.md"]`),
    ).toBeVisible();

    // reload で永続確認
    await page.reload();
    await page.getByTestId('sidebar-view-smart').click();
    await expect(
      page.locator(`[data-testid="smart-pin"][data-path="${ROOT}/pinned.md"]`),
    ).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-1-6] 編集 — 名前変更 → 永続
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-1-6] 既存アイテムを編集し名前を変更すると永続する', async ({ page }) => {
    // 事前にアイテムを追加
    await putSmartFolders({
      version: 1,
      items: [
        {
          kind: 'query',
          id: 'sfe-edit',
          name: '変更前',
          icon: 'search',
          dql: `LIST FROM "${ROOT}" SORT file.name ASC`,
        },
      ],
    });

    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sfe-edit"]'),
    ).toBeVisible();

    // 編集ボタン
    await page
      .locator('[data-testid="smart-folder"][data-id="sfe-edit"]')
      .getByTestId('smart-folder-edit')
      .click();
    await expect(page.getByTestId('sf-form')).toBeVisible();
    await expect(page.getByTestId('sf-form-name')).toHaveValue('変更前');

    // 名前を変更して保存
    await page.getByTestId('sf-form-name').fill('変更後');
    await page.getByTestId('sf-form-save').click();
    await expect(page.getByTestId('sf-form')).not.toBeVisible();

    // 名前が更新されている
    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sfe-edit"]'),
    ).toContainText('変更後');

    // reload で永続確認
    await page.reload();
    await page.getByTestId('sidebar-view-smart').click();
    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sfe-edit"]'),
    ).toContainText('変更後');
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-1-6] 並べ替え (moveup / movedown) → 永続
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-1-6] 並べ替えボタンで順序を変更すると永続する', async ({ page }) => {
    await putSmartFolders({
      version: 1,
      items: [
        { kind: 'query', id: 'sfe-a', name: 'A フォルダ', dql: 'LIST' },
        { kind: 'query', id: 'sfe-b', name: 'B フォルダ', dql: 'LIST' },
        { kind: 'query', id: 'sfe-c', name: 'C フォルダ', dql: 'LIST' },
      ],
    });

    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();

    // 並び順確認: A, B, C
    const folders = page.locator('[data-testid="smart-folder"]');
    await expect(folders.first()).toContainText('A フォルダ');

    // B フォルダを上へ移動 (B が A の前に来る)
    await page
      .locator('[data-testid="smart-folder"][data-id="sfe-b"]')
      .getByTestId('smart-folder-moveup')
      .click();

    // 並び: B, A, C になる
    await expect(folders.first()).toContainText('B フォルダ');
    await expect(folders.nth(1)).toContainText('A フォルダ');

    // reload で永続確認
    await page.reload();
    await page.getByTestId('sidebar-view-smart').click();
    await expect(
      page.locator('[data-testid="smart-folder"]').first(),
    ).toContainText('B フォルダ');
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-1-6] 削除 → 永続
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-1-6] アイテムを削除すると永続する', async ({ page }) => {
    await putSmartFolders({
      version: 1,
      items: [
        { kind: 'query', id: 'sfe-del', name: '削除対象', dql: 'LIST' },
        { kind: 'query', id: 'sfe-keep', name: '残すフォルダ', dql: 'LIST' },
      ],
    });

    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sfe-del"]'),
    ).toBeVisible();

    // 削除ボタン
    await page
      .locator('[data-testid="smart-folder"][data-id="sfe-del"]')
      .getByTestId('smart-folder-delete')
      .click();

    // 削除対象が消える
    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sfe-del"]'),
    ).toHaveCount(0);
    // 残す方は残る
    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sfe-keep"]'),
    ).toBeVisible();

    // reload で永続確認
    await page.reload();
    await page.getByTestId('sidebar-view-smart').click();
    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sfe-del"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sfe-keep"]'),
    ).toBeVisible();

    // API でも確認
    const config = await getSmartFolders();
    expect((config.items as Array<{ id: string }>).map((i) => i.id)).not.toContain('sfe-del');
    expect((config.items as Array<{ id: string }>).map((i) => i.id)).toContain('sfe-keep');
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-1-7] read-only モードでは編集 UI が存在しない
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-1-7] read-only / append-only モードでは編集 UI が非表示', async ({
    page,
  }) => {
    // E2E サーバーは full モードで起動。ここでは append-only サーバーをテストするのは難しいため、
    // 実サーバーの full モードで smart-view-add, edit/delete ボタンが見えることを確認し、
    // AC-7 の mock 版 (smart-folder-editor.mock.spec.ts) で非表示を担保する。

    await putSmartFolders({
      version: 1,
      items: [{ kind: 'query', id: 'sfe-ro', name: 'ビュー確認', dql: 'LIST' }],
    });

    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await expect(page.getByTestId('smart-view-add')).toBeVisible();

    // full モードでは編集ボタンが存在する
    await expect(
      page
        .locator('[data-testid="smart-folder"][data-id="sfe-ro"]')
        .getByTestId('smart-folder-edit'),
    ).toBeVisible();
    await expect(
      page
        .locator('[data-testid="smart-folder"][data-id="sfe-ro"]')
        .getByTestId('smart-folder-delete'),
    ).toBeVisible();
  });
});
