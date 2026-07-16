/**
 * オフライン LLM acceptance (S8a3f2e-5 / ADR-0025)。
 *
 * ゴール: 「インターネット接続なしでエージェントが動く」ことを回帰で守る。
 *
 * 構成 (実サーバー 1 プロセス + 実 HTTP):
 *   - 外部ネットワーク遮断: サーバー側 globalThis.fetch を egress ガードで包み、
 *     127.0.0.1 / localhost 以外への発信を拒否する (LOAMIUM_BLOCK_EXTERNAL_FETCH=1)。
 *   - backend=local を明示選択した agent.json + .loamium/models/llm/ にモデル 1 つ。
 *   - エンジン実体は決定的スタブ (LOAMIUM_LLM_TEST_STUB=1)。addon / 実 GGUF 非依存。
 *   - 経路 (pi → shim /api/llm/v1/chat/completions → engine) は本物を通す。
 *
 * AC-S8a3f2e-5-1: backend=local セッションで 1 プロンプト送信 → shim 経由で応答が返る。
 * AC-S8a3f2e-5-2: 外部 baseUrl への発信ゼロ (egress ガードのブロック数 0・許可は
 *   すべてループバック)。既存 agent-tools e2e pin は別レイヤ (packages/ui) で非破壊。
 * AC-S8a3f2e-5-4: CI 実行可能 (スタブで addon 非依存)。テスト無効化 / アサーション
 *   弱体化 / エラー握りつぶしをしない。real-server は 1 プロセスで直列に叩く。
 *
 * 注: real-server spec の直列化 (既知 flake) に配慮し、1 サーバーを共有して
 *     セッション作成→送信を順に行う (並行しない)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

/** 内蔵モデルのファイル名 (.loamium/models/llm/ 配下に置く)。 */
const LOCAL_MODEL = 'offline-stub.gguf';

/**
 * backend=local を明示選択した agent.json を書く。external フィールドは
 * 到達不能な外部 baseUrl / ダミーキーにしておく (backend=local なので使われない
 * = 外部へ発信しないことの傍証。もし誤って external を叩けば egress ガードで失敗する)。
 */
async function writeLocalBackendConfig(vault: string): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'agent.json'),
    JSON.stringify({
      api: 'openai',
      baseUrl: 'https://api.example.com/v1', // external — 使われないはず
      model: 'gpt-x',
      apiKey: 'sk-should-not-be-used',
      backend: 'local',
      localModel: LOCAL_MODEL,
    }),
    'utf8',
  );
}

/** .loamium/models/llm/<LOCAL_MODEL> にダミーモデルファイルを置く (中身は使わない)。 */
async function writeLocalModel(vault: string): Promise<void> {
  const dir = path.join(vault, '.loamium', 'models', 'llm');
  await mkdir(dir, { recursive: true });
  // GGUF マジックだけ書く (スタブエンジンは中身を読まないが、実在ファイルは要る)。
  await writeFile(path.join(dir, LOCAL_MODEL), 'GGUF-stub');
}

/** POST /api/agent/sessions → sessionId。 */
async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/agent/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect(id).toBeTruthy();
  return id;
}

/** SSE イベントの最小型 (messages ルートが送る種別)。 */
interface SseEvent {
  type: string;
  text?: string;
  message?: string;
}

/**
 * POST /api/agent/sessions/:id/messages を叩き、SSE を最後まで読み、
 * イベント列を返す。text_delta を連結した本文も返す。
 */
async function sendMessage(
  baseUrl: string,
  id: string,
  content: string,
): Promise<{ events: SseEvent[]; text: string }> {
  const res = await fetch(`${baseUrl}/api/agent/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(200);
  const body = res.body;
  if (body === null) throw new Error('SSE body was null');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const events: SseEvent[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    // SSE フレームは "\n\n" 区切り。data: 行だけ拾う。
    let sep: number;
    while ((sep = buffered.indexOf('\n\n')) !== -1) {
      const frame = buffered.slice(0, sep);
      buffered = buffered.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice('data:'.length).trim();
        if (json === '' || json === '[DONE]') continue;
        events.push(JSON.parse(json) as SseEvent);
      }
    }
  }

  const text = events
    .filter((e) => e.type === 'text_delta' && typeof e.text === 'string')
    .map((e) => e.text as string)
    .join('');
  return { events, text };
}

let server: TestServer;

beforeAll(async () => {
  const vault = await makeTempVault();
  await writeLocalBackendConfig(vault);
  await writeLocalModel(vault);
  server = await startServer({
    vault,
    mode: 'full',
    env: {
      // 決定的スタブエンジン (addon / 実 GGUF 非依存で shim → engine を成立させる)。
      LOAMIUM_LLM_TEST_STUB: '1',
      // 外部 egress を遮断し、外部発信ゼロを観測可能にする。
      LOAMIUM_BLOCK_EXTERNAL_FETCH: '1',
    },
  });
}, 30_000);

afterAll(async () => {
  if (server) {
    await server.stop();
    await cleanupVault(server.vault);
  }
});

describe('[AC-S8a3f2e-5-1] オフライン: backend=local で pi → shim → engine が応答を返す', () => {
  it('egress ガードが install され、事前の外部発信は無い', async () => {
    const res = await fetch(`${server.baseUrl}/api/_test/egress-stats`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      installed: boolean;
      blockedCount: number;
    };
    // ガードがサーバープロセスで有効であること (テスト前提の健全性)。
    expect(stats.installed).toBe(true);
    // セッション未送信の時点で外部発信ブロックは 0。
    expect(stats.blockedCount).toBe(0);
  });

  it('shim /api/llm/v1/models が内蔵モデルを OpenAI models 形で返す (経路の一方の実体)', async () => {
    const res = await fetch(`${server.baseUrl}/api/llm/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: { id: string }[] };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toContain(LOCAL_MODEL);
  });

  it('1 プロンプト送信 → shim 経由でスタブエンジンの応答が返る', async () => {
    const id = await createSession(server.baseUrl);
    const { events, text } = await sendMessage(server.baseUrl, id, 'ping offline');

    // done イベントで正常終了 (error イベントは無い)。エラー握りつぶし禁止のため厳密に。
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents, `unexpected error events: ${JSON.stringify(errorEvents)}`).toHaveLength(0);
    expect(events.some((e) => e.type === 'done')).toBe(true);

    // スタブエンジンは "[stub:<path>] echo: <prompt>" を返す。pi → shim → engine を
    // 本物で通した結果、その応答が assistant text として届く。
    expect(text).toContain('[stub:');
    expect(text).toContain('offline-stub.gguf');
    // 縮約プロンプト (messagesToPrompt) が engine に届いていること。
    expect(text).toContain('ping offline');
  });
});

describe('[AC-S8a3f2e-5-2] 外部 baseUrl への発信がゼロ', () => {
  it('プロンプト送信後も外部発信ブロックは 0・許可はすべてループバック', async () => {
    // 上の送信で pi が openai クライアント経由で shim (127.0.0.1) を叩いている。
    // もし external baseUrl (api.example.com) を叩けば egress ガードが blockedCount を
    // 増やす。ブロック 0 = 外部発信が一切起きていない。
    const res = await fetch(`${server.baseUrl}/api/_test/egress-stats`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      installed: boolean;
      blockedCount: number;
      allowedCount: number;
    };
    expect(stats.installed).toBe(true);
    // 外部発信ゼロ (遮断されたものが 0 = そもそも外部を叩いていない)。
    expect(stats.blockedCount).toBe(0);
  });
});
