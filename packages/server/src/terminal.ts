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
import { spawn, type IPty } from 'node-pty';
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

/** process.env から undefined を除いた pty 用 env を作る。 */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.TERM = 'xterm-256color';
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
    upgradeWebSocket(() => {
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
          try {
            proc = spawn(config.terminal.cmd, [], {
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
