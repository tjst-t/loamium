/**
 * バックエンド明示選択・非フォールバックのユニット / 統合テスト
 * (S8a3f2e-2 / AC-S8a3f2e-2-4 / ADR-0025 amendment)。
 *
 * - resolveBackend: ユーザーが選んだ backend に従い api/baseUrl/apiKey/model を返す。
 *   未準備 (local だがモデル未選択/未存在、external だがキー空) は
 *   AgentBackendNotReadyError で接続無効。他方へ暗黙に切り替えない。
 * - 統合: local 選択時の baseUrl が shim (/api/llm/v1) を指し、その URL に
 *   実際に mount した shim ルート経由で 1 ターンが成立する (エンジンはスタブ)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import {
  resolveBackend,
  makeLocalBackendResolver,
  AgentBackendNotReadyError,
} from './agent-service.js';
import type { AppEnv } from './http.js';
import type { ServerConfig } from './config.js';
import { llmRoutes, localLlmBaseUrl } from './routes/llm.js';
import { LocalLlmEngine, type EngineLoader, type LoadedSession } from './local-llm-engine.js';
import { modelKindDir } from './model-paths.js';
import type { AgentConfig } from '@loamium/shared';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loamium-backend-'));
});
afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

const baseConfig: AgentConfig = {
  api: 'openai',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-x',
  apiKey: 'sk-real',
};

describe('resolveBackend (明示選択・非フォールバック)', () => {
  it('backend 未指定は external として従来どおり', () => {
    const r = resolveBackend(baseConfig);
    expect(r).toEqual({
      api: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-real',
      model: 'gpt-x',
    });
  });

  it('external でキー空なら未準備 (local へ暗黙切替しない)', () => {
    const cfg: AgentConfig = { ...baseConfig, apiKey: '' };
    // resolver を渡しても external 選択のまま未準備で投げる (local へ落ちない)。
    let localResolverCalled = false;
    expect(() =>
      resolveBackend(cfg, () => {
        localResolverCalled = true;
        return { baseUrl: 'x', apiKey: 'y', model: 'z' };
      }),
    ).toThrow(AgentBackendNotReadyError);
    expect(localResolverCalled).toBe(false);
  });

  it('backend=local + localModel 選択で shim URL・ダミーキーへ向ける', () => {
    const cfg: AgentConfig = { ...baseConfig, backend: 'local', localModel: 'qwen.gguf' };
    const r = resolveBackend(cfg, (m) => ({
      baseUrl: 'http://127.0.0.1:3000/api/llm/v1',
      apiKey: 'local',
      model: m,
    }));
    expect(r.api).toBe('openai');
    expect(r.baseUrl).toBe('http://127.0.0.1:3000/api/llm/v1');
    expect(r.apiKey).toBe('local');
    expect(r.model).toBe('qwen.gguf');
  });

  it('backend=local だが localModel 未選択なら未準備 (external へ暗黙切替しない)', () => {
    const cfg: AgentConfig = { ...baseConfig, backend: 'local' };
    expect(() => resolveBackend(cfg, () => ({ baseUrl: 'x', apiKey: 'y', model: 'z' }))).toThrow(
      AgentBackendNotReadyError,
    );
  });
});

describe('makeLocalBackendResolver (モデル存在で未準備を判定)', () => {
  it('モデル未存在なら AgentBackendNotReadyError (external へ落ちない)', () => {
    const resolver = makeLocalBackendResolver(vaultRoot);
    expect(() => resolver('missing.gguf')).toThrow(AgentBackendNotReadyError);
  });

  it('モデル実在なら shim baseUrl を返す', async () => {
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'present.gguf'), 'x');

    const resolver = makeLocalBackendResolver(vaultRoot);
    const r = resolver('present.gguf');
    expect(r.baseUrl).toBe(localLlmBaseUrl());
    expect(r.baseUrl.endsWith('/api/llm/v1')).toBe(true);
    expect(r.model).toBe('present.gguf');
  });

  it('不正なモデル名は未準備扱い (パス封じ込め)', () => {
    const resolver = makeLocalBackendResolver(vaultRoot);
    expect(() => resolver('../escape.gguf')).toThrow(AgentBackendNotReadyError);
  });
});

describe('[AC-S8a3f2e-5-3] 明示選択の 4 パターン回帰 (自動フォールバック無し)', () => {
  it('パターン1: backend=external はローカルモデルが在っても外部を使う', async () => {
    // ローカルモデルを実在させても、external 選択なら resolver は呼ばれず外部 baseUrl。
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'present.gguf'), 'x');

    const cfg: AgentConfig = { ...baseConfig, backend: 'external', localModel: 'present.gguf' };
    let localResolverCalled = false;
    const r = resolveBackend(cfg, () => {
      localResolverCalled = true;
      return { baseUrl: makeLocalBackendResolver(vaultRoot)('present.gguf').baseUrl, apiKey: 'local', model: 'present.gguf' };
    });
    expect(localResolverCalled).toBe(false); // ローカルへ落ちない
    expect(r.baseUrl).toBe('https://api.example.com/v1');
    expect(r.apiKey).toBe('sk-real');
    expect(r.model).toBe('gpt-x');
  });

  it('パターン2: backend=local かつモデル在りなら内蔵 (shim) を使う', async () => {
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'present.gguf'), 'x');

    const cfg: AgentConfig = { ...baseConfig, backend: 'local', localModel: 'present.gguf' };
    const r = resolveBackend(cfg, makeLocalBackendResolver(vaultRoot));
    expect(r.baseUrl).toBe(localLlmBaseUrl());
    expect(r.baseUrl.endsWith('/api/llm/v1')).toBe(true);
    expect(r.model).toBe('present.gguf');
    // 外部キーは使わない (shim は無認証、apiKey はダミー)。
    expect(r.apiKey).not.toBe('sk-real');
  });

  it('パターン3: backend=local だがモデル無しは未準備 (external へ自動フォールバックしない)', () => {
    const cfg: AgentConfig = { ...baseConfig, backend: 'local', localModel: 'missing.gguf' };
    // resolver がモデル未存在で AgentBackendNotReadyError を投げ、external へ落ちない。
    expect(() => resolveBackend(cfg, makeLocalBackendResolver(vaultRoot))).toThrow(
      AgentBackendNotReadyError,
    );
    try {
      resolveBackend(cfg, makeLocalBackendResolver(vaultRoot));
    } catch (err) {
      expect(err).toBeInstanceOf(AgentBackendNotReadyError);
      expect((err as AgentBackendNotReadyError).backend).toBe('local');
    }
  });

  it('パターン4: backend=external だがキー無しは未準備 (local へ自動フォールバックしない)', async () => {
    // ローカルモデルが在っても、external 未準備は local へ落ちない。
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'present.gguf'), 'x');

    const cfg: AgentConfig = {
      ...baseConfig,
      backend: 'external',
      apiKey: '',
      localModel: 'present.gguf',
    };
    let localResolverCalled = false;
    expect(() =>
      resolveBackend(cfg, () => {
        localResolverCalled = true;
        return { baseUrl: 'x', apiKey: 'y', model: 'z' };
      }),
    ).toThrow(AgentBackendNotReadyError);
    expect(localResolverCalled).toBe(false); // local へ落ちない
  });
});

describe('統合: local 選択の baseUrl 経由で shim 1 ターンが成立する', () => {
  function echoEngine(): LocalLlmEngine {
    const loader: EngineLoader = {
      load: (): Promise<LoadedSession> =>
        Promise.resolve({
          prompt: (t: string) => Promise.resolve(`local-answer to: ${t}`),
          chat: () => Promise.resolve({ kind: 'text' as const, content: 'local-answer' }),
          dispose: () => Promise.resolve(),
        }),
    };
    return new LocalLlmEngine(loader);
  }

  it('resolveBackend の baseUrl パス + shim ルートで chat.completion が返る', async () => {
    // 内蔵モデルを配置し、resolver が shim baseUrl を返すことを確認。
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'qwen.gguf'), 'x');

    const cfg: AgentConfig = { ...baseConfig, backend: 'local', localModel: 'qwen.gguf' };
    const resolved = resolveBackend(cfg, makeLocalBackendResolver(vaultRoot));
    // baseUrl は shim。pi はこれに /chat/completions を付けて叩く。
    const chatPath = new URL(`${resolved.baseUrl}/chat/completions`).pathname;
    expect(chatPath).toBe('/api/llm/v1/chat/completions');

    // 同じパスへ mount した shim へ 1 ターン (エンジンはスタブ)。
    const engine = echoEngine();
    await engine.loadEngine(path.join(dir, 'qwen.gguf'));
    const config: ServerConfig = { vaultRoot, mode: 'full', maxUploadBytes: 1024 };
    const app = new Hono<AppEnv>();
    app.route('/', llmRoutes(config, { engine }));

    const res = await app.request(chatPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: resolved.model,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toContain('local-answer to:');
    expect(body.choices[0]?.message.content).toContain('User: ping');
  });
});
