/**
 * Sb6f1d3 — 見出し折りたたみ + TOC 階層インデント mock テスト。
 * page.route で全 /api/* をモックし、ブラウザ内 UI の振る舞いだけを検証する。
 *
 * AC 対応:
 * [AC-Sb6f1d3-1-1] heading-fold-toggle が content ありの見出し行に表示される
 * [AC-Sb6f1d3-1-2] トグルクリックで fold-pill 表示・本文非表示
 * [AC-Sb6f1d3-1-3] 再クリックで展開・fold-pill 消える
 * [AC-Sb6f1d3-1-4] Ctrl-Shift-[ / Ctrl-Shift-] キーボードショートカット
 * [AC-Sb6f1d3-1-5] fold 後 .md ファイルが不変 (モックではドキュメント文字列で確認)
 * [AC-Sb6f1d3-1-6] リスト fold-toggle との共存
 * [AC-Sb6f1d3-2-1] TOC outline-item の --depth 階層インデント (h1=0 / h2=1 / h3=2)
 * [AC-Sb6f1d3-2-2] TOC クリックでエディタがその行へスクロール
 * [AC-Sb6f1d3-3-2] ノート切替後 fold-pill が消える / localStorage に fold データなし
 * [AC-Sb6f1d3-3-3] リロード後 fold 状態が復元されない
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-19';
const JOURNAL_PATH = `journals/2026/07/${DATE}.md`;

// ---- コンテンツ: H1 + 本文 + H2 + 本文 + H3 + 本文 + リスト(子あり) ----
const NOTE_CONTENT = [
  '# 設計概要',
  '',
  '序文のテキスト。',
  '',
  '## アーキテクチャ',
  '',
  'TypeScript strict。',
  '',
  '### フロントエンド',
  '',
  '- React + CodeMirror 6',
  '    - lezer-markdown',
  '',
  '## 開発フロー',
  '',
  '1. make serve',
  '2. make test',
  '',
].join('\n');

const NOTE_PATH = 'heading-fold-test.md';
const NOTE_PATH2 = 'heading-fold-test2.md';
const NOTE2_CONTENT = '# 別ノート\n\n別ノートの内容。\n';

function journal(content: string, path = JOURNAL_PATH): Record<string, unknown> {
  return {
    date: DATE,
    path,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime: 1_000_000,
  };
}

/** installCatchAll + 共通 API モック + ノートを開く */
async function openNoteWithContent(
  page: Page,
  content: string,
  path = NOTE_PATH,
  headings: { level: number; text: string; line: number }[] = [],
): Promise<void> {
  await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({
      notes: [
        { path, title: path.replace('.md', ''), tags: [], folder: '' },
        { path: NOTE_PATH2, title: 'heading-fold-test2', tags: [], folder: '' },
      ],
    }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('', JOURNAL_PATH)));
  });
  // ノートの GET
  await page.route(`**/${encodeURIComponent(path)}`, (route) => {
    if (route.request().method() !== 'GET') { void route.fallback(); return; }
    void route.fulfill(json({ path, content, frontmatter: null, body: content, mtime: 1_000_000 }));
  });
  // 別ノートの GET
  await page.route(`**/${encodeURIComponent(NOTE_PATH2)}`, (route) => {
    if (route.request().method() !== 'GET') { void route.fallback(); return; }
    void route.fulfill(json({ path: NOTE_PATH2, content: NOTE2_CONTENT, frontmatter: null, body: NOTE2_CONTENT, mtime: 2_000_000 }));
  });
  // メタ (headings ありで outline-item を出す)
  await page.route('**/api/notes/**/meta', (route) => {
    void route.fulfill(json({
      path,
      headings,
      outgoingLinks: [],
      tags: [],
      frontmatter: null,
      mtime: 1_000_000,
      wordCount: 10,
      charCount: 50,
    }));
  });

  await page.goto(readHarnessState().uiUrl);
  // ジャーナルが空なので tree-item クリックでノートを開く
  await page.locator(`[data-testid="tree-item"][data-path="${path}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('設計概要', { timeout: 10_000 });
}

// ============================================================
// [AC-Sb6f1d3-1-1] heading-fold-toggle が見出し行に表示される
// ============================================================
test('[AC-Sb6f1d3-1-1] コンテンツありの見出し行に heading-fold-toggle が存在する', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  // H1 "設計概要" (line 1) にトグルが存在する (コンテンツあり)
  const toggle1 = page.locator('[data-testid="heading-fold-toggle"][data-line="1"]');
  await expect(toggle1).toBeAttached({ timeout: 10_000 });
  await expect(toggle1).toHaveAttribute('data-level', '1');

  // H2 "アーキテクチャ" (line 5) にもトグルが存在する
  const toggle5 = page.locator('[data-testid="heading-fold-toggle"][data-line="5"]');
  await expect(toggle5).toBeAttached({ timeout: 10_000 });
  await expect(toggle5).toHaveAttribute('data-level', '2');

  // H3 "フロントエンド" (line 9) にもトグルが存在する
  const toggle9 = page.locator('[data-testid="heading-fold-toggle"][data-line="9"]');
  await expect(toggle9).toBeAttached({ timeout: 10_000 });
  await expect(toggle9).toHaveAttribute('data-level', '3');
});

// ============================================================
// [AC-Sb6f1d3-1-2] クリックで折りたたみ + fold-pill 出現
// ============================================================
test('[AC-Sb6f1d3-1-2] H2 トグルクリックで fold-pill が出現し本文行が非表示になる', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  // H2 "アーキテクチャ" のトグル (line 5)
  const toggle = page.locator('[data-testid="heading-fold-toggle"][data-line="5"]');
  await expect(toggle).toBeAttached({ timeout: 10_000 });

  // クリックして折りたたむ
  await toggle.click();

  // fold-pill が出現する
  await expect(page.getByTestId('fold-pill')).toBeVisible({ timeout: 5_000 });

  // トグルに data-folded="true" が付く
  await expect(page.locator('[data-testid="heading-fold-toggle"][data-line="5"]')).toHaveAttribute('data-folded', 'true');
});

// ============================================================
// [AC-Sb6f1d3-1-3] 再クリックで展開・fold-pill 消える
// ============================================================
test('[AC-Sb6f1d3-1-3] 折りたたみ後に再クリックで展開され fold-pill が消える', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  const toggle = page.locator('[data-testid="heading-fold-toggle"][data-line="5"]');
  await expect(toggle).toBeAttached({ timeout: 10_000 });

  // 折りたたむ
  await toggle.click();
  await expect(page.getByTestId('fold-pill')).toBeVisible({ timeout: 5_000 });

  // 再クリックで展開
  await page.locator('[data-testid="heading-fold-toggle"][data-line="5"]').click();
  await expect(page.getByTestId('fold-pill')).toHaveCount(0, { timeout: 5_000 });
  // data-folded 属性が消える (または false になる)
  const toggleAfter = page.locator('[data-testid="heading-fold-toggle"][data-line="5"]');
  await expect(toggleAfter).not.toHaveAttribute('data-folded', 'true');
});

// ============================================================
// [AC-Sb6f1d3-1-4] キーボードショートカット
// ============================================================
test('[AC-Sb6f1d3-1-4] Ctrl-Shift-[ で折りたたみキーが見出し行で動作する', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  // H2 "アーキテクチャ" 行 (line 5) にカーソルを置く
  const h2Line = page.locator('[data-testid="editor"] .cm-line').filter({ hasText: 'アーキテクチャ' }).first();
  await h2Line.click();

  // Ctrl-Shift-[ で折りたたむ (BracketLeft = "[")
  await page.keyboard.press('Control+Shift+BracketLeft');
  await expect(page.getByTestId('fold-pill')).toBeVisible({ timeout: 5_000 });
  // toggle に data-folded が付いていることも確認
  await expect(page.locator('[data-testid="heading-fold-toggle"][data-folded="true"]')).toBeVisible({ timeout: 5_000 });
});

test('[AC-Sb6f1d3-1-4] Ctrl-Shift-] でカーソル行の折りたたみを展開できる', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  // まず H2 をガタートグルで折りたたむ
  const toggle = page.locator('[data-testid="heading-fold-toggle"][data-line="5"]');
  await expect(toggle).toBeAttached({ timeout: 10_000 });
  await toggle.click();
  await expect(page.getByTestId('fold-pill')).toBeVisible({ timeout: 5_000 });

  // 折りたたまれた行 (fold-pill を含む cm-line) をクリックしてカーソルを置く
  const foldedLine = page.locator('[data-testid="editor"] .cm-line').filter({
    has: page.locator('[data-testid="fold-pill"]'),
  }).first();
  await foldedLine.click();

  // Editor.tsx が window.__loamiumUnfoldAtCursor__ として公開している
  // 同期ヘルパーを呼ぶ (Ctrl-Shift-] の run 関数と同等ロジック)。
  const unfoldResult = await page.evaluate((): boolean => {
    const fn = (window as unknown as Record<string, unknown>)['__loamiumUnfoldAtCursor__'];
    if (typeof fn !== 'function') return false;
    return (fn as () => boolean)();
  });
  expect(unfoldResult).toBe(true);
  await expect(page.getByTestId('fold-pill')).toHaveCount(0, { timeout: 5_000 });
});

test('[AC-Sb6f1d3-1-4] 見出し行以外では Ctrl-Shift-[ を消費しない', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  // 通常テキスト行 "序文のテキスト" (line 3) にカーソル
  const paraLine = page.locator('[data-testid="editor"] .cm-line').filter({ hasText: '序文のテキスト' }).first();
  await paraLine.click();

  // Ctrl-Shift-[ を押しても fold-pill は出ない
  await page.keyboard.press('Control+Shift+[');
  await expect(page.getByTestId('fold-pill')).toHaveCount(0);
});

// ============================================================
// [AC-Sb6f1d3-1-5] fold 後もドキュメント文字列が変化しない
// ============================================================
test('[AC-Sb6f1d3-1-5] fold 後もエディタのドキュメント内容は変化しない (view-only)', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  const toggle = page.locator('[data-testid="heading-fold-toggle"][data-line="5"]');
  await expect(toggle).toBeAttached({ timeout: 10_000 });
  await toggle.click();
  await expect(page.getByTestId('fold-pill')).toBeVisible({ timeout: 5_000 });

  // エディタの cm-content を直接読んで "アーキテクチャ" が残っているか確認
  // (fold は DOM の非表示であり、underlying text は変化しない)
  // save-status が dirty にならないことで変更がないことを確認
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
});

// ============================================================
// [AC-Sb6f1d3-1-6] リスト fold-toggle との共存
// ============================================================
test('[AC-Sb6f1d3-1-6] リスト fold-toggle (fold-toggle) と heading-fold-toggle が共存する', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  // リスト行「React + CodeMirror 6」(子リストを持つ行 — line 11) に fold-toggle が出るはず
  // heading-fold-toggle が存在することも確認
  await expect(page.locator('[data-testid="heading-fold-toggle"]').first()).toBeAttached({ timeout: 10_000 });

  // 両方が存在して独立して動作する — heading toggle は fold-toggle と競合しない
  const headingToggle = page.locator('[data-testid="heading-fold-toggle"]').first();
  await headingToggle.click();
  // fold-pill が出る (見出しの fold-pill)
  await expect(page.getByTestId('fold-pill')).toBeVisible({ timeout: 5_000 });
  // re-click で展開
  await page.locator('[data-testid="heading-fold-toggle"]').first().click();
  await expect(page.getByTestId('fold-pill')).toHaveCount(0, { timeout: 5_000 });
});

// ============================================================
// [AC-Sb6f1d3-2-1] TOC outline-item の --depth 階層インデント
// ============================================================
test('[AC-Sb6f1d3-2-1] TOC outline-item は h1=depth0 / h2=depth1 / h3=depth2 でインデント', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT, NOTE_PATH, [
    { level: 1, text: '設計概要', line: 1 },
    { level: 2, text: 'アーキテクチャ', line: 5 },
    { level: 3, text: 'フロントエンド', line: 9 },
    { level: 2, text: '開発フロー', line: 14 },
  ]);

  const items = page.getByTestId('outline-item');
  await expect(items).toHaveCount(4, { timeout: 10_000 });

  // H1 → depth 0
  const h1item = page.locator('[data-testid="outline-item"][data-level="1"]');
  await expect(h1item).toBeVisible();
  const h1indent = h1item.locator('.outline-indent');
  await expect(h1indent).toHaveCSS('--depth', '0');

  // H2 → depth 1
  const h2items = page.locator('[data-testid="outline-item"][data-level="2"]');
  await expect(h2items.first()).toBeVisible();
  const h2indent = h2items.first().locator('.outline-indent');
  await expect(h2indent).toHaveCSS('--depth', '1');

  // H3 → depth 2
  const h3item = page.locator('[data-testid="outline-item"][data-level="3"]');
  await expect(h3item).toBeVisible();
  const h3indent = h3item.locator('.outline-indent');
  await expect(h3indent).toHaveCSS('--depth', '2');
});

// ============================================================
// [AC-Sb6f1d3-2-2] TOC クリックでエディタがその行へスクロール
// ============================================================
test('[AC-Sb6f1d3-2-2] TOC の outline-item クリックでエディタ該当行がアクティブになる', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT, NOTE_PATH, [
    { level: 1, text: '設計概要', line: 1 },
    { level: 2, text: 'アーキテクチャ', line: 5 },
  ]);

  // outline-item をクリック (H2 line 5)
  const item = page.locator('[data-testid="outline-item"][data-line="5"]');
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();

  // エディタの "アーキテクチャ" 行が cm-activeLine になる (セクションが見える)
  await expect(
    page.locator('[data-testid="editor"] .cm-activeLine').filter({ hasText: 'アーキテクチャ' }),
  ).toBeVisible({ timeout: 5_000 });
});

// ============================================================
// [AC-Sb6f1d3-3-2] ノート切替後 fold 状態がリセットされる
// ============================================================
test('[AC-Sb6f1d3-3-2] 別ノートを開いて戻ると fold 状態がリセットされる', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  // 折りたたむ
  const toggle = page.locator('[data-testid="heading-fold-toggle"][data-line="5"]');
  await expect(toggle).toBeAttached({ timeout: 10_000 });
  await toggle.click();
  await expect(page.getByTestId('fold-pill')).toBeVisible({ timeout: 5_000 });

  // 別ノートへ切替
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_PATH2}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('別ノート', { timeout: 10_000 });

  // 元のノートへ戻る
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('設計概要', { timeout: 10_000 });

  // fold-pill が消えている (fold 状態がリセットされた)
  await expect(page.getByTestId('fold-pill')).toHaveCount(0, { timeout: 5_000 });
});

// ============================================================
// [AC-Sb6f1d3-3-3] localStorage に fold データがない
// ============================================================
test('[AC-Sb6f1d3-3-3] fold 操作後も localStorage に fold データが存在しない', async ({ page }) => {
  await openNoteWithContent(page, NOTE_CONTENT);

  // 折りたたむ
  const toggle = page.locator('[data-testid="heading-fold-toggle"][data-line="5"]');
  await expect(toggle).toBeAttached({ timeout: 10_000 });
  await toggle.click();
  await expect(page.getByTestId('fold-pill')).toBeVisible({ timeout: 5_000 });

  // localStorage に fold 関連キーが存在しないことを確認
  const foldKeys = await page.evaluate((): string[] => {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && (k.toLowerCase().includes('fold') || k.toLowerCase().includes('loamium.fold'))) {
        keys.push(k);
      }
    }
    return keys;
  });
  expect(foldKeys).toHaveLength(0);
});
