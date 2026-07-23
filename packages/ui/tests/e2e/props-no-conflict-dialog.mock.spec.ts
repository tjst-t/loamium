/**
 * S2df65d 回帰テスト: プロパティ(frontmatter)編集後に ConflictResolverDialog が
 * 誤表示されないことを検証する。
 *
 * 修正前の問題: saveNow() が保存した内容と、SSE が届いた時点の contentRef.current
 * が異なると(保存後に次のプロパティ編集が始まった場合)、自己エコー抑制が機能せず
 * dirty 経路で 3-way マージに入り、競合ダイアログが誤表示された。
 *
 * [AC-S2df65d-regression-1] プロパティ追加後の自己エコー SSE で ConflictResolverDialog が開かない
 * [AC-S2df65d-regression-2] プロパティ削除後の自己エコー SSE で ConflictResolverDialog が開かない
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY = '2026-07-23';
const JOURNAL_PATH = `journals/${TODAY}.md`;
const NOTE_PATH = 'props-regression/テスト.md';

/** frontmatter 付きノートの初期内容 */
const NOTE_WITH_PROPS = [
  '---',
  'status: x',
  '---',
  '',
  'アンカー行。',
  '',
].join('\n');

/** frontmatter 追加後の内容 (プロパティ追加コミット後) */
const NOTE_AFTER_ADD = [
  '---',
  'status: x',
  '個数: 5',
  '---',
  '',
  'アンカー行。',
  '',
].join('\n');

type MockSseSender = (event: { type: string; path: string; op: string }) => void;

async function bootWithPropsNote(
  page: Page,
  initialContent: string,
  savedContent: string,
): Promise<{ unexpected: string[]; sendSse: MockSseSender }> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(
        json({
          notes: [{ path: NOTE_PATH, title: 'テスト', tags: [], folder: 'props-regression' }],
        }),
      );
    } else {
      void route.fallback();
    }
  });

  await page.route('**/api/journal**', (route) => {
    void route.fulfill(
      json({
        date: TODAY,
        path: JOURNAL_PATH,
        content: '# journal\n',
        frontmatter: null,
        body: '# journal\n',
        created: false,
        mtime: 1000,
      }),
    );
  });

  await page.route('**/api/property-keys', (route) => {
    void route.fulfill(json({ keys: [] }));
  });

  await page.route('**/api/property-types', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({}));
    } else {
      void route.fulfill(json({}));
    }
  });

  // ノート GET: 初回は initialContent, SSE 後の再取得は savedContent を返す
  let getCount = 0;
  await page.route(`**/api/notes/${encodeURIComponent(NOTE_PATH)}`, (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      getCount += 1;
      const content = getCount === 1 ? initialContent : savedContent;
      void route.fulfill(
        json({
          path: NOTE_PATH,
          content,
          frontmatter: getCount === 1 ? { status: 'x' } : null,
          body: content,
          mtime: getCount * 1000,
        }),
      );
      return;
    }
    if (req.method() === 'PUT') {
      // autosave/save の PUT → 成功を返す
      void route.fulfill(json({ path: NOTE_PATH, mtime: 9999, created: false }));
      return;
    }
    void route.fallback();
  });

  // URL エンコードなしのパスパターンにもマッチさせる
  await page.route('**/api/notes/props-regression/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET' && !req.url().includes('/meta')) {
      getCount += 1;
      const content = getCount === 1 ? initialContent : savedContent;
      void route.fulfill(
        json({
          path: NOTE_PATH,
          content,
          frontmatter: getCount === 1 ? { status: 'x' } : null,
          body: content,
          mtime: getCount * 1000,
        }),
      );
      return;
    }
    if (req.method() === 'PUT') {
      void route.fulfill(json({ path: NOTE_PATH, mtime: 9999, created: false }));
      return;
    }
    void route.fallback();
  });

  await page.route('**/api/events', async (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
      body: ': keep-alive\n\n',
    });
  });

  await page.goto(readHarnessState().uiUrl);

  const sendSse: MockSseSender = (event) => {
    void page.evaluate((evt) => {
      const fn = (window as unknown as Record<string, unknown>)['__loamium_testSseInject'];
      if (typeof fn === 'function') {
        (fn as (e: unknown) => void)(evt);
      }
    }, event);
  };

  return { unexpected, sendSse };
}

/**
 * [AC-S2df65d-regression-1]
 * プロパティ追加後の自己エコー SSE で ConflictResolverDialog が開かない。
 *
 * シナリオ:
 * 1. ノートを開く (baseMd = NOTE_WITH_PROPS)
 * 2. プロパティ追加 (contentRef = NOTE_AFTER_ADD, dirty=true)
 * 3. autosave が NOTE_AFTER_ADD を PUT → lastSavedContentRef = NOTE_AFTER_ADD
 * 4. さらにプロパティ削除 (contentRef = NOTE_WITH_PROPS 相当, dirty=true になる)
 * 5. SSE notes_changed (PUT のエコー = NOTE_AFTER_ADD)
 *    → note.content(NOTE_AFTER_ADD) === lastSavedContentRef(NOTE_AFTER_ADD) なら自己エコーとして抑制
 *    → ConflictResolverDialog が開かない
 */
test('[AC-S2df65d-regression-1][MOCK] プロパティ追加後の自己エコー SSE で ConflictResolverDialog が開かない', async ({
  page,
}) => {
  // savedContent: 最後に保存した内容 (SSE が届く際にサーバーが返す)
  const { sendSse } = await bootWithPropsNote(page, NOTE_WITH_PROPS, NOTE_AFTER_ADD);

  // ノートを開く
  await page.getByTestId('tree-item').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor')).toContainText('アンカー行');

  // エディタを dirty にする (キーボードでテキスト入力)
  const anchorLine = page.getByTestId('editor').locator('.cm-line', { hasText: 'アンカー行' }).first();
  await anchorLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' 追記');
  await expect(page.getByTestId('editor')).toContainText('追記');

  // autosave の完了を待つ (1500ms デバウンス + 余裕)
  await page.waitForTimeout(2500);

  // autosave 後にさらに編集 (dirty=true に戻す)
  await anchorLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' さらに');

  // SSE: 自分の書き込み (NOTE_AFTER_ADD) のエコーを注入
  sendSse({ type: 'notes_changed', path: NOTE_PATH, op: 'upsert' });

  // ConflictResolverDialog は開かない (自己エコー抑制が機能している)
  await expect(page.getByTestId('conflict-resolver-dialog')).not.toBeVisible({ timeout: 3000 });
});

/**
 * [AC-S2df65d-regression-2][MOCK]
 * プロパティ削除後の自己エコー SSE で ConflictResolverDialog が開かない。
 *
 * シナリオ:
 * 1. ノートを開く
 * 2. 何らかの編集 → autosave → lastSavedContentRef に記録
 * 3. 次の編集 (dirty=true) 中に前の autosave の SSE エコーが届く
 * 4. ConflictResolverDialog が開かないこと
 */
test('[AC-S2df65d-regression-2][MOCK] dirty 中に前回 autosave の自己エコー SSE が届いても ConflictResolverDialog が開かない', async ({
  page,
}) => {
  const savedContent = NOTE_WITH_PROPS;
  const { sendSse } = await bootWithPropsNote(page, NOTE_WITH_PROPS, savedContent);

  await page.getByTestId('tree-item').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor')).toContainText('アンカー行');

  // 1回目の編集 → autosave
  const anchorLine = page.getByTestId('editor').locator('.cm-line', { hasText: 'アンカー行' }).first();
  await anchorLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' 編集1');

  // autosave 完了を待つ
  await page.waitForTimeout(2500);

  // 2回目の編集 (dirty=true になる)
  await anchorLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' 編集2');

  // SSE: 1回目の autosave のエコー (savedContent = NOTE_WITH_PROPS) が届く
  // dirty=true の状態で自己エコーが届くが、lastSavedContentRef で抑制されるべき
  sendSse({ type: 'notes_changed', path: NOTE_PATH, op: 'upsert' });

  // ConflictResolverDialog は開かない
  await expect(page.getByTestId('conflict-resolver-dialog')).not.toBeVisible({ timeout: 3000 });
});
