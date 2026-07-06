/**
 * タグ候補補完 UI 一式 (Sprint S45fa45 — prototype/props-redesign/chosen.html D/E 準拠)。
 *
 * 共通ソース: GET /api/tags (既存タグ + 件数)。tags プロパティ値 (S45fa45-1) と
 * 本文の `#` 入力 (S45fa45-2) の両方が、shared の filterTagSuggestions と本モジュールの
 * buildTagMenu (同一 DOM / testid 契約) を共有する:
 *  - tag-suggest-menu   … 候補メニューのコンテナ
 *  - tag-suggest-option … 候補項目 (data-tag)。末尾は create-new (新規作成: #xxx)
 *
 * 本文の `#` 判定: `# ` (直後スペース) は Markdown 見出し、`#tag` (スペース無し) はタグ。
 * これは shared/extract.ts の #tag 抽出 (matchInlineTags) と整合する。
 * 記法はピュア Markdown の Obsidian 互換 `#tag` のまま (DESIGN_PRINCIPLES priority 1 / 4)。
 */
import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { filterTagSuggestions, type TagCount, type TagSuggestion } from '@loamium/shared';

/** App から注入するタグ補完環境 (実装はすべて ref 読みの安定関数にすること)。 */
export interface TagSuggestEnv {
  /** 現在のタグ一覧 (件数付き)。null = 未ロード。 */
  getTags: () => readonly TagCount[] | null;
  /** 確定タグのクリック — タグで絞り込んだ検索/一覧へ遷移する。 */
  openTag: (tag: string) => void;
}

export const tagSuggestEnvFacet = Facet.define<TagSuggestEnv, TagSuggestEnv | null>({
  combine: (values) => values[0] ?? null,
});

/** state からタグ一覧を引く (live-preview の本文タグ装飾・補完が使う)。 */
export function tagsOf(state: EditorState): readonly TagCount[] | null {
  return state.facet(tagSuggestEnvFacet)?.getTags() ?? null;
}

// ---- 共通メニュー DOM (プロパティ入力・本文ツールチップで共有) -----------------

/** 候補メニューの DOM を組み立てる。update で項目・選択を差し替える。 */
export function buildTagMenu(opts: {
  hint: string;
  onChoose: (item: TagSuggestion) => void;
  onHover?: (index: number) => void;
}): { el: HTMLElement; update: (items: TagSuggestion[], selected: number) => void } {
  const el = document.createElement('div');
  el.className = 'tag-suggest';
  el.setAttribute('data-testid', 'tag-suggest-menu');

  const hint = document.createElement('div');
  hint.className = 'tag-suggest-hint';
  const hintLabel = document.createElement('span');
  hintLabel.textContent = opts.hint;
  const hintKeys = document.createElement('span');
  hintKeys.innerHTML = '<kbd>↑</kbd><kbd>↓</kbd> <kbd>Enter</kbd>';
  hint.append(hintLabel, hintKeys);

  const list = document.createElement('div');
  list.className = 'tag-list';

  const empty = document.createElement('div');
  empty.className = 'tag-suggest-empty';
  empty.setAttribute('data-testid', 'tag-suggest-empty');
  empty.textContent = '一致するタグがありません';
  empty.style.display = 'none';

  el.append(hint, list, empty);

  const update = (items: TagSuggestion[], selected: number): void => {
    empty.style.display = items.length === 0 ? '' : 'none';
    list.replaceChildren();
    items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag-opt';
      if (item.isCreate) btn.classList.add('create-new');
      if (i === selected) btn.classList.add('sel');
      btn.setAttribute('data-testid', 'tag-suggest-option');
      btn.setAttribute('data-tag', item.tag);

      if (item.isCreate) {
        const plus = document.createElement('span');
        plus.className = 'plus';
        plus.textContent = '+';
        btn.append(plus, document.createTextNode(` 新規作成: #${item.tag}`));
      } else {
        const hash = document.createElement('span');
        hash.className = 'hash';
        hash.textContent = '#';
        const name = document.createElement('span');
        if (item.matchRange !== null) {
          const [s, e] = item.matchRange;
          name.append(document.createTextNode(item.tag.slice(0, s)));
          const mark = document.createElement('mark');
          mark.textContent = item.tag.slice(s, e);
          name.append(mark, document.createTextNode(item.tag.slice(e)));
        } else {
          name.textContent = item.tag;
        }
        const cnt = document.createElement('span');
        cnt.className = 'cnt';
        cnt.textContent = String(item.count);
        btn.append(hash, name, cnt);
      }
      // mousedown: 入力/エディタからフォーカス・キャレットを奪わずに確定する。
      // 確定は widget/tooltip を同期的に作り替えて自身を DOM から外すため、
      // クリック (mousedown→mouseup) が完了してから実行する (mouseup 前に外すと
      // クリックが不成立になる)。
      const chosen = item;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setTimeout(() => opts.onChoose(chosen), 0);
      });
      if (opts.onHover !== undefined) {
        btn.addEventListener('mouseenter', () => opts.onHover?.(i));
      }
      list.append(btn);
    });
    const sel = list.children[selected];
    if (sel instanceof HTMLElement) sel.scrollIntoView({ block: 'nearest' });
  };

  return { el, update };
}

function wrap(index: number, len: number): number {
  if (len === 0) return 0;
  return ((index % len) + len) % len;
}

// ---- プロパティ入力 (tags 値) の `#` 補完コントローラ (S45fa45-1) --------------

/** tags チップ入力に `#` 補完メニューを結線する。keydown は host 側から委譲する。 */
export interface TagInputSuggest {
  /** open 中なら該当キーを処理して true を返す (host の keydown で先に呼ぶ)。 */
  handleKeydown: (e: KeyboardEvent) => boolean;
  /** 入力値変化に追従して開閉・絞り込みを更新する。 */
  refresh: () => void;
  /** メニューを閉じる。 */
  close: () => void;
  /** DOM とリスナを破棄する。 */
  destroy: () => void;
}

export function attachTagInputSuggest(
  input: HTMLInputElement,
  opts: { getTags: () => readonly TagCount[] | null; onPick: (tag: string) => void },
): TagInputSuggest {
  let open = false;
  let items: TagSuggestion[] = [];
  let selected = 0;
  const menu = buildTagMenu({
    hint: 'タグを挿入',
    onChoose: (item) => choose(item),
    onHover: (i) => {
      selected = i;
      render();
    },
  });
  menu.el.style.display = 'none';

  // メニューは初回オープン時に input の親 (= 接続済みの値セル) へ遅延マウントする。
  // attach 時点では input がまだ DOM 未接続で親を持たないため (renderChips は
  // input を組み立ててから cell へ append する)。
  const ensureMounted = (): void => {
    if (menu.el.isConnected) return;
    const parent = input.parentElement ?? document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(menu.el);
  };

  const render = (): void => {
    if (!open) {
      menu.el.style.display = 'none';
      return;
    }
    ensureMounted();
    menu.el.style.display = '';
    menu.el.style.left = `${input.offsetLeft}px`;
    menu.el.style.top = `${input.offsetTop + input.offsetHeight + 3}px`;
    menu.update(items, selected);
  };

  const choose = (item: TagSuggestion): void => {
    opts.onPick(item.tag);
    input.value = '';
    open = false;
    render();
    input.focus();
  };

  const refresh = (): void => {
    // `#` で始まる入力のときだけメニューを開く (AC: 「`#` を入力すると候補メニュー」)
    const raw = input.value;
    if (!raw.startsWith('#')) {
      open = false;
      render();
      return;
    }
    items = filterTagSuggestions(opts.getTags() ?? [], raw);
    selected = 0;
    open = true;
    render();
  };

  const handleKeydown = (e: KeyboardEvent): boolean => {
    if (!open || e.isComposing) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = wrap(selected + 1, items.length);
      render();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = wrap(selected - 1, items.length);
      render();
      return true;
    }
    if (e.key === 'Enter') {
      const chosen = items[selected];
      if (chosen === undefined) return false;
      e.preventDefault();
      choose(chosen);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      open = false;
      render();
      return true;
    }
    return false;
  };

  const close = (): void => {
    open = false;
    render();
  };
  const destroy = (): void => {
    menu.el.remove();
  };
  return { handleKeydown, refresh, close, destroy };
}

// ---- 本文の `#tag` 補完 (CodeMirror tooltip — S45fa45-2) ----------------------

/** frontmatter (--- ... ---) の内側位置か (本文外では #tag 補完を出さない)。 */
function inFrontmatter(state: EditorState, pos: number): boolean {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.replace(/\r$/, '') !== '---') return false;
  for (let n = 2; n <= doc.lines; n++) {
    if (doc.line(n).text.replace(/\r$/, '') === '---') {
      return pos <= doc.line(n).to;
    }
  }
  return false; // 閉じられていない frontmatter は本文扱い
}

/** カーソル直前の `#query` トークンを検出。見出し・コード内・frontmatter・非空選択は null。 */
export function detectBodyTagTrigger(state: EditorState): { from: number; query: string } | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const pos = sel.head;
  if (inFrontmatter(state, pos)) return null;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  // 行頭 or 区切り直後の `#` + (空白と # を含まないタグ本体)。`# ` (直後スペース) は
  // タグ本体が空になるため一致せず、見出しとして扱われる (AC-S45fa45-2-1)。
  const m = /(?:^|[\s(["'{>])#([\p{L}\p{M}\p{N}_/-]*)$/u.exec(before);
  if (m === null) return null;
  const query = m[1] ?? '';
  const hashPos = pos - query.length - 1;

  // コードフェンス内・インラインコード内では発火しない (extractTags と整合)
  const tree = ensureSyntaxTree(state, pos, 100) ?? syntaxTree(state);
  let node: SyntaxNode | null = tree.resolveInner(hashPos, 1);
  for (; node !== null; node = node.parent) {
    const n = node.name;
    if (n === 'FencedCode' || n === 'CodeText' || n === 'CodeBlock' || n === 'InlineCode' || n === 'CodeMark') {
      return null;
    }
  }
  return { from: hashPos, query };
}

interface TagMenuState {
  open: boolean;
  /** `#` の位置 */
  from: number;
  query: string;
  selected: number;
  /** Esc で閉じた `#` 位置。同位置では再オープンしない。 */
  dismissedFrom: number | null;
}

const CLOSED: TagMenuState = { open: false, from: 0, query: '', selected: 0, dismissedFrom: null };

const moveSelection = StateEffect.define<number>();
const dismissMenu = StateEffect.define<null>();

function deriveState(
  state: EditorState,
  prev: TagMenuState,
  dismissed: number | null,
  move = 0,
): TagMenuState {
  const det = detectBodyTagTrigger(state);
  if (det === null) return { ...CLOSED, dismissedFrom: null };
  if (det.from === dismissed) return { ...CLOSED, dismissedFrom: dismissed };
  const items = filterTagSuggestions(tagsOf(state) ?? [], det.query);
  const keep = prev.open && prev.from === det.from && prev.query === det.query;
  const base = keep ? prev.selected : 0;
  const selected = wrap(base + move, items.length);
  return { open: true, from: det.from, query: det.query, selected, dismissedFrom: null };
}

const tagMenuField = StateField.define<TagMenuState>({
  create: (state) => deriveState(state, CLOSED, null),
  update(value, tr) {
    let dismissed = value.open ? null : value.dismissedFrom;
    if (tr.docChanged && dismissed !== null) dismissed = tr.changes.mapPos(dismissed);
    if (tr.effects.some((e) => e.is(dismissMenu))) {
      return { ...CLOSED, dismissedFrom: value.open ? value.from : dismissed };
    }
    let move = 0;
    for (const e of tr.effects) if (e.is(moveSelection)) move += e.value;
    // IME 変換中の入力ではメニューを開かない (# の誤発火防止 — 既存状態を維持)。
    if (tr.isUserEvent('input.type.compose')) {
      return value.open ? value : { ...CLOSED, dismissedFrom: dismissed };
    }
    return deriveState(tr.state, value, dismissed, move);
  },
});

/** query を `#tag ` で確定挿入し、カーソルをタグ末尾 (スペースの後) へ置く。 */
function confirmTag(view: EditorView, s: TagMenuState, tag: string): void {
  const to = view.state.selection.main.head;
  const insert = `#${tag} `;
  view.dispatch({
    changes: { from: s.from, to, insert },
    selection: { anchor: s.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input.complete',
  });
  view.focus();
}

const tagTooltipField = StateField.define<Tooltip | null>({
  create: (state) => computeTooltip(state, null),
  update: (value, tr) => computeTooltip(tr.state, value),
  provide: (f) => showTooltip.from(f),
});

function computeTooltip(state: EditorState, prev: Tooltip | null): Tooltip | null {
  const s = state.field(tagMenuField);
  if (!s.open) return null;
  if (prev !== null && prev.pos === s.from) return prev;
  return { pos: s.from, above: false, strictSide: false, arrow: false, create: (view) => renderTooltip(view) };
}

function renderTooltip(view: EditorView): TooltipView {
  let curState = view.state.field(tagMenuField);
  const menu = buildTagMenu({
    hint: '本文タグを挿入',
    onChoose: (item) => confirmTag(view, curState, item.tag),
    onHover: (i) => view.dispatch({ effects: moveSelection.of(i - curState.selected) }),
  });

  const render = (state: EditorState): void => {
    const s = state.field(tagMenuField);
    if (!s.open) return;
    curState = s;
    const items = filterTagSuggestions(tagsOf(state) ?? [], s.query);
    menu.update(items, s.selected);
  };
  render(view.state);

  return {
    dom: menu.el,
    update: (u) => {
      if (u.state.field(tagMenuField).open) render(u.state);
    },
  };
}

/** メニュー open 中だけ ↑↓/Enter/Esc を奪う。IME 変換中は委ねる。 */
const tagKeymap = keymap.of([
  {
    key: 'ArrowDown',
    run: (view) => {
      if (view.composing) return false;
      if (!view.state.field(tagMenuField).open) return false;
      view.dispatch({ effects: moveSelection.of(1) });
      return true;
    },
  },
  {
    key: 'ArrowUp',
    run: (view) => {
      if (view.composing) return false;
      if (!view.state.field(tagMenuField).open) return false;
      view.dispatch({ effects: moveSelection.of(-1) });
      return true;
    },
  },
  {
    key: 'Enter',
    run: (view) => {
      if (view.composing) return false;
      const s = view.state.field(tagMenuField);
      if (!s.open) return false;
      const items = filterTagSuggestions(tagsOf(view.state) ?? [], s.query);
      const chosen = items[s.selected];
      if (chosen === undefined) return false;
      confirmTag(view, s, chosen.tag);
      return true;
    },
  },
  {
    key: 'Escape',
    run: (view) => {
      if (!view.state.field(tagMenuField).open) return false;
      view.dispatch({ effects: dismissMenu.of(null) });
      return true;
    },
  },
]);

/** 本文 `#tag` 補完一式 (Editor に登録する)。 */
export function bodyTagSuggestExtension(): Extension {
  return [tagMenuField, tagTooltipField, Prec.highest(tagKeymap)];
}
