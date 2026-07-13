/**
 * palettePrefix.ts — パレット入力プレフィックス解析 (ADR-0019)
 *
 * '>' prefix  → コマンド専用モード
 * (将来) '#'  → タグ検索モード、など加算的に足せる
 *
 * このモジュールが prefix→mode の唯一の正源とする。
 * SearchPalette.tsx はこの関数だけを呼び、モードを派生させる。
 */

export type PaletteMode = 'normal' | 'command';

export interface ParsedPaletteInput {
  mode: PaletteMode;
  /** モード固有のクエリ文字列 (プレフィックス除去後) */
  query: string;
}

/** prefix → mode の対応マップ。将来 '#' 等を追加する際はここだけ変える。 */
const PREFIX_MAP: ReadonlyArray<{ prefix: string; mode: PaletteMode }> = [
  { prefix: '>', mode: 'command' },
];

/**
 * rawInput を解析してパレットモードとクエリを返す。
 * プレフィックスが見つかった場合、プレフィックス直後の文字列 (先頭スペースを保持) をクエリとする。
 * gui-spec シナリオ edge_prefix_centralized 参照。
 */
export function parsePaletteInput(rawInput: string): ParsedPaletteInput {
  for (const { prefix, mode } of PREFIX_MAP) {
    if (rawInput.startsWith(prefix)) {
      return { mode, query: rawInput.slice(prefix.length) };
    }
  }
  return { mode: 'normal', query: rawInput };
}
