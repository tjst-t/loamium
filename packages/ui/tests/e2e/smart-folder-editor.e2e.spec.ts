/**
 * Story S7b2f22-1 + S7b2f22-2 E2E — スマートフォルダ 作成/編集/削除/DnD/コンテキストメニュー UI。
 *
 * 実ブラウザ → 実 Vite → 実サーバー → 実ファイルシステム。
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

test.describe('スマートフォルダ作成/編集/削除/並べ替え (S7b2f22-1+S7b2f22-2)', () => {
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
  // [AC-S7b2f22-1-1][AC-S7b2f22-1-4][AC-S7b2f22-1-5] query 作成 + 解決 + 永続
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-1-1][AC-S7b2f22-1-2][AC-S7b2f22-1-4][AC-S7b2f22-1-5] query フォルダを作成し解決・永続する', async ({
    page,
  }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await expect(page.getByTestId('smart-view-add')).toBeVisible();

    await page.getByTestId('smart-view-add').click();
    await expect(page.getByTestId('sf-form')).toBeVisible();

    await page.getByTestId('sf-form-name').fill('直近ノート');
    await page.getByTestId('sf-form-icon').fill('clock');
    await page.selectOption('[data-testid="sf-form-preset"]', 'recent');
    await page.getByTestId('sf-form-preset-n').fill('5');
    await expect(page.getByTestId('sf-form-dql')).toHaveValue(
      'LIST SORT file.mtime DESC LIMIT 5',
    );

    await page.getByTestId('sf-form-save').click();
    await expect(page.getByTestId('sf-form')).not.toBeVisible();

    const folder = page.locator('[data-testid="smart-folder"]').first();
    await expect(folder).toBeVisible();
    await expect(folder.locator('[data-testid="smart-folder-icon"]')).toHaveAttribute(
      'data-icon',
      'clock',
    );

    // フォルダ展開して解決
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
  // [AC-S7b2f22-1-3][AC-S7b2f22-1-5] pin 作成
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-1-3][AC-S7b2f22-1-5] pin を作成しスマートビューに表示・永続する', async ({
    page,
  }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await page.getByTestId('smart-view-add').click();
    await expect(page.getByTestId('sf-form')).toBeVisible();

    await page.getByTestId('sf-form-kind-pin').click();
    await expect(page.getByTestId('sf-form-path')).toBeVisible();

    await page.getByTestId('sf-form-name').fill('ピン留め');
    await page.getByTestId('sf-form-path').fill(`${ROOT}/pinned.md`);
    // パスドロップダウンを閉じてから保存 (マッチするオプションが Save ボタンを覆う場合がある)
    await page.getByTestId('sf-form-name').click();
    await page.getByTestId('sf-form-save').click();
    await expect(page.getByTestId('sf-form')).not.toBeVisible();

    await expect(
      page.locator(`[data-testid="smart-pin"][data-path="${ROOT}/pinned.md"]`),
    ).toBeVisible();

    await page.reload();
    await page.getByTestId('sidebar-view-smart').click();
    await expect(
      page.locator(`[data-testid="smart-pin"][data-path="${ROOT}/pinned.md"]`),
    ).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-2-1] pin パスピッカー (実ノート)
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-2-1] sf-form-path でノート候補が表示され、クリックで選択できる', async ({
    page,
  }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await page.getByTestId('smart-view-add').click();
    await page.getByTestId('sf-form-kind-pin').click();
    await expect(page.getByTestId('sf-form-path')).toBeVisible();

    // 'alpha' でフィルタ → sfe-e2e/alpha.md が候補に出る
    await page.getByTestId('sf-form-path').focus();
    await page.getByTestId('sf-form-path').fill('alpha');

    const option = page.locator('[data-testid="sf-form-path-option"]').first();
    await expect(option).toBeVisible({ timeout: 5000 });
    await expect(option).toHaveAttribute('data-path', `${ROOT}/alpha.md`);

    await option.click();
    await expect(page.getByTestId('sf-form-path')).toHaveValue(`${ROOT}/alpha.md`);
    await expect(page.locator('[data-testid="sf-form-path-option"]')).toHaveCount(0);
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-2-2] アイコンピッカー (実際に選択して保存)
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-2-2] アイコンピッカーで選択した icon が保存される', async ({ page }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await page.getByTestId('smart-view-add').click();

    await page.getByTestId('sf-form-name').fill('スターフォルダ');

    // icon ピッカーで 'star' を選択
    await page.getByTestId('sf-form-icon').focus();
    await page.getByTestId('sf-form-icon').fill('star');
    const iconOpt = page.locator('[data-testid="sf-form-icon-option"][data-icon="star"]');
    await expect(iconOpt).toBeVisible();
    await iconOpt.click();
    await expect(page.getByTestId('sf-form-icon')).toHaveValue('star');

    await page.selectOption('[data-testid="sf-form-preset"]', 'todo');
    await page.getByTestId('sf-form-save').click();
    await expect(page.getByTestId('sf-form')).not.toBeVisible();

    await expect(
      page.locator('[data-testid="smart-folder-icon"][data-icon="star"]'),
    ).toBeVisible();

    // reload で永続確認
    await page.reload();
    await page.getByTestId('sidebar-view-smart').click();
    await expect(
      page.locator('[data-testid="smart-folder-icon"][data-icon="star"]'),
    ).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-2-3] + ボタンの配置
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-2-3] smart-view-add はノート/スマートトグルと同じ行にある', async ({
    page,
  }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await expect(page.getByTestId('smart-view-add')).toBeVisible();

    const header = page.getByTestId('smart-view-header');
    await expect(header.getByTestId('sidebar-view-smart')).toBeVisible();
    await expect(header.getByTestId('smart-view-add')).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-2-4] 削除確認ダイアログ → 永続
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-2-4] 右クリック削除→確認→永続する', async ({ page }) => {
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

    // 右クリック → 削除
    await page
      .locator('[data-testid="smart-folder"][data-id="sfe-del"]')
      .click({ button: 'right' });
    await expect(page.getByTestId('smart-context-menu')).toBeVisible();
    await page.getByTestId('smart-context-delete').click();

    // 確認ダイアログ
    await expect(page.getByTestId('smart-delete-dialog')).toBeVisible();
    await page.getByTestId('smart-delete-confirm').click();

    // アイテムが消える
    await expect(
      page.locator('[data-testid="smart-folder"][data-id="sfe-del"]'),
    ).toHaveCount(0);
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
  // [AC-S7b2f22-2-5] DnD 並べ替え → 永続
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-2-5] ドラッグ&ドロップで並べ替えると永続する', async ({ page }) => {
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

    const folders = page.locator('[data-testid="smart-folder"]');
    await expect(folders.first()).toContainText('A フォルダ');

    // A を B の位置へドラッグ
    const srcEl = page.locator('[data-testid="smart-folder"][data-id="sfe-a"]');
    const tgtEl = page.locator('[data-testid="smart-folder"][data-id="sfe-b"]');
    await srcEl.dragTo(tgtEl);

    // 順序が変わっている (B が先に来る)
    await expect(async () => {
      const allFolders = page.locator('[data-testid="smart-folder"]');
      const first = await allFolders.first().getAttribute('data-id');
      expect(first).toBe('sfe-b');
    }).toPass({ timeout: 5000 });

    // reload で永続確認
    await page.reload();
    await page.getByTestId('sidebar-view-smart').click();
    const reloadedFolders = page.locator('[data-testid="smart-folder"]');
    const firstId = await reloadedFolders.first().getAttribute('data-id');
    expect(firstId).toBe('sfe-b');
  });

  // -----------------------------------------------------------------------
  // [AC-S7b2f22-2-6] 右クリック → 編集 → 永続
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-2-6] 右クリック編集でフォームが prefill され、保存すると永続する', async ({
    page,
  }) => {
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

    // 右クリック → 編集
    await page
      .locator('[data-testid="smart-folder"][data-id="sfe-edit"]')
      .click({ button: 'right' });
    await expect(page.getByTestId('smart-context-menu')).toBeVisible();
    await page.getByTestId('smart-context-edit').click();

    await expect(page.getByTestId('sf-form')).toBeVisible();
    await expect(page.getByTestId('sf-form-name')).toHaveValue('変更前');

    // 名前を変更して保存
    await page.getByTestId('sf-form-name').fill('変更後');
    await page.getByTestId('sf-form-save').click();
    await expect(page.getByTestId('sf-form')).not.toBeVisible();

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
  // [AC-S7b2f22-2-7] full モードでは編集 UI が存在する
  // -----------------------------------------------------------------------
  test('[AC-S7b2f22-2-7] full モードでは smart-view-add と右クリックメニューが利用可能', async ({
    page,
  }) => {
    await putSmartFolders({
      version: 1,
      items: [{ kind: 'query', id: 'sfe-ro', name: 'ビュー確認', dql: 'LIST' }],
    });

    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await expect(page.getByTestId('smart-view-add')).toBeVisible();

    // full モードでは右クリックメニューに編集/削除がある
    await page
      .locator('[data-testid="smart-folder"][data-id="sfe-ro"]')
      .click({ button: 'right' });
    await expect(page.getByTestId('smart-context-menu')).toBeVisible();
    await expect(page.getByTestId('smart-context-edit')).toBeVisible();
    await expect(page.getByTestId('smart-context-delete')).toBeVisible();

    // 閉じる
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('smart-context-menu')).toHaveCount(0);
  });

  // -----------------------------------------------------------------------
  // [AC-Sebf6b0-2-3] folder-pin の展開 + note-pin は葉 (E2E + 永続)
  // -----------------------------------------------------------------------
  test('[AC-Sebf6b0-2-3] folder-pin を展開すると配下ノートが表示され、note-pin は葉のまま。永続確認', async ({
    page,
  }) => {
    // フォルダ配下のノートを作成
    await putNote(`${ROOT}/sub/note-a.md`, '# Note A\n\n本文A\n');
    await putNote(`${ROOT}/sub/note-b.md`, '# Note B\n\n本文B\n');
    await putNote(`${ROOT}/pinned.md`, '# Pinned\n\nピン留めノート\n');

    // folder-pin (sfe-fp) と note-pin (sfe-np) を設定
    await putSmartFolders({
      version: 1,
      items: [
        { kind: 'pin', id: 'sfe-fp', name: 'Sub フォルダ', path: `${ROOT}/sub` },
        { kind: 'pin', id: 'sfe-np', name: 'Pinned ノート', path: `${ROOT}/pinned.md` },
      ],
    });

    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();

    // folder-pin: aria-expanded を持つ展開可能行として描画
    const folderPin = page.locator('[data-testid="smart-pin"][data-id="sfe-fp"]');
    await expect(folderPin).toBeVisible();
    await expect(folderPin).toHaveAttribute('aria-expanded', 'false');

    // note-pin: smart-pin として描画 (aria-expanded なし)
    const notePin = page.locator('[data-testid="smart-pin"][data-id="sfe-np"]');
    await expect(notePin).toBeVisible();

    // folder-pin を展開 → 配下ノートが表示される
    await folderPin.locator('button').first().click();
    await expect(folderPin).toHaveAttribute('aria-expanded', 'true');

    await expect(
      page.locator(`[data-testid="smart-note"][data-path="${ROOT}/sub/note-a.md"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(`[data-testid="smart-note"][data-path="${ROOT}/sub/note-b.md"]`),
    ).toBeVisible();

    // reload で永続確認
    await page.reload();
    await page.getByTestId('sidebar-view-smart').click();

    // folder-pin が残っている
    await expect(
      page.locator('[data-testid="smart-pin"][data-id="sfe-fp"]'),
    ).toBeVisible();
    // note-pin が残っている
    await expect(
      page.locator('[data-testid="smart-pin"][data-id="sfe-np"]'),
    ).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // [AC-Sebf6b0-2-1][AC-Sebf6b0-2-2] folder-pin 作成フロー (フォルダ候補 + 検証)
  // -----------------------------------------------------------------------
  test('[AC-Sebf6b0-2-1][AC-Sebf6b0-2-2] フォルダ候補から選択して folder-pin を作成できる', async ({
    page,
  }) => {
    // フォルダ配下のノートを先に作成 (フォルダ候補が出るように)
    await putNote(`${ROOT}/docs/readme.md`, '# Readme\n\n説明\n');
    await putNote(`${ROOT}/docs/guide.md`, '# Guide\n\nガイド\n');

    await page.goto(state().uiUrl);
    await page.getByTestId('sidebar-view-smart').click();
    await page.getByTestId('smart-view-add').click();
    await expect(page.getByTestId('sf-form')).toBeVisible();

    await page.getByTestId('sf-form-kind-pin').click();
    await expect(page.getByTestId('sf-form-path')).toBeVisible();

    // "docs" でフィルタ → ROOT/docs フォルダ候補が出る
    await page.getByTestId('sf-form-path').focus();
    await page.getByTestId('sf-form-path').fill(`${ROOT}`);

    // ROOT/docs フォルダオプションが表示される
    const folderOpt = page.locator(`[data-testid="sf-form-path-option"][data-path="${ROOT}/docs"]`);
    await expect(folderOpt).toBeVisible({ timeout: 5000 });
    await folderOpt.click();
    await expect(page.getByTestId('sf-form-path')).toHaveValue(`${ROOT}/docs`);

    // 保存 → エラーなし
    await page.getByTestId('sf-form-name').click();
    await page.getByTestId('sf-form-save').click();
    await expect(page.getByTestId('sf-form-error')).toHaveCount(0);
    await expect(page.getByTestId('sf-form')).not.toBeVisible();

    // folder-pin が描画される
    await expect(
      page.locator(`[data-testid="smart-pin"][data-path="${ROOT}/docs"]`),
    ).toBeVisible();

    // 展開して配下ノートを確認
    const fp = page.locator(`[data-testid="smart-pin"][data-path="${ROOT}/docs"]`);
    await fp.locator('button').first().click();
    await expect(
      page.locator(`[data-testid="smart-note"][data-path="${ROOT}/docs/readme.md"]`),
    ).toBeVisible({ timeout: 15_000 });
  });
});
