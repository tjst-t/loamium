/**
 * 詳細検索ページ (S935867-1 → Sa629e2-3 でスリム化)。
 *
 * Cmd+K パレット (Sbd061c) が「1 件開くと閉じるジャンプ用」なのに対し、こちらは
 * 「開いても閉じない探索用」。結果一覧 (search-results) は常時マウントされ、結果を
 * クリックすると右カラムの読み取り専用プレビューにノートを表示する。一覧は保持され、
 * 複数の結果を順に閲覧できる (AC-S935867-1-1)。
 *
 * Sa629e2-3: 条件は 1 行のインラインバー (Enter で検索)、検索履歴はバー直下の
 * 控えめなチップ列、結果は 1〜2 行の密なリスト。説明文の類は置かない。
 * /search では App が右サイドバーを非表示にする (表示層のみ — セッション維持)。
 *
 * - 条件 (全文 q / タグ tag / フォルダ folder / 並び sort) は URL クエリに同期する。
 *   実行の真実源は URL (params prop)。フォームは下書きで、送信で URL に commit する
 *   → params が変わって検索が走る。戻る/進む・ブックマーク・リロードで再現 (AC-1-2)。
 * - サーバーは無改修: 全文は GET /api/search?q=、タグ (空白区切り AND) とフォルダは
 *   GET /api/notes のメタ (tags/folder/mtime) でクライアント側フィルタ (decisions I2)。
 * - 検索履歴は localStorage。クリックで同じ検索を再実行 (AC-1-3)。
 * - プレビューは mini-md (textContent ベース・安全) を再利用した read-only 表示。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type JSX,
  type ReactNode,
} from 'react';
import type { NoteMeta } from '@loamium/shared';
import type { SearchParams, SearchSort } from '../router.js';
import { api, ApiError } from '../api.js';
import { renderMarkdownInto } from '../renderers/mini-md.js';
import { CloseIcon, DocumentIcon, FileIcon, SearchIcon } from '../icons.js';

const HISTORY_KEY = 'loamium.searchHistory';
const HISTORY_MAX = 12;

export interface SearchPageProps {
  /** URL に同期済みの現在条件 (検索実行の真実源)。 */
  params: SearchParams;
  /** 条件を commit して /search?… へ遷移する (履歴に積む)。 */
  onNavigate: (params: SearchParams) => void;
  /** プレビュー中のノートをエディタ (/n/…) で開く。 */
  onOpenNoteInEditor: (path: string) => void;
}

interface ResultRow {
  path: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
  mtime: number;
}

interface HistoryEntry {
  q: string;
  tag: string;
  folder: string;
  sort: SearchSort;
  count: number;
}

function normalize(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/** `#a #b` / `a b` → ["a","b"] (# 除去・NFC・小文字・空要素除去)。 */
function parseTagQuery(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.replace(/^#+/, '').normalize('NFC').toLowerCase())
    .filter((t) => t.length > 0);
}

function noteMatchesTags(noteTags: string[], wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  const lower = noteTags.map((t) => t.toLowerCase());
  // ネストタグ: tag=dev は dev/api にもマッチ (Obsidian 互換・server listNotes と同挙動)
  return wanted.every((w) => lower.some((t) => t === w || t.startsWith(`${w}/`)));
}

function noteInFolder(folder: string, wanted: string): boolean {
  if (wanted === '') return true;
  const f = wanted.replace(/^\/+|\/+$/g, '');
  return folder === f || folder.startsWith(`${f}/`);
}

/** query の最初の一致箇所を <mark> で強調 (prototype の sr-snippet mark 契約)。 */
function highlight(text: string, query: string): ReactNode {
  const q = normalize(query);
  if (q.length === 0) return text;
  const idx = normalize(text).indexOf(q);
  if (idx === -1 || idx + q.length > text.length) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function formatMtime(mtime: number): string {
  if (mtime <= 0) return '';
  const d = new Date(mtime);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `更新 ${mm}/${dd} ${hh}:${mi}`;
}

function isSearchSort(v: string): v is SearchSort {
  return v === 'updated' || v === 'score' || v === 'name';
}

function readHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: HistoryEntry[] = [];
    for (const e of parsed) {
      if (typeof e !== 'object' || e === null) continue;
      const r = e as Record<string, unknown>;
      const sort = typeof r['sort'] === 'string' && isSearchSort(r['sort']) ? r['sort'] : 'updated';
      out.push({
        q: typeof r['q'] === 'string' ? r['q'] : '',
        tag: typeof r['tag'] === 'string' ? r['tag'] : '',
        folder: typeof r['folder'] === 'string' ? r['folder'] : '',
        sort,
        count: typeof r['count'] === 'number' ? r['count'] : 0,
      });
    }
    return out.slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function historyKey(e: { q: string; tag: string; folder: string; sort: SearchSort }): string {
  return JSON.stringify([e.q, e.tag, e.folder, e.sort]);
}

/** data-query 属性値 (テストで条件を特定する — prototype と同じ q=…&tag=… 形式)。 */
function historyQueryAttr(e: HistoryEntry): string {
  const sp = new URLSearchParams();
  if (e.q !== '') sp.set('q', e.q);
  if (e.tag !== '') sp.set('tag', e.tag.replace(/^#+/, ''));
  if (e.folder !== '') sp.set('folder', e.folder);
  if (e.sort !== 'updated') sp.set('sort', e.sort);
  return sp.toString();
}

function historyLabel(e: HistoryEntry): string {
  if (e.q !== '') return e.q;
  if (e.tag !== '') return e.tag;
  if (e.folder !== '') return `${e.folder}/`;
  return '(すべて)';
}

function historyMeta(e: HistoryEntry): string {
  const parts: string[] = [];
  if (e.tag !== '') parts.push(e.tag.split(/\s+/).map((t) => `#${t.replace(/^#+/, '')}`).join(' '));
  parts.push(e.folder === '' ? '全フォルダ' : `${e.folder}/`);
  parts.push(`${String(e.count)} 件`);
  return parts.join(' · ');
}

const SORT_LABELS: Record<SearchSort, string> = {
  updated: '更新日時(新しい順)',
  score: '関連度スコア',
  name: 'ファイル名(昇順)',
};

export function SearchPage({
  params,
  onNavigate,
  onOpenNoteInEditor,
}: SearchPageProps): JSX.Element {
  // 下書き (フォーム編集用)。params が変わると同期する。
  const [draftQ, setDraftQ] = useState(params.q);
  const [draftTag, setDraftTag] = useState(params.tag);
  const [draftFolder, setDraftFolder] = useState(params.folder);
  const [draftSort, setDraftSort] = useState<SearchSort>(params.sort);

  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => readHistory());

  // プレビュー (右カラム)。結果クリックで表示、一覧は保持される。
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | 'loading' | 'error'>('loading');

  const searchSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);

  const hasCriteria = params.q !== '' || params.tag !== '' || params.folder !== '';

  const upsertHistory = useCallback(
    (e: { q: string; tag: string; folder: string; sort: SearchSort }, count: number): void => {
      const entry: HistoryEntry = { ...e, count };
      setHistory((prev) => {
        const key = historyKey(e);
        const next = [entry, ...prev.filter((h) => historyKey(h) !== key)].slice(0, HISTORY_MAX);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {
          // localStorage 不可 (プライベートモード等) でも検索自体は動く
        }
        return next;
      });
    },
    [],
  );

  // ---- params (URL) に従って検索を実行する ----
  useEffect(() => {
    // フォームを URL の条件へ同期 (戻る/進む・履歴クリック・ブックマークで反映)
    setDraftQ(params.q);
    setDraftTag(params.tag);
    setDraftFolder(params.folder);
    setDraftSort(params.sort);
    setPreviewPath(null);

    const seq = (searchSeqRef.current += 1);
    if (!hasCriteria) {
      setRows([]);
      setError(null);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    const wantedTags = parseTagQuery(params.tag);
    void (async (): Promise<void> => {
      try {
        const noteRes = await api.listNotes();
        if (seq !== searchSeqRef.current) return;
        setNotes(noteRes.notes);
        const filtered = noteRes.notes.filter(
          (n) => noteMatchesTags(n.tags, wantedTags) && noteInFolder(n.folder, params.folder),
        );
        let result: ResultRow[];
        if (params.q !== '') {
          const searchRes = await api.search(params.q);
          if (seq !== searchSeqRef.current) return;
          const metaByPath = new Map(filtered.map((n) => [n.path, n]));
          result = searchRes.results.flatMap((r) => {
            const m = metaByPath.get(r.path);
            if (m === undefined) return [];
            return [
              {
                path: r.path,
                title: r.title,
                snippet: r.snippet,
                score: r.score,
                tags: m.tags,
                mtime: m.mtime ?? 0,
              },
            ];
          });
        } else {
          result = filtered.map((n) => ({
            path: n.path,
            title: n.title,
            snippet: '',
            score: 0,
            tags: n.tags,
            mtime: n.mtime ?? 0,
          }));
        }
        result.sort((a, b) => {
          if (params.sort === 'name') return a.title.localeCompare(b.title, 'ja');
          if (params.sort === 'score') return a.score - b.score;
          return b.mtime - a.mtime; // updated
        });
        setRows(result);
        setError(null);
        setLoaded(true);
        upsertHistory({ q: params.q, tag: params.tag, folder: params.folder, sort: params.sort }, result.length);
      } catch (err) {
        if (seq !== searchSeqRef.current) return;
        setRows([]);
        setError(
          `検索に失敗しました — ${err instanceof ApiError ? err.message : String(err)}`,
        );
        setLoaded(true);
      }
    })();
    // upsertHistory は同一 render 内で安定 (下で定義)。params のみを依存にする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // ---- プレビュー取得 ----
  useEffect(() => {
    if (previewPath === null) return;
    const seq = (previewSeqRef.current += 1);
    setPreviewContent('loading');
    api.getNote(previewPath).then(
      (res) => {
        if (seq === previewSeqRef.current) setPreviewContent(res.content);
      },
      () => {
        if (seq === previewSeqRef.current) setPreviewContent('error');
      },
    );
  }, [previewPath]);

  // ---- プレビュー本文を mini-md で描画 (read-only / textContent ベース) ----
  useEffect(() => {
    const el = previewBodyRef.current;
    if (el === null) return;
    el.replaceChildren();
    if (typeof previewContent === 'string' && previewContent !== 'loading' && previewContent !== 'error') {
      renderMarkdownInto(el, previewContent, {});
    }
  }, [previewContent, previewPath]);

  // ---- フォルダ select の選択肢 (実データから distinct) ----
  const folderOptions = useMemo(() => {
    const set = new Set<string>();
    for (const n of notes) if (n.folder !== '') set.add(n.folder);
    // 現在の絞り込み値が候補に無くても選べるようにする
    if (params.folder !== '') set.add(params.folder.replace(/\/+$/, ''));
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
  }, [notes, params.folder]);

  const commit = useCallback(
    (next: SearchParams): void => {
      onNavigate(next);
    },
    [onNavigate],
  );

  const onSubmit = useCallback(
    (e: FormEvent): void => {
      e.preventDefault();
      commit({
        q: draftQ.trim().normalize('NFC'),
        tag: draftTag.trim().normalize('NFC'),
        folder: draftFolder,
        sort: draftSort,
      });
    },
    [commit, draftQ, draftTag, draftFolder, draftSort],
  );

  const onReset = useCallback((): void => {
    setDraftQ('');
    setDraftTag('');
    setDraftFolder('');
    setDraftSort('updated');
  }, []);

  const replayHistory = useCallback(
    (h: HistoryEntry): void => {
      commit({ q: h.q, tag: h.tag, folder: h.folder, sort: h.sort });
    },
    [commit],
  );

  const previewTitle = useMemo(() => {
    if (previewPath === null) return '';
    const base = previewPath.split('/').at(-1) ?? previewPath;
    return base.endsWith('.md') ? base.slice(0, -3) : base;
  }, [previewPath]);

  const showEmpty = hasCriteria && loaded && error === null && rows.length === 0;

  return (
    <div className="search-page" data-testid="search-page">
      {/* 条件はコンパクトな 1 行インラインバー (AC-Sa629e2-3-1)。Enter (submit) で検索 */}
      <form className="search-bar" data-testid="search-form" onSubmit={onSubmit} onReset={onReset}>
        <div className="sb-kw">
          <SearchIcon />
          <input
            id="search-q"
            type="text"
            data-testid="search-field-fulltext"
            value={draftQ}
            placeholder="全文キーワード"
            title="全文キーワード (本文・見出し)"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDraftQ(e.currentTarget.value)}
          />
        </div>
        <input
          id="search-tag"
          type="text"
          className="sb-tag"
          data-testid="search-field-tag"
          value={draftTag}
          placeholder="#tag(空白で AND)"
          title="タグ絞り込み (空白区切りで AND)"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraftTag(e.currentTarget.value)}
        />
        <select
          id="search-folder"
          data-testid="search-field-folder"
          value={draftFolder}
          title="フォルダ絞り込み"
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setDraftFolder(e.currentTarget.value)}
        >
          <option value="">すべてのフォルダ</option>
          {folderOptions.map((f) => (
            <option key={f} value={f}>
              {f}/
            </option>
          ))}
        </select>
        <select
          id="search-sort"
          data-testid="search-field-sort"
          value={draftSort}
          title="並び順"
          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
            const v = e.currentTarget.value;
            if (isSearchSort(v)) setDraftSort(v);
          }}
        >
          <option value="updated">{SORT_LABELS.updated}</option>
          <option value="score">{SORT_LABELS.score}</option>
          <option value="name">{SORT_LABELS.name}</option>
        </select>
        <button className="btn primary" type="submit" data-testid="search-submit">
          検索
        </button>
        <button className="btn" type="reset" title="条件をクリア">
          クリア
        </button>
        <span className="result-count">
          {hasCriteria && loaded ? `${String(rows.length)} 件` : ''}
        </span>
      </form>

      {/* 検索履歴: バー直下の控えめなチップ列 (クリックで同じ検索を再実行) */}
      {history.length > 0 && (
        <div className="search-history-strip" data-testid="search-history">
          <span className="shs-label">最近:</span>
          {history.map((h) => (
            <button
              key={historyKey(h)}
              type="button"
              className="history-chip"
              data-testid="search-history-item"
              data-query={historyQueryAttr(h)}
              title={historyMeta(h)}
              onClick={() => replayHistory(h)}
            >
              <FileIcon />
              <span className="hc-label">{historyLabel(h)}</span>
              <span className="hc-count">{h.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="search-main">
        <div className="search-results-col" data-testid="search-results">
          {error !== null && (
            <div className="search-error" data-testid="search-error">
              {error}
            </div>
          )}

          {/* 密な結果リスト: タイトル・パス・更新日時 + スニペット 1 行 (AC-Sa629e2-3-2) */}
          {rows.map((r) => (
            <button
              key={r.path}
              type="button"
              className={`search-result-row${previewPath === r.path ? ' active' : ''}`}
              data-testid="search-result-item"
              data-path={r.path}
              onClick={() => setPreviewPath(r.path)}
            >
              <div className="sr-top">
                <span className="sr-title">{r.title}</span>
                {r.tags.map((t) => (
                  <span key={t} className="sr-badge tag">
                    #{t}
                  </span>
                ))}
                <span className="sr-path">{r.path}</span>
                {formatMtime(r.mtime) !== '' && (
                  <span className="sr-mtime">{formatMtime(r.mtime)}</span>
                )}
              </div>
              {r.snippet !== '' && (
                <div className="sr-snippet">{highlight(r.snippet, params.q)}</div>
              )}
            </button>
          ))}

          {showEmpty && (
            <div className="search-empty" data-testid="search-empty">
              条件に一致するノートはありません。
            </div>
          )}
          {!hasCriteria && (
            <div className="search-empty" data-testid="search-empty">
              全文キーワード・タグ・フォルダのいずれかを指定して検索してください。
            </div>
          )}
        </div>

        {previewPath !== null && (
          <aside className="search-preview-col" data-testid="search-preview-pane" data-path={previewPath}>
            <div className="search-preview-head">
              <div className="spv-title">
                <DocumentIcon />
                <div>
                  <div className="spv-name">{previewTitle}</div>
                  <div className="spv-path">{previewPath}</div>
                </div>
              </div>
              <div className="spv-actions">
                <button
                  className="btn"
                  type="button"
                  data-testid="search-preview-open-editor"
                  onClick={() => onOpenNoteInEditor(previewPath)}
                >
                  エディタで開く
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  title="プレビューを閉じる"
                  data-testid="search-preview-close"
                  onClick={() => setPreviewPath(null)}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
            {previewContent === 'loading' ? (
              <div className="search-preview-status">読み込み中…</div>
            ) : previewContent === 'error' ? (
              <div className="search-preview-status">ノートを読み込めませんでした。</div>
            ) : (
              <div className="search-preview-body md-preview" ref={previewBodyRef} />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
