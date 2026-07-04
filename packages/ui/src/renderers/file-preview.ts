/**
 * ![[file]] の埋め込みプレビューブロック (Sf53ad6-3 — prototype/file-preview.html)。
 *
 * embed の拡張子レジストリ (registerEmbedFileRenderer) に乗る:
 * - PDF (data-kind="pdf")   ブラウザ内蔵ビューア (iframe / GET /api/files)。pdf.js は同梱しない
 * - テキスト (data-kind="text")  読み取り専用ブロック。コード拡張子は Shiki ハイライト、
 *   大きいものは先頭 N 行 + 「全体を開く」(file-embed-open-full)
 * - それ以外 (data-kind="card")  ファイルカード (名前・サイズ・ダウンロードリンク)
 *
 * .md は embed.ts が transclusion (embed-card) として処理し、ここへは来ない。
 * すべて表示層のみ — ファイル (ピュア Markdown) は変更しない (priority 1)。
 */
import type { RenderContext } from '../registries.js';
import { extensionOf, formatSize, TEXT_PREVIEW_EXTENSIONS } from '../file-kind.js';
import { SHIKI_LANGS } from './shiki.js';

/** 先頭に表示する行数 (プロトタイプの「先頭 N 行 + 全体を開く」)。 */
export const TEXT_PREVIEW_LINES = 30;
/** これを超えるテキストはプレビュー取得せず「新しいタブで開く」誘導にする。 */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** vault 相対パス → GET /api/files URL (セグメント単位 percent-encode)。 */
export function filesUrlOf(rel: string): string {
  return `/api/files/${rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`;
}

/** コード拡張子 → Shiki 言語 (対応が無ければ null = プレーン表示)。 */
export function shikiLangOf(ext: string): string | null {
  const alias: Record<string, string> = {
    mjs: 'js',
    cjs: 'js',
    h: 'c',
    hpp: 'cpp',
    htm: 'html',
    patch: 'diff',
  };
  const lang = alias[ext] ?? ext;
  return SHIKI_LANGS.includes(lang) ? lang : null;
}

const FILE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" class="embed-ico"><path d="M4 1.8h5.2L12.2 4.8v9.4H4z"/><path d="M9.2 1.8v3h3"/></svg>';
const OPEN_TAB_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h7v7M13 3L7 9"/><path d="M11 9v4H3V5h4" opacity="0.5"/></svg>';
const EXPAND_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z"/><path d="M8 8v3M6.5 9.5h3"/></svg>';
const DOWNLOAD_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8M4.8 7.3L8 10.5l3.2-3.2"/><path d="M2.5 11v2.5h11V11"/></svg>';

/** 固定 SVG 文字列 (上の定数のみ) をアイコン要素にする。vault 由来の文字列は通さない。 */
function icon(svg: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'embed-ico-wrap';
  span.innerHTML = svg;
  return span;
}

function basenameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/** env の添付一覧からサイズ等のメタを引く。null = 一覧未ロード or 不在。 */
function fileMetaOf(
  path: string,
  ctx: RenderContext,
): { size: number; mtime: number } | null {
  const files = ctx.env?.getFiles?.() ?? null;
  if (files === null) return null;
  return files.find((f) => f.path === path) ?? null;
}

function buildShell(kind: 'pdf' | 'text' | 'card', path: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'file-embed';
  el.setAttribute('data-testid', 'file-embed');
  el.setAttribute('data-kind', kind);
  el.setAttribute('data-path', path);
  return el;
}

function buildBar(path: string, meta: string): { bar: HTMLElement; metaEl: HTMLElement } {
  const bar = document.createElement('div');
  bar.className = 'file-embed-bar';
  const fname = document.createElement('span');
  fname.className = 'fname';
  fname.append(icon(FILE_ICON), document.createTextNode(basenameOf(path)));
  const metaEl = document.createElement('span');
  metaEl.className = 'meta';
  metaEl.textContent = meta;
  bar.append(fname, metaEl);
  return { bar, metaEl };
}

/**
 * フッターのアクションボタン (file-embed-open-full)。
 * click ではなく mousedown で処理する: クリックでカーソルが行へ入ると装飾が
 * ソース表示に差し替わり click が届かない (embed ヘッダと同じ理由)。
 */
function buildFooterButton(label: string, iconSvg: string, onActivate: () => void): HTMLElement {
  const footer = document.createElement('div');
  footer.className = 'file-embed-footer';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'open-full-btn';
  btn.setAttribute('data-testid', 'file-embed-open-full');
  btn.append(icon(iconSvg), document.createTextNode(label));
  btn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate();
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  footer.append(btn);
  return footer;
}

// ---- PDF ビューアブロック (AC-Sf53ad6-3-1) --------------------------------------

export function renderPdfEmbed(path: string, ctx: RenderContext): HTMLElement {
  const el = buildShell('pdf', path);
  const meta = fileMetaOf(path, ctx);
  const { bar } = buildBar(
    path,
    meta !== null ? `${formatSize(meta.size)} · PDF` : 'PDF',
  );
  el.append(bar);

  const url = filesUrlOf(path);
  // ブラウザ内蔵の PDF ビューア (スクロール・ページ操作はビューア側が提供する)。
  // 重い pdf.js の同梱は避ける (Sprint 指示 / priority 5: シンプルさ)。
  const frame = document.createElement('iframe');
  frame.className = 'pdf-frame';
  frame.src = url;
  frame.title = path;
  el.append(frame);

  el.append(
    buildFooterButton('新しいタブで開く', OPEN_TAB_ICON, () => {
      window.open(url, '_blank', 'noopener');
    }),
  );
  return el;
}

// ---- 読み取り専用テキストブロック (AC-Sf53ad6-3-2) ------------------------------

function appendPlainRows(box: HTMLElement, lines: string[], startLine: number): void {
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement('div');
    row.className = 't-row';
    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.textContent = String(startLine + i);
    const text = document.createElement('span');
    text.textContent = lines[i] ?? '';
    row.append(ln, text);
    box.append(row);
  }
}

async function fillTextPreview(
  el: HTMLElement,
  body: HTMLElement,
  metaEl: HTMLElement,
  path: string,
  lang: string | null,
): Promise<void> {
  let text: string;
  try {
    const res = await fetch(filesUrlOf(path));
    if (!res.ok) {
      throw new Error(res.status === 404 ? `ファイルが見つかりません: ${path}` : `HTTP ${String(res.status)}`);
    }
    text = await res.text();
  } catch (err) {
    metaEl.textContent = 'エラー';
    body.textContent = `テキストを読み込めませんでした — ${
      err instanceof Error ? err.message : String(err)
    }`;
    body.classList.add('embed-body-error');
    el.setAttribute('data-error', 'true');
    return;
  }

  const lines = text.replace(/\n$/, '').split('\n');
  const total = lines.length;

  const renderRows = async (count: number): Promise<void> => {
    const slice = lines.slice(0, count);
    body.textContent = '';
    if (lang !== null) {
      // コード拡張子は Shiki 再利用 (S9ab6c3-2 と同じ github-light / dynamic import)
      try {
        const { codeToHtml } = await import('shiki');
        const html = await codeToHtml(slice.join('\n'), { lang, theme: 'github-light' });
        const wrap = document.createElement('div');
        wrap.className = 'text-preview code-block';
        wrap.innerHTML = html; // Shiki の出力のみ (vault 由来の生文字列は通さない)
        body.append(wrap);
        return;
      } catch {
        // Shiki が読み込めない場合はプレーン表示にフォールバック (行は欠けさせない)
      }
    }
    const box = document.createElement('div');
    box.className = 'text-preview';
    appendPlainRows(box, slice, 1);
    body.append(box);
  };

  const truncated = total > TEXT_PREVIEW_LINES;
  await renderRows(truncated ? TEXT_PREVIEW_LINES : total);
  metaEl.textContent = truncated
    ? `${String(total)} 行 · 先頭 ${String(TEXT_PREVIEW_LINES)} 行を表示`
    : `全 ${String(total)} 行`;

  if (truncated) {
    body.firstElementChild?.classList.add('truncated');
    const footer = buildFooterButton(
      `全体を開く(残り ${String(total - TEXT_PREVIEW_LINES)} 行)`,
      EXPAND_ICON,
      () => {
        void renderRows(total).then(() => {
          metaEl.textContent = `全 ${String(total)} 行`;
          el.setAttribute('data-expanded', 'true');
          footer.remove();
        });
      },
    );
    el.append(footer);
  }
}

export function renderTextEmbed(path: string, ctx: RenderContext): HTMLElement {
  const el = buildShell('text', path);
  const meta = fileMetaOf(path, ctx);
  const { bar, metaEl } = buildBar(path, '読み込み中…');
  el.append(bar);
  const body = document.createElement('div');
  body.className = 'file-embed-body';
  el.append(body);

  if (meta !== null && meta.size > TEXT_PREVIEW_MAX_BYTES) {
    // 巨大テキストはエディタ内で全文取得しない (UI を固めない — priority 2)
    metaEl.textContent = `${formatSize(meta.size)} · プレビュー上限超過`;
    body.textContent = `このファイルは大きいためプレビューしません (${formatSize(meta.size)})。`;
    body.classList.add('file-embed-note');
    el.append(
      buildFooterButton('新しいタブで開く', OPEN_TAB_ICON, () => {
        window.open(filesUrlOf(path), '_blank', 'noopener');
      }),
    );
    return el;
  }

  const ext = extensionOf(path) ?? '';
  void fillTextPreview(el, body, metaEl, path, shikiLangOf(ext));
  return el;
}

// ---- プレビュー不能ファイルのカード (AC-Sf53ad6-3-3) ----------------------------

export function renderFileCard(path: string, ctx: RenderContext): HTMLElement {
  const el = buildShell('card', path);
  const card = document.createElement('div');
  card.className = 'file-card';

  const big = document.createElement('div');
  big.className = 'big-ico';
  big.innerHTML = FOLDER_ICON;

  const main = document.createElement('div');
  main.className = 'fc-main';
  const name = document.createElement('div');
  name.className = 'fc-name';
  name.textContent = basenameOf(path);
  const metaEl = document.createElement('div');
  metaEl.className = 'fc-meta';
  const meta = fileMetaOf(path, ctx);
  const files = ctx.env?.getFiles?.() ?? null;
  if (meta !== null) {
    metaEl.textContent = `${formatSize(meta.size)} · プレビュー非対応の形式`;
  } else if (files !== null) {
    metaEl.textContent = 'ファイルが見つかりません';
    el.setAttribute('data-error', 'true');
  } else {
    metaEl.textContent = 'プレビュー非対応の形式';
  }
  main.append(name, metaEl);

  const dl = document.createElement('a');
  dl.className = 'dl-btn';
  dl.setAttribute('data-testid', 'file-embed-download');
  dl.href = filesUrlOf(path);
  dl.setAttribute('download', basenameOf(path));
  dl.title = 'ダウンロード';
  dl.append(icon(DOWNLOAD_ICON), document.createTextNode('ダウンロード'));
  // アンカーの既定動作 (ダウンロード) を活かしつつ、widget の
  // 「ソース編集へ戻る」クリックには届かせない
  dl.addEventListener('mousedown', (e) => e.stopPropagation());
  dl.addEventListener('click', (e) => e.stopPropagation());

  card.append(big, main, dl);
  el.append(card);
  return el;
}

/** テキスト/PDF レンダラーの登録対象拡張子。 */
export const PDF_EXTENSIONS = ['pdf'] as const;
export { TEXT_PREVIEW_EXTENSIONS };
