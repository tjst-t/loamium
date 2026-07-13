/**
 * [S5bd678-3 / 権限ポップオーバー] チャット UI 権限トグル + プリセット mock テスト。
 *
 * 権限 UI はセッションバーの権限ボタン (agent-perm-button) → ポップオーバー
 * (agent-perm-popover) に集約された。各テストはまず権限ボタンを押してポップオーバーを開く。
 *
 * fetch を page.route でモックし、UI 単体の挙動を検証する:
 *   - (a) プリセット選択 → ケーパビリティ別トグルがそのプリセット集合に同期する。
 *   - (b) 個別トグル変更 → カスタム状態 (data-preset=custom) になる。
 *   - (c) 初回送信で POST /api/agent/sessions の body に選択した permissions が載る。
 *   - (d) 送信後、GET 詳細の effectivePermissions が (ポップオーバー内に) 表示される。
 *   - (e) LOAMIUM_MODE で剥がれたケーパビリティ (要求にあるが実効に無い) が区別表示される。
 *   - (f) 送信済みセッションでトグルすると PUT /permissions が飛び、実効権限が更新される。
 *
 * mock 手法は agent-sessions.mock.spec.ts / agent-chat.mock.spec.ts を踏襲。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const SESSION_A = 'ses-perm-a';

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

interface BootResult {
  unexpected: string[];
  postBodies: unknown[];
  putBodies: unknown[];
  /** PUT /permissions の応答 effectivePermissions を差し替えるための可変参照 */
  putEffective: { value: string[] };
}

/** エージェント有効・セッション一覧空でブート。effectivePermissions は opts で指定。 */
async function bootAgent(
  page: Page,
  opts: { effectivePermissions?: string[] } = {},
): Promise<BootResult> {
  const unexpected = await installCatchAll(page);
  const postBodies: unknown[] = [];
  const putBodies: unknown[] = [];
  const effective = opts.effectivePermissions ?? ['read'];
  const putEffective = { value: effective };

  await page.route('**/api/health', (route) =>
    void route.fulfill(
      json({ status: 'ok', mode: 'full', agent: { enabled: true, reason: null } }),
    ),
  );
  await page.route('**/api/notes', (route) => void route.fulfill(json({ notes: [] })));

  await page.route('**/api/agent/sessions', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      postBodies.push(req.postDataJSON());
      void route.fulfill(json({ id: SESSION_A }));
    } else {
      void route.fulfill(json({ sessions: [] }));
    }
  });

  // セッション詳細 (作成後の effectivePermissions 取得 + 送信後の再取得に応答) と
  // PUT /permissions (セッション中の権限変更) を method で分岐する。
  await page.route(`**/api/agent/sessions/${SESSION_A}`, (route) =>
    void route.fulfill(json({ id: SESSION_A, messages: [], effectivePermissions: effective })),
  );
  await page.route(`**/api/agent/sessions/${SESSION_A}/permissions`, (route) => {
    putBodies.push(route.request().postDataJSON());
    void route.fulfill(json({ effectivePermissions: putEffective.value }));
  });
  await page.route(`**/api/agent/sessions/${SESSION_A}/messages`, (route) =>
    void route.fulfill(sse([{ type: 'text_delta', text: '応答' }, { type: 'done' }])),
  );

  return { unexpected, postBodies, putBodies, putEffective };
}

async function openAgentPane(page: Page): Promise<void> {
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('right-tab-agent').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();
}

/** 権限ボタンを押してポップオーバーを開く。 */
async function openPermPopover(page: Page): Promise<void> {
  await page.getByTestId('agent-perm-button').click();
  await expect(page.getByTestId('agent-perm-popover')).toBeVisible();
}

// ---------------------------------------------------------------------------
// (a) プリセット選択 → トグル同期
// ---------------------------------------------------------------------------
test('[MOCK-PERM-a] プリセット選択でケーパビリティ別トグルが同期する', async ({ page }) => {
  const { unexpected } = await bootAgent(page);
  await openAgentPane(page);
  await openPermPopover(page);

  // 既定は read-only プリセット
  await expect(page.getByTestId('agent-perm-popover')).toHaveAttribute('data-preset', 'read-only');

  // トグルは常時表示 (展開ボタン不要)
  await expect(page.getByTestId('agent-perm-toggles')).toBeVisible();
  // read-only なので read のみ ON
  await expect(page.getByTestId('agent-perm-toggle-read')).toHaveAttribute('data-checked', 'true');
  await expect(page.getByTestId('agent-perm-toggle-note_edit')).toHaveAttribute('data-checked', 'false');

  // notes-rw プリセットを選択 → read + journal_append + note_create + note_edit が ON
  await page.getByTestId('agent-perm-preset-notes-rw').click();
  await expect(page.getByTestId('agent-perm-popover')).toHaveAttribute('data-preset', 'notes-rw');
  await expect(page.getByTestId('agent-perm-toggle-read')).toHaveAttribute('data-checked', 'true');
  await expect(page.getByTestId('agent-perm-toggle-note_edit')).toHaveAttribute('data-checked', 'true');
  await expect(page.getByTestId('agent-perm-toggle-web')).toHaveAttribute('data-checked', 'false');

  // full プリセット → web を含む全ケーパビリティが ON
  await page.getByTestId('agent-perm-preset-full').click();
  await expect(page.getByTestId('agent-perm-popover')).toHaveAttribute('data-preset', 'full');
  await expect(page.getByTestId('agent-perm-toggle-web')).toHaveAttribute('data-checked', 'true');

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (b) 個別トグル変更 → カスタム状態
// ---------------------------------------------------------------------------
test('[MOCK-PERM-b] 個別トグルを変えるとカスタム状態になる', async ({ page }) => {
  const { unexpected } = await bootAgent(page);
  await openAgentPane(page);
  await openPermPopover(page);

  // read-only から note_edit を追加 → プリセットに一致しない custom に
  await page.getByTestId('agent-perm-toggle-note_edit').click();
  await expect(page.getByTestId('agent-perm-toggle-note_edit')).toHaveAttribute('data-checked', 'true');
  await expect(page.getByTestId('agent-perm-popover')).toHaveAttribute('data-preset', 'custom');

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (c) 初回送信で POST body に選択した permissions が載る
// ---------------------------------------------------------------------------
test('[MOCK-PERM-c] 初回送信の POST body に選択した permissions が載る', async ({ page }) => {
  const { unexpected, postBodies } = await bootAgent(page, {
    effectivePermissions: ['read', 'journal_append', 'note_create', 'note_edit'],
  });
  await openAgentPane(page);
  await openPermPopover(page);

  // notes-rw を選択
  await page.getByTestId('agent-perm-preset-notes-rw').click();
  // ポップオーバーを閉じてから送信 (外側クリックで閉じる)
  await page.getByTestId('agent-input').click();

  await page.getByTestId('agent-input').fill('ノートを作って');
  await page.getByTestId('agent-send').click();

  // 応答が出る = 送信完了
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('応答');

  // POST body に notes-rw 相当のケーパビリティ配列が載っている
  expect(postBodies).toHaveLength(1);
  const body = postBodies[0] as { permissions?: unknown };
  expect(Array.isArray(body.permissions)).toBe(true);
  expect(new Set(body.permissions as string[])).toEqual(
    new Set(['read', 'journal_append', 'note_create', 'note_edit']),
  );

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (d) 送信後、effectivePermissions が (ポップオーバー内に) 表示される
// ---------------------------------------------------------------------------
test('[MOCK-PERM-d] 送信後に実効権限が表示される', async ({ page }) => {
  const { unexpected } = await bootAgent(page, {
    effectivePermissions: ['read', 'journal_append', 'note_create', 'note_edit'],
  });
  await openAgentPane(page);
  await openPermPopover(page);

  await page.getByTestId('agent-perm-preset-notes-rw').click();
  await page.getByTestId('agent-input').click();
  await page.getByTestId('agent-input').fill('こんにちは');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('応答');

  // 権限ボタンを再度開くと、実効権限がチェックボックスに反映されている
  // (送信済みセッションのトグルは実効権限 = effectivePermissions を反映する)
  await openPermPopover(page);
  await expect(page.getByTestId('agent-perm-toggle-read')).toHaveAttribute('data-checked', 'true');
  await expect(page.getByTestId('agent-perm-toggle-note_edit')).toHaveAttribute('data-checked', 'true');

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (e) LOAMIUM_MODE で剥がれたケーパビリティはチェックボックスに反映される
//     (専用の実効/剥がれ表示は撤去済み — 実効はチェックボックス状態で表す)
// ---------------------------------------------------------------------------
test('[MOCK-PERM-e] LOAMIUM_MODE で剥がれたケーパビリティはチェックが外れる', async ({ page }) => {
  // full を要求するが、サーバーは read-only モードで read のみ返す
  const { unexpected } = await bootAgent(page, {
    effectivePermissions: ['read'],
  });
  await openAgentPane(page);
  await openPermPopover(page);

  // full プリセットを選択 (全 7 ケーパビリティを要求)
  await page.getByTestId('agent-perm-preset-full').click();
  await page.getByTestId('agent-input').click();
  await page.getByTestId('agent-input').fill('編集して');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('応答');

  await openPermPopover(page);
  // read は実効に残る → チェック on
  await expect(page.getByTestId('agent-perm-toggle-read')).toHaveAttribute('data-checked', 'true');
  // note_edit は LOAMIUM_MODE クランプで剥がれた → 実効に無く、チェックも off
  await expect(page.getByTestId('agent-perm-toggle-note_edit')).toHaveAttribute('data-checked', 'false');

  expect(unexpected).toEqual([]);
});

// ---------------------------------------------------------------------------
// (f) 送信済みセッションでトグルすると PUT /permissions が飛び実効権限が更新される
// ---------------------------------------------------------------------------
test('[MOCK-PERM-f] セッション中のトグルで PUT が飛び実効権限が更新される', async ({ page }) => {
  const boot = await bootAgent(page, { effectivePermissions: ['read'] });
  await openAgentPane(page);

  // まず送信してセッションを確定する (read-only 既定)
  await page.getByTestId('agent-input').fill('はじめまして');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('応答');

  // PUT 応答を notes-rw 相当に差し替える
  boot.putEffective.value = ['read', 'journal_append', 'note_create', 'note_edit'];

  // セッション中に notes-rw プリセットへ切替 → PUT /permissions が飛ぶ
  await openPermPopover(page);
  await page.getByTestId('agent-perm-preset-notes-rw').click();

  // PUT が飛んで実効権限が更新される (チェックボックスに反映)
  await expect(page.getByTestId('agent-perm-toggle-note_edit')).toHaveAttribute('data-checked', 'true');

  expect(boot.putBodies).toHaveLength(1);
  const putBody = boot.putBodies[0] as { permissions?: unknown };
  expect(new Set(putBody.permissions as string[])).toEqual(
    new Set(['read', 'journal_append', 'note_create', 'note_edit']),
  );

  expect(boot.unexpected).toEqual([]);
});
