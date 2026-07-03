/**
 * KaTeX 数式レンダラー (client 種別 — SPEC §8.4)。
 *
 * - $…$ → inline レジストリ (math-inline)
 * - $$…$$ → block レジストリ (math-block、複数行 / 1 行の両対応)
 *
 * katex は小さく数式は高頻度なので静的 import (decisions.json I7)。
 * throwOnError: false — 不正な数式はエラー色の TeX ソース表示に留める。
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { registerBlockRule, registerInlineRule } from '../registries.js';

function renderMath(tex: string, displayMode: boolean): HTMLElement {
  const el = document.createElement(displayMode ? 'div' : 'span');
  el.className = displayMode ? 'math-block' : 'math-inline';
  el.setAttribute('data-testid', displayMode ? 'math-block' : 'math-inline');
  katex.render(tex, el, { displayMode, throwOnError: false });
  return el;
}

const BLOCK_OPEN_RE = /^\s*\$\$/;
const BLOCK_SINGLE_LINE_RE = /^\s*\$\$(.+)\$\$\s*$/;
const BLOCK_CLOSE_RE = /\$\$\s*$/;

export function registerKatexRenderers(): void {
  // $…$ インライン数式。開始直後が空白/$ のもの (通貨表記等) は対象外。
  registerInlineRule({
    pattern: /\$([^\s$][^$\n]*?)\$/g,
    render(match) {
      return renderMath(match[1] ?? '', false);
    },
  });

  // $$…$$ ブロック数式
  registerBlockRule({
    match: (line) => BLOCK_OPEN_RE.test(line),
    matchEnd(line, offsetFromStart) {
      if (offsetFromStart === 0) return BLOCK_SINGLE_LINE_RE.test(line);
      return BLOCK_CLOSE_RE.test(line);
    },
    render(lines) {
      const single = BLOCK_SINGLE_LINE_RE.exec(lines[0] ?? '');
      const tex =
        single !== null && lines.length === 1
          ? (single[1] ?? '')
          : lines
              .join('\n')
              .replace(/^\s*\$\$/, '')
              .replace(/\$\$\s*$/, '');
      return renderMath(tex.trim(), true);
    },
  });
}
