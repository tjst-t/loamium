/**
 * ==highlight== インラインレンダラー (S9e5ca4-4 — Obsidian 互換記法)。
 *
 * inline レジストリに登録するだけの最小実装。エンジン (live-preview) 側の規約で
 * - カーソル行はソース表示
 * - コードフェンス・インラインコード内は装飾されない
 * が保証される (AC-S9e5ca4-4-1)。
 */
import { registerInlineRule } from '../registries.js';

/**
 * ==text== (内容は非空・先頭非空白、= の連続は含まない)。
 * mini-md.ts のインライン規則と同じパターンを使う。
 */
export const HIGHLIGHT_RE = /==([^\s=](?:[^=\n]|=(?!=))*)==/g;

export function registerHighlightRenderer(): void {
  registerInlineRule({
    pattern: HIGHLIGHT_RE,
    render(match) {
      const mark = document.createElement('span');
      mark.className = 'md-mark';
      mark.setAttribute('data-testid', 'highlight');
      mark.textContent = match[1] ?? '';
      return mark;
    },
  });
}
