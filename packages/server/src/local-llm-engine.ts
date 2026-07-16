/**
 * 内蔵オフライン LLM エンジン (ADR-0025 / S8a3f2e-1)。
 *
 * node-llama-cpp v3 (ESM, getLlama() → loadModel(gguf) → LlamaChatSession) を
 * 薄くラップし、`loadEngine(modelPath)` / `unloadEngine()` / `isLoaded()` /
 * `complete(prompt)` を提供する。バックエンド選択 (外部 / ローカルの明示選択)
 * はこの層の責務ではない (S8a3f2e-2/-4)。ここはエンジンの load/unload/推論のみ。
 *
 * ## 遅延ロード & 利用不可フォールバック (環境非依存の要)
 * node-llama-cpp はネイティブ addon を含む。dev VM / CI ではプレビルドが動かず
 * ソースビルドが要ることがある (GLIBC/gcc)。そこで:
 *   - `node-llama-cpp` は **動的 import** する。モジュールを import しただけでは
 *     addon をロードしない (loadEngine 呼び出し時に初めて import する)。
 *   - addon が無い / ロードできない場合は握りつぶさず `LocalLlmUnavailableError`
 *     を投げる。これは「モデル未ロード」と同様の *明示的な利用不可* であり、
 *     エラーの握りつぶしではない。server の起動・型チェック・他テストは
 *     このモジュールを import しても壊れない (addon ロードは遅延されるため)。
 *
 * ## 直列化 (単一ユーザーローカル前提 / ADR-0025 consequences)
 * ロード / アンロード / 推論は 1 本の Promise チェーン (mutex) で直列化する。
 * in-flight 中に来た新規要求はキュー末尾で順に処理される (同時推論はしない)。
 */

/**
 * エンジン利用不可 (addon 未ロード / モデル未ロード等) を表す明示エラー。
 * 呼び出し側 (shim / 選択ロジック) はこれを捕捉して「ローカル LLM は使えない」と
 * ユーザーへ返す。握りつぶし禁止の規約下でも *明示的な利用不可* は正当。
 */
export class LocalLlmUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LocalLlmUnavailableError';
  }
}

/** 推論オプション (最小サブセット; shim 側で拡張余地)。 */
export interface CompletionOptions {
  /** 生成上限トークン数。 */
  maxTokens?: number;
  /** サンプリング温度。 */
  temperature?: number;
}

/**
 * ロードされたモデルの 1 セッション。node-llama-cpp の LlamaChatSession を
 * 薄く包む最小面。テスト用スタブもこの面を満たせばよい。
 */
export interface LoadedSession {
  /** ユーザープロンプトに対する完了文字列を返す。 */
  prompt(text: string, options?: CompletionOptions): Promise<string>;
  /** モデル / コンテキスト / セッションを破棄する。 */
  dispose(): Promise<void>;
}

/**
 * エンジンローダー抽象。既定は node-llama-cpp を動的 import する実装
 * (`nodeLlamaCppLoader`)。テストは決定的スタブを注入して addon 無しで
 * ロード→completion→アンロードの往復を検証する (AC-S8a3f2e-1-3)。
 */
export interface EngineLoader {
  /**
   * gguf パスからセッションを 1 つ用意する。addon がロードできない場合は
   * `LocalLlmUnavailableError` を投げること。
   */
  load(modelPath: string): Promise<LoadedSession>;
}

/** ロード済みエンジンの内部状態。 */
interface EngineState {
  modelPath: string;
  session: LoadedSession;
}

/**
 * node-llama-cpp を動的 import する既定ローダー。
 * import / getLlama / loadModel のいずれで落ちても `LocalLlmUnavailableError`
 * に変換する (原因は cause に保持)。GPU があれば使い、無ければ CPU に自動で
 * フォールバックする (gpu: 'auto' が既定挙動)。
 */
export const nodeLlamaCppLoader: EngineLoader = {
  async load(modelPath: string): Promise<LoadedSession> {
    // 動的 import。addon の解決 (プレビルド or ローカルビルド) はここで初めて走る。
    let mod: typeof import('node-llama-cpp');
    try {
      mod = await import('node-llama-cpp');
    } catch (cause) {
      throw new LocalLlmUnavailableError(
        'node-llama-cpp をロードできません (ネイティブ addon 未ビルド / 未対応環境)。',
        { cause },
      );
    }

    const { getLlama, LlamaChatSession } = mod;

    try {
      // gpu: 'auto' — GPU (Metal/CUDA/Vulkan) があれば使い、無ければ CPU。
      const llama = await getLlama({ gpu: 'auto' });
      const model = await llama.loadModel({ modelPath });
      const context = await model.createContext();
      const chat = new LlamaChatSession({ contextSequence: context.getSequence() });

      return {
        async prompt(text: string, options?: CompletionOptions): Promise<string> {
          // exactOptionalPropertyTypes 下では undefined を明示的に渡さない
          // (未指定キーは node-llama-cpp 側の既定に委ねる)。
          const promptOptions: { maxTokens?: number; temperature?: number } = {};
          if (options?.maxTokens !== undefined) promptOptions.maxTokens = options.maxTokens;
          if (options?.temperature !== undefined) promptOptions.temperature = options.temperature;
          return chat.prompt(text, promptOptions);
        },
        async dispose(): Promise<void> {
          // セッション→コンテキスト→モデルの順に破棄。llama 本体は再利用され得るため残す。
          chat.dispose();
          await context.dispose();
          await model.dispose();
        },
      };
    } catch (cause) {
      throw new LocalLlmUnavailableError(
        `ローカルモデルのロードに失敗しました: ${modelPath}`,
        { cause },
      );
    }
  },
};

/**
 * 内蔵 LLM エンジン。単一インスタンス運用を想定 (単一ユーザーローカル)。
 * ロード / アンロード / 推論を 1 本の mutex で直列化する。
 */
export class LocalLlmEngine {
  private readonly loader: EngineLoader;
  private state: EngineState | null = null;
  /** 直列化用の末尾 Promise。全操作をこのチェーンに連ねる。 */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(loader: EngineLoader = nodeLlamaCppLoader) {
    this.loader = loader;
  }

  /** 操作を直列化キュー末尾に積み、順に実行する。 */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    // 前段の成否に関わらず次を走らせる (catch で連鎖を切らない)。
    const run = this.tail.then(op, op);
    // tail は「完了したか」だけを追えばよく、値/例外は run が持つ。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 現在モデルがロード済みか。 */
  isLoaded(): boolean {
    return this.state !== null;
  }

  /** ロード済みモデルの gguf パス (未ロードなら null)。 */
  loadedModelPath(): string | null {
    return this.state?.modelPath ?? null;
  }

  /**
   * gguf パスからモデルをロードする。既にロード済みなら先にアンロードして
   * 置き換える (同時に 2 モデルは持たない)。直列化される。
   * addon 不在等では `LocalLlmUnavailableError`。
   */
  loadEngine(modelPath: string): Promise<void> {
    return this.serialize(async () => {
      if (this.state) {
        await this.state.session.dispose();
        this.state = null;
      }
      const session = await this.loader.load(modelPath);
      this.state = { modelPath, session };
    });
  }

  /**
   * ロード済みモデルをアンロードする。未ロードなら no-op。直列化される。
   */
  unloadEngine(): Promise<void> {
    return this.serialize(async () => {
      if (!this.state) return;
      const { session } = this.state;
      this.state = null;
      await session.dispose();
    });
  }

  /**
   * ロード済みモデルで completion を実行する。直列化される
   * (in-flight 推論の完了後に順に処理)。未ロードなら `LocalLlmUnavailableError`。
   */
  complete(prompt: string, options?: CompletionOptions): Promise<string> {
    return this.serialize(async () => {
      if (!this.state) {
        throw new LocalLlmUnavailableError('モデルが未ロードです。先に loadEngine() を呼んでください。');
      }
      return this.state.session.prompt(prompt, options);
    });
  }
}
