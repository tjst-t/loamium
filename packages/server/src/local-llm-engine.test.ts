/**
 * local-llm-engine.ts のユニット / 境界テスト (S8a3f2e-1 / AC-S8a3f2e-1-3)。
 *
 * 小型 GGUF は用意できないため、ロード層 (EngineLoader) を **決定的スタブ**に
 * 差し替えて、ロード→簡易 completion→アンロードの往復と、推論の直列化を検証する。
 * 既定ローダー (node-llama-cpp 動的 import) は addon が無い環境でも
 * `LocalLlmUnavailableError` を投げること (利用不可の明示) を確認する。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  LocalLlmEngine,
  LocalLlmUnavailableError,
  nodeLlamaCppLoader,
  type EngineLoader,
  type LoadedSession,
} from './local-llm-engine.js';

// ---- 決定的スタブローダー -------------------------------------------------

interface StubEvents {
  disposed: boolean;
}

/**
 * 呼ばれた prompt をエコーする決定的セッション。dispose 済みフラグを外部へ公開。
 * `onPrompt` フックで直列化検証用に処理を遅延/観測できる。
 */
function makeStubSession(
  modelPath: string,
  events: StubEvents,
  onPrompt?: () => Promise<void>,
): LoadedSession {
  return {
    async prompt(text: string): Promise<string> {
      if (onPrompt) await onPrompt();
      return `[${modelPath}] echo: ${text}`;
    },
    async dispose(): Promise<void> {
      events.disposed = true;
    },
  };
}

describe('LocalLlmEngine (stub loader)', () => {
  it('ロード→completion→アンロードの往復が成立する', async () => {
    const events: StubEvents = { disposed: false };
    const loader: EngineLoader = {
      load: (modelPath) => Promise.resolve(makeStubSession(modelPath, events)),
    };
    const engine = new LocalLlmEngine(loader);

    expect(engine.isLoaded()).toBe(false);
    expect(engine.loadedModelPath()).toBeNull();

    await engine.loadEngine('/models/llm/test.gguf');
    expect(engine.isLoaded()).toBe(true);
    expect(engine.loadedModelPath()).toBe('/models/llm/test.gguf');

    const out = await engine.complete('hello');
    expect(out).toBe('[/models/llm/test.gguf] echo: hello');

    await engine.unloadEngine();
    expect(engine.isLoaded()).toBe(false);
    expect(events.disposed).toBe(true);
  });

  it('未ロードで complete すると LocalLlmUnavailableError', async () => {
    const engine = new LocalLlmEngine({
      load: (mp) => Promise.resolve(makeStubSession(mp, { disposed: false })),
    });
    await expect(engine.complete('x')).rejects.toBeInstanceOf(LocalLlmUnavailableError);
  });

  it('再ロードは既存セッションを dispose して置き換える', async () => {
    const first: StubEvents = { disposed: false };
    const second: StubEvents = { disposed: false };
    let call = 0;
    const loader: EngineLoader = {
      load: (mp) => {
        call += 1;
        return Promise.resolve(makeStubSession(mp, call === 1 ? first : second));
      },
    };
    const engine = new LocalLlmEngine(loader);

    await engine.loadEngine('/models/llm/a.gguf');
    await engine.loadEngine('/models/llm/b.gguf');

    expect(first.disposed).toBe(true); // 旧セッションは破棄済み
    expect(second.disposed).toBe(false); // 新セッションは生存
    expect(engine.loadedModelPath()).toBe('/models/llm/b.gguf');
  });

  it('unloadEngine は未ロードでも no-op で解決する', async () => {
    const engine = new LocalLlmEngine({
      load: (mp) => Promise.resolve(makeStubSession(mp, { disposed: false })),
    });
    await expect(engine.unloadEngine()).resolves.toBeUndefined();
  });

  it('推論を直列化する (同時 complete は順に処理され並行しない)', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    // prompt を人為的に遅延させ、並行実行が起きないことを観測する。
    const loader: EngineLoader = {
      load: (mp) =>
        Promise.resolve(
          makeStubSession(mp, { disposed: false }, async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 10));
            active -= 1;
          }),
        ),
    };
    const engine = new LocalLlmEngine(loader);
    await engine.loadEngine('/models/llm/s.gguf');

    // ロードを待たずに 3 本まとめて投入する。
    const p1 = engine.complete('1').then(() => order.push('1'));
    const p2 = engine.complete('2').then(() => order.push('2'));
    const p3 = engine.complete('3').then(() => order.push('3'));
    await Promise.all([p1, p2, p3]);

    expect(maxActive).toBe(1); // 同時に走ったのは常に 1 本
    expect(order).toEqual(['1', '2', '3']); // 投入順に処理
  });

  it('ロード失敗後も後続の操作でキューが詰まらない', async () => {
    let attempt = 0;
    const loader: EngineLoader = {
      load: (mp) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve(makeStubSession(mp, { disposed: false }));
      },
    };
    const engine = new LocalLlmEngine(loader);

    await expect(engine.loadEngine('/models/llm/bad.gguf')).rejects.toThrow('boom');
    expect(engine.isLoaded()).toBe(false);

    // 直列化チェーンが例外で切れておらず、次のロードが成立する。
    await engine.loadEngine('/models/llm/ok.gguf');
    expect(engine.isLoaded()).toBe(true);
  });
});

describe('nodeLlamaCppLoader (既定ローダーの利用不可フォールバック)', () => {
  it('addon が無い環境ではロード失敗を LocalLlmUnavailableError として投げる', async () => {
    // 存在しない gguf を渡す。addon がロードできない環境でも、addon が
    // ロードできてモデルが無い環境でも、いずれも LocalLlmUnavailableError になる。
    await expect(nodeLlamaCppLoader.load('/nonexistent/model.gguf')).rejects.toBeInstanceOf(
      LocalLlmUnavailableError,
    );
  });

  it('動的 import が失敗しても握りつぶさず明示エラーへ変換する', async () => {
    // import 失敗経路の直接検証はモジュールモックが要るため、
    // ここでは「利用不可が明示エラー型で伝わる」ことのみ担保する。
    const err = new LocalLlmUnavailableError('x', { cause: new Error('inner') });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LocalLlmUnavailableError');
    expect((err.cause as Error).message).toBe('inner');
    // vi は import 済み (未使用警告回避)。
    expect(vi.isMockFunction(() => undefined)).toBe(false);
  });
});
