/**
 * 拡張レンダリングの 3 レジストリ (SPEC.md §8.2)。
 *
 * fence / inline / block の 3 つの拡張ポイントを UI 基盤の段階で敷いておく
 * (Sprint Sa704c3 の責務は構造のみ)。実レンダラー (Mermaid / KaTeX / Shiki) の
 * 登録とエディタへの結線はライブプレビュー Story (S9ab6c3-2) が行う。
 * すべての拡張は標準 Markdown 記法の上に乗り、ファイルを汚さない (priority 1)。
 */

/**
 * レンダラーがエディタ環境 (ノート一覧・ナビゲーション) へアクセスするための
 * 注入点 (S9e5ca4-1 で追加 — additive)。embed カードのリンク解決とヘッダクリック
 * ナビゲーションが使う。単体テストや環境なしのレンダリングでは省略される。
 */
export interface RenderEnv {
  /** vault 内の全ノートパス。null = 一覧未ロード (壊れ扱いにしない) */
  getNotePaths(): readonly string[] | null;
  /** ノートを開く (embed カードのヘッダクリック等) */
  openNote(path: string): void;
}

export interface RenderContext {
  /** レンダリング対象ノートの vault 相対パス */
  notePath: string;
  /**
   * フェンスの言語識別子 (S9ab6c3-2 で追加 — additive)。
   * 複数言語を 1 レンダラーで受ける場合 (Shiki 等) に render 側で参照する。
   */
  lang?: string;
  /** エディタ環境 (S9e5ca4-1 で追加 — additive)。省略時は装飾のみ */
  env?: RenderEnv;
  /**
   * embed の再帰チェーン (S9e5ca4-1 で追加 — additive)。
   * 先頭がルートノートで、ネストした embed が自分の解決先を積んで伝搬する。
   * 循環 (再訪) と深さ制限の判定に使う。省略時は [notePath] 相当。
   */
  embedChain?: readonly string[];
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
  /** fence-widget のバー右側に出す補足表示 (省略時は「クリックでソース編集」) */
  info?: string;
}

export interface InlineRule {
  /** テキスト中のパターン ($math$, ==highlight== 等) */
  pattern: RegExp;
  render(match: RegExpExecArray, ctx: RenderContext): HTMLElement;
}

export interface BlockRule {
  /** 行頭パターン (> [!note] callout, ![[embed]] 等) */
  match(line: string): boolean;
  /**
   * 複数行ブロックの終端判定 (S9ab6c3-2 で追加 — additive)。
   * offsetFromStart は開始行を 0 とした行オフセット。開始行を含め、最初に
   * true を返した行までがブロック。省略時は開始行のみの 1 行ブロック。
   * 定義されているのに終端が見つからない場合、ブロックは成立しない
   * (閉じられていない $$ 等はソース表示のまま)。
   */
  matchEnd?(line: string, offsetFromStart: number): boolean;
  /**
   * 連続ブロックの継続判定 (S9e5ca4-3 で追加 — additive)。
   * matchEnd と排他で使う: 開始行の次から、この述語が true を返し続ける限り
   * ブロックに含める (最後に true を返した行が終端。開始行のみでも成立する)。
   * callout (> が続く限り) のような「終端記号がない」ブロック用。
   */
  matchWhile?(line: string, offsetFromStart: number): boolean;
  /**
   * 装飾の同一性キー (S9e5ca4-1 で追加 — additive)。
   * ソース行が同じでも描画結果が外部状態に依存する場合 (embed のリンク解決先等) に
   * 返す。値が変わると widget が再生成される。省略時はソース行のみで同一視。
   */
  identity?(lines: string[], ctx: RenderContext): string;
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
