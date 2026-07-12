/**
 * エージェントチャットペイン (S53409d-2 / S53409d-3 / sessionmgmt)。
 *
 * 状態:
 *   unconfigured — agent.json 未設定: セットアップガイドを表示。入力欄なし。
 *   ready        — 設定済み (empty or with history): 入力欄あり。
 *   streaming    — SSE 受信中: 送信→中断に切替、入力欄無効。
 *   error        — SSE error イベント受信: エラーバブル表示、入力欄再有効化。
 *
 * data-testid 一覧 (gui-spec-S53409d-2.json / gui-spec-S53409d-3.json / sessionmgmt):
 *   agent-pane (+ data-agent-status), agent-setup-guide,
 *   agent-new-session, agent-messages,
 *   agent-msg-user, agent-msg-assistant, agent-error,
 *   agent-input, agent-send, agent-abort,
 *   agent-tool-chip (完了ツールチップ), agent-tool-chip-running (実行中チップ),
 *   agent-wikilink (存在するノートへのリンク), agent-wikilink-broken (不在ノートリンク),
 *   agent-session-switcher (セッション一覧を開くボタン),
 *   agent-session-list (ドロップダウン一覧),
 *   agent-session-item (各行, data-session-id),
 *   agent-session-delete (各行の削除ボタン),
 *   agent-perm-selector (新規セッションの権限セレクタ, data-preset),
 *   agent-perm-preset-<name> (プリセットボタン: read-only/notes-rw/full),
 *   agent-perm-toggle-<cap> (ケーパビリティ別トグル, data-checked),
 *   agent-effective-perms (現在セッションの実効権限表示),
 *   agent-effective-cap-<cap> (実効ケーパビリティのバッジ),
 *   agent-perm-stripped-<cap> (要求したが LOAMIUM_MODE で剥がれたケーパビリティ)
 *
 * localStorage キー:
 *   loamium.agent.currentSessionId — 現在のセッション ID (null = 新規未送信)
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
import type { HealthResponse, NoteMeta, Capability, AgentPresetName } from '@loamium/shared';
import { AGENT_CAPABILITIES, AGENT_PRESET_NAMES, AGENT_PRESETS } from '@loamium/shared';

// ---- 型 -----------------------------------------------------------------------

type AgentStatus = 'unconfigured' | 'ready' | 'streaming';

// ---- 権限 UI 定義 (S5bd678-3) -------------------------------------------------

/** ケーパビリティの表示ラベル (日本語)。トグル UI 用。 */
const CAPABILITY_LABELS: Record<Capability, string> = {
  read: '読み取り',
  journal_append: 'ジャーナル追記',
  note_create: 'ノート作成',
  note_edit: 'ノート編集',
  template_write: 'テンプレート書込',
  dataview_write: 'dataview 書込',
  web: 'Web アクセス',
};

/** プリセットの表示ラベル。 */
const PRESET_LABELS: Record<AgentPresetName, string> = {
  'read-only': '読取のみ',
  'notes-rw': 'ノートRW',
  full: 'フル',
};

/** ケーパビリティ集合を AGENT_CAPABILITIES 順に整列して返す (比較の安定化用)。 */
function sortCaps(caps: Iterable<Capability>): Capability[] {
  const present = new Set<Capability>(caps);
  return AGENT_CAPABILITIES.filter((c) => present.has(c));
}

/** 2 つのケーパビリティ集合が (順不同で) 一致するか。 */
function sameCapSet(a: readonly Capability[], b: readonly Capability[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((c) => sb.has(c));
}

/** 選択集合に一致するプリセット名を返す (無ければ null = カスタム)。 */
function matchPreset(caps: readonly Capability[]): AgentPresetName | null {
  for (const name of AGENT_PRESET_NAMES) {
    if (sameCapSet(caps, AGENT_PRESETS[name])) return name;
  }
  return null;
}

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

interface SessionSummary {
  id: string;
  title: string | null;
  updatedAt: number;
}

// ---- localStorage ヘルパー ----------------------------------------------------

const LS_KEY = 'loamium.agent.currentSessionId';

function persistCurrentSessionId(id: string | null): void {
  try {
    if (id === null) {
      localStorage.removeItem(LS_KEY);
    } else {
      localStorage.setItem(LS_KEY, id);
    }
  } catch {
    // localStorage が使えない環境では無視
  }
}

function readPersistedSessionId(): string | null {
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
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

async function apiDelete(url: string): Promise<unknown> {
  const res = await fetch(url, { method: 'DELETE' });
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

// ---- 相対時刻表示 ------------------------------------------------------------

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'たった今';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}時間前`;
  return `${Math.floor(diff / 86_400_000)}日前`;
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

  // 権限セレクタ (S5bd678-3): 新規セッション作成時に送る選択ケーパビリティ集合。
  // 既定は read-only プリセット (サーバー既定と一致)。
  const [selectedCaps, setSelectedCaps] = useState<Capability[]>(() => [
    ...AGENT_PRESETS['read-only'],
  ]);
  // ケーパビリティ別トグルの展開状態。
  const [permExpanded, setPermExpanded] = useState(false);
  // 現在セッションの実効権限 (GET 詳細の effectivePermissions)。null = 未取得。
  const [effectivePerms, setEffectivePerms] = useState<Capability[] | null>(null);
  // 現在セッション作成時に「要求した」ケーパビリティ集合。剥がれ検出に使う。
  // 既存セッションに切替えた場合は要求集合が不明なので null (剥がれ表示は出さない)。
  const [requestedPerms, setRequestedPerms] = useState<Capability[] | null>(null);

  // セッション一覧 & スイッチャー
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * MF-2: 遅延セッション作成中に abort が呼ばれたとき、作成されたセッション ID を
   * 参照できるよう ref で追跡する。状態更新 (setSessionId) は非同期なのでここに保持。
   */
  const activeSendSessionIdRef = useRef<string | null>(null);

  /**
   * RD-2: 二重送信競合防止フラグ。handleSend の先頭で同期的に true にする。
   */
  const sendInFlightRef = useRef<boolean>(false);

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

  // ---- セッション一覧取得 -------------------------------------------------------

  const fetchSessions = useCallback(async (): Promise<SessionSummary[]> => {
    try {
      const listRes = (await apiGet('/api/agent/sessions')) as {
        sessions: SessionSummary[];
      };
      return listRes.sessions;
    } catch {
      return [];
    }
  }, []);

  // ---- 権限セレクタ操作 (S5bd678-3) --------------------------------------------

  /** プリセットボタン: そのプリセットのケーパビリティ集合に選択を同期する。 */
  const handleSelectPreset = useCallback((name: AgentPresetName): void => {
    setSelectedCaps([...AGENT_PRESETS[name]]);
  }, []);

  /** ケーパビリティ別トグル: 個別に on/off する (カスタム集合になりうる)。 */
  const handleToggleCap = useCallback((cap: Capability): void => {
    setSelectedCaps((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) {
        next.delete(cap);
      } else {
        next.add(cap);
      }
      return sortCaps(next);
    });
  }, []);

  /** GET 詳細の effectivePermissions を検証して Capability[] へ絞り込む。 */
  const parseEffective = useCallback((raw: unknown): Capability[] => {
    if (!Array.isArray(raw)) return [];
    const valid = new Set<string>(AGENT_CAPABILITIES);
    return sortCaps(raw.filter((v): v is Capability => typeof v === 'string' && valid.has(v)));
  }, []);

  // ---- 初期化 ---------------------------------------------------------------

  useEffect(() => {
    if (!agentEnabled) {
      setStatus('unconfigured');
      return;
    }

    void (async () => {
      try {
        const sessionList = await fetchSessions();
        setSessions(sessionList);

        const persistedId = readPersistedSessionId();

        // (a) localStorage に ID があり、一覧に存在する → そのセッションを復元
        // (b) 一覧が空でない → 最新セッションを復元
        // (c) 一覧が空 → 新規未送信状態 (lazy new)

        let targetId: string | null = null;

        if (persistedId && sessionList.some((s) => s.id === persistedId)) {
          targetId = persistedId;
        } else if (sessionList.length > 0 && sessionList[0]) {
          targetId = sessionList[0].id;
        }

        if (targetId) {
          const detail = (await apiGet(`/api/agent/sessions/${targetId}`)) as {
            id: string;
            messages: {
              role: 'user' | 'assistant';
              content: string;
              tools: { name: string; argsSummary: string; status: 'running' | 'done' }[];
            }[];
            effectivePermissions?: unknown;
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
          setSessionId(targetId);
          setMessages(restored);
          setEffectivePerms(parseEffective(detail.effectivePermissions));
          // 復元セッションは要求集合が不明 → 剥がれ表示は出さない
          setRequestedPerms(null);
          persistCurrentSessionId(targetId);
        } else {
          // 新規未送信状態
          setSessionId(null);
          setMessages([]);
          setEffectivePerms(null);
          setRequestedPerms(null);
          persistCurrentSessionId(null);
        }

        setStatus('ready');
      } catch {
        setStatus('ready');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentEnabled]);

  // ---- メッセージ末尾に自動スクロール ------------------------------------------

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ---- スイッチャー外クリック / Esc で閉じる ------------------------------------

  useEffect(() => {
    if (!switcherOpen) return;

    const handleClick = (e: MouseEvent): void => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    const handleKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setSwitcherOpen(false);
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [switcherOpen]);

  // ---- 新規セッション (lazy) ---------------------------------------------------

  /**
   * "+" ボタン: サーバーを叩かずに空の新規状態にする。
   * 実際のセッションは最初の送信時に作成する。
   */
  const handleNewSession = useCallback((): void => {
    if (status === 'streaming') return;
    // すでに新規未送信状態ならべき等
    if (sessionId === null && messages.length === 0) return;
    setSessionId(null);
    setMessages([]);
    setInputText('');
    setEffectivePerms(null);
    setRequestedPerms(null);
    persistCurrentSessionId(null);
    setSwitcherOpen(false);
  }, [status, sessionId, messages.length]);

  // ---- セッション切替 -----------------------------------------------------------

  const handleSwitchSession = useCallback(
    async (id: string): Promise<void> => {
      if (status === 'streaming') return;
      setSwitcherOpen(false);
      try {
        const detail = (await apiGet(`/api/agent/sessions/${id}`)) as {
          id: string;
          messages: {
            role: 'user' | 'assistant';
            content: string;
            tools: { name: string; argsSummary: string; status: 'running' | 'done' }[];
          }[];
          effectivePermissions?: unknown;
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
        setSessionId(id);
        setMessages(restored);
        setEffectivePerms(parseEffective(detail.effectivePermissions));
        // 切替先セッションは要求集合が不明 → 剥がれ表示は出さない
        setRequestedPerms(null);
        persistCurrentSessionId(id);
      } catch {
        // 切替失敗は無視
      }
    },
    [status, parseEffective],
  );

  // ---- セッション削除 -----------------------------------------------------------

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, id: string): Promise<void> => {
      e.stopPropagation();
      // MF-1: DELETE 成功した場合のみ UI を更新する。失敗時はリスト/現セッションを変更しない。
      let deleted = false;
      try {
        await apiDelete(`/api/agent/sessions/${id}`);
        deleted = true;
      } catch (err) {
        // 削除失敗 — UI は変えない (現セッションを失わないようにする)
        setMessages((prev) => {
          // エラーバブルをメッセージ末尾に追加してユーザーに通知
          const errMsg = err instanceof Error ? err.message : String(err);
          return [
            ...prev,
            { role: 'assistant' as const, content: '', tools: [], error: `削除失敗: ${errMsg}` },
          ];
        });
        return;
      }

      if (!deleted) return;

      // 一覧を更新
      const newList = await fetchSessions();
      setSessions(newList);

      // 削除したのが現在のセッションなら fallback
      if (id === sessionId) {
        const fallback = newList[0];
        if (fallback) {
          await handleSwitchSession(fallback.id);
        } else {
          setSessionId(null);
          setMessages([]);
          persistCurrentSessionId(null);
        }
      }
    },
    [sessionId, fetchSessions, handleSwitchSession],
  );

  // ---- スイッチャーを開く -------------------------------------------------------

  const handleOpenSwitcher = useCallback(async (): Promise<void> => {
    const list = await fetchSessions();
    setSessions(list);
    setSwitcherOpen(true);
  }, [fetchSessions]);

  // ---- 送信 ------------------------------------------------------------------

  const handleSend = useCallback((): void => {
    const text = inputText.trim();
    if (!text || status === 'streaming') return;

    // RD-2: 二重送信競合防止 — 同期的にガードを立てる
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    setMessages((prev) => [...prev, { role: 'user', content: text, tools: [] }]);
    setInputText('');
    setStatus('streaming');

    const ac = new AbortController();
    setAbortController(ac);

    void (async () => {
      try {
        // セッション ID が null の場合 (lazy new 後の初回送信) — サーバーにセッションを作成する
        let currentSessionId = sessionId;
        if (currentSessionId === null) {
          try {
            // S5bd678-3: 選択したケーパビリティ集合を permissions として送る (配列形式)。
            const requested = sortCaps(selectedCaps);
            const res = (await apiPost('/api/agent/sessions', {
              permissions: requested,
            })) as { id: string };
            currentSessionId = res.id;
            // MF-2: abort が sessionId state より先に発火してもサーバー abort を送れるよう ref に記録
            activeSendSessionIdRef.current = currentSessionId;
            setSessionId(currentSessionId);
            // 要求集合を記録 (剥がれ検出用)
            setRequestedPerms(requested);
            persistCurrentSessionId(currentSessionId);
            // 作成直後に実効権限を取得して表示 (LOAMIUM_MODE クランプ後)
            try {
              const detail = (await apiGet(`/api/agent/sessions/${currentSessionId}`)) as {
                effectivePermissions?: unknown;
              };
              setEffectivePerms(parseEffective(detail.effectivePermissions));
            } catch {
              // 実効権限取得失敗は致命的でない — 表示しないだけ
              setEffectivePerms(null);
            }
            // 一覧にも追加 (次に switcher を開いたとき反映される)
            const newList = await fetchSessions();
            setSessions(newList);
          } catch (err) {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, error: String(err) };
              } else {
                next.push({ role: 'assistant', content: '', tools: [], error: String(err) });
              }
              return next;
            });
            return; // finally が setStatus('ready') / setAbortController(null) / ref クリアを行う
          }
        } else {
          // MF-2: 既存セッションの場合も ref に記録
          activeSendSessionIdRef.current = currentSessionId;
        }

        // アシスタントバブルを追加 (逐次更新用)
        let assistantIdx = -1;
        setMessages((prev) => {
          assistantIdx = prev.length;
          return [...prev, { role: 'assistant', content: '', tools: [] }];
        });

        try {
          const response = await fetch(`/api/agent/sessions/${currentSessionId}/messages`, {
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
            return; // finally が setStatus('ready') / setAbortController(null) / ref クリアを行う
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
              return; // finally が setStatus('ready') / setAbortController(null) / ref クリアを行う
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
      } finally {
        // RD-2: ターン終了 (完了/エラー/中断) 時にガードを解除
        sendInFlightRef.current = false;
        // MF-2: ターン終了時に active session ref をクリア
        activeSendSessionIdRef.current = null;
        setStatus('ready');
        setAbortController(null);
      }
    })();
  }, [inputText, sessionId, status, selectedCaps, parseEffective, fetchSessions]);

  // ---- 中断 ------------------------------------------------------------------

  const handleAbort = useCallback((): void => {
    abortController?.abort();
    // MF-2: sessionId state は遅延作成中まだ null かもしれないので ref を使う
    const abortSessionId = activeSendSessionIdRef.current ?? sessionId;
    if (abortSessionId) {
      void fetch(`/api/agent/sessions/${abortSessionId}/abort`, { method: 'POST' });
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

  // セッションバーに表示するタイトル
  const sessionTitle = (() => {
    if (sessionId === null) return '新規セッション';
    const found = sessions.find((s) => s.id === sessionId);
    if (found?.title) return found.title;
    // メッセージ先頭から推定
    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser) {
      const t = firstUser.content.trim();
      return t.length > 30 ? t.slice(0, 30) + '…' : t;
    }
    return 'セッション';
  })();

  // ---- 権限 UI 派生値 (S5bd678-3) ---------------------------------------------

  // 権限セレクタは「新規未送信セッション」でのみ表示する (作成時に適用するため)。
  const showPermSelector = sessionId === null;
  // 選択集合に一致するプリセット (無ければ null = カスタム)。
  const activePreset = matchPreset(selectedCaps);
  const selectedCapSet = new Set(selectedCaps);

  // 実効権限表示: 送信済みセッションで effectivePerms が取得できていれば表示。
  const showEffective = sessionId !== null && effectivePerms !== null;
  const effectiveSet = new Set(effectivePerms ?? []);
  // 剥がれたケーパビリティ = 要求集合にあるが実効集合に無いもの (LOAMIUM_MODE クランプ)。
  // 要求集合が不明 (既存/復元セッション) の場合は空 (剥がれ表示なし)。
  const strippedCaps: Capability[] =
    requestedPerms !== null
      ? sortCaps(requestedPerms.filter((c) => !effectiveSet.has(c)))
      : [];

  return (
    <div
      className="agent-body"
      data-testid="agent-pane"
      data-agent-status={isStreaming ? 'streaming' : 'ready'}
    >
      {/* セッションバー */}
      <div className="agent-session-bar" ref={switcherRef}>
        {/* セッション名ボタン (スイッチャーを開く) */}
        <button
          className="agent-session-switcher-btn"
          data-testid="agent-session-switcher"
          title="セッション一覧"
          onClick={() => {
            if (switcherOpen) {
              setSwitcherOpen(false);
            } else {
              void handleOpenSwitcher();
            }
          }}
          disabled={isStreaming}
        >
          <span className="session-title">{sessionTitle}</span>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" style={{ width: 12, height: 12, flexShrink: 0 }}>
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>

        {/* "+" 新規セッションボタン */}
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

        {/* セッション一覧ドロップダウン */}
        {switcherOpen && (
          <div className="agent-session-list" data-testid="agent-session-list" role="listbox">
            {sessions.length === 0 ? (
              <div className="agent-session-list-empty">セッション履歴なし</div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`agent-session-item${s.id === sessionId ? ' current' : ''}`}
                  data-testid="agent-session-item"
                  data-session-id={s.id}
                  role="option"
                  aria-selected={s.id === sessionId}
                  onClick={() => void handleSwitchSession(s.id)}
                >
                  <span className="agent-session-item-title">
                    {s.title ?? '無題'}
                  </span>
                  <span className="agent-session-item-time">{relativeTime(s.updatedAt)}</span>
                  <button
                    className="agent-session-delete-btn"
                    data-testid="agent-session-delete"
                    title="削除"
                    onClick={(e) => void handleDeleteSession(e, s.id)}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 権限セレクタ (新規未送信セッション時のみ, S5bd678-3) */}
      {showPermSelector && (
        <div
          className="agent-perm-selector"
          data-testid="agent-perm-selector"
          data-preset={activePreset ?? 'custom'}
        >
          <div className="agent-perm-presets" role="group" aria-label="権限プリセット">
            <span className="agent-perm-label">権限</span>
            {AGENT_PRESET_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                className={`agent-perm-preset${activePreset === name ? ' active' : ''}`}
                data-testid={`agent-perm-preset-${name}`}
                aria-pressed={activePreset === name}
                disabled={isStreaming}
                onClick={() => handleSelectPreset(name)}
              >
                {PRESET_LABELS[name]}
              </button>
            ))}
            <button
              type="button"
              className="agent-perm-expand"
              data-testid="agent-perm-expand"
              aria-expanded={permExpanded}
              disabled={isStreaming}
              onClick={() => setPermExpanded((v) => !v)}
            >
              {permExpanded ? '詳細を隠す' : '詳細'}
              {activePreset === null && <span className="agent-perm-custom-dot" aria-hidden="true" />}
            </button>
          </div>
          {permExpanded && (
            <div className="agent-perm-toggles" data-testid="agent-perm-toggles">
              {AGENT_CAPABILITIES.map((cap) => {
                const checked = selectedCapSet.has(cap);
                return (
                  <label
                    key={cap}
                    className={`agent-perm-toggle${checked ? ' checked' : ''}`}
                    data-testid={`agent-perm-toggle-${cap}`}
                    data-checked={checked ? 'true' : 'false'}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isStreaming}
                      onChange={() => handleToggleCap(cap)}
                    />
                    <span>{CAPABILITY_LABELS[cap]}</span>
                    {cap === 'web' && <span className="agent-perm-note">(未実装)</span>}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 実効権限表示 (送信済みセッション, S5bd678-3) */}
      {showEffective && (
        <div className="agent-effective-perms" data-testid="agent-effective-perms">
          <span className="agent-perm-label">実効権限</span>
          <div className="agent-effective-list">
            {(effectivePerms ?? []).length === 0 ? (
              <span className="agent-effective-empty">なし</span>
            ) : (
              (effectivePerms ?? []).map((cap) => (
                <span
                  key={cap}
                  className="agent-effective-cap"
                  data-testid={`agent-effective-cap-${cap}`}
                >
                  {CAPABILITY_LABELS[cap]}
                </span>
              ))
            )}
            {strippedCaps.map((cap) => (
              <span
                key={cap}
                className="agent-effective-cap stripped"
                data-testid={`agent-perm-stripped-${cap}`}
                title="LOAMIUM_MODE により無効"
              >
                {CAPABILITY_LABELS[cap]}
                <span className="agent-perm-stripped-note"> (LOAMIUM_MODE により無効)</span>
              </span>
            ))}
          </div>
        </div>
      )}

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
