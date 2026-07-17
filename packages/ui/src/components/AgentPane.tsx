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
 *   agent-perm-button (セッションバーの権限ボタン: ポップオーバー開閉),
 *   agent-perm-popover (権限ポップオーバー本体, data-preset),
 *   agent-perm-preset-<name> (プリセットボタン: read-only/notes-rw/full),
 *   agent-perm-toggles (ケーパビリティ別トグル群),
 *   agent-perm-toggle-<cap> (ケーパビリティ別トグル, data-checked),
 *   agent-web-warning (web 有効化時の漏洩リスク警告)
 *
 * 権限 UI (改善2): 新規/既存いずれもセッションバーの agent-perm-button →
 * agent-perm-popover に集約。新規 (未送信) はトグルが selectedCaps を更新し作成時に送信、
 * 既存 (送信済み) はトグルで PUT /api/agent/sessions/{id}/permissions を呼びセッション中に権限変更する。
 * 実効権限は専用表示を撤去し、チェックボックス (data-checked) の状態で表す
 * (既存セッションのトグルは effectivePermissions を反映する)。
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
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
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
  note_delete: 'ノート削除',
  template_write: 'テンプレート書込',
  dataview_write: 'dataview 書込',
  smartfolder_write: 'スマートフォルダ書込',
  command_run: 'コマンド実行',
  command_write: 'コマンド編集',
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

async function apiPut(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

// ---- チャット Markdown レンダリング (marked + DOMPurify) -----------------------

/** HTML 特殊文字をエスケープする ([[リンク]] display をアンカーへ埋め込む前処理)。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * content を「コード領域 (``` フェンス / `インラインコード`)」と「非コード領域」に分割する。
 * コード領域内の [[ ]] は装飾しないため、非コード領域のみを wikilink 置換の対象にする。
 *
 * shared/extract.ts のコードフェンス除外は「行単位で null にする (行番号を保つ)」インデックス用の
 * ロジックで、ここで必要な「元テキストを保ったままコード/非コードに分割」とは目的が異なるため
 * 局所実装する。フェンス行そのもの・フェンス内・インラインコードすべてをコード領域として扱う。
 */
function splitCodeRegions(content: string): Array<{ code: boolean; value: string }> {
  const segments: Array<{ code: boolean; value: string }> = [];
  const lines = content.split('\n');
  let inFence = false;
  let fenceMarker = '';
  let bufNonCode: string[] = [];
  let bufCode: string[] = [];

  const flushNonCode = (): void => {
    if (bufNonCode.length > 0) {
      segments.push({ code: false, value: bufNonCode.join('\n') });
      bufNonCode = [];
    }
  };
  const flushCode = (): void => {
    if (bufCode.length > 0) {
      segments.push({ code: true, value: bufCode.join('\n') });
      bufCode = [];
    }
  };

  const fenceRe = /^(\s{0,3})(`{3,}|~{3,})/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const isLast = i === lines.length - 1;
    const nl = isLast ? '' : '\n';
    const fence = fenceRe.exec(line);
    const marker = fence?.[2]?.[0] ?? '';
    if (fence && (!inFence || marker === fenceMarker)) {
      if (!inFence) {
        // フェンス開始: 直前の非コードを確定し、フェンス行をコードへ
        flushNonCode();
        inFence = true;
        fenceMarker = marker;
        bufCode.push(line + nl);
      } else {
        // フェンス終了: フェンス行をコードに含めて確定
        bufCode.push(line + nl);
        inFence = false;
        fenceMarker = '';
        flushCode();
      }
      continue;
    }
    if (inFence) {
      bufCode.push(line + nl);
    } else {
      bufNonCode.push(line + nl);
    }
  }
  flushCode();
  flushNonCode();
  return segments;
}

/**
 * 非コード行の中でインラインコード (`...`) を保護しつつ、コード外の [[リンク]] のみ置換する。
 * replacer は wikilink 一致に対して HTML 文字列を返す。
 */
function replaceWikilinksOutsideInlineCode(
  text: string,
  replacer: (target: string, display: string) => string,
): string {
  // インラインコードスパンを一旦プレースホルダに退避
  const codeSpans: string[] = [];
  const guarded = text.replace(/`[^`\n]*`/g, (m) => {
    const idx = codeSpans.push(m) - 1;
    return ` CODE${idx} `;
  });
  const linked = guarded.replace(/\[\[([^\]\n]+?)\]\]/g, (_full, innerRaw: string) => {
    const inner = innerRaw;
    const pipeIdx = inner.indexOf('|');
    const target = pipeIdx !== -1 ? inner.slice(0, pipeIdx) : inner;
    const display = pipeIdx !== -1 ? inner.slice(pipeIdx + 1) : inner;
    return replacer(target, display);
  });
  // プレースホルダを戻す
  return linked.replace(/ CODE(\d+) /g, (_m, n: string) => codeSpans[Number(n)] ?? '');
}

/**
 * content を Markdown として整形描画する HTML を生成する。
 *
 * 1. コード領域を除外して [[リンク]] のみアンカー/スパンへ置換する (コード内は装飾しない)。
 * 2. marked.parse (GFM, 改行有効) で Markdown を HTML 化する。
 * 3. DOMPurify で無害化する (許可タグ + data-wl-target + a[href] http/https/mailto + target/rel)。
 *
 * 生成される wikilink 要素:
 *   存在ノート → <a class="agent-wikilink" data-wl-target="<resolvedPath>" data-testid="agent-wikilink">display</a>
 *   不在ノート → <span class="agent-wikilink broken" data-testid="agent-wikilink-broken" title="...">display</span>
 */
function renderChatMarkdown(content: string, notePaths: ReadonlySet<string>): string {
  const wikilinkReplacer = (target: string, display: string): string => {
    const trimmedTarget = target.trim();
    const targetMd = trimmedTarget.endsWith('.md') ? trimmedTarget : `${trimmedTarget}.md`;
    const exists = notePaths.has(targetMd) || notePaths.has(trimmedTarget);
    const displayHtml = escapeHtml(display);
    if (exists) {
      const resolvedPath = notePaths.has(targetMd) ? targetMd : trimmedTarget;
      return (
        `<a class="agent-wikilink" data-wl-target="${escapeHtml(resolvedPath)}" ` +
        `data-testid="agent-wikilink" role="link" tabindex="0">${displayHtml}</a>`
      );
    }
    return (
      `<span class="agent-wikilink broken" data-testid="agent-wikilink-broken" ` +
      `title="${escapeHtml(`ノートが見つかりません: ${trimmedTarget}`)}">${displayHtml}</span>`
    );
  };

  // コード領域を除外して非コード領域のみ [[リンク]] を置換する
  const segments = splitCodeRegions(content);
  const replaced = segments
    .map((seg) =>
      seg.code ? seg.value : replaceWikilinksOutsideInlineCode(seg.value, wikilinkReplacer),
    )
    .join('');

  // GFM + 改行有効で Markdown → HTML
  const rawHtml = marked.parse(replaced, { async: false, gfm: true, breaks: true });

  // 無害化: 標準 Markdown タグ + wikilink 属性のみ許可
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'strong', 'em', 'del', 's',
      'code', 'pre',
      'ul', 'ol', 'li',
      'blockquote',
      'a', 'span',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['class', 'href', 'title', 'target', 'rel', 'role', 'tabindex', 'data-wl-target', 'data-testid'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}

/**
 * アシスタントメッセージを Markdown 整形描画する。
 * [[リンク]] は onClick デリゲーションで onOpenNote へ繋ぐ (キーボード Enter も対応)。
 * 外部リンク (http(s)) は新規タブで開く (marked が生成する a[href] に付与)。
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
  const html = useMemo(() => renderChatMarkdown(content, notePaths), [content, notePaths]);

  // クリックデリゲーション: data-wl-target を持つ要素 (またはその祖先) で onOpenNote を呼ぶ。
  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      const wl = (e.target as HTMLElement).closest('[data-wl-target]');
      if (wl instanceof HTMLElement) {
        const target = wl.getAttribute('data-wl-target');
        if (target) {
          e.preventDefault();
          onOpenNote(target);
          return;
        }
      }
      // 外部リンク (http(s)/mailto) は新規タブで開く
      const anchor = (e.target as HTMLElement).closest('a[href]');
      if (anchor instanceof HTMLAnchorElement && !anchor.hasAttribute('data-wl-target')) {
        e.preventDefault();
        window.open(anchor.href, '_blank', 'noopener,noreferrer');
      }
    },
    [onOpenNote],
  );

  // キーボード: フォーカスした wikilink 上で Enter を押すとナビゲート。
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.hasAttribute('data-wl-target')) {
        const target = active.getAttribute('data-wl-target');
        if (target) {
          e.preventDefault();
          onOpenNote(target);
        }
      }
    },
    [onOpenNote],
  );

  return (
    <div
      className="agent-md"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
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
  // 権限ポップオーバーの開閉状態 (セッションバーの権限ボタンにアンカー)。
  const [permOpen, setPermOpen] = useState(false);
  // 現在セッションの実効権限 (GET 詳細の effectivePermissions)。null = 未取得。
  const [effectivePerms, setEffectivePerms] = useState<Capability[] | null>(null);
  // 現在セッション作成時に「要求した」ケーパビリティ集合。剥がれ検出に使う。
  // 既存セッションに切替えた場合は要求集合が不明なので null (剥がれ表示は出さない)。
  const [requestedPerms, setRequestedPerms] = useState<Capability[] | null>(null);

  // セッション一覧 & スイッチャー
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const permRef = useRef<HTMLDivElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
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

  // ---- 権限セレクタ操作 (S5bd678-3 / S_agent-ui) -------------------------------

  /** GET 詳細の effectivePermissions を検証して Capability[] へ絞り込む。 */
  const parseEffective = useCallback((raw: unknown): Capability[] => {
    if (!Array.isArray(raw)) return [];
    const valid = new Set<string>(AGENT_CAPABILITIES);
    return sortCaps(raw.filter((v): v is Capability => typeof v === 'string' && valid.has(v)));
  }, []);

  /**
   * 権限変更を適用する。
   * - 新規 (未送信) セッション (sessionId === null): selectedCaps を更新するだけ (作成時に送信)。
   * - 既存 (送信済み) セッション: PUT /permissions を呼び、応答の実効権限で表示更新する。
   */
  const applyPermissions = useCallback(
    (nextCaps: Capability[]): void => {
      const sorted = sortCaps(nextCaps);
      if (sessionId === null) {
        setSelectedCaps(sorted);
        return;
      }
      // 既存セッション: サーバーへ反映 (セッション中の権限変更)。
      // 楽観的に selectedCaps も更新し、要求集合を剥がれ検出用に記録する。
      setSelectedCaps(sorted);
      setRequestedPerms(sorted);
      void (async () => {
        try {
          const res = (await apiPut(`/api/agent/sessions/${sessionId}/permissions`, {
            permissions: sorted,
          })) as { effectivePermissions?: unknown };
          setEffectivePerms(parseEffective(res.effectivePermissions));
        } catch {
          // 反映失敗は表示を変えない (楽観的更新は残す)
        }
      })();
    },
    [sessionId, parseEffective],
  );

  /** プリセットボタン: そのプリセットのケーパビリティ集合を適用する。 */
  const handleSelectPreset = useCallback(
    (name: AgentPresetName): void => {
      applyPermissions([...AGENT_PRESETS[name]]);
    },
    [applyPermissions],
  );

  /** ケーパビリティ別トグル: 個別に on/off する (カスタム集合になりうる)。 */
  const handleToggleCap = useCallback(
    (cap: Capability): void => {
      const base = new Set(selectedCaps);
      if (base.has(cap)) {
        base.delete(cap);
      } else {
        base.add(cap);
      }
      applyPermissions(sortCaps(base));
    },
    [selectedCaps, applyPermissions],
  );

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

  // ---- 権限ポップオーバー外クリック / Esc で閉じる (スイッチャーと同じパターン) --------

  useEffect(() => {
    if (!permOpen) return;

    const handleClick = (e: MouseEvent): void => {
      if (permRef.current && !permRef.current.contains(e.target as Node)) {
        setPermOpen(false);
      }
    };
    const handleKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setPermOpen(false);
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [permOpen]);

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

  // ---- 入力欄オートグロー (上方向、上限 = チャット高の 1/3) ----------------------

  /**
   * textarea を内容に合わせて上方向に伸ばす。
   * 上限はチャット (agent-messages) 実高の 1/3。超えたら overflow-y:auto でスクロール。
   * 1 行時は既定高さ (CSS min-height) に戻る。上限は clientHeight から動的算出する
   * (CSS で固定 px にしない = レイアウトに応じて 1/3 を守る)。
   */
  const autoGrowTextarea = useCallback((): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    // まず auto にして scrollHeight を正しく測る
    ta.style.height = 'auto';
    const chatH = messagesRef.current?.clientHeight ?? 0;
    // 上限: チャット高の 1/3 (chatH が未確定なら緩い既定上限)
    const maxH = chatH > 0 ? Math.floor(chatH / 3) : 200;
    const next = Math.min(ta.scrollHeight, maxH);
    ta.style.height = `${String(next)}px`;
    ta.style.overflowY = ta.scrollHeight > maxH ? 'auto' : 'hidden';
  }, []);

  // inputText 変化 (入力・送信後クリア・復元) に追従してリサイズする。
  useEffect(() => {
    autoGrowTextarea();
  }, [inputText, autoGrowTextarea]);

  // チャット領域のリサイズ (ペイン幅/高さ変化) に追従して上限 1/3 を再算出する。
  useEffect(() => {
    const el = messagesRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => autoGrowTextarea());
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoGrowTextarea]);

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

  // ---- 権限 UI 派生値 (S5bd678-3 / 権限ポップオーバー) --------------------------

  // トグル/プリセットが反映する集合:
  //   新規 (未送信) セッション → selectedCaps (作成時に送信する要求集合)
  //   既存 (送信済み) セッション → 実効権限 (現在のセッション権限。トグルで PUT して更新)
  const permCaps: Capability[] =
    sessionId === null ? selectedCaps : effectivePerms ?? selectedCaps;
  // 選択集合に一致するプリセット (無ければ null = カスタム)。
  const activePreset = matchPreset(permCaps);
  const selectedCapSet = new Set(permCaps);
  // 権限ボタンのバッジ (有効ケーパビリティ数)。
  const permCount = permCaps.length;

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

        {/* 権限ボタン + ポップオーバー (盾アイコン) */}
        <div className="agent-perm-anchor" ref={permRef}>
          <button
            className="icon-btn agent-perm-btn"
            data-testid="agent-perm-button"
            title="権限"
            aria-haspopup="true"
            aria-expanded={permOpen}
            onClick={() => setPermOpen((v) => !v)}
            disabled={isStreaming}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1.6l5 1.8v3.2c0 3.1-2.1 5.4-5 6.4-2.9-1-5-3.3-5-6.4V3.4z" />
            </svg>
            <span className="agent-perm-btn-count" aria-hidden="true">{permCount}</span>
          </button>

          {permOpen && (
            <div
              className="agent-perm-popover"
              data-testid="agent-perm-popover"
              data-preset={activePreset ?? 'custom'}
              role="dialog"
              aria-label="エージェント権限"
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
              </div>

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
                    </label>
                  );
                })}
              </div>

              {/* Web 有効化時の漏洩リスク警告 (AC-S5e0206-2-1, ADR-0017) */}
              {selectedCapSet.has('web') && (
                <div
                  className="agent-web-warning"
                  data-testid="agent-web-warning"
                  role="alert"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 2L1.8 13h12.4z" />
                    <path d="M8 6.5v3M8 11.5h.01" />
                  </svg>
                  <span>
                    Web アクセスを有効にすると、ノート内に紛れた悪意あるテキスト
                    (プロンプトインジェクション) 経由で vault の情報が外部へ送信される
                    リスクがあります。信頼する vault でのみ有効にしてください。
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

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

      {/* メッセージ一覧 */}
      <div className="agent-messages" data-testid="agent-messages" ref={messagesRef}>
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
