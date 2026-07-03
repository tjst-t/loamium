/**
 * バックリンクパネル (右ペイン) — Story S6fbf45-2。
 *
 * 開いているノートへの参照元 (GET /api/backlinks) を「参照元ノート + リンク行の
 * コンテキスト」で一覧表示する (prototype/wikilink-autocomplete.html 右ペイン準拠)。
 * - ノート切替 (notePath) と保存 (refreshToken) で再取得する
 * - 項目クリックで参照元ノートへ移動する
 * - 取得失敗はパネル内エラー表示に留め、エディタは阻害しない
 */
import { useEffect, useState, type JSX } from 'react';
import { noteTitle, type BacklinkSource } from '@loamium/shared';
import { api, ApiError } from '../api.js';
import { ChevronLeftIcon, ChevronRightIcon, DocumentIcon, LinkIcon } from '../icons.js';

export interface BacklinkPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  /** 開いているノートの vault 相対パス (null = ノート未オープン) */
  notePath: string | null;
  /** 増えるたびに再取得する (保存成功時に App がインクリメント) */
  refreshToken: number;
  /** 参照元クリックでそのノートを開く */
  onOpenNote: (path: string) => void;
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

export function BacklinkPanel({
  collapsed,
  onToggle,
  notePath,
  refreshToken,
  onOpenNote,
}: BacklinkPanelProps): JSX.Element {
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

  return (
    <aside className={collapsed ? 'panel collapsed' : 'panel'} data-testid="backlink-panel">
      <div className="panel-header">
        {!collapsed && <span className="label">バックリンク</span>}
        {!collapsed && notePath !== null && backlinks !== null && error === null && (
          <span className="count" data-testid="backlink-count">
            {items.length}
          </span>
        )}
        <button
          className="icon-btn"
          data-testid="backlink-panel-toggle"
          title={collapsed ? 'パネルを開く' : 'パネルを閉じる'}
          onClick={onToggle}
        >
          {collapsed ? <ChevronLeftIcon /> : <ChevronRightIcon />}
        </button>
      </div>
      {!collapsed && (
        <div className="panel-body">
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
      )}
    </aside>
  );
}
