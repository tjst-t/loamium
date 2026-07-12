/**
 * [AC-S53409d-2-3] 回帰テスト: サーバー再起動後、ディスク永続セッションへの
 * 継続送信が 404 にならず JSONL からリハイドレートされること。
 *
 * バグ: POST /api/agent/sessions/:id/messages が in-memory の active session だけを見ており、
 * サーバー再起動でキャッシュが空になると、UI が復元した直近セッションへ送信すると 404 (session_not_found)
 * になっていた (GET 詳細はディスク復元するのに POST /messages はしていなかった)。
 *
 * LLM は呼ばない: agent.json は到達不能な baseUrl を指す。よって「送信」は
 *   - バグ時: 404 session_not_found (ディスク復元されずキャッシュミス)
 *   - 修正後: 200 + SSE の error イベント (復元されて LLM 呼出まで到達し、そこで接続失敗)
 * で区別できる。ここで見たいのは「404 にならないこと = ディスク復元されたこと」。
 *
 * 実サーバー 2 プロセス (起動→作成→停止→再起動→送信) + 実 HTTP。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

// 到達不能な LLM エンドポイント (ポート 1 は使えない)。登録は成功するが prompt で接続失敗する。
const UNREACHABLE_AGENT_CONFIG = JSON.stringify({
  api: 'openai',
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'stub-model',
  apiKey: 'stub-key',
});

async function writeAgentConfig(vault: string): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'agent.json'), UNREACHABLE_AGENT_CONFIG, 'utf8');
}

/** SSE 本文をテキストとして読み切る。 */
async function readSseText(res: Response): Promise<string> {
  return await res.text();
}

let vault: string | null = null;
let running: TestServer | null = null;

afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
  if (vault) {
    await cleanupVault(vault);
    vault = null;
  }
});

describe('agent session disk restore across restart', () => {
  it('[AC-S53409d-2-3] 再起動後、復元セッションへの送信が 404 にならずディスク復元される', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);

    // --- プロセス A: セッションを作成し 1 通送信して停止 ---
    // 送信すると pi の SessionManager が user メッセージエントリを JSONL に永続化する
    // (LLM は到達不能なので応答は error で終わるが、履歴はディスクに残る)。
    // これは「UI の一覧に出る = 履歴のあるセッション」= 実際に復元される対象の再現。
    const serverA = await startServer({ vault, mode: 'full' });
    const createRes = await fetch(`${serverA.baseUrl}/api/agent/sessions`, { method: 'POST' });
    expect(createRes.status).toBe(200);
    const { id: sessionId } = (await createRes.json()) as { id: string };
    expect(sessionId).toBeTruthy();
    const firstSend = await fetch(`${serverA.baseUrl}/api/agent/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '最初のメッセージ' }),
    });
    expect(firstSend.status).toBe(200);
    await firstSend.text(); // ストリームを読み切る (user エントリ永続化を待つ)
    await serverA.stop();

    // --- プロセス B: 再起動 (active キャッシュは空) → 復元セッションへ送信 ---
    const serverB = await startServer({ vault, mode: 'full' });
    running = serverB;
    const sendRes = await fetch(`${serverB.baseUrl}/api/agent/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '再起動後の継続送信' }),
    });

    // バグ回帰の核心: 404 session_not_found ではないこと (= ディスクから復元された)。
    expect(sendRes.status).not.toBe(404);
    expect(sendRes.status).toBe(200);
    // LLM は到達不能なので SSE error イベントで終わる (session_not_found ではない)。
    const body = await readSseText(sendRes);
    expect(body).toContain('"type":"error"');
    expect(body).not.toContain('session_not_found');
  });

  it('[AC-S53409d-2-3] 実在しないセッションへの送信は 404 session_not_found', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    const server = await startServer({ vault, mode: 'full' });
    running = server;

    const res = await fetch(
      `${server.baseUrl}/api/agent/sessions/019f0000-0000-7000-8000-000000000000/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x' }),
      },
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe('session_not_found');
  });
});
