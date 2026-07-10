/**
 * タグクリック共通ハンドラ (S11493d-4)。
 *
 * 任意のタグ表示箇所で共通利用できるファクトリ関数。React・非 React どちらの
 * コンテキストでも使えるよう、フレームワーク依存なしの純粋関数として実装する。
 * App.tsx で 1 回だけインスタンス化し、各描画箇所 (InfoPanel / properties.ts /
 * dataview.ts / table.ts / Editor の onOpenTag) へ注入する。
 *
 * URL エンコードは既存の openSearch → SearchParams → routeToPath の経路に委ねる
 * (ここでは二重エンコードしない)。
 */
import type { SearchParams } from './router.js';

/**
 * タグクリックハンドラのファクトリ。
 * @param openSearch - App.tsx の openSearch 関数 (SearchParams → void)
 * @returns `(tag: string) => void` 形式のハンドラ。クリックされたタグを
 *          `/search?tag=<tag>` へナビゲートする。
 */
export function makeTagClickHandler(
  openSearch: (params: SearchParams) => void,
): (tag: string) => void {
  return (tag: string): void => {
    openSearch({ q: '', tag, folder: '', sort: 'updated' });
  };
}
