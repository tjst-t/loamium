/**
 * Story S89a350-3「テンプレートから新規作成する UI」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * 新規作成導線 → テンプレート選択 → 変数入力モーダル(キーボード完結)→ instantiate →
 * 解決先パス(衝突時連番)に作成されたノートがエディタで開く、までを実サーバーで検証する。
 * 生成ノートが解決済みピュア Markdown(テンプレ記法 {{...}} 非残存)であることを実ファイルで確認。
 *
 * テンプレート templates/議事録.md は harness/global-setup.ts がシードする。
 * ビジュアルの正: prototype/templates/{picker,modal}.html。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

function todayParts(): { y: string; m: string; d: string } {
  const now = new Date();
  return {
    y: String(now.getFullYear()).padStart(4, '0'),
    m: String(now.getMonth() + 1).padStart(2, '0'),
    d: String(now.getDate()).padStart(2, '0'),
  };
}

async function readVaultFile(rel: string): Promise<string> {
  return readFile(path.join(state().vault, rel), 'utf8');
}

async function openModal(page: Page): Promise<void> {
  await page.goto(state().uiUrl);
  await page.getByTestId('sidebar-new-note').click();
  await expect(page.getByTestId('new-note-menu')).toBeVisible();
  await page.getByTestId('new-note-menu-template').click();
  await expect(page.getByTestId('template-picker')).toBeVisible();
  // 一覧に議事録が出る (実サーバーの GET /api/templates)
  await expect(page.locator('[data-testid="template-item"][data-template="議事録"]')).toBeVisible();
  await page.locator('[data-testid="template-item"][data-template="議事録"]').click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
}

test('[AC-S89a350-3-1] 新規作成導線 → テンプレート選択 → vars 定義に応じた入力モーダル', async ({
  page,
}) => {
  await openModal(page);
  const modal = page.getByTestId('template-modal');
  // property-types 流用ウィジェット: text / date / select / tags
  await expect(modal.locator('[data-testid="template-var-input"][data-var="会議名"]')).toHaveAttribute(
    'type',
    'text',
  );
  await expect(modal.locator('[data-testid="template-var-input"][data-var="日付"]')).toHaveAttribute(
    'type',
    'date',
  );
  await expect(modal.locator('[data-testid="template-var-input"][data-var="カテゴリ"] .tpl-opt')).toHaveCount(3);
  await expect(
    modal.locator('[data-testid="template-var-input"][data-var="参加者"] .tpl-tag-input'),
  ).toBeVisible();
});

test('[AC-S89a350-3-2] 必須未入力は確定不可 + インライン表示、キーボードで確定できる', async ({
  page,
}) => {
  await openModal(page);
  const modal = page.getByTestId('template-modal');
  const createBtn = modal.getByTestId('template-create');

  // 会議名 (必須) が空 → 確定不可 (aria-disabled は force で押下してエラーを確認)
  await expect(createBtn).toHaveAttribute('aria-disabled', 'true');
  await createBtn.click({ force: true });
  await expect(modal.locator('[data-testid="template-var-error"][data-var="会議名"]')).toBeVisible();
  await expect(page.getByTestId('template-modal')).toBeVisible();

  // 会議名を入力すると確定可能に。Enter (キーボード) で作成できる
  const name = 'キーボード確定会';
  const input = modal.locator('[data-testid="template-var-input"][data-var="会議名"]');
  await input.click();
  await input.fill(name);
  await expect(createBtn).toHaveAttribute('aria-disabled', 'false');
  await input.press('Enter');

  // 作成されたノートがエディタで開く
  await expect(page.getByTestId('template-modal')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText(name);
});

test('[AC-S89a350-3-3] 確定で instantiate → 解決先パスに作成されたノートがエディタで開く (ピュア Markdown)', async ({
  page,
}) => {
  const t = todayParts();
  const name = '設計定例会';
  await openModal(page);
  const modal = page.getByTestId('template-modal');

  await modal.locator('[data-testid="template-var-input"][data-var="会議名"]').fill(name);
  // select カテゴリ: 臨時 を選ぶ
  await modal.locator('[data-testid="template-var-input"][data-var="カテゴリ"] .tpl-opt[data-value="臨時"]').click();
  // tags 参加者: 田中 を追加
  const tagInput = modal.locator('[data-testid="template-var-input"][data-var="参加者"] .tpl-tag-input');
  await tagInput.fill('田中');
  await tagInput.press('Enter');

  await modal.getByTestId('template-create').click();

  // エディタで開く (解決済み本文)
  await expect(page.getByTestId('template-modal')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText(name);
  // 現在ルート表示 (breadcrumb) が解決先パスを反映
  await expect(page.getByTestId('route-display')).toContainText(name);

  // 実ファイルが解決済みピュア Markdown で作成されている
  const rel = `議事録/${t.y}/${t.m}/${t.d}_${name}.md`;
  const raw = await readVaultFile(rel);
  expect(raw).not.toContain('{{');
  expect(raw).not.toContain('loamium-template');
  expect(raw).toContain(`# ${name}`);
  expect(raw).toContain('カテゴリ: "臨時"');
  expect(raw).toContain('参加者: 田中');
});

test('[AC-S89a350-3-3] パス衝突時は連番 (_2) を付けた新パスに作成して開く', async ({ page }) => {
  const t = todayParts();
  const name = '衝突テスト会';

  // 1 回目
  await openModal(page);
  let modal = page.getByTestId('template-modal');
  await modal.locator('[data-testid="template-var-input"][data-var="会議名"]').fill(name);
  await modal.getByTestId('template-create').click();
  await expect(page.getByTestId('template-modal')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText(name);

  // 2 回目 (同じ会議名) → 連番 _2
  await openModal(page);
  modal = page.getByTestId('template-modal');
  await modal.locator('[data-testid="template-var-input"][data-var="会議名"]').fill(name);
  await modal.getByTestId('template-create').click();
  await expect(page.getByTestId('template-modal')).toHaveCount(0);

  const rel2 = `議事録/${t.y}/${t.m}/${t.d}_${name}_2.md`;
  const raw2 = await readVaultFile(rel2);
  expect(raw2).toContain(`# ${name}`);
  await expect(page.getByTestId('route-display')).toContainText(`${name}_2`);
});
