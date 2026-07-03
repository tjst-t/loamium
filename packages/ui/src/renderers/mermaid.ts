/**
 * Mermaid フェンスレンダラー (client / replace — SPEC §8.4)。
 *
 * mermaid はバンドルが大きいので dynamic import で遅延ロードする
 * (CDN は使わない — オフライン動作要件。decisions.json I7)。
 * 不正なコードはフェンス内のエラー表示に留め、アプリを壊さない。
 */
import { registerFenceRenderer } from '../registries.js';

let initialized = false;
let seq = 0;

export function registerMermaidRenderer(): void {
  registerFenceRenderer({
    lang: 'mermaid',
    kind: 'client',
    mode: 'replace',
    info: 'クリックでソース編集',
    async render(code, el) {
      try {
        const { default: mermaid } = await import('mermaid');
        if (!initialized) {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
          initialized = true;
        }
        seq += 1;
        const { svg } = await mermaid.render(`loamium-mermaid-${String(seq)}`, code);
        el.innerHTML = svg;
      } catch (err: unknown) {
        el.textContent = `mermaid のレンダリングに失敗しました: ${err instanceof Error ? err.message : String(err)}`;
        el.classList.add('fence-render-error');
      }
    },
  });
}
