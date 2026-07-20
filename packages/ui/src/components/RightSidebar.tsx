/**
 * 右サイドバー — インフォ ⇄ Agent のトグル (S11493d + S53409d 統合)。
 *
 * - seg-toggle で right-tab-info / right-tab-agent を切り替える (aria-selected)。
 * - ターミナル (Claude) タブは ADR-0011 (内蔵エージェントがターミナルを置換) により廃止。
 *   代わりに AgentPane (pi-SDK チャット) を Agent タブとして提供する。
 * - インフォパネル (InfoPanel, S11493d) はメタ API を消費し、バックリンク + アウトライン +
 *   プロパティ + タグ + メタを表示する。バックリンク取得はここで行い props で渡す。
 * - Agent 表示中もメインのノートは見えたまま (メインを占有しない — DESIGN_PRINCIPLES)。
 * - 両ペインは collapsed / タブ切替時も UNMOUNT せず display 切替のみ。
 *   InfoPanel のスクロール位置と AgentPane の in-flight セッション状態を保持する。
 * - 左端ハンドルのドラッグでサイドバー幅を変更できる (localStorage 永続化)。
 */
import {
  useEffect,
  useState,
  type JSX,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { type BacklinkSource, type HealthResponse, type NoteMeta } from '@loamium/shared';
import { api, ApiError } from '../api.js';
import { InfoPanel, ActionsMenu } from './InfoPanel.js';
import { AgentPane } from './AgentPane.js';
import { ChevronLeftIcon, ChevronRightIcon } from '../icons.js';

export type RightTab = 'info' | 'agent';

/** 右サイドバー幅の永続化キー / 制約 (ドラッグリサイズ)。 */
const RS_WIDTH_KEY = 'loamium.rightSidebar.width';
const RS_MIN_WIDTH = 240;
const RS_DEFAULT_WIDTH = 300;
/** 上限はウィンドウ幅の割合 (残りの編集領域を潰しすぎない)。 */
const RS_MAX_FRACTION = 0.6;

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(RS_WIDTH_KEY);
    if (raw !== null) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= RS_MIN_WIDTH) return n;
    }
  } catch {
    // localStorage 不可 (プライベートモード等) — 既定値へ
  }
  return RS_DEFAULT_WIDTH;
}

export interface RightSidebarProps {
  /** 開いているノートの vault 相対パス (null = ノート未オープン) */
  notePath: string | null;
  /** 増えるたびにバックリンクを再取得する (保存成功時に App がインクリメント) */
  refreshToken: number;
  /** 参照元クリック / 解決済みアウトゴーイングリンクのクリックでそのノートを開く */
  onOpenNote: (path: string) => void;
  /** outline-item クリック: 現在ノートの指定行へジャンプする。 */
  onJumpToLine?: (line: number) => void;
  /** tag-chip クリック: /search?tag=xxx へ遷移する。 */
  onSearchTag?: (tag: string) => void;
  /**
   * true のときサイドバー全体を非表示にする (Sa629e2-3: /search ルート)。
   * unmount ではなく display:none — 各ペインの状態を維持する。
   */
  hidden?: boolean;
  /** vault のノート一覧 (エージェントペインの [[wikilink]] 解決用) */
  notes?: NoteMeta[] | null;
  /**
   * エージェントがターンを完了しファイルを書いた可能性があるときに呼ぶ (sidebar-refresh)。
   * AgentPane の done 受信時に転送し、左サイドバー (ファイルツリー) を再取得させる。
   */
  onNotesChanged?: (() => void) | undefined;
}

/** インフォアイコン (プロトタイプ準拠) */
function InfoIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.5v4M8 5.5h.01" />
    </svg>
  );
}

/** エージェントアイコン (プロトタイプ prototype/agent-chat.html より) */
function AgentIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.8l1.4 3.3 3.4.4-2.5 2.4.7 3.5L8 9.7l-3 1.7.7-3.5L3.2 5.5l3.4-.4z" />
    </svg>
  );
}

export function RightSidebar({
  notePath,
  refreshToken,
  onOpenNote,
  onJumpToLine,
  onSearchTag,
  hidden = false,
  notes = null,
  onNotesChanged,
}: RightSidebarProps): JSX.Element {
  const [tab, setTab] = useState<RightTab>('info');
  const [collapsed, setCollapsed] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [width, setWidth] = useState<number>(readStoredWidth);

  const [backlinks, setBacklinks] = useState<BacklinkSource[] | null>(null);
  const [backlinkError, setBacklinkError] = useState<string | null>(null);

  // 幅変更のたびに永続化する。
  useEffect(() => {
    try {
      localStorage.setItem(RS_WIDTH_KEY, String(width));
    } catch {
      // 保存不可でも動作は継続
    }
  }, [width]);

  // 左端ハンドルのドラッグでサイドバー幅を変更する (右サイドバーなので右端固定・左へ広がる)。
  const handleResizeStart = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const maxWidth = Math.max(RS_MIN_WIDTH, Math.round(window.innerWidth * RS_MAX_FRACTION));
    const onMove = (ev: MouseEvent): void => {
      const next = Math.min(maxWidth, Math.max(RS_MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setWidth(next);
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
  };

  // エージェント有効化状態を health から取得する (AgentPane 用)。
  useEffect(() => {
    let cancelled = false;
    api.getHealth().then(
      (res) => {
        if (!cancelled) setHealth(res);
      },
      () => {
        // health 取得失敗時はエージェント無効として扱う
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // バックリンク取得 (InfoPanel に props で渡す)。
  useEffect(() => {
    if (notePath === null) {
      setBacklinks(null);
      setBacklinkError(null);
      return;
    }
    let cancelled = false;
    api.getBacklinks(notePath).then(
      (res) => {
        if (cancelled) return;
        setBacklinks(res.backlinks);
        setBacklinkError(null);
      },
      (err: unknown) => {
        if (cancelled) return;
        setBacklinkError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
        setBacklinks(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [notePath, refreshToken]);

  const items =
    backlinks?.flatMap((src) => src.links.map((link) => ({ source: src.source, link }))) ?? [];
  const countKnown = notePath !== null && backlinks !== null && backlinkError === null;

  // /search では表示しない (display:none — マウントは維持)。
  // collapsed 時は CSS の .collapsed 幅 (40px) を優先し、inline width は付けない。
  const asideStyle: CSSProperties = {
    ...(hidden ? { display: 'none' } : {}),
    ...(collapsed ? {} : { width }),
  };

  return (
    <aside
      className={`panel${collapsed ? ' collapsed' : ''}`}
      data-testid="right-sidebar"
      style={asideStyle}
    >
      {/* 左端リサイズハンドル (collapsed 時は非表示) */}
      {!collapsed && (
        <div
          className="rs-resizer"
          data-testid="right-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="サイドバー幅を変更"
          onMouseDown={handleResizeStart}
        />
      )}

      <div className="panel-header">
        {collapsed ? (
          /* collapsed: toggle ボタンのみ。左向きシェブロン = パネルを開く方向を示す */
          <button
            className="icon-btn"
            data-testid="right-sidebar-toggle"
            aria-label="サイドバーを開く"
            title="サイドバーを開く"
            onClick={() => setCollapsed(false)}
          >
            <ChevronLeftIcon />
          </button>
        ) : (
          /* expanded: タブ切替 + ⋯ メニュー + toggle */
          <>
            <div className="seg-toggle" role="tablist" aria-label="右サイドバー切替">
              <button
                className={`seg-btn${tab === 'info' ? ' active' : ''}`}
                data-testid="right-tab-info"
                role="tab"
                aria-selected={tab === 'info'}
                onClick={() => setTab('info')}
              >
                <InfoIcon />
                インフォ
                {countKnown && (
                  <span
                    className="count"
                    data-testid="backlink-count"
                    style={items.length === 0 ? { display: 'none' } : undefined}
                  >
                    {items.length}
                  </span>
                )}
              </button>
              <button
                className={`seg-btn${tab === 'agent' ? ' active' : ''}`}
                data-testid="right-tab-agent"
                role="tab"
                aria-selected={tab === 'agent'}
                onClick={() => setTab('agent')}
              >
                <AgentIcon />
                Agent
              </button>
            </div>

            {/* ⋯ アクションメニュー (エクスポート等) */}
            <ActionsMenu notePath={notePath} />

            <button
              className="icon-btn"
              data-testid="right-sidebar-toggle"
              aria-label="サイドバーを閉じる"
              title="サイドバーを閉じる"
              style={{ marginLeft: 4 }}
              onClick={() => setCollapsed(true)}
            >
              <ChevronRightIcon />
            </button>
          </>
        )}
      </div>

      {/* インフォパネル本体 — 非選択/collapsed 時も display:none で DOM に残す
          (contents で InfoPanel の子を .panel の flex 子として扱う)。 */}
      <div style={{ display: !collapsed && tab === 'info' ? 'contents' : 'none' }}>
        <InfoPanel
          notePath={notePath}
          refreshToken={refreshToken}
          onJumpToLine={(line) => onJumpToLine?.(line)}
          onSearchTag={(tag) => onSearchTag?.(tag)}
          onOpenNote={onOpenNote}
          backlinks={backlinks}
          backlinkError={backlinkError}
        />
      </div>

      {/* エージェントペイン — 非選択/collapsed 時も display:none で DOM に残す
          (rs-pane-fill で .agent-body に高さを伝え、in-flight セッションを保持)。 */}
      <div className="rs-pane-fill" style={!collapsed && tab === 'agent' ? undefined : { display: 'none' }}>
        <AgentPane health={health} notes={notes} onOpenNote={onOpenNote} onNotesChanged={onNotesChanged} />
      </div>
    </aside>
  );
}
