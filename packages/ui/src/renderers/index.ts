/**
 * ビルトインレンダラーの一括登録 (S9ab6c3-2 で実証する Mermaid + KaTeX + Shiki)。
 * すべて 3 レジストリ (fence / inline / block) 経由で登録される (SPEC §8.7)。
 * アプリ起動時 (main.tsx) にエディタ生成より先に呼ぶ。
 */
import { registerKatexRenderers } from './katex.js';
import { registerMermaidRenderer } from './mermaid.js';
import { registerShikiRenderer } from './shiki.js';

let registered = false;

export function registerBuiltinRenderers(): void {
  if (registered) return; // HMR / 再マウントでの二重登録を防ぐ
  registered = true;
  registerMermaidRenderer();
  registerKatexRenderers();
  registerShikiRenderer();
}
