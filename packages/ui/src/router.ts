/**
 * History API ベースの軽量ルーター (Sf1a90a-1)。
 *
 * ルート:
 *   - ノート: /n/{vault パス — 末尾 .md を除いたもの}
 *     例: projects/Hydra 設計メモ.md → /n/projects/Hydra%20設計メモ
 *   - ファイル一覧 (アセット): /files  (ページ本体は Seac77a — 本 Sprint は placeholder)
 *   - それ以外 (/ 含む未知パス): home = 今日のジャーナルへ着地
 *
 * URL から .md を除く理由:
 *   - prototype/shell-routing.html の `/n/projects/Hydra 設計メモ` に厳密一致
 *   - Vite dev の SPA フォールバックが `.md` 終端 URL を静的アセット要求と誤認して
 *     404 になるのを避ける
 * 正本は常にピュア Markdown (path は .md 付きの vault 相対パス)。URL 表現だけ .md を落とす。
 */

export type Route =
  | { readonly kind: 'note'; readonly path: string }
  | { readonly kind: 'files' }
  | { readonly kind: 'home' };

/** Route を pathname 文字列へ (pushState 用)。ノートは .md を除いてセグメント符号化。 */
export function routeToPath(route: Route): string {
  switch (route.kind) {
    case 'files':
      return '/files';
    case 'home':
      return '/';
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

/** location.pathname を Route へ。未知パスは home。 */
export function parseLocation(pathname: string): Route {
  if (pathname === '/files') return { kind: 'files' };
  const m = /^\/n\/(.+)$/.exec(pathname);
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
    const path = /\.md$/i.test(decoded) ? decoded : `${decoded}.md`;
    return { kind: 'note', path: path.normalize('NFC') };
  }
  return { kind: 'home' };
}

/** 2 つの Route が同一遷移先か (履歴の重複 push を避ける)。 */
export function sameRoute(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'note' && b.kind === 'note') return a.path === b.path;
  return true;
}
