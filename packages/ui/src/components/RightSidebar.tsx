/**
 * 右サイドバー — インフォ ⇄ Claude のトグル (S11493d-2 / prototype/info-panel.html)。
 *
 * - seg-toggle で right-tab-info / right-tab-claude を切り替える (aria-selected)。
 * - Claude 表示中もメインのノートは見えたまま (メインを占有しない — DESIGN_PRINCIPLES)。
 * - TerminalPane (claude-panel) は初回に Claude を開いた時点で一度だけマウントし、
 *   以後はトグルで display 切替のみ — xterm セッションを維持する (AC-Sf1a90a-2-1)。
 * - right-sidebar-toggle でサイドバー自体を開閉する。
 * - バックリンク取得はここで行い、件数バッジ (backlink-count) はタブに常時出す。
 * - インフォパネル (InfoPanel) はメタ API (S11493d-1) を消費し、4 セクションを表示する。
 *   S11493d-3 でアウトゴーイング/バックリンクをセクション化するまでの暫定として、
 *   バックリンクリストは InfoPanel の children として渡す。
 */
import { useEffect, useState, type JSX } from 'react';
import { noteTitle, type BacklinkSource } from '@loamium/shared';
import { api, ApiError } from '../api.js';
import { TerminalPane, type TerminalStatus } from './TerminalPane.js';
import { InfoPanel, ActionsMenu } from './InfoPanel.js';
import { ChevronRightIcon, DocumentIcon, LinkIcon, TerminalIcon } from '../icons.js';

export type RightTab = 'info' | 'claude';

export interface RightSidebarProps {
  /** 開いているノートの vault 相対パス (null = ノート未オープン) */
  notePath: string | null;
  /** 増えるたびにバックリンクを再取得する (保存成功時に App がインクリメント) */
  refreshToken: number;
  /** 参照元クリックでそのノートを開く */
  onOpenNote: (path: string) => void;
  /**
   * outline-item クリック: 現在ノートの指定行へジャンプする。
   * App.tsx の openNoteAtLine を notePath 固定で使う。
   */
  onJumpToLine?: (line: number) => void;
  /**
   * tag-chip クリック: /search?tag=xxx へ遷移する。
   * App.tsx の openSearch を呼ぶ。
   */
  onSearchTag?: (tag: string) => void;
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
  onJumpToLine,
  onSearchTag,
  hidden = false,
}: RightSidebarProps): JSX.Element {
  const [tab, setTab] = useState<RightTab>('info');
  const [collapsed, setCollapsed] = useState(false);
  /** 一度 Claude を開いたら unmount しない (トグルでセッションを切らない) */
  const [claudeMounted, setClaudeMounted] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>('loading');

  const [backlinks, setBacklinks] = useState<BacklinkSource[] | null>(null);
  const [backlinkError, setBacklinkError] = useState<string | null>(null);

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
      },
    );
    return () => {
      cancelled = true;
    };
  }, [notePath, refreshToken]);

  const items =
    backlinks?.flatMap((src) => src.links.map((link) => ({ source: src.source, link }))) ?? [];
  const countKnown = notePath !== null && backlinks !== null && backlinkError === null;

  const selectClaude = (): void => {
    setClaudeMounted(true);
    setTab('claude');
  };

  // /search では表示しない (display:none — マウントは維持し xterm セッションを守る)
  const hiddenStyle = hidden ? ({ display: 'none' } as const) : undefined;

  // バックリンクリストのレンダリング (InfoPanel の children として渡す)
  const backlinkBody = (
    <>
      {backlinkError !== null ? (
        <div className="panel-empty" data-testid="backlink-error">
          バックリンクを取得できませんでした。
          <br />
          <span className="detail">{backlinkError}</span>
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
    </>
  );

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
            className={`seg-btn${tab === 'info' ? ' active' : ''}`}
            data-testid="right-tab-info"
            role="tab"
            aria-selected={tab === 'info'}
            onClick={() => setTab('info')}
          >
            {/* インフォアイコン (プロトタイプ準拠) */}
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="8" cy="8" r="5.5" />
              <path d="M8 7.5v4M8 5.5h.01" />
            </svg>
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

        {/* ⋯ アクションメニュー */}
        <ActionsMenu notePath={notePath} />

        <button
          className="icon-btn"
          data-testid="right-sidebar-toggle"
          title="サイドバーを閉じる"
          style={{ marginLeft: 4 }}
          onClick={() => setCollapsed(true)}
        >
          <ChevronRightIcon />
        </button>
      </div>

      {/* インフォパネル本体 (Claude 表示中は隠すが unmount はしない) */}
      <div style={{ display: tab === 'info' ? 'contents' : 'none' }}>
        <InfoPanel
          notePath={notePath}
          refreshToken={refreshToken}
          onJumpToLine={(line) => onJumpToLine?.(line)}
          onSearchTag={(tag) => onSearchTag?.(tag)}
        >
          {backlinkBody}
        </InfoPanel>
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
