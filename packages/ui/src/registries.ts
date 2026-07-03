/**
 * 拡張レンダリングの 3 レジストリ (SPEC.md §8.2)。
 *
 * fence / inline / block の 3 つの拡張ポイントを UI 基盤の段階で敷いておく
 * (Sprint Sa704c3 の責務は構造のみ)。実レンダラー (Mermaid / KaTeX / Shiki) の
 * 登録とエディタへの結線はライブプレビュー Story (S9ab6c3-2) が行う。
 * すべての拡張は標準 Markdown 記法の上に乗り、ファイルを汚さない (priority 1)。
 */

export interface RenderContext {
  /** レンダリング対象ノートの vault 相対パス */
  notePath: string;
}

export interface FenceRenderer {
  /** コードフェンスの言語識別子 ('mermaid', ['drawio', 'xml-drawio'] 等) */
  lang: string | string[];
  /** client: ブラウザ内で描画 / server: POST /api/render/:lang 経由 */
  kind: 'client' | 'server';
  /** replace: コードを図に置換 / augment: コードの下に描画を追加 */
  mode: 'replace' | 'augment';
  render(code: string, el: HTMLElement, ctx: RenderContext): void | Promise<void>;
  /** 専用エディタ (draw.io 等)。あればダブルクリックで起動 */
  edit?(code: string, ctx: RenderContext): Promise<string>;
}

export interface InlineRule {
  /** テキスト中のパターン ($math$, ==highlight== 等) */
  pattern: RegExp;
  render(match: RegExpExecArray, ctx: RenderContext): HTMLElement;
}

export interface BlockRule {
  /** 行頭パターン (> [!note] callout, ![[embed]] 等) */
  match(line: string): boolean;
  render(lines: string[], ctx: RenderContext): HTMLElement;
}

const fenceRenderers = new Map<string, FenceRenderer>();
const inlineRules: InlineRule[] = [];
const blockRules: BlockRule[] = [];

export function registerFenceRenderer(renderer: FenceRenderer): void {
  const langs = Array.isArray(renderer.lang) ? renderer.lang : [renderer.lang];
  for (const lang of langs) {
    fenceRenderers.set(lang, renderer);
  }
}

export function registerInlineRule(rule: InlineRule): void {
  inlineRules.push(rule);
}

export function registerBlockRule(rule: BlockRule): void {
  blockRules.push(rule);
}

export function getFenceRenderer(lang: string): FenceRenderer | undefined {
  return fenceRenderers.get(lang);
}

export function getInlineRules(): readonly InlineRule[] {
  return inlineRules;
}

export function getBlockRules(): readonly BlockRule[] {
  return blockRules;
}
