/**
 * Story S53409d-2 mock テスト (エージェントチャット: 未設定/送信/中断/エラー/新規セッション)。
 * page.route で全 /api/* をモックする (gui-spec-S53409d-2.json 参照)。
 * SSE イベント契約: data: {type:'text_delta'|'tool_start'|'tool_end'|'error'|'done', ...}
 * 受け入れ条件の本検証は agent-chat.e2e.spec.ts (実サーバー + スタブ LLM) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const SESSION_ID = 'ses-mock-1';

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

async function bootAgent(
  page: Page,
  opts: { enabled?: boolean; messages?: unknown[] } = {},
): Promise<string[]> {
  const enabled = opts.enabled ?? true;
  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) =>
    void route.fulfill(
      json({
        status: 'ok',
        mode: 'full',
        agent: { enabled, reason: enabled ? null : 'not_configured' },
      }),
    ),
  );
  await page.route('**/api/notes', (route) => void route.fulfill(json({ notes: [] })));
  await page.route('**/api/agent/sessions', (route) => {
    if (route.request().method() === 'POST') {
      void route.fulfill(json({ id: SESSION_ID }));
    } else {
      void route.fulfill(json({ sessions: [] }));
    }
  });
  await page.route(`**/api/agent/sessions/${SESSION_ID}`, (route) =>
    void route.fulfill(json({ id: SESSION_ID, messages: opts.messages ?? [] })),
  );
  return unexpected;
}

async function openAgentPane(page: Page): Promise<void> {
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('right-tab-agent').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();
}

test('[MOCK] 未設定時は設定ガイドを表示し、入力欄は出さない', async ({ page }) => {
  const unexpected = await bootAgent(page, { enabled: false });
  await openAgentPane(page);
  await expect(page.getByTestId('agent-setup-guide')).toBeVisible();
  await expect(page.getByTestId('agent-setup-guide')).toContainText('agent.json');
  await expect(page.getByTestId('agent-input')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 送信でユーザー発言が表示され、SSE の text_delta が応答として描画される', async ({
  page,
}) => {
  const unexpected = await bootAgent(page);
  const captured: { value: { content?: string } | null } = { value: null };
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) => {
    captured.value = route.request().postDataJSON() as { content?: string };
    void route.fulfill(
      sse([
        { type: 'text_delta', text: 'vault には ' },
        { type: 'text_delta', text: '42 件のノートがあります。' },
        { type: 'done' },
      ]),
    );
  });
  await openAgentPane(page);
  await page.getByTestId('agent-input').fill('ノートは何件ある?');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-msg-user')).toContainText('ノートは何件ある?');
  await expect(page.getByTestId('agent-msg-assistant')).toContainText(
    'vault には 42 件のノートがあります。',
  );
  expect(captured.value?.content).toBe('ノートは何件ある?');
  expect(unexpected).toEqual([]);
});

test('[MOCK] reasoning_delta が「推論」折りたたみとして表示され、展開できる', async ({
  page,
}) => {
  const unexpected = await bootAgent(page);
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) => {
    void route.fulfill(
      sse([
        { type: 'reasoning_delta', text: 'まず要件を' },
        { type: 'reasoning_delta', text: '整理する。' },
        { type: 'text_delta', text: '承知しました。' },
        { type: 'done' },
      ]),
    );
  });
  await openAgentPane(page);
  await page.getByTestId('agent-input').fill('計画を立てて');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('承知しました。');
  // 折りたたみトグルが出る。既定は折りたたみ (本文が来たため body は非表示)。
  const toggle = page.getByTestId('agent-reasoning-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId('agent-reasoning-body')).toHaveCount(0);
  // 展開すると推論テキストが見える。
  await toggle.click();
  await expect(page.getByTestId('agent-reasoning-body')).toContainText('まず要件を整理する。');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 思考のみ(text なし)応答でも推論が表示され、空表示にならない', async ({
  page,
}) => {
  const unexpected = await bootAgent(page);
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) => {
    void route.fulfill(
      sse([
        { type: 'reasoning_delta', text: '了解の返信なので追加アクションは不要。' },
        { type: 'done' },
      ]),
    );
  });
  await openAgentPane(page);
  await page.getByTestId('agent-input').fill('わかりました。');
  await page.getByTestId('agent-send').click();
  // 本文が空でも推論トグルが出る = 「反応が無い(空表示)」誤解を防ぐ。
  const toggle = page.getByTestId('agent-reasoning-toggle');
  await expect(toggle).toBeVisible();
  // 空応答プレースホルダは出ない (推論があるため)。
  await expect(page.getByTestId('agent-msg-empty')).toHaveCount(0);
  // 既定は折りたたみ。展開すると推論テキストが読める。
  await toggle.click();
  await expect(page.getByTestId('agent-reasoning-body')).toContainText(
    '了解の返信なので追加アクションは不要。',
  );
  expect(unexpected).toEqual([]);
});

test('[MOCK] text も推論もツールも無い空応答はプレースホルダを表示する', async ({
  page,
}) => {
  const unexpected = await bootAgent(page);
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) => {
    void route.fulfill(sse([{ type: 'done' }]));
  });
  await openAgentPane(page);
  await page.getByTestId('agent-input').fill('...');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-msg-empty')).toContainText(
    'テキスト応答がありませんでした',
  );
  expect(unexpected).toEqual([]);
});

test('[MOCK] 入力が空のとき送信ボタンは無効', async ({ page }) => {
  const unexpected = await bootAgent(page);
  await openAgentPane(page);
  await expect(page.getByTestId('agent-send')).toBeDisabled();
  await page.getByTestId('agent-input').fill('x');
  await expect(page.getByTestId('agent-send')).toBeEnabled();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 応答中は中断ボタンに切替わり、中断で Ready に戻る (abort が呼ばれる)', async ({
  page,
}) => {
  const unexpected = await bootAgent(page);
  let releaseStream: (() => void) | null = null;
  const abortCalled: { value: boolean } = { value: false };
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, async (route) => {
    // 中断されるまでレスポンスを保留してストリーミング中状態を再現する
    await new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    void route.fulfill(sse([{ type: 'text_delta', text: '部分応答' }, { type: 'done' }]));
  });
  await page.route(`**/api/agent/sessions/${SESSION_ID}/abort`, (route) => {
    abortCalled.value = true;
    releaseStream?.();
    void route.fulfill(json({ ok: true }));
  });
  await openAgentPane(page);
  await page.getByTestId('agent-input').fill('長い処理をして');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-abort')).toBeVisible();
  await page.getByTestId('agent-abort').click();
  await expect(page.getByTestId('agent-abort')).toHaveCount(0);
  await expect(page.getByTestId('agent-send')).toBeVisible();
  expect(abortCalled.value).toBe(true);
  expect(unexpected).toEqual([]);
});

test('[MOCK] SSE の error イベントはエラーバブルとして表示され、再送信できる', async ({
  page,
}) => {
  const unexpected = await bootAgent(page);
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) =>
    void route.fulfill(sse([{ type: 'error', message: '認証に失敗しました (401)' }])),
  );
  await openAgentPane(page);
  await page.getByTestId('agent-input').fill('こんにちは');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-error')).toContainText('認証に失敗しました');
  await expect(page.getByTestId('agent-input')).toBeEnabled();
  await expect(page.getByTestId('agent-send')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] アシスタント本文が Markdown として整形描画される (見出し/太字/コード/[[リンク]])', async ({
  page,
}) => {
  const unexpected = await bootAgent(page);
  // notes に照合対象のノートを 1 本用意して [[リンク]] を解決させる
  await page.unroute('**/api/notes');
  await page.route('**/api/notes', (route) =>
    void route.fulfill(
      json({ notes: [{ path: 'design.md', title: 'design', tags: [], folder: '' }] }),
    ),
  );
  const md =
    '## 見出し\n\n**太字** と `inline` と [[design]] です。\n\n```\ncode [[notlink]]\n```';
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) =>
    void route.fulfill(sse([{ type: 'text_delta', text: md }, { type: 'done' }])),
  );
  await openAgentPane(page);
  await page.getByTestId('agent-input').fill('Markdown を返して');
  await page.getByTestId('agent-send').click();

  const assistant = page.getByTestId('agent-msg-assistant');
  // 見出しが <h2> に、太字が <strong>、インラインコードが <code> になる
  await expect(assistant.locator('h2')).toHaveText('見出し');
  await expect(assistant.locator('strong')).toHaveText('太字');
  await expect(assistant.locator('code').first()).toHaveText('inline');
  // フェンスコードブロックが <pre> になる
  await expect(assistant.locator('pre')).toBeVisible();
  // 非コード領域の [[design]] は解決されてクリック可能なリンク (a[data-wl-target]) になる。
  // (実クリックによるノート遷移は agent-tools.e2e の AC-S53409d-3-3 が実サーバーで検証する。)
  const link = page.getByTestId('agent-wikilink');
  await expect(link).toHaveText('design');
  await expect(link).toHaveAttribute('data-wl-target', 'design.md');
  await expect(link.locator('xpath=self::a')).toHaveCount(1);
  // コード領域内の [[notlink]] はリンク化されない (装飾しない)
  await expect(page.getByTestId('agent-wikilink')).toHaveCount(1);

  expect(unexpected).toEqual([]);
});

test('[MOCK] 新規セッション (+) で履歴がクリアされる (lazy: サーバーへの POST は不要)', async ({
  page,
}) => {
  // セッション一覧にセッションがある状態で起動 → 復元される
  const unexpected = await bootAgent(page, {
    messages: [{ role: 'user', content: '前回の質問', tools: [] }],
  });
  const created: { value: boolean } = { value: false };
  await page.route('**/api/agent/sessions', (route) => {
    if (route.request().method() === 'POST') {
      created.value = true;
      void route.fulfill(json({ id: 'ses-mock-2' }));
    } else {
      void route.fulfill(json({ sessions: [{ id: SESSION_ID, title: null, updatedAt: 1000 }] }));
    }
  });
  await openAgentPane(page);
  await expect(page.getByTestId('agent-msg-user')).toContainText('前回の質問');
  await page.getByTestId('agent-new-session').click();
  // 履歴がクリアされる
  await expect(page.getByTestId('agent-msg-user')).toHaveCount(0);
  // lazy new: "+" 単体では POST /api/agent/sessions を呼ばない
  expect(created.value).toBe(false);
  expect(unexpected).toEqual([]);
});

test('[sidebar-refresh][MOCK] エージェントのターン完了 (done) 後に GET /api/notes が再取得される', async ({
  page,
}) => {
  const unexpected = await bootAgent(page);

  // GET /api/notes の呼び出し回数を数える (bootAgent 登録より後 = 優先される)
  let notesCount = 0;
  await page.route('**/api/notes', (route) => {
    notesCount += 1;
    void route.fulfill(json({ notes: [] }));
  });
  // エージェントがツールでファイルを書き、done で完了する SSE
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) => {
    void route.fulfill(
      sse([
        { type: 'tool_start', name: 'create_note', argsSummary: 'inbox/新規.md' },
        { type: 'tool_end', name: 'create_note', ok: true },
        { type: 'text_delta', text: 'ノートを作成しました。' },
        { type: 'done' },
      ]),
    );
  });

  await openAgentPane(page);
  const before = notesCount;

  await page.getByTestId('agent-input').fill('ノートを作って');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('ノートを作成しました。');

  // done 受信後にノート一覧が再取得される (onNotesChanged 配線)
  await expect.poll(() => notesCount).toBeGreaterThan(before);

  expect(unexpected).toEqual([]);
});
