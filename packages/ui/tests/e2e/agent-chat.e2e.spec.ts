/**
 * Story S53409d-2 E2E — エージェント接続とチャット対話 (+ AC-S53409d-1-3 ターミナルタブ不在)。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実サーバー → 実 HTTP のスタブ LLM。
 * スタブ LLM は別ポートの OpenAI 互換 (chat/completions, SSE) サーバーで、決定的な応答を返す。
 * モックするのは外部 SaaS 相当の LLM のみ (decisions.json 参照)。Loamium 側の経路はすべて実物。
 *
 * 前提 (実装契約): 接続設定 .loamium/agent.json はセッション作成時に遅延読込される。
 * このため各テストは vault 内の agent.json を書き換えてから操作する (サーバー再起動不要)。
 */
import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const STUB_REPLY = 'こんにちは。vault の情報収集を手伝います。';

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

/** OpenAI chat/completions 互換のストリーミングスタブ。100ms 刻みで 2 チャンク返す。 */
function startStubLlm(): Promise<number> {
  stub = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const chunk = (content: string): string =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
      // 100ms 間隔で送ることで「応答中 (中断ボタン表示)」状態を実ブラウザから観測可能にする
      res.write(chunk(STUB_REPLY.slice(0, 6)));
      setTimeout(() => {
        res.write(chunk(STUB_REPLY.slice(6)));
        setTimeout(() => {
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        }, 100);
      }, 100);
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

test.describe.serial('agent chat', () => {
  test.beforeAll(async () => {
    stubPort = await startStubLlm();
  });

  test.afterAll(async () => {
    await new Promise((resolve) => stub.close(resolve));
    removeAgentConfig();
  });

  test('[AC-S53409d-2-1] 未設定時は設定手順ガイドが表示される', async ({ page }) => {
    removeAgentConfig();
    await openAgentPane(page);
    await expect(page.getByTestId('agent-setup-guide')).toBeVisible();
    await expect(page.getByTestId('agent-setup-guide')).toContainText('agent.json');
  });

  test('[AC-S53409d-1-3] 右パネルにターミナル (Claude) タブが存在しない', async ({ page }) => {
    await page.goto(state().uiUrl);
    await expect(page.getByTestId('right-tab-agent')).toBeVisible();
    await expect(page.getByTestId('right-tab-terminal')).toHaveCount(0);
    await expect(page.getByTestId('terminal-pane')).toHaveCount(0);
    // 旧実装の xterm DOM が残っていないこと
    expect(await page.locator('.xterm').count()).toBe(0);
  });

  test('[AC-S53409d-2-2] 送信で SSE ストリーミング描画され、応答中は中断ボタンが出る', async ({
    page,
  }) => {
    writeAgentConfig(`http://127.0.0.1:${stubPort}/v1`);
    await openAgentPane(page);
    await page.getByTestId('agent-input').fill('はじめまして');
    await page.getByTestId('agent-send').click();
    // ストリーミング中: 中断ボタンが観測できる (スタブは 100ms 刻みで返す)
    await expect(page.getByTestId('agent-abort')).toBeVisible();
    // 完了: 全文が描画され Ready に戻る
    await expect(page.getByTestId('agent-msg-assistant')).toContainText(STUB_REPLY);
    await expect(page.getByTestId('agent-send')).toBeVisible();
  });

  test('[AC-S53409d-2-3] リロード後も直近セッションが復元され、新規セッションを開始できる', async ({
    page,
  }) => {
    await openAgentPane(page);
    // 前テストの対話が JSONL 永続化から復元される
    await expect(page.getByTestId('agent-msg-user')).toContainText('はじめまして');
    await expect(page.getByTestId('agent-msg-assistant')).toContainText(STUB_REPLY);
    await page.getByTestId('agent-new-session').click();
    await expect(page.getByTestId('agent-msg-user')).toHaveCount(0);
  });

  test('[AC-S53409d-2-4] 接続不能エラーはチャット内に表示され、サーバーは落ちない', async ({
    page,
  }) => {
    // 到達不能なエンドポイントを設定 (遅延読込のため再起動不要)
    writeAgentConfig('http://127.0.0.1:9/v1');
    await openAgentPane(page);
    await page.getByTestId('agent-new-session').click();
    await page.getByTestId('agent-input').fill('つながる?');
    await page.getByTestId('agent-send').click();
    await expect(page.getByTestId('agent-error')).toBeVisible();
    // サーバーが生きていること (実 HTTP)
    const health = await fetch(`${state().apiUrl}/api/health`);
    expect(health.ok).toBe(true);
  });
});
