/**
 * Story S9ab6c3-1「リスト行限定のアウトライン操作」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 * ファイル直読みは「ピュア Markdown で保存されている」ことの検証に限る。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const NOTE_PATH = 'outline-e2e.md';
const NOTE_CONTENT = [
  '# アウトラインテスト',
  '',
  '段落テキストです。',
  '',
  '- 親タスク A',
  '- 親タスク B',
  '    - 子タスク B1',
  '    - 子タスク B2',
  '- [ ] 未完了タスク',
  '- [x] 完了タスク',
  '',
  '1. 手順一',
  '2. 手順二',
  '',
].join('\n');

/** 対象ノートを実 API で用意し、UI で開く */
async function openOutlineNote(page: Page): Promise<void> {
  const { uiUrl, apiUrl } = state();
  const res = await fetch(`${apiUrl}/api/notes/${encodeURIComponent(NOTE_PATH)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: NOTE_CONTENT }),
  });
  expect(res.ok).toBe(true);
  await page.goto(uiUrl);
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('親タスク A');
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function noteOnDisk(): Promise<string> {
  return readFile(path.join(state().vault, NOTE_PATH), 'utf8');
}

test('[AC-S9ab6c3-1-1] リスト行で Tab がサブツリーごとインデント、Shift+Tab でアンインデントされる', async ({ page }) => {
  await openOutlineNote(page);

  // --- 箇条書き: 親 B をインデントすると子 2 行も追従する (A の子になる) ---
  await editorLine(page, '親タスク B').click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  let disk = await noteOnDisk();
  expect(disk).toContain(
    '- 親タスク A\n    - 親タスク B\n        - 子タスク B1\n        - 子タスク B2\n- [ ] 未完了タスク',
  );

  // --- Shift+Tab で元に戻る (子も追従) ---
  await editorLine(page, '親タスク B').click();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  disk = await noteOnDisk();
  expect(disk).toBe(NOTE_CONTENT); // 完全に元どおり (ピュア Markdown 維持)

  // --- 番号付きリスト (1.) でも Tab が効く ---
  await editorLine(page, '手順二').click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  disk = await noteOnDisk();
  expect(disk).toContain('1. 手順一\n    2. 手順二');

  // 後片付け: 元に戻す
  await editorLine(page, '手順二').click();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(await noteOnDisk()).toBe(NOTE_CONTENT);

  // ブロック ID 等の独自記法が混入していない
  expect(await noteOnDisk()).not.toMatch(/\^[a-zA-Z0-9]{4,}|id::/);
});

test('[AC-S9ab6c3-1-2] 見出し行・段落では Tab を押してもインデント操作にならない', async ({ page }) => {
  await openOutlineNote(page);

  // 見出し行にカーソル → Tab → ドキュメント不変 (dirty にならない)
  await editorLine(page, 'アウトラインテスト').click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // 段落行にカーソル → Tab → ドキュメント不変
  await editorLine(page, '段落テキストです。').click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // 少し待っても自動保存は発火せずファイルは元のまま
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(await noteOnDisk()).toBe(NOTE_CONTENT);
});

test('[AC-S9ab6c3-1-3] 子を持つリスト行をガターから折りたたみ・展開できる', async ({ page }) => {
  await openOutlineNote(page);

  // 子を持つ行 (6 行目: 親タスク B) にだけ fold-toggle が出る
  const toggle = page.locator('[data-testid="fold-toggle"][data-line="6"]');
  await expect(toggle).toBeVisible();
  await expect(page.locator('[data-testid="fold-toggle"][data-line="5"]')).toHaveCount(0); // 親タスク A は子なし

  // 折りたたみ: 子行が隠れ、fold-pill (… 2 行) が出る
  await toggle.click();
  await expect(editorLine(page, '子タスク B1')).toHaveCount(0);
  await expect(editorLine(page, '子タスク B2')).toHaveCount(0);
  const pill = page.getByTestId('fold-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toContainText('… 2 行');
  await expect(page.locator('[data-testid="fold-toggle"][data-line="6"]')).toHaveAttribute('data-folded', 'true');

  // 折りたたみは表示だけ — ファイルは不変 (ピュア Markdown)
  expect(await noteOnDisk()).toBe(NOTE_CONTENT);

  // fold-pill クリックで展開
  await pill.click();
  await expect(editorLine(page, '子タスク B1')).toBeVisible();
  await expect(page.getByTestId('fold-pill')).toHaveCount(0);

  // ガターの再クリックでも折りたたみ → 展開できる
  await toggle.click();
  await expect(editorLine(page, '子タスク B1')).toHaveCount(0);
  await page.locator('[data-testid="fold-toggle"][data-line="6"]').click();
  await expect(editorLine(page, '子タスク B1')).toBeVisible();
});

test('[AC-S9ab6c3-1-4] チェックボックスのクリックでトグルされ、ファイルに - [x] として保存される', async ({ page }) => {
  await openOutlineNote(page);

  // 9 行目 (- [ ] 未完了タスク) のチェックボックスをクリック → checked
  const checkbox = page.locator('[data-testid="task-checkbox"][data-line="9"]');
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toHaveClass(/checked/);
  await checkbox.click();
  await expect(page.locator('[data-testid="task-checkbox"][data-line="9"]')).toHaveClass(/checked/);

  // 自動保存を待ち、ファイルに - [x] として載る (ピュア Markdown)
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  let disk = await noteOnDisk();
  expect(disk).toContain('- [x] 未完了タスク');
  expect(disk).toContain('- [x] 完了タスク');

  // 完了タスク (10 行目) をクリックで解除 → - [ ] に戻る
  await page.locator('[data-testid="task-checkbox"][data-line="10"]').click();
  await expect(page.locator('[data-testid="task-checkbox"][data-line="10"]')).not.toHaveClass(/checked/);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  disk = await noteOnDisk();
  expect(disk).toContain('- [ ] 完了タスク');

  // 元に戻して後片付け
  await page.locator('[data-testid="task-checkbox"][data-line="9"]').click();
  await page.locator('[data-testid="task-checkbox"][data-line="10"]').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(await noteOnDisk()).toBe(NOTE_CONTENT);
});
