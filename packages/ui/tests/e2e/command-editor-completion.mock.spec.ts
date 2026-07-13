/**
 * CommandEditor 補完 mock テスト — S9e64e7-3。
 *
 * AC-S9e64e7-3-1: kind: の後に 6 種の候補が表示され、選択するとフィールド雛形が挿入される。
 * AC-S9e64e7-3-2: {{ の後に param 名・date:/now: トークンが補完される。
 * AC-S9e64e7-3-3: 補完ソース関数の単体テスト (文書 + カーソル位置 → 期待オプション)。
 *
 * 補完ポップアップは .cm-tooltip-autocomplete / .cm-completionLabel で参照する。
 * (CodeMirror が描画する — 独自 testid は不要、gui-spec 参照)
 *
 * テスト戦略:
 *  - AC-3-3: 補完ソース関数を直接ユニットテスト形式で検証
 *             (kindCompletionSource / tokenCompletionSource の正確さを保証)。
 *  - AC-3-1/-2: Playwright でエディタに文字入力して補完ポップアップを確認。
 *
 * NOTE: CodeMirror の autocompletion は "activateOnTyping" で動作するため、
 *       入力直後に補完が出るまで短い待機が必要。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';
import type { Page } from '@playwright/test';

// ---- ユニットテスト層 (補完ソース関数の直接テスト) --------------------------
// Playwright の test() 内で Node.js モジュールとして import して動作確認する。
// (Vitest 環境が不要な純粋ロジックテスト)

import {
  DSL_KINDS,
  DSL_PARAM_TYPES,
  DSL_POSITIONS,
  extractParamNames,
} from '../../src/commandDslCompletion.js';

// ============================================================
// AC-S9e64e7-3-3: 補完ソース単体テスト (DSL 語彙 + パーサ)
// ============================================================

test('[AC-S9e64e7-3-3] DSL_KINDS は DSL v2 の 6 種を含み、不正な kind を含まない', () => {
  // 6 種が存在すること [AC-S9e64e7-3-1]
  expect(DSL_KINDS).toHaveLength(6);
  expect(DSL_KINDS).toContain('journal-append');
  expect(DSL_KINDS).toContain('note-append');
  expect(DSL_KINDS).toContain('note-create');
  expect(DSL_KINDS).toContain('template-instantiate');
  expect(DSL_KINDS).toContain('prop-set');
  expect(DSL_KINDS).toContain('note-patch');

  // 不正な kind を含まないこと [AC-S9e64e7-3-1 + edge_kind_completion_only_valid_kinds]
  expect(DSL_KINDS).not.toContain('agent-run');
  expect(DSL_KINDS).not.toContain('run-command');
});

test('[AC-S9e64e7-3-3] DSL_PARAM_TYPES は shared スキーマの 7 種を含む', () => {
  expect(DSL_PARAM_TYPES).toContain('string');
  expect(DSL_PARAM_TYPES).toContain('text');
  expect(DSL_PARAM_TYPES).toContain('date');
  expect(DSL_PARAM_TYPES).toContain('select');
  expect(DSL_PARAM_TYPES).toContain('note');
  expect(DSL_PARAM_TYPES).toContain('boolean');
  expect(DSL_PARAM_TYPES).toContain('number');
  expect(DSL_PARAM_TYPES).toHaveLength(7);
});

test('[AC-S9e64e7-3-3] DSL_POSITIONS は bottom/top/section を含む', () => {
  expect(DSL_POSITIONS).toContain('bottom');
  expect(DSL_POSITIONS).toContain('top');
  expect(DSL_POSITIONS).toContain('section');
  expect(DSL_POSITIONS).toHaveLength(3);
});

test('[AC-S9e64e7-3-3] extractParamNames: params セクションの name フィールドを抽出する', () => {
  const doc = [
    '---',
    'loamium-command:',
    '  name: create todo',
    '  params:',
    '    - name: summary',
    '      label: タスク概要',
    '      required: true',
    '    - name: due',
    '      label: 期限',
    '      type: date',
    '    - name: detail',
    '      label: タスク詳細',
    '      type: text',
    '  steps:',
    '    - kind: journal-append',
    '      content: "- [ ] {{summary}}"',
    '---',
  ].join('\n');

  const names = extractParamNames(doc);
  // 3 つの param 名が抽出される
  expect(names).toContain('summary');
  expect(names).toContain('due');
  expect(names).toContain('detail');
  // 重複なし
  expect(new Set(names).size).toBe(names.length);
});

test('[AC-S9e64e7-3-3] extractParamNames: params 未定義のとき空配列を返す', () => {
  const doc = [
    '---',
    'loamium-command:',
    '  name: no-param',
    '  steps:',
    '    - kind: journal-append',
    '      content: "entry"',
    '---',
  ].join('\n');

  const names = extractParamNames(doc);
  expect(names).toHaveLength(0);
});

// ============================================================
// フィクスチャ (mock テスト共通)
// ============================================================

const DATE = '2026-07-13';
const JOURNAL_PATH = `journals/${DATE}.md`;

const NOTES_WITH_COMMAND = {
  notes: [
    { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
    { path: 'commands/create-todo.md', title: 'create-todo', tags: [], folder: 'commands' },
  ],
};

/** 有効なスマートコマンド定義 (params 2件) */
const COMMAND_WITH_PARAMS_CONTENT = [
  '---',
  'loamium-command:',
  '  name: create todo',
  '  params:',
  '    - name: summary',
  '      required: true',
  '    - name: due',
  '      type: date',
  '  steps:',
  '    - kind: journal-append',
  '      content: "- [ ] {{summary}}"',
  '---',
  '',
  '# create todo',
].join('\n');

/** params なしのコマンド定義 (token 補完で date/now のみ出ることを確認) */
const COMMAND_NO_PARAMS_CONTENT = [
  '---',
  'loamium-command:',
  '  name: no-param',
  '  steps:',
  '    - kind: journal-append',
  '      content: "entry"',
  '---',
  '',
  '# no-param',
].join('\n');

function commandNote(content: string, path = 'commands/create-todo.md'): Record<string, unknown> {
  return {
    path,
    content,
    frontmatter: { 'loamium-command': { name: 'create todo' } },
    body: '# create todo\n',
    mtime: 2000,
  };
}

async function openCommandEditor(page: Page, content: string): Promise<void> {
  await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    void route.fulfill(json(NOTES_WITH_COMMAND));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json({
      date: DATE,
      path: JOURNAL_PATH,
      content: '# ジャーナル\n',
      frontmatter: null,
      body: '# ジャーナル\n',
      created: false,
      mtime: 1000,
    }));
  });
  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(content)));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');
}

// ============================================================
// AC-S9e64e7-3-1: kind: 補完 — 6 種の候補が表示される
// ============================================================

test('[AC-S9e64e7-3-1] kind: の後に 6 種の候補が表示される', async ({ page }) => {
  await openCommandEditor(page, COMMAND_WITH_PARAMS_CONTENT);

  // 左ペインにフォーカスし、末尾へ移動
  const leftPane = page.getByTestId('cmd-edit-yaml');
  await leftPane.click();

  // ドキュメント末尾へ移動してから新しい step を入力
  await page.keyboard.press('Control+End');
  // YAML の steps 内に "- kind: " を入力すると補完が発火する
  await page.keyboard.press('Enter');
  await page.keyboard.type('    - kind: ');

  // 補完ポップアップが表示されるまで待つ
  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible({ timeout: 5000 });

  // 6 種すべての候補ラベルが visible
  const labels = popup.locator('.cm-completionLabel');
  const allText = await labels.allTextContents();

  for (const kind of DSL_KINDS) {
    const found = allText.some((t) => t.includes(kind));
    expect(found, `補完候補に "${kind}" が存在すること`).toBe(true);
  }

  // 不正な kind が含まれないこと [edge_kind_completion_only_valid_kinds]
  expect(allText.some((t) => t.includes('agent-run'))).toBe(false);
  expect(allText.some((t) => t.includes('run-command'))).toBe(false);
});

test('[AC-S9e64e7-3-1] kind: journal-append を選択するとフィールド雛形が挿入される', async ({ page }) => {
  await openCommandEditor(page, COMMAND_WITH_PARAMS_CONTENT);

  const leftPane = page.getByTestId('cmd-edit-yaml');
  await leftPane.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  // "- kind: j" まで入力して journal-append のみに絞り込む
  await page.keyboard.type('    - kind: j');

  // 補完ポップアップが表示されるまで待つ
  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible({ timeout: 5000 });

  // journal-append のみが候補として表示される (j で始まる kind は journal-append のみ)
  const labelsAfterJ = await popup.locator('.cm-completionLabel').allTextContents();
  expect(labelsAfterJ.every((t) => t.startsWith('j'))).toBe(true);

  // Enter で最初の候補 (journal-append) を確定
  await page.keyboard.press('Enter');

  // ポップアップが閉じる
  await expect(popup).not.toBeVisible({ timeout: 5000 });

  // scaffold の content: フィールドが挿入される
  const editorContent = await leftPane.locator('.cm-content').innerText();
  expect(editorContent).toContain('content:');
  expect(editorContent).toContain('journal-append');
});

test('[AC-S9e64e7-3-1] kind: note-patch を選択すると target/old/new が挿入される', async ({ page }) => {
  await openCommandEditor(page, COMMAND_WITH_PARAMS_CONTENT);

  const leftPane = page.getByTestId('cmd-edit-yaml');
  await leftPane.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  // "note-pa" で note-patch のみに絞り込む (note-append は "note-a" で始まる)
  await page.keyboard.type('    - kind: note-pa');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible({ timeout: 5000 });
  // CodeMirror の interactionDelay (75ms) が経過してから Enter で確定する
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await expect(popup).not.toBeVisible({ timeout: 5000 });

  const editorContent = await leftPane.locator('.cm-content').innerText();
  expect(editorContent).toContain('note-patch');
  expect(editorContent).toContain('target:');
  expect(editorContent).toContain('old:');
  expect(editorContent).toContain('new:');
});

test('[AC-S9e64e7-3-1] kind: prop-set を選択すると target/set?/unset? が挿入される', async ({ page }) => {
  await openCommandEditor(page, COMMAND_WITH_PARAMS_CONTENT);

  const leftPane = page.getByTestId('cmd-edit-yaml');
  await leftPane.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  // "p" で prop-set のみが候補になる (DSL_KINDS で p で始まるのは prop-set のみ)
  await page.keyboard.type('    - kind: p');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible({ timeout: 5000 });
  // popup の候補に prop-set が含まれることを確認
  const propSetLabels = await popup.locator('.cm-completionLabel').allTextContents();
  expect(propSetLabels.some((t) => t.includes('prop-set'))).toBe(true);

  // CodeMirror の interactionDelay (75ms) が経過してから Enter で確定する
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await expect(popup).not.toBeVisible({ timeout: 5000 });

  const editorContent = await leftPane.locator('.cm-content').innerText();
  expect(editorContent).toContain('prop-set');
  expect(editorContent).toContain('target:');
});

// ============================================================
// AC-S9e64e7-3-2: {{ トークン補完 — param 名・date/now
// ============================================================

test('[AC-S9e64e7-3-2] {{ を入力すると宣言済み param 名が補完候補に表示される', async ({ page }) => {
  await openCommandEditor(page, COMMAND_WITH_PARAMS_CONTENT);

  const leftPane = page.getByTestId('cmd-edit-yaml');
  await leftPane.click();
  // content: "" 行を探してそこで {{ を入力する。
  // 末尾に新しい content 行を追加。
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('      content: "{{');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible({ timeout: 5000 });

  const labels = popup.locator('.cm-completionLabel');
  const allText = await labels.allTextContents();

  // summary と due が候補に含まれる [AC-S9e64e7-3-2]
  expect(allText.some((t) => t.includes('summary')), '補完候補に "summary" が存在すること').toBe(true);
  expect(allText.some((t) => t.includes('due')), '補完候補に "due" が存在すること').toBe(true);

  // date: と now: トークンも候補に含まれる
  expect(allText.some((t) => t.includes('date:')), '補完候補に "date:" が存在すること').toBe(true);
  expect(allText.some((t) => t.includes('now:')), '補完候補に "now:" が存在すること').toBe(true);
});

test('[AC-S9e64e7-3-2] {{ を入力すると date:YYYY-MM-DD が補完候補に表示される', async ({ page }) => {
  await openCommandEditor(page, COMMAND_WITH_PARAMS_CONTENT);

  const leftPane = page.getByTestId('cmd-edit-yaml');
  await leftPane.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  // "{{date" とタイプして date:YYYY-MM-DD に絞り込む
  await page.keyboard.type('      content: "{{date');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible({ timeout: 5000 });

  // date:YYYY-MM-DD が候補に含まれることを確認
  const dateLabels = await popup.locator('.cm-completionLabel').allTextContents();
  expect(dateLabels.some((t) => t.includes('date:YYYY-MM-DD'))).toBe(true);

  // CodeMirror の interactionDelay (75ms) が経過してから Enter で確定する
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await expect(popup).not.toBeVisible({ timeout: 5000 });

  // "date:YYYY-MM-DD}}" が挿入される
  const editorContent = await leftPane.locator('.cm-content').innerText();
  expect(editorContent).toContain('date:YYYY-MM-DD}}');
});

test('[AC-S9e64e7-3-2] {{ を入力すると now:HH:mm が補完候補に表示される', async ({ page }) => {
  await openCommandEditor(page, COMMAND_WITH_PARAMS_CONTENT);

  const leftPane = page.getByTestId('cmd-edit-yaml');
  await leftPane.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  // "{{now" とタイプして now: トークンに絞り込む
  await page.keyboard.type('      content: "{{now');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible({ timeout: 5000 });

  // now:HH:mm が候補に含まれることを確認
  const nowLabels = await popup.locator('.cm-completionLabel').allTextContents();
  expect(nowLabels.some((t) => t.includes('now:HH:mm'))).toBe(true);

  // CodeMirror の interactionDelay (75ms) が経過してから Enter で確定する
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await expect(popup).not.toBeVisible({ timeout: 5000 });

  const editorContent = await leftPane.locator('.cm-content').innerText();
  expect(editorContent).toContain('now:HH:mm}}');
});

test('[AC-S9e64e7-3-2] params 未定義のとき {{ 補完では date:/now: のみ表示される', async ({ page }) => {
  // params なしのコマンド定義を使用 [edge_completion_no_params_defined]
  await openCommandEditor(page, COMMAND_NO_PARAMS_CONTENT);

  const leftPane = page.getByTestId('cmd-edit-yaml');
  await leftPane.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('      content: "{{');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible({ timeout: 5000 });

  const labels = popup.locator('.cm-completionLabel');
  const allText = await labels.allTextContents();

  // date: と now: は表示される
  expect(allText.some((t) => t.includes('date:')), '補完候補に "date:" が存在すること').toBe(true);
  expect(allText.some((t) => t.includes('now:')), '補完候補に "now:" が存在すること').toBe(true);

  // param 名は表示されない (params が空だから)
  // summary/due などユーザー定義 param 名が含まれないことを確認
  // (date/now/|fallback 以外の param 系候補がないことを確認)
  const paramLikeOptions = allText.filter((t) => {
    const tl = t.toLowerCase();
    return !tl.includes('date') && !tl.includes('now') && !tl.includes('fallback');
  });
  expect(paramLikeOptions).toHaveLength(0);
});

test('[AC-S9e64e7-3-2] param summary を選択すると {{summary}} が挿入される', async ({ page }) => {
  await openCommandEditor(page, COMMAND_WITH_PARAMS_CONTENT);

  const leftPane = page.getByTestId('cmd-edit-yaml');
  await leftPane.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  // "{{su" まで入力して summary に絞り込む
  await page.keyboard.type('      content: "{{su');

  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible({ timeout: 5000 });

  // summary が候補に含まれる
  const labels = await popup.locator('.cm-completionLabel').allTextContents();
  expect(labels.some((t) => t.includes('summary'))).toBe(true);

  // Enter で確定
  await page.keyboard.press('Enter');
  await expect(popup).not.toBeVisible({ timeout: 5000 });

  // {{summary}} が挿入される (}} も補完される)
  const editorContent = await leftPane.locator('.cm-content').innerText();
  expect(editorContent).toContain('{{summary}}');
});
