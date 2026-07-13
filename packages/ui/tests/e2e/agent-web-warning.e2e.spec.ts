/**
 * [S5e0206-2] Web 有効化の漏洩リスク警告 UI E2E。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実サーバー → 実 HTTP のスタブ LLM。
 * モックするのは外部 SaaS 相当の LLM のみ。Loamium 側の権限解決・セッション作成は
 * すべて実物 (packages/server) を通す。MOCK で実機を偽装しない。
 *
 * ハーネスは LOAMIUM_MODE=full で起動する (global-setup.ts)。full はクランプ恒等なので、
 * full プリセットで作成したセッションの実効権限に web が含まれる。
 *
 * 前提: .loamium/agent.json はセッション作成時に遅延読込される。
 *
 *   [AC-S5e0206-2-1] web トグル on で漏洩リスク警告が表示される。
 *   [AC-S5e0206-2-2] web が実効権限に含まれ web ツールが利用可能なことが UI で分かる。
 *                    web トグルに「(未実装)」注記が無い。
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

test.describe.serial('agent web warning', () => {
  test.beforeAll(async () => {
    stubPort = await startStubLlm();
    writeAgentConfig(`http://127.0.0.1:${stubPort}/v1`);
  });

  test.afterAll(async () => {
    await new Promise((resolve) => stub.close(resolve));
    removeAgentConfig();
  });

  test('[AC-S5e0206-2-1] web トグル on で漏洩リスク警告が表示され「未実装」注記が無い', async ({
    page,
  }) => {
    await openAgentPane(page);
    await page.getByTestId('agent-new-session').click();
    await openPermPopover(page);

    // web off (既定 read-only) では警告なし
    await expect(page.getByTestId('agent-web-warning')).toHaveCount(0);

    // ポップオーバー内トグルは常時表示。web トグルを on にする
    await expect(page.getByTestId('agent-perm-toggle-web')).toBeVisible();
    // 「(未実装)」注記が除去されている
    await expect(page.getByTestId('agent-perm-toggle-web')).not.toContainText('未実装');

    await page.getByTestId('agent-perm-toggle-web').click();
    await expect(page.getByTestId('agent-perm-toggle-web')).toHaveAttribute(
      'data-checked',
      'true',
    );

    // 漏洩リスク警告が表示される
    await expect(page.getByTestId('agent-web-warning')).toBeVisible();
    await expect(page.getByTestId('agent-web-warning')).toContainText('プロンプトインジェクション');
  });

  test('[AC-S5e0206-2-2] full プリセットで作成したセッションの実効権限に web が含まれる', async ({
    page,
  }) => {
    await openAgentPane(page);
    await page.getByTestId('agent-new-session').click();
    await openPermPopover(page);

    // full プリセットを選択 → web を含む。警告も表示される。
    await page.getByTestId('agent-perm-preset-full').click();
    await expect(page.getByTestId('agent-perm-popover')).toHaveAttribute('data-preset', 'full');
    await expect(page.getByTestId('agent-web-warning')).toBeVisible();

    // ポップオーバーを閉じて送信 → 実サーバーが permissions 付きでセッションを作成
    await page.getByTestId('agent-input').click();
    await page.getByTestId('agent-input').fill('Web を使って調べて');
    await page.getByTestId('agent-send').click();
    await expect(page.getByTestId('agent-msg-assistant')).toContainText(STUB_REPLY);

    // 実効権限に web が含まれる (LOAMIUM_MODE=full なので web ツール利用可能)。
    // 表示は権限ポップオーバーのチェックボックスに集約されたので開いて確認する。
    await openPermPopover(page);
    await expect(page.getByTestId('agent-perm-toggle-web')).toHaveAttribute('data-checked', 'true');
  });
});
