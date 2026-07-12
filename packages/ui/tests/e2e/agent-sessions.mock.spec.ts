/**
 * [sessionmgmt] エージェントセッション管理 mock テスト。
 *
 * - (a) "+" は POST /api/agent/sessions を呼ばず空状態になる。繰り返しても空のまま。
 * - (b) 初回送信が POST /api/agent/sessions してから POST /messages を呼ぶ。
 * - (c) スイッチャーにセッション一覧が出て、行クリックでそのセッションの履歴が表示される。
 * - (d) 削除ボタンが DELETE を呼び、行が消える。削除したのが現セッションなら最新にフォールバック。
 * - (e) サイドバーを collapsed→expanded しても現セッション/メッセージが保持される (FIX-1 regression)。
 * - (f) [MF-2] 遅延セッション作成中に abort を押すとサーバーに abort が送られる。
 * - (g) [MF-1] 削除 DELETE が 5xx 失敗しても現セッションは変わらない。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const SESSION_A = 'ses-sm-a';
const SESSION_B = 'ses-sm-b';

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
 * エージェントを有効状態でブート。セッション一覧は opts.sessions で指定。
 * 各セッションの detail (メッセージ) は opts.details に id→messages のマップで渡す。
 */
async function bootAgent(
  page: Page,
  opts: {
    sessions?: Array<{ id: string; title: string | null; updatedAt: number }>;
    details?: Record<string, Array<{ role: 'user' | 'assistant'; content: string; tools: [] }>>;
  } = {},
): Promise<string[]> {
  const sessions = opts.sessions ?? [];
  const details = opts.details ?? {};
  const unexpected = await installCatchAll(page);

  await page.route('**/api/health', (route) =>
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: true, reason: null } }),
    ),
  );
  await page.route('**/api/notes', (route) => void route.fulfill(json({ notes: [] })));

  // sessions list — POST = create, GET = list
  await page.route('**/api/agent/sessions', (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      void route.fulfill(json({ id: SESSION_A }));
    } else {
      void route.fulfill(json({ sessions }));
    }
  });

  // session detail per id
  for (const [id, messages] of Object.entries(details)) {
    await page.route(`**/api/agent/sessions/${id}`, (route) =>
      void route.fulfill(json({ id, messages })),
    );
  }
  // fallback detail for ids not in details
  await page.route('**/api/agent/sessions/*', (route) => {
    const url = route.request().url();
    const id = url.split('/').pop() ?? '';
    const msgs = details[id] ?? [];
    void route.fulfill(json({ id, messages: msgs }));
  });

  return unexpected;
}

async function openAgentPane(page: Page): Promise<void> {
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('right-tab-agent').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();
}

// ---------------------------------------------------------------------------
// (a) "+" は POST せず空状態になる。繰り返してもべき等。
// ---------------------------------------------------------------------------
test('[MOCK-SM-a] "+" は POST /api/agent/sessions を呼ばず空状態になる', async ({ page }) => {
  const unexpected = await bootAgent(page, {
    sessions: [{ id: SESSION_A, title: '前回セッション', updatedAt: Date.now() }],
    details: {
      [SESSION_A]: [{ role: 'user', content: '前回の質問', tools: [] }],
    },
  });

  const createCalls: string[] = [];
  await page.route('**/api/agent/sessions', (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      createCalls.push('POST');
      void route.fulfill(json({ id: 'ses-new' }));
    } else {
      void route.fulfill(
        json({ sessions: [{ id: SESSION_A, title: '前回セッション', updatedAt: Date.now() }] }),
      );
    }
  });

  await openAgentPane(page);
  // 前回セッションが復元される
  await expect(page.getByTestId('agent-msg-user')).toContainText('前回の質問');

  // "+" クリック → 空状態に
  await page.getByTestId('agent-new-session').click();
  await expect(page.getByTestId('agent-msg-user')).toHaveCount(0);
  expect(createCalls).toHaveLength(0); // POST なし

  // もう一度 "+" → べき等 (空のまま、POST なし)
  await page.getByTestId('agent-new-session').click();
  await expect(page.getByTestId('agent-msg-user')).toHaveCount(0);
  expect(createCalls).toHaveLength(0);

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (b) 初回送信が POST create → POST messages の順で呼ぶ
// ---------------------------------------------------------------------------
test('[MOCK-SM-b] 初回送信が POST /api/agent/sessions してから POST /messages を呼ぶ', async ({
  page,
}) => {
  // セッション一覧は空 → 新規未送信状態でブート
  const unexpected = await bootAgent(page, { sessions: [] });

  const callOrder: string[] = [];
  await page.route('**/api/agent/sessions', (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      callOrder.push('CREATE');
      void route.fulfill(json({ id: SESSION_A }));
    } else {
      void route.fulfill(json({ sessions: [] }));
    }
  });
  await page.route(`**/api/agent/sessions/${SESSION_A}`, (route) =>
    void route.fulfill(json({ id: SESSION_A, messages: [] })),
  );
  await page.route(`**/api/agent/sessions/${SESSION_A}/messages`, (route) => {
    callOrder.push('MESSAGE');
    void route.fulfill(sse([{ type: 'text_delta', text: '応答です' }, { type: 'done' }]));
  });

  await openAgentPane(page);
  // 空状態 (ユーザーメッセージなし)
  await expect(page.getByTestId('agent-msg-user')).toHaveCount(0);

  await page.getByTestId('agent-input').fill('初めてのメッセージ');
  await page.getByTestId('agent-send').click();

  // 応答が表示される
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('応答です');

  // CREATE → MESSAGE の順
  expect(callOrder[0]).toBe('CREATE');
  expect(callOrder[1]).toBe('MESSAGE');

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (c) スイッチャーにセッション一覧、クリックで切替
// ---------------------------------------------------------------------------
test('[MOCK-SM-c] スイッチャーにセッション一覧が出てクリックで切替わる', async ({ page }) => {
  const unexpected = await bootAgent(page, {
    sessions: [
      { id: SESSION_A, title: 'セッションA', updatedAt: Date.now() - 3600_000 },
      { id: SESSION_B, title: 'セッションB', updatedAt: Date.now() - 7200_000 },
    ],
    details: {
      [SESSION_A]: [{ role: 'user', content: 'Aの質問', tools: [] }],
      [SESSION_B]: [{ role: 'user', content: 'Bの質問', tools: [] }],
    },
  });

  await page.route('**/api/agent/sessions', (route) => {
    if (route.request().method() === 'POST') {
      void route.fulfill(json({ id: 'ses-new' }));
    } else {
      void route.fulfill(
        json({
          sessions: [
            { id: SESSION_A, title: 'セッションA', updatedAt: Date.now() - 3600_000 },
            { id: SESSION_B, title: 'セッションB', updatedAt: Date.now() - 7200_000 },
          ],
        }),
      );
    }
  });

  await openAgentPane(page);
  // SESSION_A が最新なので復元される
  await expect(page.getByTestId('agent-msg-user')).toContainText('Aの質問');

  // スイッチャーを開く
  await page.getByTestId('agent-session-switcher').click();
  await expect(page.getByTestId('agent-session-list')).toBeVisible();

  // 一覧に両セッションが出ている
  const items = page.getByTestId('agent-session-item');
  await expect(items).toHaveCount(2);

  // SESSION_B をクリック → Bのメッセージに切替わる
  await page
    .getByTestId('agent-session-item')
    .filter({ hasText: 'セッションB' })
    .click();

  await expect(page.getByTestId('agent-msg-user')).toContainText('Bの質問');
  // ドロップダウンは閉じる
  await expect(page.getByTestId('agent-session-list')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (d) 削除ボタンが DELETE を呼び、行が消える。現セッション削除 → フォールバック
// ---------------------------------------------------------------------------
test('[MOCK-SM-d] 削除ボタンが DELETE を呼び行が消える; 現セッション削除は最新にフォールバック', async ({
  page,
}) => {
  let sessionsList = [
    { id: SESSION_A, title: 'セッションA', updatedAt: Date.now() - 1000 },
    { id: SESSION_B, title: 'セッションB', updatedAt: Date.now() - 5000 },
  ];

  const unexpected = await bootAgent(page, {
    sessions: sessionsList,
    details: {
      [SESSION_A]: [{ role: 'user', content: 'Aの質問', tools: [] }],
      [SESSION_B]: [{ role: 'user', content: 'Bの質問', tools: [] }],
    },
  });

  const deleteCalls: string[] = [];
  await page.route('**/api/agent/sessions', (route) => {
    if (route.request().method() === 'POST') {
      void route.fulfill(json({ id: 'ses-new' }));
    } else {
      void route.fulfill(json({ sessions: sessionsList }));
    }
  });
  await page.route(`**/api/agent/sessions/${SESSION_A}`, (route) => {
    if (route.request().method() === 'DELETE') {
      deleteCalls.push(SESSION_A);
      sessionsList = sessionsList.filter((s) => s.id !== SESSION_A);
      void route.fulfill(json({ ok: true }));
    } else {
      void route.fulfill(
        json({
          id: SESSION_A,
          messages: [{ role: 'user', content: 'Aの質問', tools: [] }],
        }),
      );
    }
  });
  await page.route(`**/api/agent/sessions/${SESSION_B}`, (route) =>
    void route.fulfill(
      json({ id: SESSION_B, messages: [{ role: 'user', content: 'Bの質問', tools: [] }] }),
    ),
  );

  await openAgentPane(page);
  await expect(page.getByTestId('agent-msg-user')).toContainText('Aの質問');

  // スイッチャーを開く
  await page.getByTestId('agent-session-switcher').click();
  await expect(page.getByTestId('agent-session-list')).toBeVisible();

  // SESSION_A の削除ボタンをクリック
  const itemA = page.getByTestId('agent-session-item').filter({ hasText: 'セッションA' });
  await itemA.hover(); // ボタンを visible にする
  await itemA.getByTestId('agent-session-delete').click();

  // DELETE が呼ばれた
  expect(deleteCalls).toContain(SESSION_A);

  // 現セッションが削除されたので最新 (SESSION_B) にフォールバック
  await expect(page.getByTestId('agent-msg-user')).toContainText('Bの質問');

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (e) サイドバー collapsed→expanded でセッション/メッセージが保持される (FIX-1)
// ---------------------------------------------------------------------------
test('[MOCK-SM-e] collapsed→expanded でセッション状態が保持される (FIX-1)', async ({ page }) => {
  const unexpected = await bootAgent(page, {
    sessions: [{ id: SESSION_A, title: 'テストセッション', updatedAt: Date.now() }],
    details: {
      [SESSION_A]: [{ role: 'user', content: 'テストメッセージ', tools: [] }],
    },
  });

  const createCalls: string[] = [];
  await page.route('**/api/agent/sessions', (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      createCalls.push('POST');
      void route.fulfill(json({ id: 'ses-extra' }));
    } else {
      void route.fulfill(
        json({ sessions: [{ id: SESSION_A, title: 'テストセッション', updatedAt: Date.now() }] }),
      );
    }
  });

  await openAgentPane(page);
  await expect(page.getByTestId('agent-msg-user')).toContainText('テストメッセージ');

  // サイドバーを collapse
  await page.getByTestId('right-sidebar-toggle').click();
  // AgentPane は DOM に残るが非表示になる
  await expect(page.getByTestId('agent-pane')).toBeHidden();

  // 再展開
  await page.getByTestId('right-sidebar-toggle').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();

  // メッセージが保持されている (再初期化されていない)
  await expect(page.getByTestId('agent-msg-user')).toContainText('テストメッセージ');

  // 再初期化による新規セッション作成は呼ばれていない
  expect(createCalls).toHaveLength(0);

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (f) [MF-2] 遅延セッション作成後に abort → サーバーへ abort POST が送られる
// ---------------------------------------------------------------------------
test('[MOCK-SM-f] lazy 送信後に abort するとサーバーに abort POST が送られる (MF-2)', async ({
  page,
}) => {
  // セッション一覧は空 → 新規未送信状態でブート
  const unexpected = await bootAgent(page, { sessions: [] });

  const abortCalls: string[] = [];

  // sessions create: すぐに返す
  await page.route('**/api/agent/sessions', (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      void route.fulfill(json({ id: SESSION_A }));
    } else {
      void route.fulfill(json({ sessions: [] }));
    }
  });
  await page.route(`**/api/agent/sessions/${SESSION_A}`, (route) =>
    void route.fulfill(json({ id: SESSION_A, messages: [] })),
  );

  // messages endpoint: route を fulfill しない → fetch がずっとペンディングのまま
  // → status=streaming が維持され abort ボタンが出る
  let messagesRouteHit = false;
  await page.route(`**/api/agent/sessions/${SESSION_A}/messages`, (_route) => {
    messagesRouteHit = true;
    // intentionally never fulfill — keeps the fetch pending so status stays 'streaming'
  });

  // abort endpoint
  await page.route(`**/api/agent/sessions/${SESSION_A}/abort`, (route) => {
    abortCalls.push(SESSION_A);
    void route.fulfill(json({ ok: true }));
  });

  await openAgentPane(page);

  await page.getByTestId('agent-input').fill('テストメッセージ');
  await page.getByTestId('agent-send').click();

  // messages fetch が開始されたことを確認 (= session 作成が完了し activeSendSessionIdRef が設定済み)
  await expect.poll(() => messagesRouteHit, { timeout: 5000 }).toBe(true);

  // この時点で status=streaming, activeSendSessionIdRef.current=SESSION_A
  await expect(page.getByTestId('agent-abort')).toBeVisible({ timeout: 5000 });

  // abort ボタンをクリック
  await page.getByTestId('agent-abort').click();

  // サーバーに abort が送られた (activeSendSessionIdRef 経由)
  await expect.poll(() => abortCalls, { timeout: 5000 }).toContain(SESSION_A);

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (g) [MF-1] 削除 DELETE が 5xx 失敗しても現セッションは変わらない
// ---------------------------------------------------------------------------
test('[MOCK-SM-g] DELETE 失敗時は現セッションが変わらない (MF-1)', async ({ page }) => {
  const sessionsList = [
    { id: SESSION_A, title: 'セッションA', updatedAt: Date.now() - 1000 },
    { id: SESSION_B, title: 'セッションB', updatedAt: Date.now() - 5000 },
  ];

  const unexpected = await bootAgent(page, {
    sessions: sessionsList,
    details: {
      [SESSION_A]: [{ role: 'user', content: 'Aの質問', tools: [] }],
      [SESSION_B]: [{ role: 'user', content: 'Bの質問', tools: [] }],
    },
  });

  await page.route('**/api/agent/sessions', (route) => {
    if (route.request().method() === 'POST') {
      void route.fulfill(json({ id: 'ses-new' }));
    } else {
      void route.fulfill(json({ sessions: sessionsList }));
    }
  });

  // SESSION_A の DELETE は 500 を返す (失敗)
  await page.route(`**/api/agent/sessions/${SESSION_A}`, (route) => {
    if (route.request().method() === 'DELETE') {
      void route.fulfill(json({ error: 'internal server error' }, 500));
    } else {
      void route.fulfill(
        json({ id: SESSION_A, messages: [{ role: 'user', content: 'Aの質問', tools: [] }] }),
      );
    }
  });
  await page.route(`**/api/agent/sessions/${SESSION_B}`, (route) =>
    void route.fulfill(
      json({ id: SESSION_B, messages: [{ role: 'user', content: 'Bの質問', tools: [] }] }),
    ),
  );

  await openAgentPane(page);
  // SESSION_A が最新なので復元される
  await expect(page.getByTestId('agent-msg-user')).toContainText('Aの質問');

  // スイッチャーを開く
  await page.getByTestId('agent-session-switcher').click();
  await expect(page.getByTestId('agent-session-list')).toBeVisible();

  // SESSION_A (現セッション) の削除ボタンをクリック → DELETE が失敗する
  const itemA = page.getByTestId('agent-session-item').filter({ hasText: 'セッションA' });
  await itemA.hover();
  await itemA.getByTestId('agent-session-delete').click();

  // 削除失敗: 現セッション (Aの質問) が依然として表示されるか、エラーバブルが出る
  // いずれにせよ Bの質問 に切替わってはいけない
  await expect(page.getByTestId('agent-msg-user').first()).not.toContainText('Bの質問');
  // Aのメッセージはまだ表示されている
  await expect(page.getByTestId('agent-msg-user').first()).toContainText('Aの質問');

  expect(unexpected).toEqual([]);
});
