/**
 * 内蔵オフライン LLM の REST ルートテスト (S8a3f2e-2 / S8a3f2e-3 / ADR-0025)。
 *
 * shim (chat.completions / models) は EngineLoader をスタブに差し替え、
 * addon 無しで OpenAI 互換の非ストリーム / ストリーム / エラー形を検証する。
 * モデル管理 (list/download/delete) は tmp vault の実 FS + スタブ fetch で
 * 封じ込め・進捗・完了/失敗・404・不正名 400 を検証する (実 URL へは発信しない)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { llmRoutes } from './llm.js';
import type { AppEnv } from '../http.js';
import type { ServerConfig } from '../config.js';
import {
  LocalLlmEngine,
  type EngineLoader,
  type LoadedSession,
  type ChatResult,
  type ChatOptions,
} from '../local-llm-engine.js';
import type { ToolChatMessage } from '../local-llm-tools.js';
import { ModelDownloadManager, type FetchFn } from '../model-download.js';
import { modelKindDir } from '../model-paths.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loamium-llm-routes-'));
});
afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

function makeConfig(): ServerConfig {
  return { vaultRoot, mode: 'full', maxUploadBytes: 1024 };
}

/**
 * prompt をエコーする決定的セッション。
 * chat は tools ありかつ tool 結果未受領なら先頭ツールを呼び (tool_calls)、
 * tool 結果を受けた継続では最終テキストを返す (tools 往復の検証用)。
 */
function echoSession(): LoadedSession {
  return {
    async prompt(text: string): Promise<string> {
      return `echo: ${text}`;
    },
    async chat(messages: ToolChatMessage[], options?: ChatOptions): Promise<ChatResult> {
      const hasToolResult = messages.some((m) => m.role === 'tool');
      if (options?.tools && options.tools.length > 0 && !hasToolResult) {
        const tool = options.tools[0]!;
        return {
          kind: 'tool_calls',
          toolCalls: [{ id: 'call_0', name: tool.name, argumentsJson: '{"q":"loamium"}' }],
        };
      }
      const last = messages[messages.length - 1];
      const lastText = last && 'text' in last ? last.text : '';
      return { kind: 'text', content: `chat-final: ${lastText}` };
    },
    async dispose(): Promise<void> {},
  };
}

/** モデルをロード済みにしたエンジン (echo セッション)。 */
async function loadedEngine(modelPath: string): Promise<LocalLlmEngine> {
  const loader: EngineLoader = { load: () => Promise.resolve(echoSession()) };
  const engine = new LocalLlmEngine(loader);
  await engine.loadEngine(modelPath);
  return engine;
}

function mount(routes: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route('/', routes);
  return app;
}

// ============================================================
// S8a3f2e-2: OpenAI 互換 shim
// ============================================================

describe('POST /api/llm/v1/chat/completions (非ストリーム)', () => {
  it('ロード済みモデルで chat.completion 形を返す', async () => {
    const engine = await loadedEngine('/x.gguf');
    const app = mount(llmRoutes(makeConfig(), { engine }));

    const res = await app.request('/api/llm/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen.gguf',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32,
        temperature: 0.2,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: { message: { role: string; content: string } }[];
      usage: { total_tokens: number };
    };
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0]?.message.role).toBe('assistant');
    expect(body.choices[0]?.message.content).toContain('echo:');
    expect(body.choices[0]?.message.content).toContain('User: hi');
    expect(typeof body.usage.total_tokens).toBe('number');
  });

  it('未ロード時は 503 + OpenAI 互換エラー ({error:{message,type}})', async () => {
    // 未ロードのエンジン (loader は呼ばれない)。
    const engine = new LocalLlmEngine({ load: () => Promise.resolve(echoSession()) });
    const app = mount(llmRoutes(makeConfig(), { engine }));

    const res = await app.request('/api/llm/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe('local_llm_unavailable');
    expect(typeof body.error.message).toBe('string');
  });

  it('未ロードでも req.model が .loamium/models/llm/ に在れば遅延ロードして応答する (S8a3f2e-5)', async () => {
    // 内蔵モデルを配置。エンジンは未ロード。shim が req.model を遅延ロードする経路。
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'ondemand.gguf'), 'x');

    const engine = new LocalLlmEngine({ load: () => Promise.resolve(echoSession()) });
    expect(engine.isLoaded()).toBe(false);
    const app = mount(llmRoutes(makeConfig(), { engine }));

    const res = await app.request('/api/llm/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ondemand.gguf',
        messages: [{ role: 'user', content: 'lazy' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toContain('echo:');
    expect(body.choices[0]?.message.content).toContain('User: lazy');
    // 遅延ロードで実際にモデルがロードされたこと。
    expect(engine.isLoaded()).toBe(true);
  });

  it('未ロードで req.model が .loamium/models/llm/ に無ければ 503 (自動フォールバック無し)', async () => {
    const engine = new LocalLlmEngine({ load: () => Promise.resolve(echoSession()) });
    const app = mount(llmRoutes(makeConfig(), { engine }));
    const res = await app.request('/api/llm/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope.gguf', messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('local_llm_unavailable');
  });

  it('不正ボディ (messages 空) は 400', async () => {
    const engine = await loadedEngine('/x.gguf');
    const app = mount(llmRoutes(makeConfig(), { engine }));
    const res = await app.request('/api/llm/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/llm/v1/chat/completions (function calling / ADR-0025 amendment)', () => {
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'web_search',
        description: 'search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    },
  ];

  it('tools 付きリクエストで engine が functionCall を返すと OpenAI tool_calls を返す', async () => {
    const engine = await loadedEngine('/x.gguf');
    const app = mount(llmRoutes(makeConfig(), { engine }));

    const res = await app.request('/api/llm/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen.gguf',
        messages: [{ role: 'user', content: 'search loamium' }],
        tools,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: {
        message: { content: string | null; tool_calls?: { function: { name: string; arguments: string } }[] };
        finish_reason: string;
      }[];
    };
    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
    expect(body.choices[0]?.message.content).toBeNull();
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('web_search');
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe('{"q":"loamium"}');
  });

  it('後続の tool 結果メッセージ (role:tool) を含むリクエストは最終テキストを返す', async () => {
    const engine = await loadedEngine('/x.gguf');
    const app = mount(llmRoutes(makeConfig(), { engine }));

    const res = await app.request('/api/llm/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen.gguf',
        messages: [
          { role: 'user', content: 'search loamium' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_0', type: 'function', function: { name: 'web_search', arguments: '{"q":"loamium"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_0', content: 'RESULT: 3 pages' },
        ],
        tools,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string | null }; finish_reason: string }[];
    };
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.choices[0]?.message.content).toContain('chat-final');
  });
});

describe('POST /api/llm/v1/chat/completions (stream:true)', () => {
  it('text/event-stream で delta を送出し末尾 [DONE]', async () => {
    const engine = await loadedEngine('/x.gguf');
    const app = mount(llmRoutes(makeConfig(), { engine }));

    const res = await app.request('/api/llm/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    // delta チャンク + [DONE]
    expect(text).toContain('"delta"');
    expect(text).toContain('"content"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('stream:true でも未ロードは SSE 開始前に 503 エラー JSON', async () => {
    const engine = new LocalLlmEngine({ load: () => Promise.resolve(echoSession()) });
    const app = mount(llmRoutes(makeConfig(), { engine }));
    const res = await app.request('/api/llm/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('local_llm_unavailable');
  });
});

describe('GET /api/llm/v1/models (OpenAI models 形)', () => {
  it('内蔵 .gguf を {data:[{id}]} 形で返す', async () => {
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.gguf'), 'x');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x'); // 非 gguf は除外

    const app = mount(llmRoutes(makeConfig()));
    const res = await app.request('/api/llm/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: { id: string }[] };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual(['a.gguf']);
  });

  it('ディレクトリ不在でも空 data で 200', async () => {
    const app = mount(llmRoutes(makeConfig()));
    const res = await app.request('/api/llm/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });
});

// ============================================================
// S8a3f2e-3: モデル管理 REST
// ============================================================

describe('GET /api/llm/models', () => {
  it('不在なら空配列 200', async () => {
    const app = mount(llmRoutes(makeConfig()));
    const res = await app.request('/api/llm/models');
    expect(res.status).toBe(200);
    expect((await res.json()) as { models: unknown[] }).toEqual({ models: [] });
  });

  it('.gguf のみを [{id,filename,sizeBytes,path}] で返す', async () => {
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'model-a.gguf'), 'abcd');
    await fs.writeFile(path.join(dir, 'ignore.txt'), 'x');

    const app = mount(llmRoutes(makeConfig()));
    const res = await app.request('/api/llm/models');
    const body = (await res.json()) as {
      models: { id: string; filename: string; sizeBytes: number; path: string }[];
    };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]?.filename).toBe('model-a.gguf');
    expect(body.models[0]?.sizeBytes).toBe(4);
    expect(body.models[0]?.path).toBe('.loamium/models/llm/model-a.gguf');
  });
});

describe('POST /api/llm/models/download', () => {
  /** Content-Length 付きの body を返すスタブ fetch。 */
  function stubFetch(bytes: Buffer): FetchFn {
    return () =>
      Promise.resolve(
        new Response(Readable.toWeb(Readable.from([bytes])) as ReadableStream, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        }),
      );
  }

  it('封じ込め: llm/ 内へ保存し完了ステータスへ遷移する', async () => {
    const dm = new ModelDownloadManager(vaultRoot, stubFetch(Buffer.from('GGUFDATA')));
    const app = mount(llmRoutes(makeConfig(), { downloadManager: dm }));

    const res = await app.request('/api/llm/models/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/models/qwen.gguf' }),
    });
    expect(res.status).toBe(202);
    const acc = (await res.json()) as { id: string; filename: string; status: string };
    expect(acc.filename).toBe('qwen.gguf');

    // バックグラウンド DL の完了を待つ。
    await dm.getJob(acc.id)?.done;

    const statusRes = await app.request(`/api/llm/models/download/${acc.id}/status`);
    const st = (await statusRes.json()) as {
      status: string;
      receivedBytes: number;
      totalBytes: number | null;
    };
    expect(st.status).toBe('completed');
    expect(st.receivedBytes).toBe(8);
    expect(st.totalBytes).toBe(8);

    // ファイルは llm/ 内に実在する。
    const saved = path.join(modelKindDir(vaultRoot, 'llm'), 'qwen.gguf');
    expect((await fs.readFile(saved, 'utf8'))).toBe('GGUFDATA');
  });

  it('HTTP 非 2xx は failed ステータス + error (実 URL には発信しない)', async () => {
    const failFetch: FetchFn = () => Promise.resolve(new Response('nope', { status: 404 }));
    const dm = new ModelDownloadManager(vaultRoot, failFetch);
    const app = mount(llmRoutes(makeConfig(), { downloadManager: dm }));

    const res = await app.request('/api/llm/models/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/x.gguf', filename: 'x.gguf' }),
    });
    const acc = (await res.json()) as { id: string };
    await dm.getJob(acc.id)?.done;

    const st = (await (await app.request(`/api/llm/models/download/${acc.id}/status`)).json()) as {
      status: string;
      error?: string;
    };
    expect(st.status).toBe('failed');
    expect(st.error).toContain('404');
    // 部分ファイルは残らない。
    await expect(
      fs.stat(path.join(modelKindDir(vaultRoot, 'llm'), 'x.gguf.partial')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('パストラバーサル filename は FS 前に 400', async () => {
    const dm = new ModelDownloadManager(vaultRoot, stubFetch(Buffer.from('x')));
    const app = mount(llmRoutes(makeConfig(), { downloadManager: dm }));
    for (const bad of ['../evil.gguf', 'sub/dir.gguf', '..', '.hidden.gguf']) {
      const res = await app.request('/api/llm/models/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/a.gguf', filename: bad }),
      });
      expect(res.status, `filename=${bad}`).toBe(400);
    }
  });

  it('status ポーリングは未知 id で 404', async () => {
    const app = mount(llmRoutes(makeConfig()));
    const res = await app.request('/api/llm/models/download/nope/status');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/llm/models/:filename', () => {
  it('存在するモデルを削除する', async () => {
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'del.gguf'), 'x');

    const app = mount(llmRoutes(makeConfig()));
    const res = await app.request('/api/llm/models/del.gguf', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    await expect(fs.stat(path.join(dir, 'del.gguf'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('不在は 404', async () => {
    const app = mount(llmRoutes(makeConfig()));
    const res = await app.request('/api/llm/models/missing.gguf', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('不正名 (パス区切り) は FS 前に 400', async () => {
    const app = mount(llmRoutes(makeConfig()));
    const res = await app.request('/api/llm/models/..%2Fescape.gguf', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('ロード中モデルはアンロードしてから削除する', async () => {
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    const abs = path.join(dir, 'loaded.gguf');
    await fs.writeFile(abs, 'x');

    const engine = await loadedEngine(abs);
    expect(engine.isLoaded()).toBe(true);

    const app = mount(llmRoutes(makeConfig(), { engine }));
    const res = await app.request('/api/llm/models/loaded.gguf', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(engine.isLoaded()).toBe(false);
    await expect(fs.stat(abs)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
