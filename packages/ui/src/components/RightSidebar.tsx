/**
 * 右サイドバー — バックリンク ⇄ Claude のトグル (Sf1a90a-2 / prototype/claude-sidebar.html)。
 *
 * - seg-toggle で right-tab-backlinks / right-tab-claude を切り替える (aria-selected)。
 * - Claude 表示中もメインのノートは見えたまま (メインを占有しない — DESIGN_PRINCIPLES)。
 * - TerminalPane (claude-panel) は初回に Claude を開いた時点で一度だけマウントし、
 *   以後はトグルで display 切替のみ — xterm セッションを維持する (AC-Sf1a90a-2-1)。
 * - right-sidebar-toggle でサイドバー自体を開閉する。
 * - バックリンク取得はここで行い、件数バッジ (backlink-count) はタブに常時出す。
 */
import { useEffect, useState, type JSX } from 'react';
import { noteTitle, type BacklinkSource } from '@loamium/shared';
import { api, ApiError } from '../api.js';
import { TerminalPane, type TerminalStatus } from './TerminalPane.js';
import { ChevronRightIcon, DocumentIcon, LinkIcon, TerminalIcon } from '../icons.js';

export type RightTab = 'backlinks' | 'claude';

export interface RightSidebarProps {
  /** 開いているノートの vault 相対パス (null = ノート未オープン) */
  notePath: string | null;
  /** 増えるたびにバックリンクを再取得する (保存成功時に App がインクリメント) */
  refreshToken: number;
  /** 参照元クリックでそのノートを開く */
  onOpenNote: (path: string) => void;
  /**
   * true のときサイドバー全体を非表示にする (Sa629e2-3: /search ルート)。
   * unmount ではなく display:none — Claude (xterm) のセッションは維持される。
   */
  hidden?: boolean;
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

export function RightSidebar({
  notePath,
  refreshToken,
  onOpenNote,
  hidden = false,
}: RightSidebarProps): JSX.Element {
  const [tab, setTab] = useState<RightTab>('backlinks');
  const [collapsed, setCollapsed] = useState(false);
  /** 一度 Claude を開いたら unmount しない (トグルでセッションを切らない) */
  const [claudeMounted, setClaudeMounted] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>('loading');

  const [backlinks, setBacklinks] = useState<BacklinkSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const selectClaude = (): void => {
    setClaudeMounted(true);
    setTab('claude');
  };

  // /search では表示しない (display:none — マウントは維持し xterm セッションを守る)
  const hiddenStyle = hidden ? ({ display: 'none' } as const) : undefined;

  if (collapsed) {
    return (
      <aside className="panel collapsed" data-testid="right-sidebar" style={hiddenStyle}>
        <div className="panel-header">
          <button
            className="icon-btn"
            data-testid="right-sidebar-toggle"
            title="サイドバーを開く"
            onClick={() => setCollapsed(false)}
          >
            <ChevronRightIcon />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="panel" data-testid="right-sidebar" style={hiddenStyle}>
      <div className="panel-header">
        <div className="seg-toggle" role="tablist" aria-label="右サイドバー切替">
          <button
            className={`seg-btn${tab === 'backlinks' ? ' active' : ''}`}
            data-testid="right-tab-backlinks"
            role="tab"
            aria-selected={tab === 'backlinks'}
            onClick={() => setTab('backlinks')}
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
            className={`seg-btn${tab === 'claude' ? ' active' : ''}`}
            data-testid="right-tab-claude"
            role="tab"
            aria-selected={tab === 'claude'}
            onClick={selectClaude}
          >
            <TerminalIcon />
            Claude
            <span className={`live-dot${terminalStatus === 'connected' ? '' : ' off'}`} />
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
      </div>

      {/* バックリンク本体 (Claude 表示中は隠すが unmount はしない) */}
      <div
        className="panel-body"
        data-testid="backlink-panel"
        style={{ display: tab === 'backlinks' ? 'block' : 'none' }}
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

      {/* Claude (初回に開いてからマウント — トグルでセッション維持) */}
      {claudeMounted && (
        <TerminalPane
          active={tab === 'claude'}
          onStatusChange={setTerminalStatus}
          onCmdDetected={() => undefined}
        />
      )}
    </aside>
  );
}
