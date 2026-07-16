/**
 * オフライン egress ガード (S8a3f2e-5 / AC-S8a3f2e-5-2)。
 *
 * オフライン acceptance を CI で決定的に回すために、サーバープロセスの
 * `globalThis.fetch` を差し替え、ループバック (127.0.0.1 / ::1 / localhost) 以外への
 * 発信を **拒否** する。これにより「backend=local 選択時に外部 baseUrl へ発信が
 * 一切起きないこと」を、経路の外側 (fetch 層) で強制・観測できる。
 *
 * - ループバック宛て (pi → shim = 127.0.0.1:PORT/api/llm/v1) はそのまま素の fetch へ委譲。
 * - それ以外のホストは ExternalEgressBlockedError を投げ、ブロック件数を数える。
 * - 環境変数 `LOAMIUM_BLOCK_EXTERNAL_FETCH=1` のとき index.ts が install する。
 *   本番コードパスには一切影響しない (フラグ未設定なら no-op)。
 *
 * これはテストのためのネットワーク遮断ハーネスであり、アプリのロジックには
 * 手を入れない。外部発信ゼロを「遮断で失敗させて観測する」方式 (AC-5-2)。
 */

/** 外部ホストへの fetch がブロックされたことを示すエラー。 */
export class ExternalEgressBlockedError extends Error {
  readonly host: string;
  constructor(host: string, url: string) {
    super(`external egress blocked (offline harness): ${host} (${url})`);
    this.name = 'ExternalEgressBlockedError';
    this.host = host;
  }
}

/** ループバック (自プロセス到達) と見なすホスト名か判定する。 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::ffff:127.0.0.1') return true;
  // 127.0.0.0/8 はすべてループバック。
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/** install 済みガードの参照 (二重 install 防止 + カウンタ公開)。 */
interface EgressGuardHandle {
  /** ブロックした外部発信の回数。 */
  blockedCount: number;
  /** ループバックへ委譲した回数。 */
  allowedCount: number;
  /** ガードを外し素の fetch へ戻す。 */
  uninstall: () => void;
}

let installed: EgressGuardHandle | null = null;

/** install 済みガードのカウンタを返す (未 install なら null)。テスト観測用。 */
export function egressGuardStats(): { blockedCount: number; allowedCount: number } | null {
  if (!installed) return null;
  return { blockedCount: installed.blockedCount, allowedCount: installed.allowedCount };
}

/**
 * `globalThis.fetch` を egress ガードで包む。既に install 済みなら既存ハンドルを返す。
 *
 * pi (openai-completions アダプタ) は最終的に `globalThis.fetch` を使うため、
 * 差し替え後は shim (127.0.0.1) 宛てのみ通り、外部 baseUrl 宛ては即失敗する。
 * Loamium は pi の configureHttpDispatcher を呼ばない (SDK 直利用) ため、
 * この差し替えが上書きされることはない。
 */
export function installEgressGuard(): EgressGuardHandle {
  if (installed) return installed;

  // 元の参照をそのまま保持する (uninstall で identity を保つため bind しない)。
  const original = globalThis.fetch;
  const callOriginal: typeof fetch = (input, init) =>
    original.call(globalThis, input, init);

  const handle: EgressGuardHandle = {
    blockedCount: 0,
    allowedCount: 0,
    uninstall: () => {
      globalThis.fetch = original;
      installed = null;
    },
  };

  const guarded: typeof fetch = (input, init) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let host: string;
    try {
      host = new URL(rawUrl).hostname;
    } catch {
      // URL として解釈できない入力は素の fetch に委ねる (相対 URL 等はサーバー内では発生しない)。
      handle.allowedCount += 1;
      return callOriginal(input, init);
    }
    if (!isLoopbackHost(host)) {
      handle.blockedCount += 1;
      return Promise.reject(new ExternalEgressBlockedError(host, rawUrl));
    }
    handle.allowedCount += 1;
    return callOriginal(input, init);
  };

  globalThis.fetch = guarded;
  installed = handle;
  return handle;
}
