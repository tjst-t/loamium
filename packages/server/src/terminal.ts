/**
 * ターミナルブリッジ — WS /api/terminal + node-pty (Sb7f458-1 / SPEC §6)。
 *
 * pty はブラウザから任意コマンド実行に等しいため、三重ガードで守る:
 *   1. LOAMIUM_TERMINAL=1 の明示オプトイン (未設定はデフォルト無効)
 *   2. LOAMIUM_MODE=full 必須 (read-only / append-only では無効)
 *   3. バインド先は既定 127.0.0.1 (index.ts — LOAMIUM_HOST で明示上書きのみ)
 * 1・2 は起動時に config.terminal.enabled として確定し (config.ts)、
 * 無効時は upgrade せず 403 を返す (WS 接続は確立しない)。
 *
 * セッション:
 *   - 接続ごとに vault を cwd とした pty (コマンドは LOAMIUM_TERMINAL_CMD、既定 claude)
 *   - クライアント → {type:'input'|'resize'} / サーバー → {type:'output'|'exit'} の JSON
 *   - 切断時は SIGTERM → 3 秒後に未終了なら SIGKILL で子プロセスを確実に終了
 *   - セッションの開始・終了だけを audit.log へ記録する。入出力・コマンド内容は
 *     一切記録しない (vault は機微情報を含みうる — DESIGN_PRINCIPLES priority 2)
 */
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import {
  terminalClientMessageSchema,
  type TerminalServerMessage,
} from '@loamium/shared';
import type { ServerConfig } from './config.js';
import { writeAuditEntry } from './audit.js';
import { errorJson, setAudit, type AppEnv } from './http.js';

/** SIGTERM 後にこの時間で終了しなければ SIGKILL へエスカレーションする。 */
const SIGKILL_ESCALATION_MS = 3000;

/**
 * node-pty はネイティブモジュール (build/Release/pty.node)。ターミナルは既定無効の
 * オプトイン機能なので、モジュール読み込み時ではなく「実際に pty を spawn する瞬間」
 * まで遅延ロードする。これによりネイティブモジュールが無い/ロードできない環境でも
 * サーバー本体は起動でき (DESIGN_PRINCIPLES priority 2: 任意機能がコアを壊さない)、
 * ターミナル無効時は node-pty に一切触れない。キャッシュして 2 回目以降は即返す。
 */
let ptyModule: typeof import('node-pty') | null = null;
function loadPty(): typeof import('node-pty') {
  if (ptyModule === null) {
    const require = createRequire(import.meta.url);
    ptyModule = require('node-pty') as typeof import('node-pty');
  }
  return ptyModule;
}

/** 稼働中セッションの pty (サーバーシャットダウン時の一括終了用)。 */
const activeSessions = new Set<IPty>();

/** サーバー停止時に全セッションの子プロセスを終了させる。 */
export function killAllTerminalSessions(): void {
  for (const proc of activeSessions) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // 既に終了済み
    }
  }
  activeSessions.clear();
}

/**
 * cross-site WebSocket hijacking (CSWSH) 対策の Origin 検査。
 *
 * ブラウザは WebSocket ハンドシェイクに same-origin ポリシーを強制しないため、
 * ターミナル有効中にユーザーのブラウザで開いた任意のページが
 * ws://127.0.0.1:<port>/api/terminal に接続してコマンドを実行できてしまう
 * (127.0.0.1 バインドは localhost 到達を防げない → ローカル RCE)。
 * pty = 任意コマンド実行なので、三重ガードに加えて Origin を検証する
 * (DESIGN_PRINCIPLES priority 2: データ安全性 > 開発速度)。
 *
 * ターミナルの想定運用はループバック (既定 127.0.0.1 バインド、UI もローカル)。
 * 実際の CSWSH 脅威は「ユーザーが訪れた *遠隔* サイト (例 evil.example) が
 * 127.0.0.1 へ WS を張る」ケース。その Origin は遠隔ホストになるので弾ける。
 * 一方、正規の UI は Vite 開発サーバー (localhost:<uiPort>) が /api をプロキシする
 * ため、実サーバーから見た Origin は localhost だが Host は 127.0.0.1:<apiPort> と
 * ポートが食い違う。そこで:
 *
 * - Origin ヘッダ無し (curl / CLI / ws テストクライアント等の非ブラウザ) は許可
 * - Origin の host が Host と完全一致する same-origin は許可
 * - Origin の hostname がループバック (localhost / 127.0.0.1 / ::1) なら許可
 *   (ローカルで配信された UI / プロキシ経由の正規アクセス)
 * - LOAMIUM_TERMINAL_ALLOWED_ORIGINS に列挙した Origin と一致すれば許可 (S79c210-3)。
 *   `*.example.com` 形式はそのサブドメイン全体を許可する (apex や別ドメインは弾く)
 * - それ以外 (遠隔サイトの Origin) は拒否
 *
 * 注: LOAMIUM_HOST=0.0.0.0 で LAN 公開した場合、LAN の別オリジンからのアクセスは
 * ループバックではないため既定では拒否される。LAN の別デバイスから使いたい場合は
 * LOAMIUM_TERMINAL_ALLOWED_ORIGINS にそのオリジンを明示列挙する (CSWSH 保護は
 * 列挙分だけ低下する — README / ARCHITECTURE に警告付きで記載)。それ以外の LAN 公開は
 * Cloudflare Access 等の認証層を前提とする。
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[] = [],
): boolean {
  if (origin === undefined || origin === '') return true; // 非ブラウザクライアント
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // 壊れた Origin は拒否
  }
  if (host !== undefined && url.host === host) return true; // 完全一致 same-origin
  if (LOOPBACK_HOSTS.has(url.hostname)) return true; // ローカル配信の UI
  return allowedOrigins.some((entry) => originMatchesAllowed(url, entry)); // 明示許可リスト
}

/**
 * 許可エントリと Origin URL の一致判定。
 * - 通常エントリ: URL.origin の完全一致 (scheme+host+port)
 * - ワイルドカード `*.base` / `scheme://*.base`: base のサブドメインにのみ一致する。
 *   ドット境界でのみ一致するため apex (base 自体) や eviltjstkm.net は弾く。port は任意、
 *   scheme を明示した場合はその scheme に限定する。
 */
function originMatchesAllowed(url: URL, entry: string): boolean {
  const sep = entry.indexOf('://');
  const hostPart = sep === -1 ? entry : entry.slice(sep + 3);
  if (!hostPart.startsWith('*.')) return url.origin === entry; // 通常エントリは完全一致
  const scheme = sep === -1 ? null : entry.slice(0, sep);
  if (scheme !== null && url.protocol !== `${scheme}:`) return false;
  const base = hostPart.slice(2);
  const host = url.hostname.toLowerCase();
  return host.endsWith(`.${base}`) && host.length > base.length + 1;
}

/**
 * Claude Code のネスト検出変数。既定コマンド claude を pty で起動するとき、
 * サーバー自身が Claude Code 配下で動いていると子 claude が「Claude Code 内で
 * 起動された」と誤認して挙動が変わる/即終了しうる (milestone review ① の切断バグ)。
 * pty は独立した対話セッションなので、これらは継承せず落とす (AC-Sf1a90a-2-2)。
 */
const CLAUDE_NEST_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

/**
 * process.env から undefined を除いた pty 用 env を作る。
 * 既定 claude が信頼プロンプトまで確実に到達するよう TERM/COLORTERM/ロケールを整える
 * (AC-Sf1a90a-2-2)。cwd は呼び出し側で vaultRoot を渡す。
 */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const k of CLAUDE_NEST_ENV_KEYS) delete env[k];
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // CJK を含む vault 名/パスの表示崩れを避ける。既存指定があれば尊重する。
  if (env.LANG === undefined || env.LANG === '') env.LANG = 'C.UTF-8';
  return env;
}

async function auditSession(
  config: ServerConfig,
  op: 'terminal.session_start' | 'terminal.session_end',
): Promise<void> {
  await writeAuditEntry(config, {
    ts: new Date().toISOString(),
    op,
    path: '/api/terminal',
    mode: config.mode,
    result: 'ok',
    status: 101,
  });
}

/**
 * /api/terminal を登録する。無効時は upgrade しない通常の 403 ハンドラを登録する
 * (接続拒否は監査ログに result: denied で残る)。
 */
export function registerTerminalRoute(
  app: Hono<AppEnv>,
  config: ServerConfig,
  upgradeWebSocket: UpgradeWebSocket,
): void {
  if (!config.terminal.enabled) {
    app.get('/api/terminal', (c) => {
      setAudit(c, 'terminal.connect', '/api/terminal');
      const detail =
        config.terminal.reason === 'mode_not_full'
          ? `mode=${config.mode}: the terminal requires LOAMIUM_MODE=full`
          : 'the terminal is disabled by default';
      return errorJson(
        c,
        403,
        'forbidden',
        `${detail}. Start the server with LOAMIUM_TERMINAL=1 and LOAMIUM_MODE=full to enable it (SPEC §6 explicit opt-in).`,
      );
    });
    return;
  }

  app.get(
    '/api/terminal',
    upgradeWebSocket((c) => {
      // CSWSH 対策: cross-origin のブラウザ接続はハンドシェイク時点で弾く。
      // 非ブラウザ (Origin 無し) と same-origin のみ pty を起動する。
      const originOk = isAllowedOrigin(
        c.req.header('origin'),
        c.req.header('host'),
        config.terminal.allowedOrigins,
      );
      let proc: IPty | null = null;
      let exited = false;

      const endSession = (): void => {
        if (proc === null) return;
        activeSessions.delete(proc);
        void auditSession(config, 'terminal.session_end');
      };

      return {
        onOpen(_evt, ws) {
          const send = (msg: TerminalServerMessage): void => {
            // pty の onData は WS が閉じ始めた後にも発火しうる。閉じた/閉じ中の
            // ソケットへ送ると ws が throw するので readyState を確認する
            if (ws.readyState !== 1 /* OPEN */) return;
            ws.send(JSON.stringify(msg));
          };
          if (!originOk) {
            // cross-origin は pty を起動せず即座に閉じ、監査に denied を残す
            void writeAuditEntry(config, {
              ts: new Date().toISOString(),
              op: 'terminal.connect',
              path: '/api/terminal',
              mode: config.mode,
              result: 'denied',
              status: 403,
            });
            ws.close(1008, 'origin not allowed');
            return;
          }
          try {
            proc = loadPty().spawn(config.terminal.cmd, [], {
              name: 'xterm-256color',
              cols: 80,
              rows: 24,
              cwd: config.vaultRoot,
              env: ptyEnv(),
            });
          } catch (err) {
            // コマンドが存在しない等。理由を出力として見せてから閉じる
            send({
              type: 'output',
              data: `failed to start ${config.terminal.cmd}: ${String(err)}\r\n`,
            });
            send({ type: 'exit', exitCode: -1 });
            ws.close(1011, 'terminal spawn failed');
            return;
          }
          activeSessions.add(proc);
          void auditSession(config, 'terminal.session_start');

          proc.onData((data) => {
            send({ type: 'output', data });
          });
          proc.onExit(({ exitCode }) => {
            exited = true;
            endSession();
            // クライアントへ終了を通知してから WS を閉じる (UI は再接続バーを出す)
            send({ type: 'exit', exitCode });
            ws.close(1000, 'process exited');
          });
        },

        onMessage(evt) {
          if (proc === null || exited) return;
          if (typeof evt.data !== 'string') return; // バイナリフレームは扱わない
          let raw: unknown;
          try {
            raw = JSON.parse(evt.data);
          } catch {
            return; // 不正フレームは無視 (セッションは落とさない)
          }
          const parsed = terminalClientMessageSchema.safeParse(raw);
          if (!parsed.success) return;
          const msg = parsed.data;
          if (msg.type === 'input') {
            proc.write(msg.data);
          } else {
            proc.resize(msg.cols, msg.rows);
          }
        },

        onClose() {
          // 切断時に子プロセスを確実に終了する (SIGTERM → SIGKILL)
          const p = proc;
          if (p === null || exited) return;
          try {
            p.kill('SIGTERM');
          } catch {
            // 既に終了している場合
          }
          const timer = setTimeout(() => {
            if (!exited) {
              try {
                p.kill('SIGKILL');
              } catch {
                // 既に終了している場合
              }
            }
          }, SIGKILL_ESCALATION_MS);
          timer.unref();
          // session_end は onExit (SIGTERM/SIGKILL 到達後) が記録する
        },

        onError() {
          // onClose と同じ経路で回収される (@hono/node-ws は error 後に close を発火する)
        },
      };
    }),
  );
}
