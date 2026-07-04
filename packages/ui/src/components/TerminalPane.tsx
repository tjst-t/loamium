/**
 * ターミナルタブ (Sb7f458-2 — prototype/terminal.html)。
 *
 * xterm.js + fit addon で WS /api/terminal (node-pty ブリッジ) と対話する。
 * 3 状態: 接続中 (terminal) / 切断 (terminal-reconnect-bar + terminal-reconnect) /
 * サーバー側で無効 (terminal-disabled — 理由と有効化手順)。
 * 機能フラグは GET /api/health の terminal 拡張で検出する。
 * ダークテーマはこのターミナルペインのみ (プロトタイプ準拠)。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  terminalServerMessageSchema,
  type TerminalClientMessage,
  type TerminalDisabledReason,
} from '@loamium/shared';
import { api } from '../api.js';
import { TerminalIcon, WarnTriangleIcon } from '../icons.js';

export type TerminalStatus =
  | 'loading'
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'disconnected';

interface TerminalPaneProps {
  /** タブで表示中か (非表示中もセッションは維持する) */
  active: boolean;
  /** 接続状態の変化 (タブの live-dot 用) */
  onStatusChange: (status: TerminalStatus) => void;
  /** health から得たコマンド名 (タブラベル「ターミナル — claude」用) */
  onCmdDetected: (cmd: string) => void;
}

/** health 取得失敗 (サーバー停止等) も「無効」として扱うときの擬似 reason。 */
type DisabledReason = TerminalDisabledReason | 'health_unreachable';

/** プロトタイプの terminal-pane 配色に合わせた xterm ダークテーマ。 */
const XTERM_THEME = {
  background: '#17171f',
  foreground: '#c9c9d6',
  cursor: '#c9c9d6',
  selectionBackground: '#3d3d52',
};

function wsEndpoint(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/terminal`;
}

export function TerminalPane({
  active,
  onStatusChange,
  onCmdDetected,
}: TerminalPaneProps): JSX.Element {
  const [status, setStatusRaw] = useState<TerminalStatus>('loading');
  const [disabledReason, setDisabledReason] = useState<DisabledReason>('terminal_env_not_set');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const disposedRef = useRef(false);
  /** StrictMode の二重 effect 実行で古い init が二重接続しないための世代番号 */
  const initGenRef = useRef(0);

  const setStatus = useCallback(
    (s: TerminalStatus): void => {
      setStatusRaw(s);
      onStatusChange(s);
    },
    [onStatusChange],
  );

  /** ホスト要素のサイズに合わせて xterm を追従させ、pty へも伝える。 */
  const fitToHost = useCallback((): void => {
    const host = hostRef.current;
    const fit = fitRef.current;
    if (host === null || fit === null) return;
    // display:none (非アクティブタブ) 中はサイズ 0 なので何もしない
    if (host.clientWidth === 0 || host.clientHeight === 0) return;
    fit.fit();
  }, []);

  const ensureTerminal = useCallback((): Terminal | null => {
    if (termRef.current !== null) return termRef.current;
    const host = hostRef.current;
    if (host === null) return null;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Noto Sans Mono CJK JP", monospace',
      theme: XTERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        const msg: TerminalClientMessage = { type: 'input', data };
        ws.send(JSON.stringify(msg));
      }
    });
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        const msg: TerminalClientMessage = { type: 'resize', cols, rows };
        ws.send(JSON.stringify(msg));
      }
    });
    termRef.current = term;
    fitRef.current = fit;
    return term;
  }, []);

  const connect = useCallback((): void => {
    const term = ensureTerminal();
    if (term === null) return;
    setStatus('connecting');
    // 既存ソケットが残っていれば閉じてから張り直す (二重セッション防止)
    if (wsRef.current !== null) {
      const old = wsRef.current;
      wsRef.current = null;
      old.close();
    }
    const ws = new WebSocket(wsEndpoint());
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus('connected');
      // 現在の表示サイズを pty へ伝える (fit → onResize → resize メッセージ)
      fitToHost();
      const msg: TerminalClientMessage = { type: 'resize', cols: term.cols, rows: term.rows };
      ws.send(JSON.stringify(msg));
      term.focus();
    };
    ws.onmessage = (evt: MessageEvent) => {
      if (typeof evt.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(evt.data);
      } catch {
        return;
      }
      const parsed = terminalServerMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      if (parsed.data.type === 'output') {
        term.write(parsed.data.data);
      }
      // type 'exit' はサーバーが直後に close するため onclose 側で扱う
    };
    ws.onclose = () => {
      if (wsRef.current !== ws || disposedRef.current) return;
      wsRef.current = null;
      term.write('\r\n\x1b[2m[接続が終了しました]\x1b[0m\r\n');
      setStatus('disconnected');
    };
  }, [ensureTerminal, fitToHost, setStatus]);

  /** health で機能フラグを確認してから接続する (無効なら接続を試みない)。 */
  const init = useCallback(async (): Promise<void> => {
    const gen = ++initGenRef.current;
    setStatus('loading');
    try {
      const health = await api.getHealth();
      // 破棄済み・より新しい init が走っている場合は何もしない (StrictMode 二重実行)
      if (disposedRef.current || initGenRef.current !== gen) return;
      if (!health.terminal.enabled) {
        setDisabledReason(health.terminal.reason ?? 'terminal_env_not_set');
        setStatus('disabled');
        return;
      }
      if (health.terminal.cmd !== undefined) onCmdDetected(health.terminal.cmd);
      connect();
    } catch {
      if (disposedRef.current || initGenRef.current !== gen) return;
      setDisabledReason('health_unreachable');
      setStatus('disabled');
    }
  }, [connect, onCmdDetected, setStatus]);

  useEffect(() => {
    disposedRef.current = false;
    void init();
    return () => {
      disposedRef.current = true;
      wsRef.current?.close();
      wsRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 初回マウント時のみ実行する (StrictMode の 2 重実行には initGenRef で耐える)
  }, []);

  // ウィンドウ / ペインのリサイズ追従 (AC-Sb7f458-2-1)
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const observer = new ResizeObserver(() => {
      fitToHost();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, [fitToHost]);

  // タブが再表示されたとき (display:none 解除) にサイズを合わせ直す
  useEffect(() => {
    if (active) {
      fitToHost();
      termRef.current?.focus();
    }
  }, [active, fitToHost]);

  const reconnect = useCallback((): void => {
    termRef.current?.reset();
    connect();
  }, [connect]);

  return (
    <div
      className="terminal-wrap"
      style={{ display: active ? 'flex' : 'none' }}
      data-terminal-status={status}
    >
      {status === 'disabled' && (
        <div className="empty-state" data-testid="terminal-disabled">
          <div className="glyph">
            <TerminalIcon />
          </div>
          {disabledReason === 'health_unreachable' ? (
            <>
              <h2>サーバーに接続できません</h2>
              <p>
                ターミナルの状態を確認できませんでした。Loamium サーバーが起動しているか確認して、
                もう一度お試しください。
              </p>
              <button className="btn primary" onClick={() => void init()}>
                再試行
              </button>
            </>
          ) : (
            <>
              <h2>ターミナルは無効になっています</h2>
              <p>
                ターミナルは vault 上で任意コマンドを実行できるため、<strong>デフォルト無効</strong>
                です。 サーバーを次の設定で起動した場合のみ有効になります(SPEC §6 の明示オプトイン)。
              </p>
              <pre className="setup-code">
                <span className="cmt"># 1. 明示オプトイン(full モード必須)</span>
                {'\n'}
                <span className="env">LOAMIUM_TERMINAL=1</span>{' '}
                <span className="env">LOAMIUM_MODE=full</span> loamium serve
                {'\n\n'}
                <span className="cmt"># 2. 起動コマンドを変える場合(デフォルト: claude)</span>
                {'\n'}
                <span className="env">LOAMIUM_TERMINAL_CMD=bash</span> でシェルも指定可
              </pre>
              <p className="terminal-disabled-current">
                現在のサーバー:{' '}
                {disabledReason === 'mode_not_full' ? (
                  <>
                    <code>LOAMIUM_MODE</code> が full ではありません(read-only / append-only
                    モードでは無効)
                  </>
                ) : (
                  <>
                    <code>LOAMIUM_TERMINAL</code> 未設定(read-only / append-only モードでも無効)
                  </>
                )}
              </p>
            </>
          )}
        </div>
      )}
      {status === 'disconnected' && (
        <div className="reconnect-bar" data-testid="terminal-reconnect-bar">
          <WarnTriangleIcon />
          <span>
            ターミナルとの接続が切断されました。セッションは終了しています(子プロセスは停止済み)。
          </span>
          <button className="btn primary" data-testid="terminal-reconnect" onClick={reconnect}>
            再接続
          </button>
        </div>
      )}
      <div
        className={`terminal-pane${status === 'disconnected' ? ' is-disconnected' : ''}`}
        data-testid="terminal"
        aria-label="ターミナル"
        style={{ display: status === 'disabled' ? 'none' : 'flex' }}
      >
        <div className="terminal-host" ref={hostRef} />
      </div>
    </div>
  );
}
