/**
 * ライブプレビュー装飾 (Story S9ab6c3-2 — Obsidian Live Preview 準拠)。
 *
 * カーソル (選択範囲) が触れていない行の Markdown を装飾表示し、
 * カーソルを置いた行はソースを見せる。装飾はすべて表示層のみで、
 * ドキュメント (ピュア Markdown) は一切変更しない (priority 1)。
 *
 * 構成 (SPEC §8.2 の 3 レジストリを消費する):
 * - blockDecoField (StateField): 行構造に影響する装飾。
 *   fence レジストリ (mermaid / Shiki 等) と block レジストリ ($$…$$ 等)。
 *   ブロック widget は ViewPlugin から供給できないため StateField で持つ。
 * - inlinePreviewPlugin (ViewPlugin): 行内装飾。
 *   見出し/強調/インラインコードのマーク非表示、[[リンク]] ピル、
 *   inline レジストリ ($…$ 等)。
 */
import { EditorState, Facet, StateField, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { resolveLinkTarget } from '@loamium/shared';
import { activeLines } from './outline.js';
import {
  notesUpdatedAnnotation,
  notePathsOf,
  wikilinkEnvFacet,
  wikilinkTarget,
  type WikilinkEnv,
} from './wikilink.js';
import {
  getBlockRules,
  getFenceRenderer,
  getInlineRules,
  type FenceRenderer,
  type RenderContext,
  type RenderEnv,
} from './registries.js';
import { renderImageEmbed } from './renderers/embed.js';

/** 開いているノートの vault 相対パス (RenderContext 用) */
export const notePathFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? '',
});

/** 構文木を確保する (通常のノートサイズなら同期で全体をパースできる) */
function treeOf(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
}

// ---- fence / block widget (StateField) --------------------------------------

class FenceWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
    readonly renderer: FenceRenderer,
    readonly notePath: string,
  ) {
    super();
  }

  override eq(other: FenceWidget): boolean {
    return other.lang === this.lang && other.code === this.code && other.notePath === this.notePath;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = this.lang === 'mermaid' ? 'fence-widget mermaid' : 'fence-widget';
    wrap.setAttribute('data-testid', 'fence-widget');
    wrap.setAttribute('data-lang', this.lang);

    const bar = document.createElement('div');
    bar.className = 'fence-bar';
    const langLabel = document.createElement('span');
    langLabel.className = 'lang';
    langLabel.textContent = this.lang;
    const hint = document.createElement('span');
    hint.textContent = this.renderer.info ?? 'クリックでソース編集';
    bar.append(langLabel, hint);

    const body = document.createElement('div');
    body.className = 'fence-body';

    wrap.append(bar, body);

    // クリックでカーソルをフェンスへ移し、ソース編集に戻す (prototype/editor.html)
    wrap.addEventListener('click', () => {
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    });

    const ctx: RenderContext = { notePath: this.notePath, lang: this.lang };
    void Promise.resolve()
      .then(() => this.renderer.render(this.code, body, ctx))
      .catch((err: unknown) => {
        body.textContent = `レンダリングに失敗しました: ${err instanceof Error ? err.message : String(err)}`;
        body.classList.add('fence-render-error');
      });
    return wrap;
  }
}

class BlockRuleWidget extends WidgetType {
  constructor(
    readonly lines: string[],
    readonly render: (lines: string[], ctx: RenderContext) => HTMLElement,
    readonly ctx: RenderContext,
    /** ルールの identity() 由来の追加キー (リンク解決状態など外部依存の変化を検知) */
    readonly identity: string,
  ) {
    super();
  }

  override eq(other: BlockRuleWidget): boolean {
    return (
      other.ctx.notePath === this.ctx.notePath &&
      other.identity === this.identity &&
      other.lines.length === this.lines.length &&
      other.lines.every((l, i) => l === this.lines[i])
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    let el: HTMLElement;
    try {
      el = this.render(this.lines, this.ctx);
    } catch (err: unknown) {
      el = document.createElement('div');
      el.className = 'fence-render-error';
      el.textContent = `レンダリングに失敗しました: ${err instanceof Error ? err.message : String(err)}`;
    }
    el.addEventListener('click', () => {
      const pos = view.posAtDOM(el);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
}

function buildBlockDecorations(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const active = activeLines(state);
  const notePath = state.facet(notePathFacet);
  const doc = state.doc;
  // block ルール (embed 等) へ渡すエディタ環境 — 既存の wikilink 環境を再利用する
  const wlEnv = state.facet(wikilinkEnvFacet);
  const renderEnv: RenderEnv = {
    getNotePaths: () => notePathsOf(state),
    openNote: (path) => wlEnv?.openNote(path),
    getFiles: () => wlEnv?.getFiles?.() ?? null,
  };
  const blockCtx: RenderContext = { notePath, env: renderEnv, embedChain: [notePath] };
  /** fence が占有した行 (block レジストリの走査から除外) */
  const claimedLines = new Set<number>();

  const intersectsActive = (fromLine: number, toLine: number): boolean => {
    for (let n = fromLine; n <= toLine; n++) if (active.has(n)) return true;
    return false;
  };

  // ---- fence レジストリ (構文木の FencedCode) ----
  treeOf(state).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return;
      const startLine = doc.lineAt(node.from).number;
      const endLine = doc.lineAt(node.to).number;
      for (let n = startLine; n <= endLine; n++) claimedLines.add(n);

      const infoNode = node.node.getChild('CodeInfo');
      if (infoNode === null) return;
      const lang = doc.sliceString(infoNode.from, infoNode.to).trim().toLowerCase();
      const renderer = getFenceRenderer(lang);
      if (renderer === undefined) return; // 未登録言語はソースのまま
      if (intersectsActive(startLine, endLine)) return; // カーソル行はソース表示

      const codeNode = node.node.getChild('CodeText');
      const code = codeNode === null ? '' : doc.sliceString(codeNode.from, codeNode.to);
      const widget = new FenceWidget(lang, code, renderer, notePath);
      if (renderer.mode === 'replace') {
        decos.push(Decoration.replace({ widget, block: true }).range(node.from, node.to));
      } else {
        decos.push(Decoration.widget({ widget, block: true, side: 1 }).range(node.to));
      }
      return false;
    },
  });

  // ---- block レジストリ ($$…$$ 等) ----
  const rules = getBlockRules();
  if (rules.length > 0) {
    for (let n = 1; n <= doc.lines; n++) {
      if (claimedLines.has(n)) continue;
      const line = doc.line(n);
      for (const rule of rules) {
        if (!rule.match(line.text)) continue;
        let endLineNo: number | null = null;
        if (rule.matchWhile !== undefined) {
          // 継続型ブロック (callout 等): 述語が続く限り含める。開始行のみでも成立
          endLineNo = n;
          for (let m = n + 1; m <= doc.lines; m++) {
            if (claimedLines.has(m)) break; // fence にぶつかったら打ち切り
            if (!rule.matchWhile(doc.line(m).text, m - n)) break;
            endLineNo = m;
          }
        } else if (rule.matchEnd === undefined) {
          endLineNo = n;
        } else {
          for (let m = n; m <= doc.lines; m++) {
            if (claimedLines.has(m)) break; // fence にぶつかったら不成立
            if (rule.matchEnd(doc.line(m).text, m - n)) {
              endLineNo = m;
              break;
            }
          }
        }
        if (endLineNo === null) continue; // 終端なし → ブロック不成立 (ソースのまま)
        if (!intersectsActive(n, endLineNo)) {
          const lines: string[] = [];
          for (let m = n; m <= endLineNo; m++) lines.push(doc.line(m).text);
          const identity = rule.identity?.(lines, blockCtx) ?? '';
          decos.push(
            Decoration.replace({
              widget: new BlockRuleWidget(lines, rule.render.bind(rule), blockCtx, identity),
              block: true,
            }).range(line.from, doc.line(endLineNo).to),
          );
        }
        for (let m = n; m <= endLineNo; m++) claimedLines.add(m);
        n = endLineNo;
        break;
      }
    }
  }

  return Decoration.set(decos, true);
}

const blockDecoField = StateField.define<DecorationSet>({
  create: buildBlockDecorations,
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection !== undefined ||
      // ノート一覧の変化 (作成・削除・リネーム) で embed の解決をやり直す (S9e5ca4-1)
      tr.annotation(notesUpdatedAnnotation) === true
    ) {
      return buildBlockDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---- 行内装飾 (ViewPlugin) ---------------------------------------------------

class WikilinkWidget extends WidgetType {
  /**
   * @param rawTarget 記法どおりのターゲット (例: "Hydra 設計メモ")
   * @param label 表示テキスト (エイリアスがあればエイリアス)
   * @param resolved 解決済み vault パス。null = 壊れリンク。
   *   undefined = ノート一覧が未ロードで判定不能 (壊れ扱いにしない)
   * @param env クリックナビゲーション先 (null なら装飾のみ)
   */
  constructor(
    readonly rawTarget: string,
    readonly label: string,
    readonly resolved: string | null | undefined,
    readonly env: WikilinkEnv | null,
  ) {
    super();
  }

  override eq(other: WikilinkWidget): boolean {
    return (
      other.rawTarget === this.rawTarget &&
      other.label === this.label &&
      other.resolved === this.resolved
    );
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    const broken = this.resolved === null;
    span.className = broken ? 'wikilink broken' : 'wikilink';
    span.setAttribute('data-testid', broken ? 'wikilink-broken' : 'wikilink');
    span.setAttribute('data-target', this.resolved ?? wikilinkTarget(this.rawTarget));
    span.title = broken
      ? 'ノートが存在しません — クリックで新規作成'
      : 'クリックで開く';
    span.textContent = this.label;
    // click ではなく mousedown で扱う: クリックでカーソルが行に入ると装飾が
    // ソース表示に差し替わり、click イベントが届かなくなるため。
    // preventDefault でカーソル移動も抑止する (Obsidian の LP と同じ挙動)。
    span.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || this.env === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.resolved === null) {
        this.env.createAndOpenNote(this.rawTarget);
      } else {
        this.env.openNote(this.resolved ?? wikilinkTarget(this.rawTarget));
      }
    });
    return span;
  }
}

class InlineRuleWidget extends WidgetType {
  constructor(
    readonly matchedText: string,
    readonly make: () => HTMLElement,
  ) {
    super();
  }

  override eq(other: InlineRuleWidget): boolean {
    return other.matchedText === this.matchedText;
  }

  override toDOM(): HTMLElement {
    try {
      return this.make();
    } catch (err: unknown) {
      // レンダラー失敗時はソース文字列にフォールバックし、原因は console に残す
      // (verifier 指摘 V11: 無言の握りつぶしにしない)
      console.warn('[loamium] inline renderer failed:', this.matchedText, err);
      const span = document.createElement('span');
      span.textContent = this.matchedText;
      return span;
    }
  }
}

const WIKILINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;

interface ClaimedRange {
  from: number;
  to: number;
}

function overlaps(claimed: ClaimedRange[], from: number, to: number): boolean {
  return claimed.some((c) => from < c.to && to > c.from);
}

function buildInlineDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const state = view.state;
  const doc = state.doc;
  const active = activeLines(state);
  const notePath = state.facet(notePathFacet);
  const wikilinkEnv = state.facet(wikilinkEnvFacet);
  const vaultPaths = notePathsOf(state);
  /** [[target]] → 解決済みパス (null=壊れ / undefined=一覧未ロードで判定不能) */
  const resolveWikilink = (rawTarget: string): string | null | undefined => {
    if (vaultPaths === null) return undefined;
    // heading 部分 (#見出し / #^block) は解決に使わない
    const hash = rawTarget.indexOf('#');
    const target = (hash === -1 ? rawTarget : rawTarget.slice(0, hash)).trim();
    if (target.length === 0) return notePath; // [[#見出し]] は同一ノート内
    return resolveLinkTarget(target, vaultPaths);
  };
  /**
   * 装飾を一切適用しない範囲 (コードスパン・fence・autolink)。
   * [[リンク]] はこのリストだけを避ける — lezer は [[x]] の内側 [x] を
   * 参照リンク (Link ノード) と解釈するため、Link を避けると wikilink が
   * 描画できなくなる。
   */
  const codeClaims: ClaimedRange[] = [];
  /** inline レジストリを適用しない範囲 (codeClaims + Link + wikilink 済み) */
  const claimed: ClaimedRange[] = [];
  /** 装飾対象外の行 (fence 内部) */
  const fenceLines = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const lineNo = doc.lineAt(node.from).number;
        switch (node.name) {
          case 'FencedCode': {
            const endLine = doc.lineAt(node.to).number;
            for (let n = lineNo; n <= endLine; n++) fenceLines.add(n);
            codeClaims.push({ from: node.from, to: node.to });
            claimed.push({ from: node.from, to: node.to });
            return false; // フェンス内部の記法は装飾しない
          }
          case 'HeaderMark': {
            // ATX 見出しの # マークを非表示 (後続スペースも畳む)
            if (active.has(lineNo)) return;
            if (node.node.parent?.name.startsWith('ATXHeading') !== true) return;
            let to = node.to;
            if (doc.sliceString(to, to + 1) === ' ') to += 1;
            decos.push(Decoration.replace({}).range(node.from, to));
            return;
          }
          case 'EmphasisMark': {
            // **太字** / *斜体* のマークを非表示
            if (active.has(lineNo)) return;
            decos.push(Decoration.replace({}).range(node.from, node.to));
            return;
          }
          case 'InlineCode': {
            // バッククォートを非表示、内側はインラインルール適用外
            codeClaims.push({ from: node.from, to: node.to });
            claimed.push({ from: node.from, to: node.to });
            if (active.has(lineNo)) return;
            const marks = node.node.getChildren('CodeMark');
            for (const mark of marks) {
              decos.push(Decoration.replace({}).range(mark.from, mark.to));
            }
            return;
          }
          case 'Image': {
            // 標準 Markdown 画像 ![alt](path) を /api/files 経由で表示 (S9e5ca4-2)。
            // URL の無い参照形式 (行中の ![[wikilink]] が該当) は請求せず、
            // 従来どおり子ノード走査 → wikilink 処理に任せる
            const urlNode = node.node.getChild('URL');
            if (urlNode === null) return;
            codeClaims.push({ from: node.from, to: node.to });
            claimed.push({ from: node.from, to: node.to });
            if (active.has(lineNo)) return false;
            const url = doc.sliceString(urlNode.from, urlNode.to).trim();
            if (url.length === 0) return false;
            const src = doc.sliceString(node.from, node.to);
            const altMatch = /^!\[([^\]]*)\]/.exec(src);
            const alt = altMatch?.[1] ?? '';
            decos.push(
              Decoration.replace({
                widget: new InlineRuleWidget(src, () => renderImageEmbed(url, alt)),
              }).range(node.from, node.to),
            );
            return false;
          }
          case 'Autolink':
          case 'URL':
            codeClaims.push({ from: node.from, to: node.to });
            claimed.push({ from: node.from, to: node.to });
            return;
          case 'Link':
            // [[wikilink]] の内側は Link と誤解釈されるため codeClaims には入れない
            claimed.push({ from: node.from, to: node.to });
            return;
          default:
            return;
        }
      },
    });

    // ---- 行単位の走査: [[リンク]] と inline レジストリ ----
    const firstLine = doc.lineAt(from).number;
    const lastLine = doc.lineAt(to).number;
    // ルールの正規表現は 1 パスにつき 1 回だけ g 付きでコンパイルする
    const inlineRules = getInlineRules().map((rule) => ({
      rule,
      re: new RegExp(
        rule.pattern.source,
        rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`,
      ),
    }));
    for (let n = firstLine; n <= lastLine; n++) {
      if (active.has(n) || fenceLines.has(n)) continue;
      const line = doc.line(n);

      WIKILINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WIKILINK_RE.exec(line.text)) !== null) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        if (overlaps(codeClaims, from, to)) continue;
        const rawTarget = m[1] ?? '';
        const label = (m[2] ?? rawTarget).trim();
        // 解決・作成には heading (#見出し / #^block) を除いたターゲットを使う
        const hash = rawTarget.indexOf('#');
        const targetNoHeading = (hash === -1 ? rawTarget : rawTarget.slice(0, hash)).trim();
        const resolved = resolveWikilink(rawTarget);
        decos.push(
          Decoration.replace({
            widget: new WikilinkWidget(
              targetNoHeading.length > 0 ? targetNoHeading : rawTarget.trim(),
              label,
              resolved,
              wikilinkEnv,
            ),
          }).range(from, to),
        );
        claimed.push({ from, to });
      }

      for (const { rule, re } of inlineRules) {
        re.lastIndex = 0;
        let im: RegExpExecArray | null;
        while ((im = re.exec(line.text)) !== null) {
          if (im[0].length === 0) break; // 無限ループ防止
          const from = line.from + im.index;
          const to = from + im[0].length;
          if (overlaps(claimed, from, to)) continue;
          const matched = im;
          decos.push(
            Decoration.replace({
              widget: new InlineRuleWidget(im[0], () => rule.render(matched, { notePath })),
            }).range(from, to),
          );
          claimed.push({ from, to });
        }
      }
    }
  }

  return Decoration.set(decos, true);
}

const inlinePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildInlineDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        // ノート一覧の変化 (作成・削除・リネーム) で壊れリンク判定をやり直す
        update.transactions.some((tr) => tr.annotation(notesUpdatedAnnotation) === true)
      ) {
        this.decorations = buildInlineDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** ライブプレビュー一式 (Editor に登録する) */
export function livePreviewExtension(): Extension {
  return [blockDecoField, inlinePreviewPlugin];
}
