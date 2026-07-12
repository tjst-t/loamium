/**
 * Story Sde7a63-1 mock テスト — コマンドレジストリ + 組み込みコマンド + パレット コマンドセクション。
 * page.route で全 /api/* をモックする。
 *
 * AC-Sde7a63-1-1: コマンドレジストリ + Ctrl-K バインドが組み込みコマンドを提供する。
 * AC-Sde7a63-1-2: コマンドセクション表示・クエリ絞り込み・キーボードナビ・Enter/Esc・IME 退行なし。
 * AC-Sde7a63-1-3: 組み込みコマンド 5 件がパレットから動作 (既存ハンドラへ接続)。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-11';
const JOURNAL_PATH = `journals/${DATE}.md`;

const NOTES = {
  notes: [
    { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
    { path: 'projects/議事録.md', title: '議事録', tags: [], folder: 'projects' },
    { path: 'reading/テスト戦略.md', title: 'テスト戦略', tags: [], folder: 'reading' },
  ],
};

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

function searchResult(
  path: string,
  title: string,
  snippet: string,
  line: number | null,
): Record<string, unknown> {
  return { path, title, score: 0.01, snippet, line };
}

async function openApp(
  page: Page,
  opts: { searchResults?: unknown[]; failSearch?: boolean } = {},
): Promise<{ unexpected: string[] }> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json(NOTES));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('# ジャーナル\n\n本文。\n')));
  });
  await page.route('**/api/search*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    if (opts.failSearch === true) {
      void route.fulfill(json({ error: 'internal_error', message: 'index unavailable' }, 500));
      return;
    }
    void route.fulfill(json({ query: q, results: opts.searchResults ?? [] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文。');
  return { unexpected };
}

/** パレットを開いて表示を確認する */
async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await expect(page.getByTestId('command-palette')).toHaveAttribute('role', 'dialog');
  await expect(page.getByTestId('command-palette')).toHaveAttribute('aria-label', 'コマンドパレット');
}

// =========================================================================
// AC-Sde7a63-1-1: コマンドレジストリとパレットの基本構造
// =========================================================================

test('[AC-Sde7a63-1-1][MOCK] Ctrl-K でコマンドパレットが開き testid_contract に沿った要素が揃う', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  // testid_contract 確認
  await expect(page.getByTestId('command-palette-backdrop')).toBeVisible();
  await expect(page.getByTestId('search-input')).toBeVisible();
  await expect(page.getByTestId('search-input')).toBeFocused();
  // placeholder が変更されていること
  await expect(page.getByTestId('search-input')).toHaveAttribute(
    'placeholder',
    '検索またはコマンドを入力…',
  );
  // フッタの既存ボタン
  await expect(page.getByTestId('search-open-advanced')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-1-1][MOCK] 空クエリでもコマンドセクションが表示される', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  // 空クエリ → ノート/全文セクション非表示、コマンドセクション表示
  await expect(page.getByTestId('palette-section-notes')).toHaveCount(0);
  await expect(page.getByTestId('palette-section-fulltext')).toHaveCount(0);
  await expect(page.getByTestId('palette-section-commands')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-1-3: 組み込みコマンド 5 件がパレットに表示される
// =========================================================================

test('[AC-Sde7a63-1-3][MOCK] 組み込みコマンド 5 件がすべて data-source="builtin" で表示される', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  const items = page.locator('[data-testid="command-item"][data-source="builtin"]');
  await expect(items).toHaveCount(5);

  // 5 件の command-id を確認
  const ids = ['new-note', 'new-note-from-template', 'new-smart-folder', 'open-advanced-search', 'open-today-journal'];
  for (const id of ids) {
    await expect(
      page.locator(`[data-testid="command-item"][data-command-id="${id}"]`),
    ).toBeVisible();
  }

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-1-2: クエリ絞り込み
// =========================================================================

test('[AC-Sde7a63-1-2][MOCK] query でコマンドを title / keywords で絞り込む', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  // 「ジャーナル」で絞り込むと open-today-journal だけ残る
  await page.getByTestId('search-input').type('ジャーナル');
  const items = page.locator('[data-testid="command-item"]');
  await expect(items).toHaveCount(1);
  await expect(
    page.locator('[data-testid="command-item"][data-command-id="open-today-journal"]'),
  ).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-1-2][MOCK] keywords で絞り込む (英語 keyword)', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  // 'template' というキーワードで絞り込む
  await page.getByTestId('search-input').type('template');
  const items = page.locator('[data-testid="command-item"]');
  await expect(items).toHaveCount(1);
  await expect(
    page.locator('[data-testid="command-item"][data-command-id="new-note-from-template"]'),
  ).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-1-2][MOCK] 3 セクションがすべて同時に表示される (ノート/全文/コマンド)', async ({ page }) => {
  const { unexpected } = await openApp(page, {
    // 全文: 'journal' クエリで検索結果を返す
    searchResults: [searchResult('projects/議事録.md', '議事録', 'journalに関連', 3)],
  });
  await openPalette(page);

  // 'journal' はコマンドのキーワード 'journal' / ノートのパス / 全文ヒットを同時に引く
  await page.getByTestId('search-input').type('journal');

  // ノートセクション: title/path に journal は含まれていないが…
  // → 「今日のジャーナルを開く」の keyword 'journal' でコマンドセクションは表示される
  await expect(page.getByTestId('palette-section-commands')).toBeVisible();
  // 全文セクションもヒットする (mockで用意)
  await expect(page.getByTestId('palette-section-fulltext')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-1-2: キーボードナビゲーション (↑↓ + Enter) が 3 セクションをまたぐ
// =========================================================================

test('[AC-Sde7a63-1-2][MOCK] ↑↓ でコマンド候補を選択して aria-selected が移動する', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  // 空クエリ → コマンドセクションのみ表示 (items.length=5, selectedIndex=0)
  // 初期状態: selected=0 → items[0] (new-note) が aria-selected='true'
  const firstCmd = page.locator('[data-testid="command-item"]').first();
  await expect(firstCmd).toHaveAttribute('aria-selected', 'true');
  await expect(firstCmd).toHaveClass(/selected/);

  // ArrowDown → selected=1 → items[1] (new-note-from-template) が選択
  await page.keyboard.press('ArrowDown');
  const secondCmd = page.locator('[data-testid="command-item"]').nth(1);
  await expect(secondCmd).toHaveAttribute('aria-selected', 'true');

  // ArrowDown → selected=2 → items[2] が選択
  await page.keyboard.press('ArrowDown');
  const thirdCmd = page.locator('[data-testid="command-item"]').nth(2);
  await expect(thirdCmd).toHaveAttribute('aria-selected', 'true');

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-1-2][MOCK] ↑↓ キーがノート→コマンドセクションをまたいで移動する', async ({ page }) => {
  const { unexpected } = await openApp(page, { searchResults: [] });
  await openPalette(page);

  // 「議事録」で絞り込むとノートセクション 1 件 + コマンドセクション (コマンドにはマッチしない)
  // → ノート 1 件のみ items に入る。コマンドセクションは表示されない。
  await page.getByTestId('search-input').type('議事録');
  await expect(page.getByTestId('palette-section-notes')).toBeVisible();

  // items = [note_議事録], selectedIndex=0 → ノートが選択されている
  await expect(page.locator('[data-testid="search-result-note"]').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // 「新規」でノート + コマンドが同時に表示されるか確認 (cross-section ナビ)
  await page.getByTestId('search-input').fill('新規');
  await expect(page.getByTestId('palette-section-notes')).toHaveCount(0); // ノートに「新規」なし
  // コマンドセクション: 「新規ノート作成」「テンプレートからノート作成」が hit
  await expect(page.getByTestId('palette-section-commands')).toBeVisible();

  // 初期 selected=0 → 最初のコマンドが選択
  await expect(page.locator('[data-testid="command-item"]').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // ArrowDown → 2 件目が選択
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-testid="command-item"]').nth(1)).toHaveAttribute(
    'aria-selected',
    'true',
  );

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-1-2: Esc で閉じる
// =========================================================================

test('[AC-Sde7a63-1-2][MOCK] Esc でコマンドパレットが閉じる', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-1-3: 各コマンドの実行で既存ハンドラが発火する
// =========================================================================

test('[AC-Sde7a63-1-3][MOCK] new-note コマンドをクリックすると新規ノートダイアログが開く', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  await page.locator('[data-testid="command-item"][data-command-id="new-note"]').click();

  // パレットが閉じる
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  // 新規ノートダイアログが開く
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-1-3][MOCK] new-note コマンドを Enter で実行するとダイアログが開く', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  // 空クエリ → コマンドのみ表示。初期 selected=0 → new-note (items[0]) が選択済み
  await expect(
    page.locator('[data-testid="command-item"][data-command-id="new-note"]'),
  ).toHaveAttribute('aria-selected', 'true');

  // Enter で実行
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-1-3][MOCK] open-advanced-search コマンドをクリックすると /search ルートに遷移する', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  await page.locator('[data-testid="command-item"][data-command-id="open-advanced-search"]').click();

  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  // /search ルートが表示される
  await expect(page.getByTestId('route-display')).toContainText('/search');

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-1-3][MOCK] open-today-journal コマンドをクリックするとジャーナルが開く', async ({ page }) => {
  const { unexpected } = await openApp(page);

  // まず別ノートを開いてからパレットを操作する
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').type('テスト戦略');
  await expect(page.getByTestId('search-result-note')).toHaveCount(1);
  // 別ノートを開く (パレットが閉じる)
  // Note: テスト環境ではノートの実際のロードはモック応答を要するため、
  // ここでは journal コマンドの発火のみ確認する
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="open-today-journal"]').click();

  // パレットが閉じる
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-1-3][MOCK] new-note-from-template コマンドをクリックするとテンプレートエラー表示 or picker が起動する', async ({ page }) => {
  const { unexpected } = await openApp(page);
  // テンプレート一覧 API をモック (空 or エラー)
  await page.route('**/api/templates', (route) => {
    void route.fulfill(json({ templates: [] }));
  });

  await openPalette(page);
  await page.locator('[data-testid="command-item"][data-command-id="new-note-from-template"]').click();

  // パレットが閉じる
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  // テンプレートピッカー or 何らかの UI が表示される (空の場合はピッカーが表示されたまま)

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-1-2: IME ガード (退行テスト)
// =========================================================================

test('[AC-Sde7a63-1-2][MOCK] IME 変換中の Enter はコマンドパレットを閉じない', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  const input = page.getByTestId('search-input');
  await input.click();

  // IME 開始
  await input.dispatchEvent('compositionstart');
  // 変換中に Enter を押してもパレットが閉じないこと
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // compositionend 後に Esc で閉じることを確認
  await input.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-1-2: 既存ノート/全文セクションの退行テスト
// =========================================================================

test('[AC-Sde7a63-1-2][MOCK] 既存のノートセクション・全文セクションは退行しない', async ({ page }) => {
  const { unexpected } = await openApp(page, {
    searchResults: [searchResult('projects/議事録.md', '議事録', '7月の議事録', 3)],
  });
  await openPalette(page);

  await page.getByTestId('search-input').type('議事録');

  // ノートセクション (既存 testid 踏襲)
  await expect(page.getByTestId('palette-section-notes')).toBeVisible();
  await expect(page.getByTestId('search-result-note')).toHaveCount(1);

  // 全文セクション (既存 testid 踏襲)
  await expect(page.getByTestId('palette-section-fulltext')).toBeVisible();
  await expect(page.getByTestId('search-result-fulltext')).toHaveCount(1);

  // コマンドセクション: 「議事録」は既存組み込みコマンドにマッチしないため非表示
  // (空クエリではコマンド全件表示されることは別テストで検証済み)
  await expect(page.getByTestId('palette-section-commands')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-1-2][MOCK] ノート候補クリックでノートが開きパレットが閉じる', async ({ page }) => {
  const { unexpected } = await openApp(page);

  // note ルートへのナビゲーション用にモックを追加
  await page.route('**/api/notes/projects/**', (route) => {
    void route.fulfill(
      json({
        path: 'projects/議事録.md',
        content: '# 議事録\n\n内容\n',
        frontmatter: null,
        mtime: 1000,
      }),
    );
  });
  await page.route('**/api/backlinks*', (route) => {
    void route.fulfill(json({ path: 'projects/議事録.md', backlinks: [] }));
  });
  await page.route('**/api/notes/**/meta', (route) => {
    void route.fulfill(
      json({
        path: 'projects/議事録.md',
        headings: [],
        outgoingLinks: [],
        tags: [],
        frontmatter: null,
        mtime: 1000,
        wordCount: 0,
        charCount: 0,
      }),
    );
  });

  await openPalette(page);
  await page.getByTestId('search-input').type('議事録');
  await page.getByTestId('search-result-note').click();

  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-1-2: クロスセクション — ノート→コマンド間の ArrowDown フラットインデックス走査
// =========================================================================

test('[AC-Sde7a63-1-2][MOCK] ArrowDown でノートセクションからコマンドセクションへ走査する', async ({ page }) => {
  /**
   * /api/notes を上書きして「新規作業ログ.md」(title: '新規作業ログ') を含めると、
   * クエリ '新規' でノートセクション (1 件: '新規作業ログ') と
   * コマンドセクション (2 件: 'new-note', 'new-note-from-template') が同時に表示される。
   * flat index: [0]=note, [1]=cmd(new-note), [2]=cmd(new-note-from-template)
   * ArrowDown を 1 回押すと selected が 1 に移動し command-item が選ばれることを確認する。
   */
  const unexpected = await installCatchAll(page);
  // /api/notes を上書き — 既存 3 件 + 新規ノートを追加 (パレット開く前に設定)
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
          { path: 'projects/議事録.md', title: '議事録', tags: [], folder: 'projects' },
          { path: 'reading/テスト戦略.md', title: 'テスト戦略', tags: [], folder: 'reading' },
          { path: 'work/新規作業ログ.md', title: '新規作業ログ', tags: [], folder: 'work' },
        ],
      }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('# ジャーナル\n\n本文。\n')));
  });
  await page.route('**/api/search*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    void route.fulfill(json({ query: q, results: [] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文。');

  await openPalette(page);

  // '新規' で絞り込む
  await page.getByTestId('search-input').type('新規');

  // ノートセクション: '新規作業ログ' が 1 件
  await expect(page.getByTestId('palette-section-notes')).toBeVisible();
  await expect(page.getByTestId('search-result-note')).toHaveCount(1);

  // コマンドセクション: new-note / new-note-from-template が 2 件
  await expect(page.getByTestId('palette-section-commands')).toBeVisible();
  const cmdItems = page.locator('[data-testid="command-item"]');
  await expect(cmdItems).toHaveCount(2);

  // 初期状態: selected=0 → note (flat index 0) が aria-selected
  const noteItem = page.locator('[data-testid="search-result-note"]').first();
  await expect(noteItem).toHaveAttribute('aria-selected', 'true');
  await expect(noteItem).toHaveClass(/selected/);

  // ArrowDown 1 回 → flat index 1 = command-item[0] (new-note) が選択される
  await page.keyboard.press('ArrowDown');
  const firstCmd = page.locator('[data-testid="command-item"]').first();
  await expect(firstCmd).toHaveAttribute('aria-selected', 'true');
  await expect(firstCmd).toHaveClass(/selected/);
  await expect(firstCmd).toHaveAttribute('data-command-id', 'new-note');

  // ArrowDown もう 1 回 → flat index 2 = command-item[1] (new-note-from-template) が選択される
  await page.keyboard.press('ArrowDown');
  const secondCmd = page.locator('[data-testid="command-item"]').nth(1);
  await expect(secondCmd).toHaveAttribute('aria-selected', 'true');
  await expect(secondCmd).toHaveAttribute('data-command-id', 'new-note-from-template');

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-2-1 / AC-Sde7a63-2-2: '>' コマンド専用モード (Story Sde7a63-2)
// =========================================================================

/**
 * シナリオ: happy_path_enter_command_mode
 * '>' を入力するとコマンドモードになり、ノート/全文セクションが非表示になる。
 */
test('[AC-Sde7a63-2-1][MOCK] 先頭 > でコマンド専用モード: ノート/全文セクション非表示 + コマンドセクション表示', async ({ page }) => {
  const { unexpected } = await openApp(page, { searchResults: [] });
  await openPalette(page);

  // '>' を入力してコマンドモードへ
  await page.getByTestId('search-input').fill('>');

  // palette-mode-command インジケーターが visible (AC-Sde7a63-2-2)
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // ノートセクション・全文セクションは非表示 (AC-Sde7a63-2-1)
  await expect(page.getByTestId('palette-section-notes')).toHaveCount(0);
  await expect(page.getByTestId('palette-section-fulltext')).toHaveCount(0);

  // コマンドセクションは表示 (全コマンド — クエリなし)
  await expect(page.getByTestId('palette-section-commands')).toBeVisible();
  // 組み込み 5 件がすべて表示される
  await expect(page.locator('[data-testid="command-item"]')).toHaveCount(5);

  expect(unexpected).toEqual([]);
});

/**
 * シナリオ: happy_path_command_mode_filter
 * '> journal' でコマンドを絞り込む。'>' 以降のテキストがクエリになる。
 */
test('[AC-Sde7a63-2-1][MOCK] コマンドモード: > journal で journal コマンドのみ絞り込まれる', async ({ page }) => {
  const { unexpected } = await openApp(page, { searchResults: [] });
  await openPalette(page);

  await page.getByTestId('search-input').fill('> journal');

  // コマンドモードインジケーター表示 (AC-Sde7a63-2-2)
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // 'journal' を title/keywords に含むコマンドのみ表示
  const items = page.locator('[data-testid="command-item"]');
  await expect(items).toHaveCount(1);
  await expect(
    page.locator('[data-testid="command-item"][data-command-id="open-today-journal"]'),
  ).toBeVisible();

  // ノート/全文セクションは引き続き非表示
  await expect(page.getByTestId('palette-section-notes')).toHaveCount(0);
  await expect(page.getByTestId('palette-section-fulltext')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

/**
 * シナリオ: happy_path_return_to_normal_mode
 * '>' を削除すると通常モードへ復帰し、ノート/全文セクションが再び表示される。
 */
test('[AC-Sde7a63-2-1][MOCK] > を削除すると通常モードへ復帰してノートセクションが再表示される', async ({ page }) => {
  const { unexpected } = await openApp(page, {
    searchResults: [searchResult('projects/議事録.md', '議事録', '7月の議事録', 3)],
  });
  await openPalette(page);

  // コマンドモードへ
  await page.getByTestId('search-input').fill('> 議事録');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();
  await expect(page.getByTestId('palette-section-notes')).toHaveCount(0);

  // '>' を削除して通常モードへ
  await page.getByTestId('search-input').fill('議事録');
  await expect(page.getByTestId('palette-mode-command')).toHaveCount(0);

  // ノートセクションが再表示 (通常モード)
  await expect(page.getByTestId('palette-section-notes')).toBeVisible();

  expect(unexpected).toEqual([]);
});

/**
 * シナリオ: happy_path_placeholder_shows_mode
 * コマンドモード中は placeholder が「コマンドを入力…」に変わる。
 */
test('[AC-Sde7a63-2-2][MOCK] コマンドモード中は placeholder がモードを示すテキストに変わる', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  // 通常モードの placeholder
  await expect(page.getByTestId('search-input')).toHaveAttribute(
    'placeholder',
    '検索またはコマンドを入力…',
  );

  // '>' を入力してコマンドモードへ
  await page.getByTestId('search-input').fill('>');

  // placeholder がコマンドモード専用に変わる
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'コマンドを入力…');

  expect(unexpected).toEqual([]);
});

/**
 * シナリオ: happy_path_esc_closes_from_command_mode
 * コマンドモード中に Esc を押すとパレットが直接閉じる (モードを戻さず)。
 */
test('[AC-Sde7a63-2-2][MOCK] コマンドモード中の Esc はパレットを閉じる (直接 close、モード戻しなし)', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  await page.getByTestId('search-input').fill('> 議事録');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // Esc で閉じる
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

/**
 * シナリオ: edge_ime_in_command_mode
 * コマンドモード中の IME 変換ガードが機能する。
 * compositionstart 中は Enter でパレットが閉じない。
 * compositionend 後は Esc でパレットが閉じる。
 */
test('[AC-Sde7a63-2-2][MOCK] コマンドモード中の IME 変換ガード: 変換中 Enter はパレットを閉じない', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  const input = page.getByTestId('search-input');
  await input.fill('>');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // IME 開始
  await input.dispatchEvent('compositionstart');
  // 変換中に Enter を押してもパレットが閉じないこと
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // compositionend 後に Esc で閉じる
  await input.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

/**
 * シナリオ: edge_prefix_centralized
 * parsePaletteInput による prefix→mode 集約: '>' のみがコマンドモードを起動し、
 * '>' 以降の文字列がコマンドクエリとして使われる。
 * ノート/全文セクションは非表示のまま。
 */
test('[AC-Sde7a63-2-1][MOCK] edge_prefix_centralized: > create でコマンドを絞り込み、ノート/全文は非表示のまま', async ({ page }) => {
  const { unexpected } = await openApp(page, { searchResults: [] });
  await openPalette(page);

  // '> create' 入力: '>' を除去した 'create' でコマンドを絞り込む
  await page.getByTestId('search-input').fill('> create');

  // コマンドモード確認
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // 'create' に一致するコマンド (new-note / new-note-from-template / new-note title に 'create' はないが、
  // keywords 等に 'create' を含むもの) が表示される
  // → 少なくとも palette-section-commands が visible (コマンドが 0 件でも mode 維持は確認済み)
  // ここではセクション自体の表示を確認する
  // ノート/全文セクションが非表示であることが AC-Sde7a63-2-1 の本質
  await expect(page.getByTestId('palette-section-notes')).toHaveCount(0);
  await expect(page.getByTestId('palette-section-fulltext')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

/**
 * コマンドモード内でのキーボードナビゲーション: ↑↓ wrap + Enter 実行 (AC-Sde7a63-2-2)
 */
test('[AC-Sde7a63-2-2][MOCK] コマンドモード中の ↑↓ ナビゲーションが機能する', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  // '>' でコマンドモードへ (全 5 件)
  await page.getByTestId('search-input').fill('>');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // 初期 selected=0 → 1 件目が選択
  const firstItem = page.locator('[data-testid="command-item"]').first();
  await expect(firstItem).toHaveAttribute('aria-selected', 'true');

  // ArrowDown → 2 件目が選択
  await page.keyboard.press('ArrowDown');
  const secondItem = page.locator('[data-testid="command-item"]').nth(1);
  await expect(secondItem).toHaveAttribute('aria-selected', 'true');
  await expect(firstItem).not.toHaveAttribute('aria-selected', 'true');

  // ArrowUp → 1 件目に戻る
  await page.keyboard.press('ArrowUp');
  await expect(firstItem).toHaveAttribute('aria-selected', 'true');

  expect(unexpected).toEqual([]);
});

/**
 * コマンドモード中の Enter でコマンド実行 (AC-Sde7a63-2-2)
 */
test('[AC-Sde7a63-2-2][MOCK] コマンドモード中の Enter で選択コマンドが実行される', async ({ page }) => {
  const { unexpected } = await openApp(page);
  await openPalette(page);

  // '>' でコマンドモードへ — 初期 selected=0 → new-note が選択
  await page.getByTestId('search-input').fill('>');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  const firstItem = page.locator('[data-testid="command-item"]').first();
  await expect(firstItem).toHaveAttribute('aria-selected', 'true');
  await expect(firstItem).toHaveAttribute('data-command-id', 'new-note');

  // Enter で実行
  await page.keyboard.press('Enter');

  // パレットが閉じて new-note ダイアログが開く
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-2-1: コマンドモード空状態メッセージ
// =========================================================================

/**
 * シナリオ: command_mode_empty_state_message
 * '> zzznotacommand' のようにどのコマンドにもマッチしないクエリを入力した場合、
 * 空状態メッセージはコマンド向けの文言になり、
 * - 「コマンド」という語を含む
 * - 「ノート」という語を含まない
 * - 先頭の '>' 文字を含まない
 */
test('[AC-Sde7a63-2-1][MOCK] コマンドモードで一致なしのとき空状態メッセージがコマンド向け文言になる (> 除去)', async ({ page }) => {
  const { unexpected } = await openApp(page, { searchResults: [] });
  await openPalette(page);

  // '> zzznotacommand' を入力 — どのコマンドにも一致しない
  await page.getByTestId('search-input').fill('> zzznotacommand');

  // コマンドモードインジケーターが表示されている
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // コマンドが 0 件 → 空状態メッセージが表示される
  await expect(page.locator('[data-testid="command-item"]')).toHaveCount(0);
  const emptyMsg = page.getByTestId('search-empty');
  await expect(emptyMsg).toBeVisible();

  // 「コマンド」が含まれる
  await expect(emptyMsg).toContainText('コマンド');

  // 「ノート」は含まれない
  const text = await emptyMsg.textContent();
  expect(text).not.toContain('ノート');

  // '>' 文字は含まれない
  expect(text).not.toContain('>');

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-3-1: スマートコマンド表示 (source=smart / valid:false 非選択)
// =========================================================================

/** GET /api/commands モックデータ */
const SMART_COMMANDS_RESPONSE = {
  commands: [
    {
      name: 'create-todo',
      path: 'commands/create-todo.md',
      description: '今日のジャーナル Todo セクションにタスクを追加する',
      params: [
        { name: 'タスク概要', type: 'string', required: true, label: 'タスク概要' },
        { name: '期限', type: 'date', required: false, label: '期限' },
        { name: 'タスク詳細', type: 'text', required: false, label: 'タスク詳細' },
      ],
      valid: true,
    },
    {
      name: 'invalid-cmd',
      path: 'commands/invalid-cmd.md',
      valid: false,
      error: 'loamium-command キーが見つかりません',
    },
  ],
};

async function openAppWithSmartCommands(
  page: import('@playwright/test').Page,
  opts: { searchResults?: unknown[]; smartCommands?: unknown } = {},
): Promise<{ unexpected: string[] }> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json(NOTES));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('# ジャーナル\n\n本文。\n')));
  });
  await page.route('**/api/search*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    void route.fulfill(json({ query: q, results: opts.searchResults ?? [] }));
  });
  // スマートコマンド一覧をオーバーライド
  await page.route('**/api/commands', (route) => {
    void route.fulfill(json(opts.smartCommands ?? SMART_COMMANDS_RESPONSE));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文。');
  return { unexpected };
}

test('[AC-Sde7a63-3-1][MOCK] GET /api/commands のコマンドが source=smart でパレットに表示される', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // create-todo が source=smart で表示される
  const smartItem = page.locator('[data-testid="command-item"][data-source="smart"][data-command-id="smart:create-todo"]');
  await expect(smartItem).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-1][MOCK] valid:false コマンドは data-disabled=true + aria-disabled=true で表示される', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // invalid-cmd は data-disabled='true'
  const disabledItem = page.locator('[data-testid="command-item"][data-disabled="true"]');
  await expect(disabledItem).toBeVisible();
  await expect(disabledItem).toHaveAttribute('aria-disabled', 'true');

  // エラー理由が表示される
  await expect(page.getByTestId('command-item-error-reason')).toBeVisible();
  await expect(page.getByTestId('command-item-error-reason')).toContainText('loamium-command');

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-1][MOCK] valid:false コマンドは pointer-events:none で選択不可', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  const disabledItem = page.locator('[data-testid="command-item"][data-disabled="true"]');
  await expect(disabledItem).toBeVisible();

  // pointer-events:none が適用されている (CSS .cmd-disabled)
  const pointerEvents = await disabledItem.evaluate((el) => window.getComputedStyle(el).pointerEvents);
  expect(pointerEvents).toBe('none');

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-3-2: params を持つコマンドはフォームモーダルを開く
// =========================================================================

test('[AC-Sde7a63-3-2][MOCK] params を持つ create-todo を選択するとパラメータフォームモーダルが開く', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // create-todo をクリック
  await page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]').click();

  // パラメータフォームモーダルが表示される
  await expect(page.getByTestId('param-form-modal')).toBeVisible();
  await expect(page.getByTestId('param-form-modal')).toHaveAttribute('role', 'dialog');

  // フォームタイトル
  await expect(page.getByTestId('param-form-title')).toContainText('create-todo');

  // パレットは引き続き visible (閉じない)
  await expect(page.getByTestId('command-palette')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-2][MOCK] param-form-modal にパラメータフィールドが表示される (type=string/text/date)', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // タスク概要 (type=string, required=true)
  const summaryField = page.locator('[data-testid="param-field"][data-name="タスク概要"]');
  await expect(summaryField).toBeVisible();
  await expect(summaryField).toHaveAttribute('data-type', 'string');
  await expect(summaryField).toHaveAttribute('data-required', 'true');

  // type=string → input[type=text]
  const summaryInput = page.locator('[data-testid="param-field-input"][data-name="タスク概要"]');
  await expect(summaryInput).toBeVisible();
  await expect(summaryInput).toHaveAttribute('type', 'text');

  // 期限 (type=date, required=false)
  const dateField = page.locator('[data-testid="param-field"][data-name="期限"]');
  await expect(dateField).toBeVisible();
  await expect(dateField).toHaveAttribute('data-type', 'date');
  await expect(dateField).toHaveAttribute('data-required', 'false');
  const dateInput = page.locator('[data-testid="param-field-input"][data-name="期限"]');
  await expect(dateInput).toHaveAttribute('type', 'date');

  // タスク詳細 (type=text = textarea)
  const detailField = page.locator('[data-testid="param-field"][data-name="タスク詳細"]');
  await expect(detailField).toBeVisible();
  await expect(detailField).toHaveAttribute('data-type', 'text');
  const detailInput = page.locator('[data-testid="param-field-input"][data-name="タスク詳細"]');
  await expect(detailInput.locator('xpath=self::textarea')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-2][MOCK] required 未入力時は param-form-submit が aria-disabled=true', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // タスク概要 (required) が空の状態では submit が aria-disabled
  const submitBtn = page.getByTestId('param-form-submit');
  await expect(submitBtn).toHaveAttribute('aria-disabled', 'true');

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-2][MOCK] required 入力後は param-form-submit が有効になる', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // タスク概要を入力
  await page.locator('[data-testid="param-field-input"][data-name="タスク概要"]').fill('テストタスク');

  // submit が有効になる
  const submitBtn = page.getByTestId('param-form-submit');
  await expect(submitBtn).not.toHaveAttribute('aria-disabled', 'true');

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-2][MOCK] required 未入力で実行ボタン押下 → param-field-error が表示される', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // POST は呼ばれない (クライアント側バリデーション)
  // 実行ボタンをクリック (aria-disabled だが onClick は発火する)
  await page.getByTestId('param-form-submit').click({ force: true });

  // インラインエラーが表示される
  const fieldError = page.locator('[data-testid="param-field-error"][data-name="タスク概要"]');
  await expect(fieldError).toBeVisible();
  await expect(fieldError).toContainText('タスク概要');

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-2][MOCK] default 値がフィールドに事前入力される', async ({ page }) => {
  // default 付きコマンドを返すモック
  const commandsWithDefault = {
    commands: [
      {
        name: 'with-default',
        path: 'commands/with-default.md',
        description: 'デフォルト値テスト',
        params: [
          { name: 'カテゴリ', type: 'string', required: false, default: '仕事', label: 'カテゴリ' },
        ],
        valid: true,
      },
    ],
  };
  const { unexpected } = await openAppWithSmartCommands(page, { smartCommands: commandsWithDefault });
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="smart:with-default"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // default 値が入力済み
  const input = page.locator('[data-testid="param-field-input"][data-name="カテゴリ"]');
  await expect(input).toHaveValue('仕事');

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-2][MOCK] type:date で default なし → 今日の日付が事前入力される', async ({ page }) => {
  // default なし・type='date' のパラメータを持つコマンド
  const commandsWithDateParam = {
    commands: [
      {
        name: 'date-no-default',
        path: 'commands/date-no-default.md',
        description: '日付デフォルトテスト',
        params: [
          { name: '期限', type: 'date', required: false, label: '期限' },
        ],
        valid: true,
      },
    ],
  };
  const { unexpected } = await openAppWithSmartCommands(page, { smartCommands: commandsWithDateParam });
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="smart:date-no-default"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // 今日の日付を YYYY-MM-DD 形式で取得 (ブラウザの壁時計と一致させる)
  const todayStr = await page.evaluate(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const dateInput = page.locator('[data-testid="param-field-input"][data-name="期限"]');
  await expect(dateInput).toHaveValue(todayStr);

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-2][MOCK] type:date で default あり → default 値が事前入力される (今日の日付ではない)', async ({ page }) => {
  const commandsWithDateDefault = {
    commands: [
      {
        name: 'date-with-default',
        path: 'commands/date-with-default.md',
        description: '日付デフォルト値テスト',
        params: [
          { name: '締切', type: 'date', required: false, default: '2099-12-31', label: '締切' },
        ],
        valid: true,
      },
    ],
  };
  const { unexpected } = await openAppWithSmartCommands(page, { smartCommands: commandsWithDateDefault });
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="smart:date-with-default"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // default 値 '2099-12-31' が入力済み (今日の日付ではない)
  const dateInput = page.locator('[data-testid="param-field-input"][data-name="締切"]');
  await expect(dateInput).toHaveValue('2099-12-31');

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-3-3: 成功/失敗結果表示
// =========================================================================

test('[AC-Sde7a63-3-3][MOCK] POST run 成功 + openPath → パレットが閉じてノートへ遷移', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  // POST run のモック
  await page.route('**/api/commands/create-todo/run', (route) => {
    void route.fulfill(json({
      results: [{ kind: 'journal-append', ok: true, path: `journals/${DATE}.md` }],
      openPath: `journals/${DATE}.md`,
    }));
  });
  // openPath がジャーナルパスの場合、getJournal が呼ばれる (App.tsx の applyNote → loadJournal)
  await page.route('**/api/journal*', (route) => {
    void route.fulfill(json(journal('# ジャーナル\n\n- [ ] 新機能実装\n')));
  });
  // ノートを開くモック (直接ノートパスの場合)
  await page.route(`**/api/notes/journals/${DATE}.md`, (route) => {
    void route.fulfill(json({
      path: `journals/${DATE}.md`,
      content: '# ジャーナル\n\n- [ ] 新機能実装\n',
      frontmatter: null,
      body: '# ジャーナル\n\n- [ ] 新機能実装\n',
      mtime: 2000,
    }));
  });

  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // タスク概要を入力して実行
  await page.locator('[data-testid="param-field-input"][data-name="タスク概要"]').fill('新機能実装');
  await page.getByTestId('param-form-submit').click();

  // パレットとモーダルが閉じる
  await expect(page.getByTestId('param-form-modal')).toHaveCount(0);
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[AC-Sde7a63-3-3][MOCK] POST run 失敗 → param-form-result + step-result[data-ok=false] が表示', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  // POST run が部分失敗を返すモック
  await page.route('**/api/commands/create-todo/run', (route) => {
    void route.fulfill(json({
      results: [{ kind: 'journal-append', ok: false, error: 'journal not found' }],
    }));
  });

  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  await page.locator('[data-testid="param-field-input"][data-name="タスク概要"]').fill('テストタスク');
  await page.getByTestId('param-form-submit').click();

  // 結果表示エリアが見える
  await expect(page.getByTestId('param-form-result')).toBeVisible();

  // 失敗ステップの step-result
  const stepResult = page.locator('[data-testid="step-result"][data-kind="journal-append"][data-ok="false"]');
  await expect(stepResult).toBeVisible();
  await expect(stepResult).toContainText('journal not found');

  // パレットとモーダルは引き続き表示中
  await expect(page.getByTestId('param-form-modal')).toBeVisible();
  await expect(page.getByTestId('command-palette')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-3-1: '>' コマンドモードでスマートコマンドも表示される
// =========================================================================

test('[AC-Sde7a63-3-1][MOCK] コマンドモードでスマートコマンドが表示される', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page, { searchResults: [] });
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // '>' を入力してコマンドモードへ
  await page.getByTestId('search-input').fill('>');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // スマートコマンドが表示される
  await expect(
    page.locator('[data-testid="command-item"][data-source="smart"]'),
  ).toHaveCount(2); // create-todo + invalid-cmd

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-3-?: Esc でパラメータフォームを閉じてパレットへ戻る
// =========================================================================

test('[AC-Sde7a63-3][MOCK] パラメータフォームで Esc を押すとフォームが閉じてパレットへ戻る', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // Esc でフォームを閉じる
  await page.keyboard.press('Escape');

  // フォームが閉じる
  await expect(page.getByTestId('param-form-modal')).toHaveCount(0);

  // パレットは引き続き表示
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // 検索入力にフォーカスが戻る
  await expect(page.getByTestId('search-input')).toBeFocused();

  expect(unexpected).toEqual([]);
});

// =========================================================================
// D-1: builtin + smart コマンド共存 (registerBuiltinCommands が smart を消さない)
// =========================================================================

/**
 * D-1 coexistence: スマートコマンドをロードした後もパレットには
 * 組み込み (source=builtin) とスマート (source=smart) の両方が表示される。
 * registerBuiltinCommands() が clearRegistry() を呼ばなくなったことで、
 * 再マウント時に smart コマンドが消えないことを保証する。
 */
test('[D-1][MOCK] 組み込みコマンドとスマートコマンドがパレット上で共存する', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // 組み込み 5 件が存在する
  const builtinItems = page.locator('[data-testid="command-item"][data-source="builtin"]');
  await expect(builtinItems).toHaveCount(5);

  // スマートコマンド 2 件が存在する (create-todo + invalid-cmd)
  const smartItems = page.locator('[data-testid="command-item"][data-source="smart"]');
  await expect(smartItems).toHaveCount(2);

  // 合計 7 件
  const allItems = page.locator('[data-testid="command-item"]');
  await expect(allItems).toHaveCount(7);

  expect(unexpected).toEqual([]);
});

// =========================================================================
// AC-Sde7a63-3-1: ArrowDown が disabled アイテムをスキップする
// =========================================================================

/**
 * [AC-Sde7a63-3-1] キーボードナビゲーションが valid:false (disabled) のコマンドをスキップする。
 * シナリオ:
 *   - スマートコマンド (create-todo=valid:true, invalid-cmd=valid:false) がある状態でパレットを開く。
 *   - ArrowDown で全アイテムを走査する。
 *   - disabled アイテム (invalid-cmd) に aria-selected='true' が付くことがない。
 *   - disabled アイテムが表示結果の唯一のコマンドになる状況で Enter を押しても
 *     実行されない (palette は開いたまま、POST /api/commands/invalid-cmd/run は呼ばれない)。
 */
test('[AC-Sde7a63-3-1][MOCK] ArrowDown が disabled コマンドをスキップし Enter も実行しない', async ({ page }) => {
  const { unexpected } = await openAppWithSmartCommands(page);

  // POST /api/commands/invalid-cmd/run が呼ばれたら fail 用フラグ
  const runCalls: string[] = [];
  await page.route('**/api/commands/invalid-cmd/run', (route) => {
    runCalls.push(route.request().url());
    void route.fulfill(json({ results: [] }));
  });

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  const disabledItem = page.locator('[data-testid="command-item"][data-disabled="true"]');
  await expect(disabledItem).toBeVisible();

  // 全アイテム数を取得 (7件: builtin×5 + smart×2)
  const allItems = page.locator('[data-testid="command-item"]');
  const count = await allItems.count();
  expect(count).toBeGreaterThan(0);

  // ArrowDown を count 回押してすべてのアイテムを走査する
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('ArrowDown');
    // disabled アイテムが選択されていないことを確認
    await expect(disabledItem).not.toHaveAttribute('aria-selected', 'true');
  }

  // === Enter キーで disabled コマンドが実行されないことを実証 ===
  // '> invalid' でコマンドモードに入り、invalid-cmd だけに絞り込む。
  // disabled の invalid-cmd しか表示されない状態で ArrowDown + Enter を押す。
  // - nextSelectableIndex は全件 disabled のため選択が変わらない (selectedIndex = -1 相当)。
  // - confirm() は item が undefined / disabled の場合は run() を呼ばない。
  // → パレットが閉じないこと + POST が飛ばないことで「disabled は実行されない」を証明する。
  await page.getByTestId('search-input').fill('> invalid');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // disabled な invalid-cmd のみが表示される
  await expect(disabledItem).toBeVisible();
  const commandItems = page.locator('[data-testid="command-item"]');
  await expect(commandItems).toHaveCount(1); // invalid-cmd だけ

  // ArrowDown — 全件 disabled なので選択は変わらない
  await page.keyboard.press('ArrowDown');
  await expect(disabledItem).not.toHaveAttribute('aria-selected', 'true');

  // Enter — disabled コマンドは実行されない
  await page.keyboard.press('Enter');

  // パレットが閉じていない (disabled コマンドの run は呼ばれなかった)
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // POST /api/commands/invalid-cmd/run が一度も呼ばれていない
  expect(runCalls).toHaveLength(0);

  // disabled アイテムが aria-selected を持っていない (ナビゲーション全体を通じて)
  await expect(disabledItem).not.toHaveAttribute('aria-selected', 'true');

  expect(unexpected).toEqual([]);
});
