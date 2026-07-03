/**
 * リスト行限定のアウトライン操作 (C 方式 — Story S9ab6c3-1)。
 *
 * - Tab / Shift+Tab: カーソルがリスト行 (- / 1. / - [ ]) にあるときだけ
 *   サブツリーごとインデント / アンインデントする。見出し・段落では発火せず
 *   ブラウザ既定に委ねる (DESIGN_PRINCIPLES ui_ux: リスト行のみ)。
 * - 折りたたみ: 子行を持つリスト行のガターに fold-toggle を表示し、
 *   サブツリー (ListItem ノードの残り行) を折りたたむ。placeholder は
 *   fold-pill (「… N 行」)。
 * - チェックボックス: - [ ] / - [x] の TaskMarker をクリック可能な
 *   ウィジェットに置換 (カーソル行はソース表示)。トグルはドキュメント編集
 *   なので、既存の自動保存フローでピュア Markdown としてファイルに載る。
 *
 * リスト行判定は lezer-markdown の構文木 (ListItem) で行う (decisions.json I2)。
 */
import { EditorState, Prec, type Extension, type Line } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { codeFolding, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

/** インデント単位 (4 スペース — decisions.json I1: 1. リストの CommonMark ネスト要件を満たす) */
export const INDENT_UNIT = '    ';

/** 選択範囲が触れている行番号の集合 (ソース表示すべき「カーソル行」) */
export function activeLines(state: EditorState): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return lines;
}

/** この行から始まる ListItem ノード (無ければ null = リスト行ではない) */
export function listItemStartingAt(state: EditorState, line: Line): SyntaxNode | null {
  const firstChar = line.text.search(/\S/);
  if (firstChar < 0) return null;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + firstChar, 1);
  for (; node !== null; node = node.parent) {
    if (node.name === 'ListItem' && state.doc.lineAt(node.from).number === line.number) {
      return node;
    }
  }
  return null;
}

/** ListItem サブツリーの最終行番号 (継続行・ネストした子リストを含む) */
function subtreeEndLine(state: EditorState, item: SyntaxNode, startLine: number): number {
  const endLine = state.doc.lineAt(item.to);
  // ノード終端がちょうど行頭にある場合はその前の行までがサブツリー
  if (endLine.from === item.to && endLine.number > startLine) return endLine.number - 1;
  return endLine.number;
}

/**
 * リスト行のインデント操作。リスト行でなければ false (キーを消費しない)。
 * dir=1: サブツリー全行に INDENT_UNIT を挿入 / dir=-1: 先頭行の字下げ幅を上限に削る。
 */
function changeListIndent(view: EditorView, dir: 1 | -1): boolean {
  if (view.composing) return false; // IME 変換中は Tab を奪わない (decisions.json I3)
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const item = listItemStartingAt(state, line);
  if (item === null) return false;

  const start = line.number;
  const end = subtreeEndLine(state, item, start);
  const changes: { from: number; to?: number; insert?: string }[] = [];

  if (dir === 1) {
    // アウトライナー標準: 直前に同レベルの兄弟項目があるときだけ 1 段深くできる。
    // 先頭項目を字下げすると CommonMark ではコードブロック化し
    // ピュア Markdown を壊すため no-op とする (priority 1)。
    let prev = item.prevSibling;
    while (prev !== null && prev.name !== 'ListItem') prev = prev.prevSibling;
    if (prev === null) return true; // リスト行として消費するが no-op
    for (let n = start; n <= end; n++) {
      const l = state.doc.line(n);
      if (l.length === 0) continue; // 空行はインデントしない
      changes.push({ from: l.from, insert: INDENT_UNIT });
    }
  } else {
    const leading = /^ */.exec(line.text)?.[0].length ?? 0;
    const removable = Math.min(INDENT_UNIT.length, leading);
    if (removable === 0) return true; // トップレベルでの Shift+Tab は no-op (リスト行として消費)
    for (let n = start; n <= end; n++) {
      const l = state.doc.line(n);
      const lead = /^ */.exec(l.text)?.[0].length ?? 0;
      if (lead === 0) continue;
      changes.push({ from: l.from, to: l.from + Math.min(removable, lead) });
    }
  }

  if (changes.length === 0) return true;
  view.dispatch({
    changes,
    scrollIntoView: true,
    userEvent: dir === 1 ? 'input.indent' : 'delete.dedent',
  });
  return true;
}

const outlineKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Tab', run: (view) => changeListIndent(view, 1) },
    { key: 'Shift-Tab', run: (view) => changeListIndent(view, -1) },
  ]),
);

// ---- 折りたたみ (fold-toggle ガター + fold-pill placeholder) ----------------

/** リスト行の折りたたみ対象範囲 (行末〜サブツリー末尾)。子行が無ければ null */
function foldableListRange(state: EditorState, line: Line): { from: number; to: number } | null {
  const item = listItemStartingAt(state, line);
  if (item === null) return null;
  const end = subtreeEndLine(state, item, line.number);
  if (end <= line.number) return null;
  return { from: line.to, to: state.doc.line(end).to };
}

/** 行末から始まる折りたたみ済み範囲 */
function foldedAt(state: EditorState, line: Line): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(line.to, line.to, (from, to) => {
    if (from === line.to) {
      found = { from, to };
      return false;
    }
    return undefined;
  });
  return found;
}

const CHEVRON_DOWN =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
const CHEVRON_RIGHT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';

class FoldToggleMarker extends GutterMarker {
  constructor(
    readonly lineNo: number,
    readonly folded: boolean,
  ) {
    super();
  }

  override eq(other: FoldToggleMarker): boolean {
    return other.lineNo === this.lineNo && other.folded === this.folded;
  }

  override toDOM(): Node {
    const btn = document.createElement('button');
    btn.className = this.folded ? 'fold-toggle folded' : 'fold-toggle';
    btn.setAttribute('data-testid', 'fold-toggle');
    btn.setAttribute('data-line', String(this.lineNo));
    if (this.folded) btn.setAttribute('data-folded', 'true');
    btn.title = this.folded ? 'サブツリーを展開する' : 'サブツリーを折りたたむ';
    btn.innerHTML = this.folded ? CHEVRON_RIGHT : CHEVRON_DOWN;
    return btn;
  }
}

function isFoldTransaction(update: ViewUpdate): boolean {
  return update.transactions.some((tr) =>
    tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
  );
}

const outlineFoldGutter: Extension = gutter({
  class: 'cm-outline-gutter',
  lineMarker(view, block) {
    const line = view.state.doc.lineAt(block.from);
    if (foldableListRange(view.state, line) === null) return null;
    return new FoldToggleMarker(line.number, foldedAt(view.state, line) !== null);
  },
  lineMarkerChange: (update) =>
    update.docChanged || update.viewportChanged || isFoldTransaction(update),
  domEventHandlers: {
    click(view, block) {
      const line = view.state.doc.lineAt(block.from);
      const folded = foldedAt(view.state, line);
      if (folded !== null) {
        view.dispatch({ effects: unfoldEffect.of(folded) });
        return true;
      }
      const range = foldableListRange(view.state, line);
      if (range === null) return false;
      view.dispatch({ effects: foldEffect.of(range) });
      return true;
    },
  },
});

const outlineFolding: Extension = codeFolding({
  preparePlaceholder(state, range) {
    return state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number;
  },
  placeholderDOM(view, onclick, prepared) {
    const span = document.createElement('span');
    span.className = 'fold-pill';
    span.setAttribute('data-testid', 'fold-pill');
    const lines = typeof prepared === 'number' ? prepared : 0;
    span.textContent = `… ${String(lines)} 行`;
    span.title = `折りたたまれた ${String(lines)} 行を展開`;
    span.setAttribute('aria-label', span.title);
    span.onclick = onclick;
    return span;
  },
});

// ---- チェックボックス (- [ ] / - [x]) ---------------------------------------

const CHECK_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>';

class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly lineNo: number,
  ) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked && other.lineNo === this.lineNo;
  }

  override toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement('button');
    btn.className = this.checked ? 'task-checkbox checked' : 'task-checkbox';
    btn.setAttribute('data-testid', 'task-checkbox');
    btn.setAttribute('data-line', String(this.lineNo));
    btn.setAttribute('aria-label', this.checked ? '完了タスク' : '未完了タスク');
    if (this.checked) btn.innerHTML = CHECK_SVG;
    btn.onmousedown = (e) => {
      e.preventDefault(); // カーソル移動させずにトグルする
    };
    btn.onclick = (e) => {
      e.preventDefault();
      // ウィジェットは TaskMarker ([ ] / [x]) 全体を置換しているので、
      // 開始位置 +1 がチェック状態の 1 文字。
      const pos = view.posAtDOM(btn);
      const ch = view.state.doc.sliceString(pos + 1, pos + 2);
      const nowChecked = ch === 'x' || ch === 'X';
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: nowChecked ? ' ' : 'x' },
        userEvent: 'input.toggle-task',
      });
    };
    return btn;
  }
}

function buildCheckboxDecorations(view: EditorView): DecorationSet {
  const widgets: ReturnType<Decoration['range']>[] = [];
  const state = view.state;
  const active = activeLines(state);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'TaskMarker') return;
        const line = state.doc.lineAt(node.from);
        if (active.has(line.number)) return; // カーソル行はソース表示
        const text = state.doc.sliceString(node.from, node.to);
        const checked = /\[[xX]\]/.test(text);
        widgets.push(
          Decoration.replace({
            widget: new TaskCheckboxWidget(checked, line.number),
          }).range(node.from, node.to),
        );
      },
    });
  }
  return Decoration.set(widgets, true);
}

const checkboxPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildCheckboxDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildCheckboxDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** アウトライン操作一式 (Editor に登録する) */
export function outlineExtension(): Extension {
  return [outlineFolding, outlineFoldGutter, outlineKeymap, checkboxPlugin];
}
