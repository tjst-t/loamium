/**
 * エージェントチャットペイン (S53409d-2 / S53409d-3)。
 *
 * 状態:
 *   unconfigured — agent.json 未設定: セットアップガイドを表示。入力欄なし。
 *   ready        — 設定済み (empty or with history): 入力欄あり。
 *   streaming    — SSE 受信中: 送信→中断に切替、入力欄無効。
 *   error        — SSE error イベント受信: エラーバブル表示、入力欄再有効化。
 *
 * data-testid 一覧 (gui-spec-S53409d-2.json / gui-spec-S53409d-3.json):
 *   agent-pane (+ data-agent-status), agent-setup-guide,
 *   agent-new-session, agent-messages,
 *   agent-msg-user, agent-msg-assistant, agent-error,
 *   agent-input, agent-send, agent-abort,
 *   agent-tool-chip (完了ツールチップ), agent-tool-chip-running (実行中チップ),
 *   agent-wikilink (存在するノートへのリンク), agent-wikilink-broken (不在ノートリンク)
 */
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { HealthResponse, NoteMeta } from '@loamium/shared';

// ---- 型 -----------------------------------------------------------------------

type AgentStatus = 'unconfigured' | 'ready' | 'streaming';

/** ツールチップ状態 */
interface ToolChipItem {
  toolCallId: string;
  name: string;
  argsSummary: string;
  /** tool_end を受信したか */
  done: boolean;
}

interface AgentMessageItem {
  role: 'user' | 'assistant';
  content: string;
  error?: string; // エラーバブルとして表示
  /** このメッセージで実行されたツール一覧 */
  tools: ToolChipItem[];
}

// ---- API ヘルパー ------------------------------------------------------------

async function apiPost(url: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `HTTP ${String(res.status)}`;
    try {
      const j = (await res.json()) as Record<string, unknown>;
      if (typeof j['message'] === 'string') msg = j['message'];
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return res.json();
}

async function apiGet(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json();
}

// ---- SSE ストリーム読取 -------------------------------------------------------

interface SseEvent {
  type: 'text_delta' | 'tool_start' | 'tool_end' | 'error' | 'done';
  text?: string;
  toolCallId?: string;
  name?: string;
  argsSummary?: string;
  message?: string;
}

async function* readSseStream(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr) {
            try {
              yield JSON.parse(jsonStr) as SseEvent;
            } catch {
              // malformed JSON — skip
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---- [[WikiLink]] レンダリング ------------------------------------------------

/** [[target]] または [[target|alias]] を解析する。 */
function parseWikilinks(text: string): Array<{ type: 'text'; value: string } | { type: 'link'; target: string; display: string }> {
  const parts: Array<{ type: 'text'; value: string } | { type: 'link'; target: string; display: string }> = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ type: 'text', value: text.slice(last, m.index) });
    }
    const inner = m[1] ?? '';
    const pipeIdx = inner.indexOf('|');
    const target = pipeIdx !== -1 ? inner.slice(0, pipeIdx) : inner;
    const display = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : inner;
    parts.push({ type: 'link', target, display });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push({ type: 'text', value: text.slice(last) });
  }
  return parts;
}

/**
 * アシスタントメッセージのテキスト中の [[リンク]] を解決してレンダリングする。
 * 存在するノートは agent-wikilink (クリックでナビゲート)、不在は agent-wikilink-broken。
 */
function AssistantText({
  content,
  notePaths,
  onOpenNote,
}: {
  content: string;
  notePaths: ReadonlySet<string>;
  onOpenNote: (path: string) => void;
}): JSX.Element {
  const parts = useMemo(() => parseWikilinks(content), [content]);

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return <span key={i}>{part.value}</span>;
        }
        // リンクターゲットを解決: .md なし → .md を付与してノートパスと照合
        const target = part.target;
        const targetMd = target.endsWith('.md') ? target : `${target}.md`;
        const exists = notePaths.has(targetMd) || notePaths.has(target);
        if (exists) {
          const resolvedPath = notePaths.has(targetMd) ? targetMd : target;
          return (
            <span
              key={i}
              data-testid="agent-wikilink"
              className="agent-wikilink"
              role="link"
              tabIndex={0}
              onClick={() => onOpenNote(resolvedPath)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenNote(resolvedPath);
                }
              }}
            >
              {part.display}
            </span>
          );
        } else {
          return (
            <span
              key={i}
              data-testid="agent-wikilink-broken"
              className="agent-wikilink broken"
              title={`ノートが見つかりません: ${target}`}
            >
              {part.display}
            </span>
          );
        }
      })}
    </>
  );
}

// ---- ツールチップ ------------------------------------------------------------

function ToolChip({ chip }: { chip: ToolChipItem }): JSX.Element {
  if (!chip.done) {
    return (
      <span className="agent-tool-chip running" data-testid="agent-tool-chip-running">
        <span className="agent-tool-spinner" aria-hidden="true" />
        <span className="agent-tool-name">{chip.name}</span>
        {chip.argsSummary !== '' && (
          <span className="agent-tool-args">{chip.argsSummary}</span>
        )}
      </span>
    );
  }
  return (
    <span className="agent-tool-chip" data-testid="agent-tool-chip">
      <span className="agent-tool-name">{chip.name}</span>
      {chip.argsSummary !== '' && (
        <span className="agent-tool-args">{chip.argsSummary}</span>
      )}
    </span>
  );
}

// ---- コンポーネント ----------------------------------------------------------

export interface AgentPaneProps {
  health: HealthResponse | null;
  /** vault のノート一覧 (wikilink 解決用) */
  notes?: NoteMeta[] | null;
  /** ノートを開くナビゲーション (wikilink クリック時) */
  onOpenNote?: (path: string) => void;
}

export function AgentPane({ health, notes = null, onOpenNote }: AgentPaneProps): JSX.Element {
  const agentEnabled = health?.agent?.enabled ?? false;

  const [status, setStatus] = useState<AgentStatus>(agentEnabled ? 'ready' : 'unconfigured');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessageItem[]>([]);
  const [inputText, setInputText] = useState('');
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ノートパスのセット (wikilink 解決用)
  const notePaths = useMemo<ReadonlySet<string>>(
    () => new Set((notes ?? []).map((n) => n.path)),
    [notes],
  );

  // onOpenNote デフォルト (URL 直接遷移フォールバック)
  const handleOpenNote = useCallback(
    (notePath: string) => {
      if (onOpenNote) {
        onOpenNote(notePath);
      } else {
        const noExt = notePath.replace(/\.md$/, '');
        const encoded = noExt.split('/').map(encodeURIComponent).join('/');
        window.history.pushState({}, '', `/n/${encoded}`);
      }
    },
    [onOpenNote],
  );

  // ---- 初期化 ---------------------------------------------------------------

  useEffect(() => {
    if (!agentEnabled) {
      setStatus('unconfigured');
      return;
    }

    // セッション一覧を取得し、最新セッションを復元する
    void (async () => {
      try {
        const listRes = (await apiGet('/api/agent/sessions')) as {
          sessions: { id: string; title: string | null; updatedAt: number }[];
        };
        const sessions = listRes.sessions;

        if (sessions.length === 0) {
          // 空状態: 新規セッションを作成
          await createNewSession();
        } else {
          // 最新セッション復元
          const latest = sessions[0];
          if (!latest) return;
          setSessionId(latest.id);
          const detail = (await apiGet(`/api/agent/sessions/${latest.id}`)) as {
            id: string;
            messages: {
              role: 'user' | 'assistant';
              content: string;
              tools: { name: string; argsSummary: string; status: 'running' | 'done' }[];
            }[];
          };
          const restored: AgentMessageItem[] = detail.messages.map((m) => ({
            role: m.role,
            content: m.content,
            tools: (m.tools ?? []).map((t) => ({
              toolCallId: `restored-${t.name}`,
              name: t.name,
              argsSummary: t.argsSummary,
              done: true,
            })),
          }));
          setMessages(restored);
          setStatus('ready');
        }
      } catch {
        // セッション取得失敗 — empty ready 状態
        setStatus('ready');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentEnabled]);

  // ---- メッセージ末尾に自動スクロール ------------------------------------------

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ---- 新規セッション作成 -------------------------------------------------------

  const createNewSession = useCallback(async (): Promise<void> => {
    try {
      const res = (await apiPost('/api/agent/sessions')) as { id: string };
      setSessionId(res.id);
      setMessages([]);
      setStatus('ready');
    } catch {
      setStatus('ready');
    }
  }, []);

  const handleNewSession = useCallback((): void => {
    void createNewSession();
  }, [createNewSession]);

  // ---- 送信 ------------------------------------------------------------------

  const handleSend = useCallback((): void => {
    const text = inputText.trim();
    if (!text || !sessionId || status === 'streaming') return;

    setMessages((prev) => [...prev, { role: 'user', content: text, tools: [] }]);
    setInputText('');
    setStatus('streaming');

    const ac = new AbortController();
    setAbortController(ac);

    void (async () => {
      // アシスタントバブルを追加 (逐次更新用)
      let assistantIdx = -1;
      setMessages((prev) => {
        assistantIdx = prev.length;
        return [...prev, { role: 'assistant', content: '', tools: [] }];
      });

      try {
        const response = await fetch(`/api/agent/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text }),
          signal: ac.signal,
        });

        if (!response.ok) {
          const errMsg = `HTTP ${String(response.status)}`;
          setMessages((prev) => {
            const next = [...prev];
            if (assistantIdx >= 0 && assistantIdx < next.length) {
              next[assistantIdx] = { role: 'assistant', content: '', tools: [], error: errMsg };
            }
            return next;
          });
          setStatus('ready');
          setAbortController(null);
          return;
        }

        for await (const event of readSseStream(response)) {
          if (ac.signal.aborted) break;

          if (event.type === 'text_delta' && event.text) {
            setMessages((prev) => {
              const next = [...prev];
              const item = next[assistantIdx];
              if (item) {
                next[assistantIdx] = { ...item, content: item.content + event.text };
              }
              return next;
            });
          } else if (event.type === 'tool_start' && event.toolCallId && event.name) {
            const chip: ToolChipItem = {
              toolCallId: event.toolCallId,
              name: event.name,
              argsSummary: event.argsSummary ?? '',
              done: false,
            };
            setMessages((prev) => {
              const next = [...prev];
              const item = next[assistantIdx];
              if (item) {
                next[assistantIdx] = { ...item, tools: [...item.tools, chip] };
              }
              return next;
            });
          } else if (event.type === 'tool_end' && event.toolCallId) {
            const tid = event.toolCallId;
            setMessages((prev) => {
              const next = [...prev];
              const item = next[assistantIdx];
              if (item) {
                const updatedTools = item.tools.map((c) =>
                  c.toolCallId === tid ? { ...c, done: true } : c,
                );
                next[assistantIdx] = { ...item, tools: updatedTools };
              }
              return next;
            });
          } else if (event.type === 'error') {
            const errMsg = event.message ?? '不明なエラー';
            setMessages((prev) => {
              const next = [...prev];
              const item = next[assistantIdx];
              if (item) {
                next[assistantIdx] = { ...item, error: errMsg };
              }
              return next;
            });
            setStatus('ready');
            setAbortController(null);
            return;
          } else if (event.type === 'done') {
            break;
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          // 中断 — 部分応答は残す
        } else {
          setMessages((prev) => {
            const next = [...prev];
            const item = next[assistantIdx];
            if (item) {
              next[assistantIdx] = { ...item, error: String(err) };
            }
            return next;
          });
        }
      }

      setStatus('ready');
      setAbortController(null);
    })();
  }, [inputText, sessionId, status]);

  // ---- 中断 ------------------------------------------------------------------

  const handleAbort = useCallback((): void => {
    abortController?.abort();
    if (sessionId) {
      void fetch(`/api/agent/sessions/${sessionId}/abort`, { method: 'POST' });
    }
  }, [abortController, sessionId]);

  // ---- キーボード ------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // ---- 未設定ガイド ----------------------------------------------------------

  if (status === 'unconfigured') {
    return (
      <div
        className="agent-body"
        data-testid="agent-pane"
        data-agent-status="unconfigured"
      >
        <div className="empty-state" data-testid="agent-setup-guide" style={{ padding: '24px 18px' }}>
          <div className="glyph">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1.8l1.4 3.3 3.4.4-2.5 2.4.7 3.5L8 9.7l-3 1.7.7-3.5L3.2 5.5l3.4-.4z" />
            </svg>
          </div>
          <h2 style={{ fontSize: '15px' }}>エージェントは未設定です</h2>
          <p style={{ fontSize: '12.5px', maxWidth: 'none', lineHeight: 1.7 }}>
            OpenAI / Anthropic <strong>API 互換エンドポイント</strong>に接続して、vault の情報収集・まとめを行う内蔵エージェントです。vault の{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>.loamium/agent.json</code> を作成してください。
          </p>
          <pre className="setup-code">{`{
  "api": "openai",
  "baseUrl": "http://localhost:11434/v1",
  "model": "qwen3:32b",
  "apiKey": "$OPENAI_API_KEY"
}`}</pre>
          <p style={{ margin: 0, fontSize: '12px' }}>保存すると次のメッセージ送信から反映されます (再起動不要)。</p>
        </div>
      </div>
    );
  }

  // ---- チャット画面 ----------------------------------------------------------

  const isStreaming = status === 'streaming';
  const canSend = inputText.trim().length > 0 && !isStreaming;

  return (
    <div
      className="agent-body"
      data-testid="agent-pane"
      data-agent-status={isStreaming ? 'streaming' : 'ready'}
    >
      {/* セッションバー */}
      <div className="agent-session-bar">
        <span className="session-title">
          {messages.length === 0 ? '新規セッション' : 'セッション'}
        </span>
        <button
          className="icon-btn"
          data-testid="agent-new-session"
          title="新規セッション"
          onClick={handleNewSession}
          disabled={isStreaming}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
        </button>
      </div>

      {/* メッセージ一覧 */}
      <div className="agent-messages" data-testid="agent-messages">
        {messages.length === 0 && (
          <div className="empty-state" style={{ padding: '32px 18px' }}>
            <div className="glyph">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 1.8l1.4 3.3 3.4.4-2.5 2.4.7 3.5L8 9.7l-3 1.7.7-3.5L3.2 5.5l3.4-.4z" />
              </svg>
            </div>
            <h2 style={{ fontSize: '14px' }}>vault について聞いてみましょう</h2>
            <p style={{ fontSize: '12px', lineHeight: 1.7 }}>
              「先週の決定事項は?」「#hydra のノートを要約して」など。
            </p>
          </div>
        )}

        {messages.map((msg, idx) =>
          msg.role === 'user' ? (
            <div
              key={idx}
              className="agent-msg-user"
              data-testid="agent-msg-user"
            >
              {msg.content}
            </div>
          ) : msg.error !== undefined ? (
            <div
              key={idx}
              className="agent-error"
              data-testid="agent-error"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2L1.8 13h12.4z" />
                <path d="M8 6.5v3M8 11.5h.01" />
              </svg>
              <div>{msg.error}</div>
            </div>
          ) : (
            <div
              key={idx}
              className="agent-msg-assistant"
              data-testid="agent-msg-assistant"
            >
              {/* ツールチップ (メッセージ上部) */}
              {msg.tools.length > 0 && (
                <div className="agent-tool-chips">
                  {msg.tools.map((chip) => (
                    <ToolChip key={chip.toolCallId} chip={chip} />
                  ))}
                </div>
              )}
              {/* メッセージ本文 ([[リンク]] 解決付き) */}
              <AssistantText
                content={msg.content}
                notePaths={notePaths}
                onOpenNote={handleOpenNote}
              />
              {isStreaming && idx === messages.length - 1 && msg.content.length === 0 && msg.tools.length === 0 && (
                <span className="agent-streaming-caret" />
              )}
            </div>
          ),
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 入力欄 */}
      <div className="agent-input-row">
        <textarea
          ref={textareaRef}
          className="agent-input"
          data-testid="agent-input"
          rows={1}
          placeholder={isStreaming ? '応答中…' : 'vault について質問…'}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button
            className="agent-abort"
            data-testid="agent-abort"
            title="中断"
            onClick={handleAbort}
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <rect x="4" y="4" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            className="agent-send"
            data-testid="agent-send"
            title="送信 (Enter)"
            disabled={!canSend}
            onClick={handleSend}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2L7.5 8.5M14 2L9.5 14l-2-5.5L2 6.5z" />
            </svg>
          </button>
        )}
      </div>
      <div className="agent-hint">
        {isStreaming
          ? '応答中 — 中断すると部分応答は残ります'
          : 'Enter 送信 / Shift+Enter 改行'}
      </div>
    </div>
  );
}
