/**
 * Story Sb1593c-2「dataview フェンス描画」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 * クエリ実行は POST /api/query (Sb1593c-1) の実エンドポイントを通る。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

async function putNote(rel: string, content: string): Promise<void> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(`${state().apiUrl}/api/notes/${encoded}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

async function openApp(page: Page): Promise<void> {
  await page.goto(state().uiUrl);
  await expect(page.locator('.breadcrumb .current')).not.toHaveText('ノートが開かれていません');
  await expect(page.getByTestId('editor')).toBeVisible();
}

async function openNoteFromTree(page: Page, path: string, title: string): Promise<void> {
  await page.locator(`[data-testid="tree-item"][data-path="${path}"]`).click();
  await expect(page.locator('.breadcrumb .current')).toHaveText(title);
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await putNote(
    'dvproj/メモ A.md',
    '# メモ A\n\n#dvproj のノート。\n\n- [ ] A の未完了タスク\n- [x] A の完了タスク\n',
  );
  await putNote('dvproj/メモ B.md', '---\ntags: [dvproj]\nstatus: done\n---\n# メモ B\n');
  await putNote(
    'dataview ハブ.md',
    [
      '# dataview ハブ',
      '',
      '```dataview',
      'LIST from #dvproj sort file.name',
      '```',
      '',
      '```dataview',
      'TASK from "dvproj" where !completed',
      '```',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
});

test('[AC-Sb1593c-2-1] dataview フェンスが LIST/TASK の結果として描画され、クリックで元ノート (TASK は該当行) へ移動する', async ({ page }) => {
  await openApp(page);
  await openNoteFromTree(page, 'dataview ハブ.md', 'dataview ハブ');

  // カーソルは 1 行目 (見出し) — 両フェンスとも widget として描画される
  const widgets = page.getByTestId('dataview-widget');
  await expect(widgets).toHaveCount(2);
  await expect(widgets.nth(0)).toHaveAttribute('data-query-type', 'list');
  await expect(widgets.nth(1)).toHaveAttribute('data-query-type', 'task');

  // LIST: #dvproj の 2 ノート (インラインタグ + frontmatter tags)、file.name ソート
  const items = page.getByTestId('dataview-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute('data-path', 'dvproj/メモ A.md');
  await expect(items.nth(1)).toHaveAttribute('data-path', 'dvproj/メモ B.md');

  // TASK: 未完了のみ (完了タスクは出ない)、行番号付き
  const tasks = page.getByTestId('dataview-task');
  await expect(tasks).toHaveCount(1);
  await expect(tasks.first()).toHaveAttribute('data-path', 'dvproj/メモ A.md');
  await expect(tasks.first()).toHaveAttribute('data-line', '5');
  await expect(tasks.first()).toContainText('A の未完了タスク');
  await expect(widgets.nth(1)).not.toContainText('A の完了タスク');

  // LIST の結果クリック → 元ノートへ移動
  await items.nth(1).click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('メモ B');

  // 戻って TASK の結果クリック → 元ノートの該当行 (L5) へ移動
  await openNoteFromTree(page, 'dataview ハブ.md', 'dataview ハブ');
  await page.getByTestId('dataview-task').first().click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('メモ A');
  await expect(page.locator('[data-testid="editor"] .cm-activeLine')).toContainText(
    '- [ ] A の未完了タスク',
  );
});

test('[AC-Sb1593c-2-2] vault のファイル変更に追従して表示中のクエリ結果が更新される', async ({ page }) => {
  await openApp(page);
  await openNoteFromTree(page, 'dataview ハブ.md', 'dataview ハブ');

  const items = page.getByTestId('dataview-item');
  await expect(items).toHaveCount(2);

  // 表示中に API 経由で新しいノートを追加 (実サーバー → インデックス更新 → 再実行で反映)
  await putNote('dvproj/メモ C.md', '# メモ C\n\n#dvproj を追加。\n');
  await expect(items).toHaveCount(3, { timeout: 10_000 });
  await expect(items.nth(2)).toHaveAttribute('data-path', 'dvproj/メモ C.md');

  // タスク行の追記も表示中の TASK 結果へ反映される
  await putNote(
    'dvproj/メモ C.md',
    '# メモ C\n\n#dvproj を追加。\n\n- [ ] C の新タスク\n',
  );
  const tasks = page.getByTestId('dataview-task');
  await expect(tasks).toHaveCount(2, { timeout: 10_000 });
  await expect(tasks.nth(1)).toContainText('C の新タスク');
});

test('[AC-Sb1593c-2-3] 構文エラーはフェンス内に位置情報付きで表示され、エディタは通常どおり編集できる', async ({ page }) => {
  await putNote(
    '構文エラーテスト.md',
    ['# 構文エラーテスト', '', '```dataview', 'LIST form #reading', '```', '', 'アンカー行。', ''].join('\n'),
  );
  await openApp(page);
  await openNoteFromTree(page, '構文エラーテスト.md', '構文エラーテスト');

  // エラーがフェンス内に表示される (位置情報 + キャレット — prototype/dataview.html)
  const widget = page.getByTestId('dataview-widget');
  await expect(widget).toHaveAttribute('data-query-type', 'error');
  const error = page.getByTestId('dataview-error');
  await expect(error).toContainText('クエリを解析できません (400)');
  await expect(error).toContainText('LIST form #reading');
  await expect(error).toContainText('^^^^');
  await expect(error).toContainText("1 行 6 列: 予期しないトークン 'form'");

  // エディタは通常どおり編集できる (editor.e2e と同じ操作パターン)
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('ここに追記できる');
  await expect(page.getByTestId('editor')).toContainText('ここに追記できる');

  // フェンス (エラー表示) をクリックするとカーソルがフェンスへ移り、ソース編集に戻る
  await page.getByTestId('dataview-error').click();
  await expect(page.getByTestId('dataview-error')).toHaveCount(0);
  await expect(editorLine(page, 'LIST form')).toContainText('LIST form #reading');
});
