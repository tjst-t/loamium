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

test('[MOCK] 新規セッション開始で履歴がクリアされ POST /api/agent/sessions が呼ばれる', async ({
  page,
}) => {
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
  await expect(page.getByTestId('agent-msg-user')).toHaveCount(0);
  expect(created.value).toBe(true);
  expect(unexpected).toEqual([]);
});
