/**
 * Story Sfa11c0: エージェントメッセージ編集 mock テスト。
 *
 * 受け入れ基準:
 *   AC-1: ユーザーメッセージにホバーで編集ボタンが表示され、編集して再送信すると
 *         それ以降の会話が破棄され、編集後メッセージから再生成が始まる。
 *   AC-2: truncate エンドポイントが呼ばれた後に messages エンドポイントへ送信される。
 *   AC-3: ストリーミング中は編集ボタンが表示されない。
 *   AC-4: Esc でキャンセル、またはキャンセルボタンで編集を中止できる。
 *
 * page.route で /api/* をモックする。
 * SSE: data: {type:'text_delta'|'done'} の最小イベントシーケンス。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const SESSION_ID = 'ses-edit-mock-1';

function sseBody(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

function sse(events: Array<Record<string, unknown>>): {
  status: number;
  contentType: string;
  body: string;
} {
  return { status: 200, contentType: 'text/event-stream', body: sseBody(events) };
}

/**
 * エージェントペインをセットアップする。
 * 初期メッセージを持つセッションを復元する。
 */
async function bootAgentWithHistory(
  page: Page,
  initialMessages: Array<{ role: string; content: string; tools: unknown[] }>,
): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) =>
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: true, reason: null } }),
    ),
  );
  await page.route('**/api/notes', (route) => void route.fulfill(json({ notes: [] })));
  await page.route('**/api/agent/sessions', (route) => {
    if (route.request().method() === 'POST') {
      void route.fulfill(json({ id: SESSION_ID }));
    } else {
      void route.fulfill(json({ sessions: [{ id: SESSION_ID, title: 'テスト', updatedAt: Date.now() }] }));
    }
  });
  await page.route(`**/api/agent/sessions/${SESSION_ID}`, (route) =>
    void route.fulfill(json({ id: SESSION_ID, messages: initialMessages })),
  );
  return unexpected;
}

async function openAgentPane(page: Page): Promise<void> {
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('right-tab-agent').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();
}

// ---- テスト ------------------------------------------------------------------

test('[MOCK] ユーザーメッセージにホバーで編集ボタンが表示される', async ({ page }) => {
  const unexpected = await bootAgentWithHistory(page, [
    { role: 'user', content: '最初の質問', tools: [] },
    { role: 'assistant', content: '最初の回答', tools: [] },
  ]);

  await openAgentPane(page);

  // ユーザーメッセージが表示されていることを確認
  await expect(page.getByTestId('agent-msg-user').first()).toContainText('最初の質問');

  // ラッパーにホバーすることで編集ボタンが可視化される
  const wrap = page.getByTestId('agent-msg-user-wrap').first();
  await wrap.hover();

  // 編集ボタンが存在する (hover で opacity が 1 になる)
  const editBtn = page.getByTestId('agent-msg-edit-btn').first();
  await expect(editBtn).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[MOCK] 編集ボタンを押すと入力欄に元のテキストが入り、編集バナーが表示される', async ({
  page,
}) => {
  const unexpected = await bootAgentWithHistory(page, [
    { role: 'user', content: '元のメッセージ', tools: [] },
    { role: 'assistant', content: '元の回答', tools: [] },
  ]);

  await openAgentPane(page);
  await expect(page.getByTestId('agent-msg-user').first()).toContainText('元のメッセージ');

  const wrap = page.getByTestId('agent-msg-user-wrap').first();
  await wrap.hover();
  await page.getByTestId('agent-msg-edit-btn').first().click();

  // 入力欄に元のテキストが入っている
  await expect(page.getByTestId('agent-input')).toHaveValue('元のメッセージ');

  // 編集バナーが表示される
  await expect(page.getByTestId('agent-edit-banner')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[MOCK] 編集後に再送信すると truncate → messages の順に呼ばれ、以降の履歴が消える', async ({
  page,
}) => {
  const unexpected = await bootAgentWithHistory(page, [
    { role: 'user', content: '最初の質問', tools: [] },
    { role: 'assistant', content: '最初の回答', tools: [] },
    { role: 'user', content: '2番目の質問', tools: [] },
    { role: 'assistant', content: '2番目の回答', tools: [] },
  ]);

  const calls: string[] = [];

  // truncate エンドポイントのモック
  await page.route(`**/api/agent/sessions/${SESSION_ID}/truncate`, (route) => {
    calls.push('truncate');
    void route.fulfill(json({ ok: true, remainingUserMessages: 0 }));
  });

  // messages (SSE) エンドポイントのモック
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) => {
    calls.push('messages');
    void route.fulfill(sse([
      { type: 'text_delta', text: '編集後の回答' },
      { type: 'done' },
    ]));
  });

  await openAgentPane(page);

  // 最初のユーザーメッセージを編集
  const wrap = page.getByTestId('agent-msg-user-wrap').first();
  await wrap.hover();
  await page.getByTestId('agent-msg-edit-btn').first().click();

  // テキストを変更して送信
  await page.getByTestId('agent-input').fill('編集後の質問');
  await page.getByTestId('agent-send').click();

  // truncate → messages の順に呼ばれた
  await expect.poll(() => calls).toEqual(['truncate', 'messages']);

  // アシスタントの回答が表示される
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('編集後の回答');

  expect(unexpected).toEqual([]);
});

test('[MOCK] キャンセルボタンで編集を中止できる', async ({ page }) => {
  const unexpected = await bootAgentWithHistory(page, [
    { role: 'user', content: 'キャンセルテスト', tools: [] },
    { role: 'assistant', content: '回答', tools: [] },
  ]);

  await openAgentPane(page);

  const wrap = page.getByTestId('agent-msg-user-wrap').first();
  await wrap.hover();
  await page.getByTestId('agent-msg-edit-btn').first().click();

  // 編集バナーが表示されている
  await expect(page.getByTestId('agent-edit-banner')).toBeVisible();

  // キャンセルボタンをクリック
  await page.getByTestId('agent-edit-cancel').click();

  // 編集バナーが消える
  await expect(page.getByTestId('agent-edit-banner')).toHaveCount(0);

  // 入力欄がクリアされる
  await expect(page.getByTestId('agent-input')).toHaveValue('');

  expect(unexpected).toEqual([]);
});

test('[MOCK] Esc キーで編集をキャンセルできる', async ({ page }) => {
  const unexpected = await bootAgentWithHistory(page, [
    { role: 'user', content: 'Escテスト', tools: [] },
    { role: 'assistant', content: '回答', tools: [] },
  ]);

  await openAgentPane(page);

  const wrap = page.getByTestId('agent-msg-user-wrap').first();
  await wrap.hover();
  await page.getByTestId('agent-msg-edit-btn').first().click();

  // 編集バナーが表示されている
  await expect(page.getByTestId('agent-edit-banner')).toBeVisible();

  // Esc で入力欄のキーダウンをトリガー
  await page.getByTestId('agent-input').press('Escape');

  // 編集バナーが消える
  await expect(page.getByTestId('agent-edit-banner')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[MOCK] ストリーミング中は編集ボタンが表示されない', async ({ page }) => {
  const unexpected = await bootAgentWithHistory(page, [
    { role: 'user', content: 'テスト', tools: [] },
    { role: 'assistant', content: '回答済み', tools: [] },
  ]);

  let releaseStream: (() => void) | null = null;
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, async (route) => {
    await new Promise<void>((resolve) => { releaseStream = resolve; });
    void route.fulfill(sse([{ type: 'text_delta', text: '応答' }, { type: 'done' }]));
  });
  await page.route(`**/api/agent/sessions/${SESSION_ID}/abort`, (route) => {
    releaseStream?.();
    void route.fulfill(json({ ok: true }));
  });

  await openAgentPane(page);

  // 新しいメッセージを送信してストリーミング中にする
  await page.getByTestId('agent-input').fill('新しい質問');
  await page.getByTestId('agent-send').click();

  // ストリーミング中は abort ボタンが表示される
  await expect(page.getByTestId('agent-abort')).toBeVisible();

  // 編集ボタンが表示されていない (isStreaming 時は !isStreaming で非表示)
  await expect(page.getByTestId('agent-msg-edit-btn')).toHaveCount(0);

  // クリーンアップ
  await page.getByTestId('agent-abort').click();

  expect(unexpected).toEqual([]);
});

test('[MOCK] 編集モードでEnterキーを押すとhandleEditSendが実行される', async ({ page }) => {
  const unexpected = await bootAgentWithHistory(page, [
    { role: 'user', content: 'Enter キーテスト', tools: [] },
    { role: 'assistant', content: '回答', tools: [] },
  ]);

  const calls: string[] = [];
  await page.route(`**/api/agent/sessions/${SESSION_ID}/truncate`, (route) => {
    calls.push('truncate');
    void route.fulfill(json({ ok: true, remainingUserMessages: 0 }));
  });
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) => {
    calls.push('messages');
    void route.fulfill(sse([{ type: 'text_delta', text: '再生成回答' }, { type: 'done' }]));
  });

  await openAgentPane(page);

  const wrap = page.getByTestId('agent-msg-user-wrap').first();
  await wrap.hover();
  await page.getByTestId('agent-msg-edit-btn').first().click();

  // テキストを編集してEnterで送信
  await page.getByTestId('agent-input').fill('編集テキスト');
  await page.getByTestId('agent-input').press('Enter');

  await expect.poll(() => calls).toEqual(['truncate', 'messages']);
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('再生成回答');

  expect(unexpected).toEqual([]);
});
