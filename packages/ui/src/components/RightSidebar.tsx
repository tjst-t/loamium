/**
 * 右サイドバー — バックリンクパネル (Sf1a90a-2 / S53409d-1)。
 *
 * - ターミナル (Claude) タブは ADR-0007 により廃止 (S53409d-1)。
 * - バックリンクタブのみ。
 * - right-sidebar-toggle でサイドバー自体を開閉する。
 * - バックリンク取得はここで行い、件数バッジ (backlink-count) はタブに常時出す。
 */
import { useEffect, useState, type JSX } from 'react';
import { noteTitle, type BacklinkSource } from '@loamium/shared';
import { api, ApiError } from '../api.js';
import { ChevronRightIcon, DocumentIcon, LinkIcon } from '../icons.js';

export type RightTab = 'backlinks';

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
  const [collapsed, setCollapsed] = useState(false);

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

  // /search では表示しない (display:none — マウントは維持)
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
            className="seg-btn active"
            data-testid="right-tab-backlinks"
            role="tab"
            aria-selected={true}
          >
            <LinkIcon />
            バックリンク
            {countKnown && (
              <span className="count" data-testid="backlink-count">
                {items.length}
              </span>
            )}
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

      {/* バックリンク本体 */}
      <div
        className="panel-body"
        data-testid="backlink-panel"
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
    </aside>
  );
}
