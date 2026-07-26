/**
 * Shiki コードハイライトレンダラー (client / replace — SPEC §8.4)。
 *
 * カーソル外のコードフェンスを github-light テーマのハイライト表示に置換する
 * (prototype/editor.html の bash フェンスのビジュアルが正 — decisions.json I5)。
 * shiki は大きいので dynamic import (バンドル同梱・オフライン動作)。
 */
import { registerFenceRenderer } from '../registries.js';

/** ハイライト対応言語 (レジストリ登録だけで追加できる — AC-S9ab6c3-2-3) */
export const SHIKI_LANGS = [
  'bash',
  'sh',
  'shell',
  'zsh',
  'js',
  'javascript',
  'jsx',
  'ts',
  'typescript',
  'tsx',
  'json',
  'jsonc',
  'python',
  'py',
  'go',
  'rust',
  'c',
  'cpp',
  'java',
  'ruby',
  'html',
  'css',
  'scss',
  'yaml',
  'yml',
  'toml',
  'sql',
  'diff',
  'docker',
  'dockerfile',
  'makefile',
  'markdown',
  'md',
];

/**
 * ハイライトできないときの退避表示: 生のコードを `<pre><code>` で描画する。
 * innerHTML は使わず textContent で組む (vault の内容をスクリプト実行させない)。
 */
function renderPlainCode(el: HTMLElement, source: string): void {
  el.replaceChildren();
  el.classList.add('code-block');
  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.textContent = source;
  pre.append(codeEl);
  el.append(pre);
}

export function registerShikiRenderer(): void {
  registerFenceRenderer({
    lang: SHIKI_LANGS,
    kind: 'client',
    mode: 'replace',
    info: 'shiki: github-light',
    async render(code, el, ctx) {
      const source = code.replace(/\n$/, '');
      try {
        // shiki 本体・言語文法はいずれも dynamic import。github-light テーマで整形する。
        const { codeToHtml } = await import('shiki');
        const html = await codeToHtml(source, {
          lang: ctx.lang ?? 'text',
          theme: 'github-light',
        });
        // 成功時のみ差し替える (途中失敗で壊れた表示を残さない)。
        el.innerHTML = html;
        el.classList.add('code-block');
      } catch (err) {
        // ハイライト読み込み失敗 (言語文法 shellscript-*.js 等の dynamic import 失敗 —
        // dev サーバーの stale chunk / オフライン等) でも、コード内容は必ず表示する。
        // シンタックスハイライトは装飾に過ぎないため、エラーカードにはせず生コードへ退避する。
        console.warn('[loamium] shiki ハイライト失敗 → 生コード表示に退避:', err);
        renderPlainCode(el, source);
      }
    },
  });
}
