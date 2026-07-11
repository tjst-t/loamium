/**
 * Story S53409d-3 mock テスト (ツールチップ描画 / [[リンク]] 遷移 / 壊れリンク)。
 * page.route で全 /api/* をモックする (gui-spec-S53409d-3.json 参照)。
 * 「実行中スピナー」の時間的観測は agent-tools.e2e.spec.ts (遅延するスタブ LLM) が担う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const SESSION_ID = 'ses-mock-t1';
const NOTE_PATH = 'agent-mock/design.md';

function sse(events: Array<Record<string, unknown>>): {
  status: number;
  contentType: string;
  body: string;
} {
  return {
    status: 200,
    contentType: 'text/event-stream',
    body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
  };
}

async function bootAgent(page: Page, notes: Array<{ path: string; title: string }>): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) =>
    void route.fulfill(json({ status: 'ok', mode: 'full', agent: { enabled: true, reason: null } })),
  );
  await page.route('**/api/notes', (route) =>
    void route.fulfill(json({ notes: notes.map((n) => ({ ...n, tags: [], folder: n.path.split('/')[0] })) })),
  );
  await page.route('**/api/agent/sessions', (route) => {
    if (route.request().method() === 'POST') {
      void route.fulfill(json({ id: SESSION_ID }));
    } else {
      void route.fulfill(json({ sessions: [] }));
    }
  });
  await page.route(`**/api/agent/sessions/${SESSION_ID}`, (route) =>
    void route.fulfill(json({ id: SESSION_ID, messages: [] })),
  );
  return unexpected;
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('right-tab-agent').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();
  await page.getByTestId('agent-input').fill(prompt);
  await page.getByTestId('agent-send').click();
}

test('[MOCK] tool_start/tool_end がツール名+引数要約のチップとして描画される', async ({ page }) => {
  const unexpected = await bootAgent(page, [{ path: NOTE_PATH, title: 'design' }]);
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) =>
    void route.fulfill(
      sse([
        { type: 'tool_start', toolCallId: 't1', name: 'search', argsSummary: '"設計"' },
        { type: 'tool_end', toolCallId: 't1', name: 'search' },
        { type: 'text_delta', text: '設計関連は 1 件です。' },
        { type: 'done' },
      ]),
    ),
  );
  await sendPrompt(page, '設計のノートを探して');
  const chip = page.getByTestId('agent-tool-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('search');
  await expect(chip).toContainText('"設計"');
  // 完了済み: 実行中表示は残っていない
  await expect(page.getByTestId('agent-tool-chip-running')).toHaveCount(0);
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('設計関連は 1 件です。');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 連続ツール実行は個別チップで並ぶ', async ({ page }) => {
  const unexpected = await bootAgent(page, [{ path: NOTE_PATH, title: 'design' }]);
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) =>
    void route.fulfill(
      sse([
        { type: 'tool_start', toolCallId: 't1', name: 'search', argsSummary: '"設計"' },
        { type: 'tool_end', toolCallId: 't1', name: 'search' },
        { type: 'tool_start', toolCallId: 't2', name: 'read', argsSummary: NOTE_PATH },
        { type: 'tool_end', toolCallId: 't2', name: 'read' },
        { type: 'text_delta', text: '読みました。' },
        { type: 'done' },
      ]),
    ),
  );
  await sendPrompt(page, '設計ノートを読んで');
  await expect(page.getByTestId('agent-tool-chip')).toHaveCount(2);
  expect(unexpected).toEqual([]);
});

test('[MOCK] tool_end 未着のツールチップは実行中 (スピナー) 表示になる', async ({ page }) => {
  // 合成ストリーム: tool_start のみ受信した状態の描画を検証する
  // (実時間での実行中観測は agent-tools.e2e.spec.ts が担う)
  const unexpected = await bootAgent(page, []);
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) =>
    void route.fulfill(
      sse([{ type: 'tool_start', toolCallId: 't1', name: 'search', argsSummary: '"設計"' }]),
    ),
  );
  await sendPrompt(page, '検索して');
  await expect(page.getByTestId('agent-tool-chip-running')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 回答中の [[リンク]] はクリックでノートルートへ遷移する', async ({ page }) => {
  const unexpected = await bootAgent(page, [{ path: NOTE_PATH, title: 'design' }]);
  await page.route(`**/api/notes/agent-mock/design.md`, (route) =>
    void route.fulfill(
      json({ path: NOTE_PATH, content: '# design\n\n設計本文\n', frontmatter: null, body: '# design\n\n設計本文\n', mtime: 1000 }),
    ),
  );
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) =>
    void route.fulfill(
      sse([
        { type: 'text_delta', text: '出典: [[agent-mock/design]] を参照してください。' },
        { type: 'done' },
      ]),
    ),
  );
  await sendPrompt(page, '出典付きで答えて');
  const link = page.getByTestId('agent-wikilink');
  await expect(link).toContainText('agent-mock/design');
  await link.click();
  await expect(page).toHaveURL(/\/n\/agent-mock\/design/);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 存在しないノートへの [[リンク]] は壊れリンク表示になる', async ({ page }) => {
  const unexpected = await bootAgent(page, []); // ノートゼロ → どのリンクも不在
  await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) =>
    void route.fulfill(
      sse([{ type: 'text_delta', text: '参考: [[存在しないノート]]' }, { type: 'done' }]),
    ),
  );
  await sendPrompt(page, '何か教えて');
  await expect(page.getByTestId('agent-wikilink-broken')).toContainText('存在しないノート');
  expect(unexpected).toEqual([]);
});
