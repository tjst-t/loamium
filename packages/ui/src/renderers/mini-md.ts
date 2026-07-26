/**
 * 埋め込みカード・callout 本文用のミニ Markdown レンダラー (S9e5ca4-1/3)。
 *
 * CodeMirror の外 (読み取り専用ウィジェット内) で使う小さな表示専用レンダラー。
 * DOM は textContent ベースで組み立てる (innerHTML 不使用 — vault の内容を
 * スクリプトとして実行させない。DESIGN_PRINCIPLES priority 2)。
 *
 * 対応する記法 (prototype/embed-preview.html の embed-body 相当):
 * - 見出し (# 〜 ######) → .e-h1〜.e-h6
 * - 箇条書き (- / * / +) と番号リスト (1.)
 * - コードフェンス → pre > code
 * - 引用 (>)
 * - 段落 / 空行
 * - インライン: `code` / **bold** / ==highlight== / [[wikilink]] / ![](画像) /
 *   [表示名](url) (Markdown リンク) / 裸 URL の自動リンク
 * - embed 行 (![[...]]) は onEmbedLine コールバックに委譲 (embed レンダラーが
 *   再帰カードを供給する。未指定ならソース文字列のまま)
 */
import { isExternalHref, trimUrlTail } from '@loamium/shared';
import type { RenderEnv } from '../registries.js';

export interface MiniMdOptions {
  env?: RenderEnv | undefined;
  /** ![[target]] 単独行の描画。null を返すとソース文字列のままにする */
  onEmbedLine?: ((rawTarget: string) => HTMLElement | null) | undefined;
  /** ![](path) / ![[img]] の画像描画 (embed レンダラーが供給する) */
  onImage?: ((path: string, alt: string) => HTMLElement) | undefined;
}

export const EMBED_LINE_RE = /^\s*!\[\[([^[\]\n]+)\]\]\s*$/;

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const QUOTE_RE = /^>\s?(.*)$/;

/**
 * インライン記法のスキャン順 (先勝ち)。
 * 6 = Markdown リンク [表示名](url)。画像 ![..](..) と衝突しないよう直前 `!` を否定。
 * 7 = 裸 URL (http/https)。末尾の句読点は {@link trimUrlTail} で後処理する。
 */
const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(==[^\s=](?:[^=\n]|=(?!=))*==)|(\[\[[^[\]\n|]+(?:\|[^[\]\n]+)?\]\])|(!\[[^\]\n]*\]\([^()\s\n]+\))|((?<!!)\[[^\]\n]+\]\([^()\s\n]+\))|(https?:\/\/[^\s<>]+)/g;

/**
 * クリック可能なリンクアンカーを parent に追加する。
 * - 外部 (http/https/mailto): 本物の <a href target=_blank>。Electron の右クリック
 *   「リンクを開く」も real href から効く。
 * - 内部 (相対パス等): env.openNote へ委譲 (href には任意スキームを入れない = 安全)。
 * 遷移は mousedown で行い click 伝播を止める: callout 等の BlockRuleWidget ラッパは
 * click でカーソル移動 → ソース表示に戻すため、そのままだとリンクが機能しない。
 */
function appendLink(parent: HTMLElement, href: string, label: string, opts: MiniMdOptions): void {
  const a = document.createElement('a');
  a.className = 'md-link';
  a.textContent = label;
  const external = isExternalHref(href);
  if (external) {
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = href;
  } else {
    a.classList.add('internal');
    a.setAttribute('role', 'link');
  }
  a.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (external) {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else {
      opts.env?.openNote(href);
    }
  });
  // BlockRuleWidget ラッパの click(→カーソル移動) を止める。
  a.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  parent.append(a);
}

/** インライン記法を解釈して parent に追加する。 */
export function appendInlineMarkdown(parent: HTMLElement, text: string, opts: MiniMdOptions): void {
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const token = m[0];
    if (m[1] !== undefined) {
      // `code`
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (m[2] !== undefined) {
      // **bold**
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (m[3] !== undefined) {
      // ==highlight== (embed / callout 本文内でも highlight 表示を揃える)
      const mark = document.createElement('span');
      mark.className = 'md-mark';
      mark.textContent = token.slice(2, -2);
      parent.append(mark);
    } else if (m[4] !== undefined) {
      // [[target|alias]] — 表示のみのピル (クリックで env.openNote は
      // embed カード側のヘッダに委ねる: 本文中リンクは装飾に留める)
      const inner = token.slice(2, -2);
      const bar = inner.indexOf('|');
      const label = (bar === -1 ? inner : inner.slice(bar + 1)).trim();
      const span = document.createElement('span');
      span.className = 'wikilink';
      span.textContent = label;
      parent.append(span);
    } else if (m[5] !== undefined && opts.onImage !== undefined) {
      // ![alt](path)
      const im = /^!\[([^\]\n]*)\]\(([^()\s\n]+)\)$/.exec(token);
      if (im !== null) {
        parent.append(opts.onImage(im[2] ?? '', im[1] ?? ''));
      } else {
        parent.append(token);
      }
    } else if (m[6] !== undefined) {
      // [表示名](url) — Markdown リンク
      const lm = /^\[([^\]\n]+)\]\(([^()\s\n]+)\)$/.exec(token);
      if (lm !== null) {
        appendLink(parent, lm[2] ?? '', lm[1] ?? '', opts);
      } else {
        parent.append(token);
      }
    } else if (m[7] !== undefined) {
      // 裸 URL の自動リンク。末尾の句読点は URL 外としてテキストに戻す。
      const url = trimUrlTail(token);
      appendLink(parent, url, url, opts);
      if (url.length < token.length) parent.append(token.slice(url.length));
    } else {
      parent.append(token);
    }
    last = m.index + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** markdown をブロック単位で el 配下に描画する。 */
export function renderMarkdownInto(el: HTMLElement, markdown: string, opts: MiniMdOptions): void {
  const lines = markdown.split('\n');
  let paragraph: string[] = [];
  let list: { el: HTMLElement; kind: 'ul' | 'ol' } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const p = document.createElement('p');
    appendInlineMarkdown(p, paragraph.join(' '), opts);
    el.append(p);
    paragraph = [];
  };
  const flushList = (): void => {
    list = null;
  };
  const pushListItem = (kind: 'ul' | 'ol', text: string): void => {
    flushParagraph();
    if (list === null || list.kind !== kind) {
      const box = document.createElement(kind);
      el.append(box);
      list = { el: box, kind };
    }
    const li = document.createElement('li');
    appendInlineMarkdown(li, text, opts);
    list.el.append(li);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      flushParagraph();
      flushList();
      const mark = (fence[1] ?? '```')[0] ?? '`';
      const code: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j] ?? '';
        const close = FENCE_RE.exec(l);
        if (close !== null && (close[1] ?? '')[0] === mark) break;
        code.push(l);
      }
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code.join('\n');
      pre.append(codeEl);
      el.append(pre);
      i = j; // 閉じフェンス行 (無ければ末尾) までスキップ
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const embed = EMBED_LINE_RE.exec(line);
    if (embed !== null && opts.onEmbedLine !== undefined) {
      const child = opts.onEmbedLine(embed[1] ?? '');
      if (child !== null) {
        flushParagraph();
        flushList();
        el.append(child);
        continue;
      }
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const lvl = (heading[1] ?? '#').length;
      const h = document.createElement('div');
      h.className = `e-h${String(lvl)}`;
      appendInlineMarkdown(h, heading[2] ?? '', opts);
      el.append(h);
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet !== null) {
      pushListItem('ul', bullet[1] ?? '');
      continue;
    }
    const ordered = ORDERED_RE.exec(line);
    if (ordered !== null) {
      pushListItem('ol', ordered[1] ?? '');
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote !== null) {
      flushParagraph();
      flushList();
      const bq = document.createElement('blockquote');
      appendInlineMarkdown(bq, quote[1] ?? '', opts);
      el.append(bq);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
}
