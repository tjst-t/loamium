/**
 * 右サイドバー — バックリンク + エージェントタブ (Sf1a90a-2 / S53409d-1 / S53409d-2)。
 *
 * - ターミナル (Claude) タブは ADR-0011 により廃止 (S53409d-1)。
 * - バックリンクタブ + エージェントタブの 2 タブ seg-toggle。
 * - right-sidebar-toggle でサイドバー自体を開閉する。
 * - バックリンク取得はここで行い、件数バッジ (backlink-count) はタブに常時出す。
 *
 * FIX-1 (sessionmgmt): AgentPane は collapsed / タブ切替時も UNMOUNT しない。
 * display:none で DOM に残すことで AgentPane の in-flight セッション状態を保持する。
 */
import {
  useEffect,
  useState,
  type JSX,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { noteTitle, type BacklinkSource, type HealthResponse, type NoteMeta } from '@loamium/shared';
import { api, ApiError } from '../api.js';
import { ChevronRightIcon, DocumentIcon, LinkIcon } from '../icons.js';
import { AgentPane } from './AgentPane.js';

export type RightTab = 'backlinks' | 'agent';

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
  /** 参照元クリックでそのノートを開く */
  onOpenNote: (path: string) => void;
  /**
   * true のときサイドバー全体を非表示にする (Sa629e2-3: /search ルート)。
   * unmount ではなく display:none。
   */
  hidden?: boolean;
  /** vault のノート一覧 (エージェントペインの [[wikilink]] 解決用) */
  notes?: NoteMeta[] | null;
}

/** コンテキスト行中のリンク原文 (raw) を <mark> で強調する。 */
function contextWithMark(context: string, raw: string): JSX.Element {
  const idx = context.indexOf(raw);
  if (idx === -1) return <>{context}</>;
  return (
    <>
      {context.slice(0, idx)}
      <mark>{raw}</mark>
      {context.slice(idx + raw.length)}
    </>
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
  hidden = false,
  notes = null,
}: RightSidebarProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<RightTab>('backlinks');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [width, setWidth] = useState<number>(readStoredWidth);

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

  const [backlinks, setBacklinks] = useState<BacklinkSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // エージェント有効化状態を health から取得する
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

  useEffect(() => {
    if (notePath === null) {
      setBacklinks(null);
      setError(null);
      return;
    }
    let cancelled = false;
    api.getBacklinks(notePath).then(
      (res) => {
        if (cancelled) return;
        setBacklinks(res.backlinks);
        setError(null);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [notePath, refreshToken]);

  const items =
    backlinks?.flatMap((src) => src.links.map((link) => ({ source: src.source, link }))) ?? [];
  const countKnown = notePath !== null && backlinks !== null && error === null;

  // /search では表示しない (display:none — マウントは維持)。
  // collapsed 時は CSS の .collapsed 幅 (40px) を優先し、inline width は付けない。
  const asideStyle: CSSProperties = {
    ...(hidden ? { display: 'none' } : {}),
    ...(collapsed ? {} : { width }),
  };

  // collapsed 時: 細い toggle バーのみ表示。AgentPane は hidden で DOM に残す。
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
          /* collapsed: toggle ボタンのみ */
          <button
            className="icon-btn"
            data-testid="right-sidebar-toggle"
            title="サイドバーを開く"
            onClick={() => setCollapsed(false)}
          >
            <ChevronRightIcon />
          </button>
        ) : (
          /* expanded: タブ切替 + toggle ボタン */
          <>
            <div className="seg-toggle" role="tablist" aria-label="右サイドバー切替">
              <button
                className={`seg-btn${activeTab === 'backlinks' ? ' active' : ''}`}
                data-testid="right-tab-backlinks"
                role="tab"
                aria-selected={activeTab === 'backlinks'}
                onClick={() => setActiveTab('backlinks')}
              >
                <LinkIcon />
                バックリンク
                {countKnown && (
                  <span className="count" data-testid="backlink-count">
                    {items.length}
                  </span>
                )}
              </button>
              <button
                className={`seg-btn${activeTab === 'agent' ? ' active' : ''}`}
                data-testid="right-tab-agent"
                role="tab"
                aria-selected={activeTab === 'agent'}
                onClick={() => setActiveTab('agent')}
              >
                <AgentIcon />
                Agent
              </button>
            </div>
            <button
              className="icon-btn"
              data-testid="right-sidebar-toggle"
              title="サイドバーを閉じる"
              style={{ marginLeft: 'auto' }}
              onClick={() => setCollapsed(true)}
            >
              <ChevronRightIcon />
            </button>
          </>
        )}
      </div>

      {/* パネル本体 — collapsed 時は display:none で DOM に残す (AgentPane のセッション保持)。
          rs-pane-fill で flex 高さ連鎖を維持し、内部の overflow スクロールを効かせる。 */}
      <div className="rs-pane-fill" style={collapsed ? { display: 'none' } : undefined}>
        {/* バックリンク本体 */}
        <div
          className="panel-body"
          data-testid="backlink-panel"
          style={activeTab !== 'backlinks' ? { display: 'none' } : undefined}
        >
          {error !== null ? (
            <div className="panel-empty" data-testid="backlink-error">
              バックリンクを取得できませんでした。
              <br />
              <span className="detail">{error}</span>
            </div>
          ) : notePath === null || items.length === 0 ? (
            <div className="panel-empty" data-testid="backlink-empty">
              <LinkIcon />
              <br />
              {notePath === null ? (
                'ノートを開くと、ここに参照元が表示されます。'
              ) : (
                <>
                  このノートへのバックリンクはまだありません。ほかのノートから{' '}
                  <code>[[{noteTitle(notePath)}]]</code> でリンクすると、ここに参照元が表示されます。
                </>
              )}
            </div>
          ) : (
            items.map(({ source, link }, i) => (
              <button
                key={`${source}:${String(link.line)}:${String(i)}`}
                className="backlink-item"
                data-testid="backlink-item"
                data-source={source}
                onClick={() => onOpenNote(source)}
              >
                <span className="backlink-source">
                  <DocumentIcon />
                  {noteTitle(source)}
                </span>
                <span className="backlink-context">{contextWithMark(link.context, link.raw)}</span>
              </button>
            ))
          )}
        </div>

        {/* エージェントペイン — タブ非選択時も display:none で DOM に残す (セッション保持)。
            rs-pane-fill で .agent-body に高さを伝え、セッションバー固定 + メッセージ内部スクロールを効かせる。 */}
        <div className="rs-pane-fill" style={activeTab !== 'agent' ? { display: 'none' } : undefined}>
          <AgentPane health={health} notes={notes} onOpenNote={onOpenNote} />
        </div>
      </div>
    </aside>
  );
}
