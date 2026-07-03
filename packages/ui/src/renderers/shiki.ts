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

export function registerShikiRenderer(): void {
  registerFenceRenderer({
    lang: SHIKI_LANGS,
    kind: 'client',
    mode: 'replace',
    info: 'shiki: github-light',
    async render(code, el, ctx) {
      const { codeToHtml } = await import('shiki');
      const html = await codeToHtml(code.replace(/\n$/, ''), {
        lang: ctx.lang ?? 'text',
        theme: 'github-light',
      });
      el.innerHTML = html;
      el.classList.add('code-block');
    },
  });
}
