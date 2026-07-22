/**
 * Story S6fbf45-1 mock テスト ([[リンク]] オートコンプリートのエッジ・エラーケース)。
 * page.route で全 /api/* をモックする (gui-spec-S6fbf45-1.json 参照)。
 * 受け入れ条件の本検証は wikilink.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

const NOTES = [
  { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
  { path: 'CodeMirror 6 調査.md', title: 'CodeMirror 6 調査', tags: [], folder: '' },
  { path: 'reading/読書ノート - プログラマー脳.md', title: '読書ノート - プログラマー脳', tags: [], folder: 'reading' },
  { path: 'reading/読書ノート - A Philosophy of Software Design.md', title: '読書ノート - A Philosophy of Software Design', tags: [], folder: 'reading' },
];

function journal(content: string, mtime = 1000): Record<string, unknown> {
  return { date: DATE, path: JOURNAL_PATH, content, frontmatter: null, body: content, created: false, mtime };
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

interface OpenOptions {
  notes?: typeof NOTES;
  failNotesList?: boolean;
}

async function openApp(page: Page, content: string, waitText: string, opts: OpenOptions = {}): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    if (opts.failNotesList === true) {
      void route.fulfill(json({ error: 'internal_error', message: 'index unavailable' }, 500));
      return;
    }
    void route.fulfill(json({ notes: opts.notes ?? NOTES }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(content)));
  });
  // 自動保存の PUT (ジャーナル本文編集分)
  await page.route(`**/api/notes/journals/**`, (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fulfill(json(journal(content)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText(waitText);
  return unexpected;
}

test('[MOCK] [[ 入力で候補が開き、部分一致で絞り込まれ、選択で [[ノート名]] が挿入される', async ({ page }) => {
  const unexpected = await openApp(page, 'メモ: \n\nアンカー行。\n', 'アンカー行');

  await editorLine(page, 'メモ:').click();
  await page.keyboard.press('End');
  await page.keyboard.type('[[');
  const pop = page.getByTestId('wikilink-autocomplete');
  await expect(pop).toBeVisible();
  // 全ノートが候補に出る (クエリなし)
  await expect(page.getByTestId('wikilink-autocomplete-option')).toHaveCount(NOTES.length);

  // 部分一致絞り込み ("読書" → 2 件) + 一致部分の mark ハイライト
  await page.keyboard.type('読書');
  await expect(page.getByTestId('wikilink-autocomplete-option')).toHaveCount(2);
  await expect(pop.locator('mark').first()).toHaveText('読書');
  // 「新規ノートを作成してリンク」も併記される
  await expect(page.getByTestId('wikilink-autocomplete-create')).toBeVisible();

  // さらに絞る → 1 件
  await page.keyboard.type('ノート - プ');
  await expect(page.getByTestId('wikilink-autocomplete-option')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="wikilink-autocomplete-option"][data-note="reading/読書ノート - プログラマー脳.md"]'),
  ).toBeVisible();

  // Enter で挿入 (basename 一意 → 最短表記)
  await page.keyboard.press('Enter');
  await expect(pop).toHaveCount(0);
  await expect(editorLine(page, 'メモ:')).toContainText('[[読書ノート - プログラマー脳]]');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 一致ゼロのクエリでは「新規ノートを作成してリンク」だけが出て、選択で作成 PUT が飛ぶ', async ({ page }) => {
  const unexpected = await openApp(page, '書き出し: \n\nアンカー行。\n', 'アンカー行');
  const created: string[] = [];
  await page.route('**/api/notes/%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84%E6%A1%88.md', (route) => {
    created.push(route.request().method());
    void route.fulfill(json({ path: '存在しない案.md', created: true, mtime: 3000 }, 201));
  });

  await editorLine(page, '書き出し:').click();
  await page.keyboard.press('End');
  await page.keyboard.type('[[存在しない案');
  await expect(page.getByTestId('wikilink-autocomplete')).toBeVisible();
  await expect(page.getByTestId('wikilink-autocomplete-option')).toHaveCount(0);
  const create = page.getByTestId('wikilink-autocomplete-create');
  await expect(create).toBeVisible();
  await expect(create).toHaveAttribute('data-note', '存在しない案.md');

  // Enter によるキーボード選択はポップアップ出現直後のタイミング競合でフルスイート負荷下に
  // 稀に取りこぼす (backlog: wikilink.mock flaky。main でも ~2/10 で再現する既存フレーク)。
  // 隣接テスト (下記 app-error ケース) と同様、可視の create オプションを直接クリックして
  // 決定的に選択する (作成フローは Enter と同一)。アサーションは不変。
  await create.click();
  // リンクは挿入され、ノート作成 (create-only PUT) が呼ばれる。エディタは移動しない
  await expect(editorLine(page, '書き出し:')).toContainText('[[存在しない案]]');
  await expect.poll(() => created).toEqual(['PUT']);
  await expect(page.locator('.breadcrumb .current')).toHaveText(DATE);
  expect(unexpected).toEqual([]);
});

test('[MOCK] オートコンプリートからのノート作成が失敗したら app-error を表示する (本文は失われない)', async ({ page }) => {
  const unexpected = await openApp(page, '起点: \n\nアンカー行。\n', 'アンカー行');
  await page.route('**/api/notes/**', (route) => {
    if (route.request().method() === 'PUT' && !route.request().url().includes('journals')) {
      void route.fulfill(json({ error: 'internal_error', message: 'disk full' }, 500));
      return;
    }
    void route.fallback();
  });

  await editorLine(page, '起点:').click();
  await page.keyboard.press('End');
  await page.keyboard.type('[[新ノート');
  const createOption = page.getByTestId('wikilink-autocomplete-create');
  await expect(createOption).toBeVisible();
  // Enter によるキーボード選択はポップアップ出現直後のタイミング競合でフルスイート負荷下に
  // 稀に取りこぼす (backlog: wikilink.mock flaky)。可視のオプションを直接クリックして
  // 決定的に選択する (作成フローは Enter と同一)。
  await createOption.click();

  await expect(page.getByTestId('app-error')).toBeVisible();
  await expect(page.getByTestId('app-error')).toContainText('作成できませんでした');
  // 挿入済みのリンクテキストはそのまま残る
  await expect(editorLine(page, '起点:')).toContainText('[[新ノート]]');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 壊れリンクのクリックで作成 PUT が失敗したら app-error を出し、ノートは移動しない', async ({ page }) => {
  const content = '本文に [[未作成ノート]] がある。\n\nアンカー行。\n';
  const unexpected = await openApp(page, content, 'アンカー行');
  await page.route('**/api/notes/%E6%9C%AA%E4%BD%9C%E6%88%90%E3%83%8E%E3%83%BC%E3%83%88.md', (route) => {
    void route.fulfill(json({ error: 'internal_error', message: 'disk full' }, 500));
  });

  await editorLine(page, 'アンカー行').click();
  const broken = page.getByTestId('wikilink-broken');
  await expect(broken).toBeVisible();
  await expect(broken).toHaveAttribute('data-target', '未作成ノート.md');
  await broken.click();

  await expect(page.getByTestId('app-error')).toBeVisible();
  await expect(page.locator('.breadcrumb .current')).toHaveText(DATE);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 同名 basename は浅いパス優先で解決される (曖昧リンクの決定的解決)', async ({ page }) => {
  const notes = [
    { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
    { path: 'メモ.md', title: 'メモ', tags: [], folder: '' },
    { path: 'dup/メモ.md', title: 'メモ', tags: [], folder: 'dup' },
  ];
  const unexpected = await openApp(page, '参照 [[メモ]] と [[dup/メモ]]。\n\nアンカー行。\n', 'アンカー行', { notes });

  await editorLine(page, 'アンカー行').click();
  // basename 一致はルート直下 (浅いパス) に解決され、壊れリンクではない
  await expect(page.locator('[data-testid="wikilink"][data-target="メモ.md"]')).toBeVisible();
  // フルパス指定は dup/メモ.md に解決される
  await expect(page.locator('[data-testid="wikilink"][data-target="dup/メモ.md"]')).toBeVisible();
  await expect(page.getByTestId('wikilink-broken')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] ノート一覧の取得失敗時はリンクを壊れ扱いにしない (誤った赤表示を出さない)', async ({ page }) => {
  const unexpected = await openApp(page, '参照 [[どこかのノート]]。\n\nアンカー行。\n', 'アンカー行', {
    failNotesList: true,
  });

  await expect(page.getByTestId('tree-error')).toBeVisible();
  await editorLine(page, 'アンカー行').click();
  // 一覧が無い間は解決不能 → 壊れリンク表示はしない (安全側)
  await expect(page.locator('[data-testid="wikilink"][data-target="どこかのノート.md"]')).toBeVisible();
  await expect(page.getByTestId('wikilink-broken')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] コードフェンス・インラインコード内の [[リンク]] は装飾されない (クリック対象にならない)', async ({ page }) => {
  const content = ['```', '[[CodeMirror 6 調査]]', '```', '', 'インライン `[[CodeMirror 6 調査]]` はコード。', '', 'アンカー行。', ''].join('\n');
  const unexpected = await openApp(page, content, 'アンカー行');

  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('wikilink')).toHaveCount(0);
  await expect(page.getByTestId('wikilink-broken')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 非 wiki 埋め込みの [[image.png]] (! 無し) は壊れリンク扱い (ノートとして未解決)', async ({ page }) => {
  // ! を伴わない裸の [[image.png]] は埋め込みではなく通常 wikilink。
  // 拡張子付き = 非 Markdown ターゲットで未解決なので壊れ表示 (クリックで作成しない)。
  const unexpected = await openApp(page, '添付 [[image.png]] を参照。\n\nアンカー行。\n', 'アンカー行');

  await editorLine(page, 'アンカー行').click();
  const broken = page.getByTestId('wikilink-broken');
  await expect(broken).toBeVisible();
  await broken.click();

  // PUT は飛ばず (installCatchAll が検出しない)、app-error で明示する
  await expect(page.getByTestId('app-error')).toBeVisible();
  await expect(page.getByTestId('app-error')).toContainText('作成できません');
  await expect(page.locator('.breadcrumb .current')).toHaveText(DATE);
  expect(unexpected).toEqual([]);
});
