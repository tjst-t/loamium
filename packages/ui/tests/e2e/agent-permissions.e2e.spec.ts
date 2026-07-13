/**
 * [S5bd678-3] チャット UI 権限トグル + プリセット E2E。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実サーバー → 実 HTTP のスタブ LLM。
 * モックするのは外部 SaaS 相当の LLM のみ。Loamium 側の権限解決・クランプ・セッション
 * 作成はすべて実物 (packages/server) を通す。
 *
 * ハーネスは LOAMIUM_MODE=full で起動する (global-setup.ts)。full はクランプ恒等なので、
 * 選択したプリセットのケーパビリティがそのまま実効権限になることを検証する。
 * (LOAMIUM_MODE で剥がれるケースは mock テストと shared のユニットテストで網羅する。)
 *
 * 前提: .loamium/agent.json はセッション作成時に遅延読込される。各テストは vault 内へ
 * agent.json を書き込んでから操作する (サーバー再起動不要)。
 *
 *   [AC-S5bd678-3-1] プリセット選択 → 新規セッション作成時に permissions が送信される。
 *   [AC-S5bd678-3-2] 現在セッションの実効権限が UI に表示される。
 */
import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const STUB_REPLY = '了解しました。';

let stub: Server;
let stubPort: number;

function agentConfigPath(): string {
  return path.join(state().vault, '.loamium', 'agent.json');
}

function writeAgentConfig(baseUrl: string): void {
  mkdirSync(path.dirname(agentConfigPath()), { recursive: true });
  writeFileSync(
    agentConfigPath(),
    JSON.stringify({ api: 'openai', baseUrl, model: 'stub-model', apiKey: 'stub-key' }),
    'utf8',
  );
}

function removeAgentConfig(): void {
  rmSync(agentConfigPath(), { force: true });
}

/** OpenAI chat/completions 互換のストリーミングスタブ。 */
function startStubLlm(): Promise<number> {
  stub = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: STUB_REPLY }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

async function openAgentPane(page: Page): Promise<void> {
  await page.goto(state().uiUrl);
  await page.getByTestId('right-tab-agent').click();
  await expect(page.getByTestId('agent-pane')).toBeVisible();
}

/** 権限ボタンを押してポップオーバーを開く。 */
async function openPermPopover(page: Page): Promise<void> {
  await page.getByTestId('agent-perm-button').click();
  await expect(page.getByTestId('agent-perm-popover')).toBeVisible();
}

test.describe.serial('agent permissions', () => {
  test.beforeAll(async () => {
    stubPort = await startStubLlm();
    writeAgentConfig(`http://127.0.0.1:${stubPort}/v1`);
  });

  test.afterAll(async () => {
    await new Promise((resolve) => stub.close(resolve));
    removeAgentConfig();
  });

  test('[AC-S5bd678-3-1] プリセットとケーパビリティ別トグルが表示され既定は read-only', async ({
    page,
  }) => {
    await openAgentPane(page);
    await page.getByTestId('agent-new-session').click();
    await openPermPopover(page);

    // ポップオーバーが表示され、既定は read-only プリセット
    await expect(page.getByTestId('agent-perm-popover')).toHaveAttribute(
      'data-preset',
      'read-only',
    );

    // トグルは常時表示。read が ON・note_edit が OFF
    await expect(page.getByTestId('agent-perm-toggle-read')).toHaveAttribute(
      'data-checked',
      'true',
    );
    await expect(page.getByTestId('agent-perm-toggle-note_edit')).toHaveAttribute(
      'data-checked',
      'false',
    );

    // notes-rw を選ぶとトグルが同期する
    await page.getByTestId('agent-perm-preset-notes-rw').click();
    await expect(page.getByTestId('agent-perm-toggle-note_edit')).toHaveAttribute(
      'data-checked',
      'true',
    );
  });

  test('[AC-S5bd678-3-2] プリセット選択で作成したセッションの実効権限が反映される', async ({
    page,
  }) => {
    await openAgentPane(page);
    await page.getByTestId('agent-new-session').click();

    // notes-rw プリセットを選択して送信 → 実サーバーがセッションを permissions 付きで作成
    await openPermPopover(page);
    await page.getByTestId('agent-perm-preset-notes-rw').click();
    await page.getByTestId('agent-input').click();
    await page.getByTestId('agent-input').fill('メモを追記して');
    await page.getByTestId('agent-send').click();
    await expect(page.getByTestId('agent-msg-assistant')).toContainText(STUB_REPLY);

    // 実効権限表示が出る (LOAMIUM_MODE=full なので notes-rw のケーパビリティがそのまま実効)。
    // 表示は権限ポップオーバー内に集約されたので開いて確認する。
    await openPermPopover(page);
    await expect(page.getByTestId('agent-effective-perms')).toBeVisible();
    await expect(page.getByTestId('agent-effective-cap-read')).toBeVisible();
    await expect(page.getByTestId('agent-effective-cap-journal_append')).toBeVisible();
    await expect(page.getByTestId('agent-effective-cap-note_create')).toBeVisible();
    await expect(page.getByTestId('agent-effective-cap-note_edit')).toBeVisible();
    // notes-rw は web / template_write / dataview_write を含まない
    await expect(page.getByTestId('agent-effective-cap-web')).toHaveCount(0);
    await expect(page.getByTestId('agent-effective-cap-template_write')).toHaveCount(0);
    // full モードなので剥がれ (stripped) は無い
    await expect(page.locator('[data-testid^="agent-perm-stripped-"]')).toHaveCount(0);
  });

  test('[AC-agent-ui] セッション中に権限をトグルすると PUT で実効権限が更新される', async ({
    page,
  }) => {
    await openAgentPane(page);
    await page.getByTestId('agent-new-session').click();

    // read-only 既定でセッションを確定する
    await page.getByTestId('agent-input').fill('こんにちは');
    await page.getByTestId('agent-send').click();
    await expect(page.getByTestId('agent-msg-assistant')).toContainText(STUB_REPLY);

    // 送信直後は read のみが実効
    await openPermPopover(page);
    await expect(page.getByTestId('agent-effective-cap-read')).toBeVisible();
    await expect(page.getByTestId('agent-effective-cap-note_edit')).toHaveCount(0);

    // セッション中に full プリセットへ切替 → PUT /permissions が実サーバーへ飛ぶ
    // (LOAMIUM_MODE=full なので全ケーパビリティがそのまま実効になる)
    await page.getByTestId('agent-perm-preset-full').click();
    await expect(page.getByTestId('agent-effective-cap-note_edit')).toBeVisible();
    await expect(page.getByTestId('agent-effective-cap-web')).toBeVisible();

    // GET 詳細 (再取得) にも反映される: ポップオーバーを閉じて開き直す
    await page.getByTestId('agent-input').click();
    await openPermPopover(page);
    await expect(page.getByTestId('agent-effective-cap-web')).toBeVisible();
  });
});
