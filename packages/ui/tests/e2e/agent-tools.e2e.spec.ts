/**
 * Story S53409d-3 E2E — vault 読み取りツールと出典付き回答。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実サーバー → 実 HTTP のスタブ LLM。
 * スタブはツール呼び出しを返す OpenAI 互換サーバー: 1 回目の要求に tool_calls(search) を返し、
 * ツール結果を含む 2 回目の要求に [[リンク]] 付き本文を返す。search 自体は実サーバーが
 * 実 vault に対して実行する (ここは実物)。
 *
 * AC-S53409d-3-1 (ツールセット固定) は LLM への実リクエストの tools フィールドを実測して検証。
 * AC-S53409d-3-4 (パス脱出拒否) はサーバー側 tests/acceptance / unit が担当。
 */
import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();
const NOTE_REL = 'agent-e2e/loamium-design.md';
const FINAL_TEXT = '設計ノートは [[agent-e2e/loamium-design]] です。';

let stub: Server;
let stubPort: number;
/** スタブが最後に受け取った tools 定義名 (AC-3-1 の実測用) */
let advertisedTools: string[] = [];

type ChatMessage = { role: string; content?: unknown };
type ChatRequest = { messages: ChatMessage[]; tools?: Array<{ function?: { name?: string } }> };

function startStubLlm(): Promise<number> {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as ChatRequest;
      advertisedTools = (parsed.tools ?? [])
        .map((t) => t.function?.name)
        .filter((n): n is string => typeof n === 'string')
        .sort();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const hasToolResult = parsed.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        // 1 回目: search ツールを呼ぶ
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'search', arguments: JSON.stringify({ query: '設計' }) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        // 2 回目: ツール結果を受けて出典付き本文を返す
        send({ choices: [{ index: 0, delta: { content: FINAL_TEXT }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

function encodePath(rel: string): string {
  return rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

test.describe.serial('agent tools', () => {
  test.beforeAll(async () => {
    stubPort = await startStubLlm();
    const cfg = path.join(state().vault, '.loamium', 'agent.json');
    mkdirSync(path.dirname(cfg), { recursive: true });
    writeFileSync(
      cfg,
      JSON.stringify({
        api: 'openai',
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        model: 'stub-model',
        apiKey: 'stub-key',
      }),
      'utf8',
    );
    const res = await fetch(`${state().apiUrl}/api/notes/${encodePath(NOTE_REL)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Loamium 設計\n\nアーキテクチャの本文。\n' }),
    });
    expect(res.ok).toBe(true);
  });

  test.afterAll(async () => {
    await new Promise((resolve) => stub.close(resolve));
  });

  test('[AC-S53409d-3-2] ツール実行がチップ (名前+引数要約) として可視化され、出典付き回答が届く', async ({
    page,
  }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('right-tab-agent').click();
    await expect(page.getByTestId('agent-pane')).toBeVisible();
    await page.getByTestId('agent-new-session').click();
    await page.getByTestId('agent-input').fill('設計のノートを探して');
    await page.getByTestId('agent-send').click();
    const chip = page.getByTestId('agent-tool-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('search');
    await expect(page.getByTestId('agent-msg-assistant')).toContainText('設計ノートは');
  });

  test('[AC-S53409d-3-1] 既定 (read-only) セッションで LLM に広告されるツールは read 系 + help のみ (実リクエストの実測)', () => {
    // 前テストで実際に LLM へ送られた tools 定義を検証する。
    // カスタム read ツールは read_note に改名 (ADR-0008 collision 排除)。
    // ADR-0010: help ツールを追加 (どの権限セットでも使える読み取り系)。
    // ADR-0011 (ADR-0008 を supersede): 広告ツールは有効ケーパビリティから導出される。
    //   このセッションは既定=read-only プリセット (read のみ) のため書き込み/web ツールは
    //   広告されない。書き込み/web ツールが混じっていないこと自体が capability ゲートの実測。
    expect(advertisedTools).toEqual(['backlinks', 'help', 'query', 'read_note', 'search', 'tags']);
  });

  test('[AC-S53409d-3-3] 回答中の [[リンク]] クリックで当該ノートへ遷移する', async ({ page }) => {
    await page.goto(state().uiUrl);
    await page.getByTestId('right-tab-agent').click();
    // 直近セッション復元で前テストの回答が表示されている
    const link = page.getByTestId('agent-wikilink');
    await expect(link).toContainText('agent-e2e/loamium-design');
    await link.click();
    await expect(page).toHaveURL(/\/n\/agent-e2e\/loamium-design/);
    await expect(page.getByTestId('editor')).toContainText('アーキテクチャの本文。');
  });
});
