/**
 * [sessionmgmt] 受け入れテスト: DELETE /api/agent/sessions/{id}
 *
 * - セッション削除: create+send で JSONL を永続化 → DELETE → 200 → GET 一覧に消える
 * - 未知 ID 削除 → 404
 * - パストラバーサル ID → 400
 * - read-only モードでの削除 → 403
 *
 * 実サーバー + 実 HTTP (agent-session-restore.spec.ts と同じスタイル)。
 * LLM は到達不能なエンドポイントを使う (セッション JSONL を作成するために送信が必要)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

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

/**
 * セッションを作成し、1 通送信して JSONL を永続化する。
 * (LLM は到達不能なので error で終わるが JSONL エントリは書かれる)
 */
async function createAndSendSession(baseUrl: string): Promise<string> {
  const createRes = await fetch(`${baseUrl}/api/agent/sessions`, { method: 'POST' });
  expect(createRes.status).toBe(200);
  const { id } = (await createRes.json()) as { id: string };
  expect(id).toBeTruthy();

  // 1 通送信 → JSONL に user エントリが永続化される
  const sendRes = await fetch(`${baseUrl}/api/agent/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'テスト' }),
  });
  expect(sendRes.status).toBe(200);
  await sendRes.text(); // ストリームを読み切る

  return id;
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

describe('DELETE /api/agent/sessions/:id', () => {
  it('[sessionmgmt] セッションを削除すると 200 が返り、一覧から消える', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    running = await startServer({ vault, mode: 'full' });

    const id = await createAndSendSession(running.baseUrl);

    // 削除前: 一覧に存在する
    const listBefore = (await (await fetch(`${running.baseUrl}/api/agent/sessions`)).json()) as {
      sessions: { id: string }[];
    };
    expect(listBefore.sessions.some((s) => s.id === id)).toBe(true);

    // DELETE
    const delRes = await fetch(`${running.baseUrl}/api/agent/sessions/${id}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);

    // 削除後: 一覧から消えている
    const listAfter = (await (await fetch(`${running.baseUrl}/api/agent/sessions`)).json()) as {
      sessions: { id: string }[];
    };
    expect(listAfter.sessions.some((s) => s.id === id)).toBe(false);

    // GET detail → 空 messages (セッションが存在しないため)
    const detailRes = await fetch(`${running.baseUrl}/api/agent/sessions/${id}`);
    // 404 か 200+空 messages のどちらか (getSessionFromDisk が投げるが routeは200で空を返す)
    // 少なくとも一覧に出ないことを確認済みなのでここは status チェックのみ
    expect([200, 404]).toContain(detailRes.status);
  });

  it('[sessionmgmt] 未知のセッション ID を削除すると 404', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    running = await startServer({ vault, mode: 'full' });

    const res = await fetch(
      `${running.baseUrl}/api/agent/sessions/019f0000-0000-7000-8000-000000000099`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('session_not_found');
  });

  it('[sessionmgmt] パストラバーサル ID は 400 を返す', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    running = await startServer({ vault, mode: 'full' });

    // '../etc/passwd' 的な ID → validateSessionId が弾く
    const res = await fetch(`${running.baseUrl}/api/agent/sessions/..%2F..%2Fetc`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_session_id');
  });

  it('[sessionmgmt] read-only モードでの削除は 403', async () => {
    vault = await makeTempVault();
    // read-only では agent.json が不要 (health 取得できれば OK)、
    // ただし POST /api/agent/sessions は 403 になるので ID を手動で作れない。
    // ここでは full で作ったあと read-only サーバーで DELETE を試みる。
    await writeAgentConfig(vault);

    // full モードでセッション作成
    const serverFull = await startServer({ vault, mode: 'full' });
    const id = await createAndSendSession(serverFull.baseUrl);
    await serverFull.stop();

    // read-only モードで起動し直す
    running = await startServer({ vault, mode: 'read-only' });

    const res = await fetch(`${running.baseUrl}/api/agent/sessions/${id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('forbidden');
  });
});
