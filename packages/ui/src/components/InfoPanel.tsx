/**
 * インフォパネル (S11493d-2)。
 * 右サイドバーの「インフォ」タブのコンテンツ本体。
 *
 * セクション構成 (この Story):
 *   1. 目次 (Outline) — 見出しツリー、クリックでエディタ行ジャンプ
 *   2. プロパティ (Properties) — frontmatter key-value (tags キーは除外)
 *   3. タグ (Tags) — frontmatter+本文 #tag 集約チップ、クリックで /search
 *   4. メタ情報 — 単語数/文字数/更新日時
 *   [バックリンクは親 RightSidebar から引き継ぎ。Outgoing/Backlinks セクション化は S11493d-3]
 *
 * 折りたたみは <details>/<summary> で実装 (プロトタイプ準拠)。
 */
import { useEffect, useState, type JSX } from 'react';
import { noteTitle, type NoteMetaResponse } from '@loamium/shared';
import { api, ApiError } from '../api.js';

export interface InfoPanelProps {
  /** 開いているノートの vault 相対パス (null = ノート未オープン) */
  notePath: string | null;
  /** 保存成功のたびに増える — メタを再取得するトリガー */
  refreshToken: number;
  /** outline-item クリック時: 現在ノートの行 N へスクロール */
  onJumpToLine: (line: number) => void;
  /** tag-chip クリック時: /search?tag=xxx へ遷移 */
  onSearchTag: (tag: string) => void;
  /** バックリンク項目のレンダリング (RightSidebar から注入) */
  children?: React.ReactNode;
}

/** mtime (ms epoch) を "YYYY-MM-DD HH:mm" にフォーマット */
function formatMtime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** outline-item のインデント depth (level-1 で h2=0, h3=1 …) */
function depthOf(level: number): number {
  return Math.max(0, level - 2);
}

// ---- SVG アイコン (プロトタイプ準拠のインライン SVG) ----

function OutlineIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 4h10M3 8h7M3 12h5" />
    </svg>
  );
}

function PropertiesIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 6h6M5 9h4" />
    </svg>
  );
}

function TagsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 9l5 5 7-7-3.5-3.5L8 5l-3 2-3 2z" />
      <circle cx="11" cy="5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function MetaIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.5l2.5 1.5" />
    </svg>
  );
}

function ChevronDown(): JSX.Element {
  return (
    <svg
      className="info-section-chev"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function DotsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="3.5" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="12.5" cy="8" r="1" />
    </svg>
  );
}

function PdfIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 1.8h5.2L12.2 4.8v9.4H4z" />
      <path d="M9.2 1.8v3h3" />
      <path d="M5.5 10h5M5.5 12h3" />
    </svg>
  );
}

function CopyLinkIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6.5 9.5l3-3M5 7l-2 2a2.5 2.5 0 003.5 3.5l2-2M11 9l2-2A2.5 2.5 0 009.5 3.5l-2 2" />
    </svg>
  );
}

function CopyPathIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2" y="5" width="9" height="9" rx="1.5" />
      <path d="M5 5V3.5A1.5 1.5 0 016.5 2H12a1.5 1.5 0 011.5 1.5V9A1.5 1.5 0 0112 10.5H10.5" />
    </svg>
  );
}

// ---- ⋯ アクションメニュー ----

function ActionsMenu({ notePath }: { notePath: string | null }): JSX.Element {
  const [open, setOpen] = useState(false);

  const toggle = (): void => setOpen((v) => !v);

  const close = (): void => setOpen(false);

  const copyToClipboard = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // クリップボード書き込み失敗は無視 (テスト環境等)
    }
    close();
  };

  const handleCopyLink = (): void => {
    if (notePath === null) return;
    const title = noteTitle(notePath);
    void copyToClipboard(`[[${title}]]`);
  };

  const handleCopyPath = (): void => {
    if (notePath === null) return;
    void copyToClipboard(notePath);
  };

  return (
    <div className="info-actions-wrap">
      <button
        className="icon-btn"
        data-testid="info-actions-btn"
        title="アクション"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={toggle}
      >
        <DotsIcon />
      </button>
      {open && (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
          className="info-actions-scrim"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 98,
          }}
          onClick={close}
        />
      )}
      <div
        className={`info-actions-menu${open ? ' open' : ''}`}
        data-testid="info-actions-menu"
        role="menu"
        aria-label="ノートアクション"
        style={{ zIndex: 99 }}
      >
        <button
          className="menu-item"
          data-testid="action-export-pdf"
          role="menuitem"
          disabled
          onClick={close}
        >
          <PdfIcon />
          PDF エクスポート
        </button>
        <button
          className="menu-item"
          data-testid="action-copy-link"
          role="menuitem"
          onClick={handleCopyLink}
        >
          <CopyLinkIcon />
          Copy link
          {notePath !== null && (
            <span className="menu-item-hint">{`[[${noteTitle(notePath)}]]`}</span>
          )}
        </button>
        <button
          className="menu-item"
          data-testid="action-copy-path"
          role="menuitem"
          onClick={handleCopyPath}
        >
          <CopyPathIcon />
          Copy path
          {notePath !== null && (
            <span className="menu-item-hint">{notePath}</span>
          )}
        </button>
      </div>
    </div>
  );
}

// ---- InfoPanel 本体 ----

export function InfoPanel({
  notePath,
  refreshToken,
  onJumpToLine,
  onSearchTag,
  children,
}: InfoPanelProps): JSX.Element {
  const [meta, setMeta] = useState<NoteMetaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (notePath === null) {
      setMeta(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.getNoteMeta(notePath).then(
      (res) => {
        if (cancelled) return;
        setMeta(res);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
        setMeta(null);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [notePath, refreshToken]);

  if (notePath === null) {
    return (
      <div className="panel-body" data-testid="info-panel">
        <div className="panel-empty">
          ノートを開くと、ここにインフォが表示されます。
        </div>
        {children}
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="panel-body" data-testid="info-panel">
        <div className="panel-empty" data-testid="info-panel-error">
          メタ情報を取得できませんでした。
          <br />
          <span className="detail">{error}</span>
        </div>
        {children}
      </div>
    );
  }

  const headings = meta?.headings ?? [];
  const tags = meta?.tags ?? [];
  // tags キーを除いた frontmatter エントリ
  const fm = meta?.frontmatter ?? null;
  const propEntries =
    fm !== null
      ? Object.entries(fm).filter(([k]) => k !== 'tags')
      : [];
  const hasFrontmatter = fm !== null && Object.keys(fm).length > 0;
  const mtime = meta?.mtime ?? null;
  const wordCount = meta?.wordCount ?? 0;
  const charCount = meta?.charCount ?? 0;

  return (
    <div className="panel-body" data-testid="info-panel">
      {loading && meta === null && (
        <div className="panel-empty" style={{ opacity: 0.5 }}>読込中…</div>
      )}

      {/* 1. 目次 (Outline) */}
      <details className="info-section" open>
        <summary
          className="info-section-header"
          data-testid="info-section-toggle"
          data-section="outline"
        >
          <span className="info-section-icon"><OutlineIcon /></span>
          <span className="info-section-title">目次</span>
          {headings.length > 0 && (
            <span className="info-section-count">{headings.length}</span>
          )}
          <ChevronDown />
        </summary>
        <div
          className="info-section-body"
          data-testid="info-section-body"
          data-section="outline"
        >
          {headings.length === 0 ? (
            <div className="info-section-empty">見出しがありません</div>
          ) : (
            headings.map((h, i) => (
              <button
                key={`${String(h.line)}-${String(i)}`}
                className="outline-item"
                data-testid="outline-item"
                data-line={h.line}
                data-level={h.level}
                onClick={() => onJumpToLine(h.line)}
              >
                <span className="outline-indent" style={{ '--depth': depthOf(h.level) } as React.CSSProperties} />
                <span className="outline-label">{h.text}</span>
              </button>
            ))
          )}
        </div>
      </details>

      {/* 2. プロパティ (Properties) — frontmatter なし時は hidden */}
      <details className="info-section" open hidden={!hasFrontmatter}>
        <summary
          className="info-section-header"
          data-testid="info-section-toggle"
          data-section="properties"
        >
          <span className="info-section-icon"><PropertiesIcon /></span>
          <span className="info-section-title">プロパティ</span>
          {propEntries.length > 0 && (
            <span className="info-section-count">{propEntries.length}</span>
          )}
          <ChevronDown />
        </summary>
        <div
          className="info-section-body"
          data-testid="info-section-body"
          data-section="properties"
        >
          {propEntries.map(([key, value]) => (
            <div
              key={key}
              className="property-row"
              data-testid="property-row"
              data-key={key}
            >
              <span className="property-key">{key}</span>
              <span className="property-value">
                {Array.isArray(value)
                  ? (value as unknown[]).join(', ')
                  : value === null
                  ? ''
                  : String(value)}
              </span>
            </div>
          ))}
        </div>
      </details>

      {/* 3. タグ */}
      <details className="info-section" open>
        <summary
          className="info-section-header"
          data-testid="info-section-toggle"
          data-section="tags"
        >
          <span className="info-section-icon"><TagsIcon /></span>
          <span className="info-section-title">タグ</span>
          {tags.length > 0 && (
            <span className="info-section-count">{tags.length}</span>
          )}
          <ChevronDown />
        </summary>
        <div
          className="info-section-body"
          data-testid="info-section-body"
          data-section="tags"
        >
          {tags.length === 0 ? (
            <div className="info-section-empty">
              タグなし — <code>#tag</code> を本文に書くか、プロパティの <code>tags:</code> に追加
            </div>
          ) : (
            <div className="tags-chip-row">
              {tags.map((tag) => (
                <button
                  key={tag}
                  className="tag-chip clickable"
                  data-testid="tag-chip"
                  data-tag={tag}
                  title={`#${tag} で検索`}
                  onClick={() => onSearchTag(tag)}
                >
                  <span className="tag-chip-hash">#</span>
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      </details>

      {/* 4. メタ情報 */}
      <details className="info-section" open>
        <summary
          className="info-section-header"
          data-testid="info-section-toggle"
          data-section="meta"
        >
          <span className="info-section-icon"><MetaIcon /></span>
          <span className="info-section-title">メタ情報</span>
          <ChevronDown />
        </summary>
        <div
          className="info-section-body"
          data-testid="info-section-body"
          data-section="meta"
        >
          <div className="meta-row" data-testid="meta-wordcount">
            <span className="meta-label">単語数</span>
            <span className="meta-value">{wordCount}</span>
          </div>
          <div className="meta-row" data-testid="meta-charcount">
            <span className="meta-label">文字数</span>
            <span className="meta-value">{charCount}</span>
          </div>
          <div className="meta-row" data-testid="meta-mtime">
            <span className="meta-label">更新日時</span>
            <span className="meta-value">
              {mtime !== null ? formatMtime(mtime) : '—'}
            </span>
          </div>
        </div>
      </details>

      {/* S11493d-3 でアウトゴーイングリンク / バックリンクのセクションをここに追加する。
          現在はバックリンクを親 RightSidebar から children として受け取る。 */}
      {children}
    </div>
  );
}

// ⋯ ボタンをパネルヘッダ外から使えるよう再エクスポート
export { ActionsMenu };
