/**
 * Story S89a350-3 mock テスト (テンプレート選択 + 変数入力モーダル)。
 * page.route で全 /api/* をモックし、picker/modal のエラー・エッジケースを実ブラウザで固める。
 * 受け入れ本検証は template-create.e2e.spec.ts (実サーバー)。
 *
 * ビジュアルの正: prototype/templates/{picker,modal}.html。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-06';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime: 1000,
  };
}

const MEETING_TEMPLATE = {
  name: '議事録',
  path: 'templates/議事録.md',
  description: '会議の議事録',
  target: '議事録/{{date:YYYY}}/{{date:MM}}/{{date:DD}}_{{会議名}}',
  vars: [
    { name: '会議名', type: 'text', required: true },
    { name: '日付', type: 'date', required: false, default: '{{date:YYYY-MM-DD}}' },
    { name: 'カテゴリ', type: 'select', required: false, options: ['定例', '臨時', 'その他'], default: '定例' },
    { name: '参加者', type: 'tags', required: false },
  ],
};

const PLAIN_TEMPLATE = { name: '雛形', path: 'templates/雛形.md', target: null, vars: [] };

async function boot(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('# 今日\n\nメモ。\n')));
  });
  await page.route('**/api/templates', (route) => {
    void route.fulfill(json({ templates: [MEETING_TEMPLATE, PLAIN_TEMPLATE] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('メモ');
  return unexpected;
}

async function openPicker(page: Page): Promise<void> {
  await page.getByTestId('sidebar-new-note').click();
  await expect(page.getByTestId('new-note-menu')).toBeVisible();
  await page.getByTestId('new-note-menu-template').click();
  await expect(page.getByTestId('template-picker')).toBeVisible();
}

test('[MOCK] 新規ノート ▸ テンプレートから → picker に一覧・保存先プレビュー・変数チップ', async ({
  page,
}) => {
  await boot(page);
  await openPicker(page);

  const meeting = page.locator('[data-testid="template-item"][data-template="議事録"]');
  await expect(meeting).toBeVisible();
  await expect(meeting).toContainText('会議の議事録');
  // 保存先プレビュー: 未入力変数はトークンのまま
  await expect(meeting.getByTestId('template-item-target')).toContainText('{{会議名}}');
  // 変数チップ (必須は *)
  await expect(meeting.locator('.tpl-var-chip', { hasText: '会議名' })).toContainText('*');
  // frontmatter 無しの純粋雛形も出る
  await expect(page.locator('[data-testid="template-item"][data-template="雛形"]')).toBeVisible();
});

test('[MOCK] 選択で変数入力モーダルが開き、property-types ウィジェット (text/select/date/tags) が出る', async ({
  page,
}) => {
  await boot(page);
  await openPicker(page);
  await page.locator('[data-testid="template-item"][data-template="議事録"]').click();

  const modal = page.getByTestId('template-modal');
  await expect(modal).toBeVisible();
  // text (会議名) / date (日付) / select (カテゴリ) / tags (参加者)
  await expect(modal.locator('[data-testid="template-var-input"][data-var="会議名"]')).toHaveAttribute('type', 'text');
  await expect(modal.locator('[data-testid="template-var-input"][data-var="日付"]')).toHaveAttribute('type', 'date');
  await expect(modal.locator('[data-testid="template-var-input"][data-var="カテゴリ"] .tpl-opt')).toHaveCount(3);
  await expect(modal.locator('[data-testid="template-var-input"][data-var="参加者"] .tpl-tag-input')).toBeVisible();
});

test('[MOCK] 必須未入力は作成不可 + インラインエラー、入力で保存先プレビューがライブ更新', async ({
  page,
}) => {
  await boot(page);
  await openPicker(page);
  await page.locator('[data-testid="template-item"][data-template="議事録"]').click();
  const modal = page.getByTestId('template-modal');

  // 会議名 (必須) 未入力 → 作成ボタンは aria-disabled
  const createBtn = modal.getByTestId('template-create');
  await expect(createBtn).toHaveAttribute('aria-disabled', 'true');
  // 押してもインラインエラーが出る (確定しない)。aria-disabled は force で押下する
  await createBtn.click({ force: true });
  await expect(modal.locator('[data-testid="template-var-error"][data-var="会議名"]')).toBeVisible();
  await expect(page.getByTestId('template-modal')).toBeVisible(); // 閉じていない

  // 保存先プレビュー: 初期はトークン
  const preview = modal.getByTestId('template-target-preview');
  await expect(preview).toContainText('{{会議名}}');
  // 入力するとライブ更新 + 作成可能に
  await modal.locator('[data-testid="template-var-input"][data-var="会議名"]').fill('定例会議');
  await expect(preview).toContainText('定例会議');
  await expect(preview).not.toContainText('{{会議名}}');
  await expect(createBtn).toHaveAttribute('aria-disabled', 'false');
});

test('[MOCK] Esc でモーダルを中断でき、select は ←→ で切替できる', async ({ page }) => {
  await boot(page);
  await openPicker(page);
  await page.locator('[data-testid="template-item"][data-template="議事録"]').click();
  const modal = page.getByTestId('template-modal');

  // select: 既定 定例 → ArrowRight で 臨時
  const cat = modal.locator('[data-testid="template-var-input"][data-var="カテゴリ"]');
  await expect(cat.locator('.tpl-opt[data-value="定例"]')).toHaveAttribute('aria-checked', 'true');
  await cat.locator('.tpl-opt[data-value="定例"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(cat.locator('.tpl-opt[data-value="臨時"]')).toHaveAttribute('aria-checked', 'true');

  // Esc で中断 → picker へ戻る
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('template-modal')).toHaveCount(0);
  await expect(page.getByTestId('template-picker')).toBeVisible();
});

test('[MOCK] instantiate が 4xx (missing_vars) を返したらインラインにエラー表示する', async ({
  page,
}) => {
  await boot(page);
  // サーバーが不足変数エラーを返すケース (クライアント検証をすり抜けた場合の防御)
  await page.route('**/api/templates/**/instantiate', (route) => {
    void route.fulfill(
      json({ error: 'missing_vars', message: 'missing required variables: 会議名', missing: ['会議名'] }, 400),
    );
  });
  await openPicker(page);
  await page.locator('[data-testid="template-item"][data-template="議事録"]').click();
  const modal = page.getByTestId('template-modal');
  await modal.locator('[data-testid="template-var-input"][data-var="会議名"]').fill('X');
  await modal.getByTestId('template-create').click();
  await expect(page.getByTestId('template-submit-error')).toContainText('missing required variables');
  await expect(page.getByTestId('template-modal')).toBeVisible(); // 開いたまま
});
