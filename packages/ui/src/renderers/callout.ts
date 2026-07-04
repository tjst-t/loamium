/**
 * callout レンダラー (S9e5ca4-3 — prototype/callout-highlight.html 準拠)。
 *
 * blockquote 先頭行の > [!type] を検出し、タイトル付き色付きボックスで描画する。
 * - 既知タイプ: note / info / tip / warning / danger。未知タイプは note にフォールバック
 * - > [!type]- は折りたたみ (閉じた状態で描画、タイトルクリックで開閉)
 * - ブロックは連続する > 行 (次の > [!type] 行からは新しい callout)
 *
 * Obsidian 互換記法のみ (priority 4)。表示層のみでファイルは変更しない (priority 1)。
 */
import { registerBlockRule } from '../registries.js';
import { renderMarkdownInto } from './mini-md.js';

export const CALLOUT_OPEN_RE = /^>\s*\[!([A-Za-z0-9_-]+)\]([-+]?)\s?(.*)$/;
const QUOTE_LINE_RE = /^>/;

export const KNOWN_CALLOUT_TYPES = ['note', 'info', 'tip', 'warning', 'danger'] as const;
export type CalloutType = (typeof KNOWN_CALLOUT_TYPES)[number];

/** 未知タイプは note にフォールバック (AC-S9e5ca4-3-1)。 */
export function normalizeCalloutType(raw: string): CalloutType {
  const t = raw.toLowerCase();
  return (KNOWN_CALLOUT_TYPES as readonly string[]).includes(t) ? (t as CalloutType) : 'note';
}

/** タイトル省略時の既定タイトル (prototype 準拠: note は「メモ」)。 */
const DEFAULT_TITLES: Readonly<Record<CalloutType, string>> = {
  note: 'メモ',
  info: 'Info',
  tip: 'Tip',
  warning: 'Warning',
  danger: 'Danger',
};

/** タイプ別アイコン (prototype/callout-highlight.html の固定 SVG)。 */
const ICONS: Readonly<Record<CalloutType, string>> = {
  note: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L6 12l-2.7.7L4 10z"/><path d="M10 4l2 2"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2V11M8 4.8h.01"/></svg>',
  tip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8a4.4 4.4 0 00-2.4 8.1c.5.4.9 1 .9 1.6h3c0-.6.4-1.2.9-1.6A4.4 4.4 0 008 1.8z"/><path d="M6.8 13.5h2.4"/></svg>',
  warning:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L1.8 13h12.4z"/><path d="M8 6.5v3M8 11.5h.01"/></svg>',
  danger:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 1.8h5L14.2 5.5v5L10.5 14.2h-5L1.8 10.5v-5z"/><path d="M8 5v3.5M8 11h.01"/></svg>',
};

const FOLD_CHEV =
  '<svg class="fold-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';

/** 固定 SVG 文字列 (上の定数のみ) をアイコン要素にする。 */
function icon(svg: string, className: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.innerHTML = svg; // 定数リテラルのみ (vault 由来の文字列は通さない)
  return span;
}

/** 2 行目以降の > プレフィクスを剥がして本文 Markdown に戻す。 */
export function calloutBodyOf(lines: readonly string[]): string {
  return lines
    .slice(1)
    .map((l) => l.replace(/^>\s?/, ''))
    .join('\n');
}

export function registerCalloutRenderer(): void {
  registerBlockRule({
    match: (line) => CALLOUT_OPEN_RE.test(line),
    // 連続する > 行が本文。次の > [!type] 行は新しい callout の開始
    matchWhile: (line) => QUOTE_LINE_RE.test(line) && !CALLOUT_OPEN_RE.test(line),
    render(lines) {
      const m = CALLOUT_OPEN_RE.exec(lines[0] ?? '');
      const type = normalizeCalloutType(m?.[1] ?? 'note');
      const foldable = (m?.[2] ?? '') !== '';
      const startFolded = (m?.[2] ?? '') === '-';
      const customTitle = (m?.[3] ?? '').trim();
      const title = customTitle.length > 0 ? customTitle : DEFAULT_TITLES[type];

      const box = document.createElement('div');
      box.className = 'callout';
      box.setAttribute('data-testid', 'callout');
      box.setAttribute('data-type', type);

      const body = document.createElement('div');
      body.className = 'callout-body';
      renderMarkdownInto(body, calloutBodyOf(lines), {});

      if (foldable) {
        box.setAttribute('data-folded', String(startFolded));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'callout-title';
        btn.setAttribute('data-testid', 'callout-fold');
        btn.setAttribute('aria-expanded', String(!startFolded));
        btn.append(icon(ICONS[type], 'callout-ico'), document.createTextNode(title), icon(FOLD_CHEV, 'callout-chev'));
        // mousedown: click だとカーソルが行へ入り装飾がソースに差し替わる
        // (WikilinkWidget / embed ヘッダと同じ理由)
        btn.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const folded = box.getAttribute('data-folded') === 'true';
          box.setAttribute('data-folded', String(!folded));
          btn.setAttribute('aria-expanded', String(folded));
        });
        // click は callout 全体の「ソース編集へ戻る」リスナーに届かせない
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        box.append(btn, body);
      } else {
        const titleEl = document.createElement('div');
        titleEl.className = 'callout-title';
        titleEl.append(icon(ICONS[type], 'callout-ico'), document.createTextNode(title));
        box.append(titleEl, body);
      }
      return box;
    },
  });
}
