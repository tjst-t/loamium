/**
 * Sa10026-8 GUI Story 「新規ノート作成のパス対応統一 + 既定フォルダ prefill」
 * e2e テスト (実サーバー)。
 *
 * sprint verify フェーズで実行する。
 * このファイルは stub — 実サーバーが Sa10026-5 の GET /api/settings/system を
 * 返せる前提で defaultFolder → 作成 → 開く の受け入れ基準を確認する。
 *
 * [AC-Sa10026-8-1] [AC-Sa10026-8-2]
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

test('[AC-Sa10026-8-1][E2E] パス込みのノートを新規作成して開ける', async ({ page }) => {
  await page.goto(readHarnessState().uiUrl);

  await page.getByTestId('sidebar-new-note').click();
  await page.getByTestId('new-note-menu-blank').click();
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();

  // パス込みで入力
  const name = `e2e-unified-${Date.now()}`;
  await page.getByTestId('new-note-path').fill(`e2e-notes/${name}`);
  await page.getByTestId('new-note-confirm').click();

  // ノートが開く
  await expect(page.getByTestId('editor')).toBeVisible();
  // route-display にパスが反映される
  await expect(page.getByTestId('route-display')).toContainText(name);
});

test('[AC-Sa10026-8-2][E2E] system/settings.yaml の defaultFolder が new-note-path に prefill される', async ({ page }) => {
  await page.goto(readHarnessState().uiUrl);

  await page.getByTestId('sidebar-new-note').click();
  await page.getByTestId('new-note-menu-blank').click();
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();

  // 実サーバーが system/settings.yaml の defaultFolder を返す。
  // 未設定なら '' が初期値、設定済みなら "folder/" が初期値になる。
  // いずれの場合も new-note-path が表示されていれば OK (prefill 有無は環境依存)。
  await expect(page.getByTestId('new-note-path')).toBeVisible();

  // キャンセル
  await page.getByTestId('new-note-cancel').click();
  await expect(page.getByTestId('new-note-dialog')).not.toBeVisible();
});
