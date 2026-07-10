/**
 * エクスポートパイプライン — Markdown → HTML → PDF (ADR-0006)。
 *
 * 変換は SINGLE SERVER-SIDE パイプライン: REST エンドポイント + CLI の両方がこのモジュールを共有する。
 * エクスポート成果物 (HTML / PDF) はメモリ上で生成するだけで vault には一切書き戻さない
 * (ピュア Markdown 原則 / DESIGN_PRINCIPLES architecture)。
 *
 * ## 未実装 / フォールバック機能 (将来の Sprint で段階追加予定)
 * - mermaid ダイアグラム — コードフェンスのまま <pre><code> として出力される
 * - KaTeX 数式 — $...$ のまま残る
 * - Shiki シンタックスハイライト — 素の <pre><code> にフォールバック
 * - ![[embed]] Obsidian 埋め込み — リンクテキストのまま残る (未解決リンク扱い)
 * - ==highlight== — == を含むテキストとして残る (marked はデフォルト非対応)
 * - callout ブロック (> [!info]) — 通常の blockquote としてレンダリングされる
 *
 * ## Chromium プロセス管理 (PDF のみ起動)
 * playwright の chromium は pdf() 呼び出し時だけ遅延起動し (HTML には不要)、
 * try/finally で必ず close する (プロセスリーク防止)。
 * terminal.ts の node-pty 遅延ロードと同じ方針。
 */
import { createRequire } from 'node:module';
import { parseNote } from '@loamium/shared';

// ---- Markdown → HTML -------------------------------------------------------

/**
 * テーマ CSS — PDF / HTML ビューアで使う最小スタイル。
 * 印刷に適したセリフフォントと A4 マージン付き。
 * Chromium の printBackground:true を前提に背景色付き。
 */
const THEME_CSS = `
  @page { size: A4; margin: 20mm 20mm 20mm 20mm; }
  body {
    font-family: 'Noto Serif', 'Yu Mincho', Georgia, serif;
    font-size: 11pt;
    line-height: 1.7;
    color: #1a1a1a;
    background: #ffffff;
    max-width: 900px;
    margin: 0 auto;
    padding: 2em;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: 'Noto Sans', 'Hiragino Kaku Gothic ProN', Arial, sans-serif;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
    line-height: 1.3;
  }
  h1 { font-size: 2em; border-bottom: 2px solid #333; padding-bottom: 0.2em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #ccc; padding-bottom: 0.1em; }
  pre { background: #f6f8fa; border-radius: 4px; padding: 1em; overflow-x: auto; font-size: 0.9em; }
  code { font-family: 'Fira Mono', 'Consolas', monospace; font-size: 0.9em; }
  blockquote { border-left: 4px solid #ccc; margin: 0; padding-left: 1em; color: #555; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.4em 0.8em; }
  th { background: #f0f0f0; }
  img { max-width: 100%; }
  a { color: #0969da; }
  hr { border: none; border-top: 1px solid #ccc; }
`;

/**
 * markdownToHtml — Markdown 文字列を完全な HTML ドキュメントに変換する。
 *
 * - frontmatter は YAML として認識し、title として h1 に追加するか除去する。
 *   frontmatter.title があれば <title> に使い、本文先頭には追加しない。
 *   frontmatter がない場合は body 全体をそのままレンダリングする。
 * - GFM (GitHub Flavored Markdown) を有効にする。
 * - 決定論的: 同一入力に対して常に同一出力を返す。
 */
export function markdownToHtml(markdown: string): string {
  // marked は CommonJS モジュール (現在の環境では require で読み込む)
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { marked } = require('marked') as { marked: (src: string, opts?: unknown) => string };

  const parsed = parseNote(markdown);

  // frontmatter を除いた本文を GFM としてレンダリングする
  const bodyMarkdown = parsed.body;

  // marked は同期的に動作する (use async:false がデフォルト)
  const bodyHtml = marked(bodyMarkdown, { gfm: true }) as string;

  // <title> は frontmatter.title > 最初の h1 (簡易抽出) > "Note" の優先順
  const fmTitle =
    parsed.frontmatter !== null &&
    typeof parsed.frontmatter['title'] === 'string' &&
    parsed.frontmatter['title'].length > 0
      ? parsed.frontmatter['title']
      : null;

  const h1Match = /^#\s+(.+)$/m.exec(bodyMarkdown);
  const inferredTitle = h1Match?.[1] ?? 'Note';
  const docTitle = fmTitle ?? inferredTitle;

  return [
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(docTitle)}</title>`,
    '<style>',
    THEME_CSS,
    '</style>',
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>',
  ].join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- HTML → PDF (headless Chromium / playwright) ---------------------------

/** PDF レンダのハング上限 (ms)。launch / setContent に適用する。 */
const PDF_RENDER_TIMEOUT_MS = 20_000;

/**
 * htmlToPdf — 完全な HTML 文字列を PDF バッファに変換する。
 *
 * playwright の chromium を遅延起動し、try/finally で必ず close する。
 * PDF 生成の都度 browser.launch → page.close → browser.close を行うため
 * プロセスリークは原理的に発生しない (参考: terminal.ts の node-pty lazy-load)。
 *
 * Chromium バイナリは ~/.cache/ms-playwright/chromium-* に事前配置済みを前提とする。
 * --no-sandbox / --disable-setuid-sandbox はコンテナ実行に必要なフラグ (CLAUDE.md 要件)。
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const playwright = require('playwright') as typeof import('playwright');
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    // ハング防止の明示的上限 (verifier concern)。既定 30s より短く固定する。
    timeout: PDF_RENDER_TIMEOUT_MS,
  });
  try {
    const page = await browser.newPage();
    try {
      // 自己完結 HTML (外部リソースなし) 前提。timeout でレンダのハングを上限で切る。
      await page.setContent(html, { waitUntil: 'networkidle', timeout: PDF_RENDER_TIMEOUT_MS });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
      });
      return Buffer.from(pdfBuffer);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
