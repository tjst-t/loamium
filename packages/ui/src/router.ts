/**
 * History API ベースの軽量ルーター (Sf1a90a-1)。
 *
 * ルート:
 *   - ノート: /n/{vault パス — 末尾 .md を除いたもの}
 *     例: projects/Hydra 設計メモ.md → /n/projects/Hydra%20設計メモ
 *   - ファイル一覧 (アセット): /files  (ページ本体は Seac77a — 本 Sprint は placeholder)
 *   - 詳細検索ページ: /search?q=&tag=&folder=&sort=  (S935867-1)
 *     条件を URL クエリに同期し、戻る/進む・ブックマークで同じ検索を再現する。
 *   - それ以外 (/ 含む未知パス): home = 今日のジャーナルへ着地
 *
 * URL から .md を除く理由:
 *   - prototype/shell-routing.html の `/n/projects/Hydra 設計メモ` に厳密一致
 *   - Vite dev の SPA フォールバックが `.md` 終端 URL を静的アセット要求と誤認して
 *     404 になるのを避ける
 * 正本は常にピュア Markdown (path は .md 付きの vault 相対パス)。URL 表現だけ .md を落とす。
 */

/** 検索結果の並び順 (S935867-1 — prototype/search-page.html の select 3 択)。 */
export type SearchSort = 'updated' | 'score' | 'name';

/** 詳細検索ページの条件 (URL クエリに 1:1 で同期する)。 */
export interface SearchParams {
  /** 全文キーワード (GET /api/search?q=) */
  readonly q: string;
  /** タグ絞り込み。`#tag` 空白区切りで AND (raw 文字列で保持) */
  readonly tag: string;
  /** フォルダ絞り込み ("" = すべてのフォルダ) */
  readonly folder: string;
  /** 並び順 (既定 updated) */
  readonly sort: SearchSort;
}

export type Route =
  | { readonly kind: 'note'; readonly path: string }
  | { readonly kind: 'files' }
  | { readonly kind: 'search'; readonly params: SearchParams }
  | { readonly kind: 'home' };

const SEARCH_SORTS: readonly SearchSort[] = ['updated', 'score', 'name'];

function isSearchSort(v: string): v is SearchSort {
  return (SEARCH_SORTS as readonly string[]).includes(v);
}

/** URLSearchParams を SearchParams へ (欠損・不正 sort は既定へ)。 */
export function parseSearchParams(query: string): SearchParams {
  const sp = new URLSearchParams(query);
  const sortRaw = sp.get('sort') ?? '';
  return {
    q: (sp.get('q') ?? '').normalize('NFC'),
    tag: (sp.get('tag') ?? '').normalize('NFC'),
    folder: (sp.get('folder') ?? '').normalize('NFC'),
    sort: isSearchSort(sortRaw) ? sortRaw : 'updated',
  };
}

/** SearchParams を URL クエリ文字列へ (空値・既定 sort は省略してクリーンに保つ)。 */
export function searchParamsToQuery(params: SearchParams): string {
  const sp = new URLSearchParams();
  if (params.q !== '') sp.set('q', params.q);
  if (params.tag !== '') sp.set('tag', params.tag);
  if (params.folder !== '') sp.set('folder', params.folder);
  if (params.sort !== 'updated') sp.set('sort', params.sort);
  return sp.toString();
}

/** Route を pathname(+ クエリ) 文字列へ (pushState 用)。ノートは .md を除いてセグメント符号化。 */
export function routeToPath(route: Route): string {
  switch (route.kind) {
    case 'files':
      return '/files';
    case 'home':
      return '/';
    case 'search': {
      const qs = searchParamsToQuery(route.params);
      return qs === '' ? '/search' : `/search?${qs}`;
    }
    case 'note': {
      const noExt = route.path.replace(/\.md$/i, '');
      const encoded = noExt
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      return `/n/${encoded}`;
    }
  }
}

/**
 * location.pathname (+ search) を Route へ。未知パスは home。
 * pathname 内に `?` を含む単一文字列でも、pathname と search を分けて渡しても解釈する。
 */
export function parseLocation(pathname: string, search = ''): Route {
  let path = pathname;
  let query = search;
  const qIdx = path.indexOf('?');
  if (qIdx !== -1) {
    query = path.slice(qIdx + 1);
    path = path.slice(0, qIdx);
  }
  if (path === '/files') return { kind: 'files' };
  if (path === '/search') return { kind: 'search', params: parseSearchParams(query) };
  const m = /^\/n\/(.+)$/.exec(path);
  const raw = m?.[1];
  if (raw !== undefined && raw !== '') {
    let decoded: string;
    try {
      decoded = raw
        .split('/')
        .map((seg) => decodeURIComponent(seg))
        .join('/');
    } catch {
      return { kind: 'home' }; // 壊れた符号化はホームへ
    }
    // 正本は .md 付き vault パス。URL 表現の .md 欠落を補完する。
    const notedPath = /\.md$/i.test(decoded) ? decoded : `${decoded}.md`;
    return { kind: 'note', path: notedPath.normalize('NFC') };
  }
  return { kind: 'home' };
}

/** 2 つの Route が同一遷移先か (履歴の重複 push を避ける)。 */
export function sameRoute(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'note' && b.kind === 'note') return a.path === b.path;
  if (a.kind === 'search' && b.kind === 'search') {
    return searchParamsToQuery(a.params) === searchParamsToQuery(b.params);
  }
  return true;
}
