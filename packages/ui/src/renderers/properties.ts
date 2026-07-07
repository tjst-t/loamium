/**
 * frontmatter プロパティブロックの再設計描画 + WYSIWYG 編集 (S87f4b7)。
 *
 * S9df823-1 の Obsidian Properties 風ブロックを、prototype/props-redesign/chosen.html
 * の確定案へ再設計する:
 *  - 既定は畳まれ、本文直前に `>` トグルだけ (要約テキスト無し) — S87f4b7-1
 *  - 開くと枠・ヘッダ無しのミニマル 2 カラム密行 (キー淡色+型アイコン / 値)
 *  - 値は「キーごとの意味型」(D方式 — S87f4b7-2) に沿ってリッチ描画・編集
 *    (star=クリックで増減 / select=色付きピル / progress=バー / checkbox=☑ /
 *     tags=チップ / date / url / note-link / number / text)
 *  - 『+ プロパティを追加』は型ピッカー (コンテキストメニュー + インクリメンタル
 *    絞り込み) を開く — S87f4b7-3
 *
 * 正本は常に標準 YAML frontmatter のまま。意味型はファイルに一切書かない
 * (ピュア Markdown 厳守 — DESIGN_PRINCIPLES priority 1)。書き戻しは
 * serializeFrontmatterBlock で標準 YAML スカラー/フラット配列へ直列化する。
 * 畳み状態は notePath 単位でメモリ保持する (ファイルには書かない — priority 6)。
 */
import {
  buildKeyOptions,
  canCreateNewKey,
  clampProgress,
  clampStar,
  defaultValueForType,
  filterKeyOptions,
  isDateLike,
  parsePropertiesModel,
  parsePropInput,
  resolvePropertyType,
  selectColorFor,
  serializeFrontmatterBlock,
  STAR_MAX,
  summaryEntriesFor,
  type BuiltinPropertyType,
  type KeyOption,
  type PropEntry,
  type PropertyKeyCount,
  type PropertyTypeDef,
  type PropertyValue,
  type PropScalar,
  type ResolvedPropertyType,
  type TagCount,
} from '@loamium/shared';
import { attachTagInputSuggest } from '../tag-suggest.js';

/** 編集結果を元ドキュメントへ書き戻すためのハンドラ (エディタ側が dispatch を担う)。 */
export interface PropertiesEditHandlers {
  commit(newBlock: string | null): void;
  requestFocus?(target: PropsFocusTarget): void;
  editSource?(currentBlock: string): void;
}

/** 描画オプション (意味型解決・畳み状態の粒度・note-link ナビ)。 */
export interface PropertiesRenderOptions {
  /** 畳み状態の保持キー (notePath 単位)。 */
  notePath?: string;
  /** `.loamium/property-types.json` のキー→型定義 (D方式の上書き)。 */
  typeDefs?: Record<string, PropertyTypeDef>;
  /** note-link の遷移 (読み取り時)。 */
  openNoteLink?: (target: string) => void;
  /** タグ候補ソース (tags 値の `#` 補完 — S45fa45-1)。null/未指定なら補完なし。 */
  getTags?: () => readonly TagCount[] | null;
  /**
   * vault 横断のプロパティキー候補 (件数付き — Sd13ab1-2)。キーファースト追加
   * メニュー zone ① の「vault で実際に使われているキー」に使う。null/未指定なら
   * 内蔵 well-known + JSON定義キーのみ。
   */
  getPropertyKeys?: () => readonly PropertyKeyCount[] | null;
  /**
   * 新規キーの汎用型を `.loamium/property-types.json` へ永続化する (Sd13ab1-2)。
   * D方式の横断固定: 以後そのキーは全ファイルで同じ型に解決される。未指定なら
   * その場の追加のみ (型は永続化されない)。
   */
  persistType?: (key: string, def: PropertyTypeDef) => void;
}

/** コミット後の widget へフォーカス復元を配送する CustomEvent 名。detail: PropsFocusTarget */
export const PROPS_FOCUS_EVENT = 'loamium:props-focus';

/** フォーカス復元先。 */
export type PropsFocusTarget = { kind: 'add' } | { kind: 'chip'; key: string };

/**
 * 畳み/開き状態の保持 (notePath 単位・既定は畳み)。ファイルには書かない
 * (ピュア Markdown / .loamium も使わない — priority 1 / 6)。widget は頻繁に
 * 再構築されるためモジュールスコープに置く。
 */
const propsOpenState = new Map<string, boolean>();

// ---- SVG アイコン ------------------------------------------------------------

const ICON_TIMES =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const ICON_CHEVRON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
const ICON_CODE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.3"/><path d="M10.3 10.3L14 14"/></svg>';
const STAR_ON =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.7l1.9 3.85 4.25.62-3.07 3 .72 4.23L8 11.5 4.17 13.42l.72-4.23L1.82 6.17l4.25-.62z"/></svg>';
const STAR_OFF =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 2l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 10.9 4.5 12.7l.8-3.9L2.4 6.1l3.9-.5z"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';

/** 意味型ごとのキー左アイコン (prototype 準拠)。complex/list は補助アイコン。 */
const TYPE_ICONS: Record<string, string> = {
  text: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4h8M8 4v9M6.2 13h3.6"/></svg>',
  number:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 6.2l1.6-1.2V11"/><path d="M8.4 5.7a1.7 1.7 0 112.9 1.2c-.5.6-2.9 2.2-2.9 4.1h3.3"/></svg>',
  date: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="2.4" y="3.3" width="11.2" height="10.3" rx="1.6"/><path d="M2.4 6.3h11.2M5.6 1.9v2.6M10.4 1.9v2.6"/></svg>',
  checkbox:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="2.6"/><path d="M5.4 8.2l1.8 1.8 3.4-3.6"/></svg>',
  select:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14V3M4 3.5h7.5l-1.6 2.3 1.6 2.3H4"/></svg>',
  'multi-select':
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01"/></svg>',
  tags: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6 2.5L4.3 13.5M11.7 2.5L10 13.5M3 6h10.5M2.5 10h10.5"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 2l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 10.9 4.5 12.7l.8-3.9L2.4 6.1l3.9-.5z"/></svg>',
  progress:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 5.5h8M2 10.5h4.5"/><circle cx="12" cy="5.5" r="1.6"/><circle cx="8.5" cy="10.5" r="1.6"/></svg>',
  url: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 9.4a2.6 2.6 0 003.7 0l1.9-1.9a2.6 2.6 0 00-3.7-3.7l-1 1"/><path d="M9.4 6.6a2.6 2.6 0 00-3.7 0L3.8 8.5a2.6 2.6 0 003.7 3.7l1-1"/></svg>',
  'note-link':
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.2h5l3 3v8.6H4z"/><path d="M9 2.2V5.5h3"/></svg>',
  complex:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H5a2 2 0 0 0-2 2v1.5A1.5 1.5 0 0 1 1.5 8 1.5 1.5 0 0 1 3 9.5V11a2 2 0 0 0 2 2h1M10 3h1a2 2 0 0 1 2 2v1.5A1.5 1.5 0 0 0 14.5 8 1.5 1.5 0 0 0 13 9.5V11a2 2 0 0 1-2 2h-1"/></svg>',
};

/** スカラー値の表示テキスト (null は空)。 */
function scalarText(value: PropScalar): string {
  return value === null ? '' : String(value);
}

/** complex エントリの値プレビュー。 */
function complexPreview(source: string[]): string {
  const first = source[0] ?? '';
  const idx = first.indexOf(':');
  const head = idx >= 0 ? first.slice(idx + 1).trim() : '';
  const multi = source.length > 1;
  if (head === '') return multi ? '…' : '';
  return multi ? `${head} …` : head;
}

/** エントリの解決用の値 (list は配列、scalar は値、complex/raw は null)。 */
function entryValue(entry: PropEntry): PropertyValue {
  if (entry.kind === 'scalar') return entry.value;
  if (entry.kind === 'list') return entry.items;
  return null;
}

/** note-link 文字列 `[[name]]` から内側の名前を取り出す (不正なら原文)。 */
function noteLinkTarget(value: string): string {
  const m = /^\[\[(.+)\]\]$/.exec(value.trim());
  return m?.[1] ?? value;
}

/** 要約バーの 1 テキスト項目 (`.pc-sum-item`)。 */
function makeSumItem(text: string, className = 'pc-sum-item'): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * 畳み時の値要約 (Sd13ab1-1): 1 エントリを型別の簡易トークンへ変換する。
 * tags→チップ / select→色ラベル / star→★ / progress→% / checkbox→☑ + キー /
 * date・text・number・url・note-link→値。空値は空配列 (バーに出さない)。
 * ラベル語『プロパティ』は一切出さない (値/キー名のみ)。
 */
function summaryTokensFor(
  entry: PropEntry,
  resolve: (e: PropEntry) => ResolvedPropertyType,
): HTMLElement[] {
  if (entry.kind === 'raw') return [];
  if (entry.kind === 'complex') return [makeSumItem('…')];

  const resolved = resolve(entry);

  if (entry.kind === 'list') {
    if (entry.items.length === 0) return [];
    const out: HTMLElement[] = [];
    const shown = entry.items.slice(0, 4);
    for (const item of shown) {
      const text = scalarText(item);
      if (text === '') continue;
      out.push(makeSumItem(resolved.type === 'tags' ? `#${text}` : text, 'pc-sum-tag'));
    }
    if (entry.items.length > 4) out.push(makeSumItem(`+${entry.items.length - 4}`, 'pc-sum-more'));
    return out;
  }

  // scalar
  const value = entry.value;
  if (resolved.type === 'select' || resolved.type === 'multi-select') {
    const v = scalarText(value);
    if (v === '') return [];
    const chip = document.createElement('span');
    chip.className = 'pc-sum-item pc-sum-select';
    chip.dataset.color = selectColorFor(v, resolved.options);
    const dot = document.createElement('span');
    dot.className = 'st-dot';
    const text = document.createElement('span');
    text.textContent = v;
    chip.append(dot, text);
    return [chip];
  }
  if (resolved.type === 'star') {
    const n = clampStar(typeof value === 'number' ? value : Number(value) || 0);
    if (n === 0) return [];
    return [makeSumItem('★'.repeat(n) + '☆'.repeat(STAR_MAX - n), 'pc-sum-stars')];
  }
  if (resolved.type === 'progress') {
    const pct = clampProgress(typeof value === 'number' ? value : Number(value) || 0);
    return [makeSumItem(`${pct}%`)];
  }
  if (resolved.type === 'checkbox' || typeof value === 'boolean') {
    return [makeSumItem(`${value === true ? '☑' : '☐'} ${entry.key}`)];
  }
  const text = scalarText(value);
  if (text === '') return [];
  return [makeSumItem(text)];
}

/**
 * 畳み時の値要約バーの中身を組み立てる (Sd13ab1-1)。上限を超えるエントリは
 * 末尾に +N で件数だけ示す。バーは値チップ/テキストのみ (ラベル語なし)。
 */
function buildSummary(
  container: HTMLElement,
  entries: PropEntry[],
  resolve: (e: PropEntry) => ResolvedPropertyType,
): void {
  container.replaceChildren();
  const vals = document.createElement('span');
  vals.className = 'pc-sum-vals';
  const { shown, more } = summaryEntriesFor(entries, 6);
  let first = true;
  for (const entry of shown) {
    const tokens = summaryTokensFor(entry, resolve);
    if (tokens.length === 0) continue;
    if (!first) {
      const sep = document.createElement('span');
      sep.className = 'sum-sep';
      sep.textContent = '·';
      vals.append(sep);
    }
    for (const t of tokens) vals.append(t);
    first = false;
  }
  if (more > 0) vals.append(makeSumItem(`+${more}`, 'pc-sum-more'));
  container.append(vals);
}

/**
 * frontmatter のソース行配列 (--- 区切りを含む) をプロパティブロックへ描画する。
 * handlers を渡すと編集が有効になる。モデル化できない frontmatter は Error を投げる。
 */
export function renderProperties(
  lines: string[],
  handlers?: PropertiesEditHandlers,
  options?: PropertiesRenderOptions,
): HTMLElement {
  const inner = lines
    .slice(1, -1)
    .map((l) => l.replace(/\r$/, ''))
    .join('\n');
  const parsed = parsePropertiesModel(inner);
  if (parsed === null) {
    throw new Error('frontmatter をプロパティモデルへ分解できません (ソース表示のまま)');
  }
  const entries: PropEntry[] = parsed;
  const editable = handlers !== undefined;
  const typeDefs = options?.typeDefs ?? {};
  const notePathKey = options?.notePath ?? '';
  const openNoteLink = options?.openNoteLink;

  const resolve = (entry: PropEntry): ResolvedPropertyType =>
    entry.kind === 'raw'
      ? { type: 'text', source: 'builtin' }
      : resolvePropertyType(entry.key, entryValue(entry), typeDefs);

  // ---- ルート要素 ------------------------------------------------------------

  const wrap = document.createElement('div');
  wrap.className = editable ? 'pc md-props-wrap editable' : 'pc md-props-wrap';
  wrap.setAttribute('data-testid', 'properties-widget');
  if (editable) wrap.setAttribute('data-editable', 'true');
  const open = propsOpenState.get(notePathKey) ?? false;
  wrap.dataset.open = open ? 'true' : 'false';

  // ---- コミット基盤 (table.ts と同じ: flush → 直列化 → 変化時のみ dispatch) ----

  const serializeBlock = (): string | null => serializeFrontmatterBlock(entries);
  let lastCommitted = serializeBlock() ?? '';
  let flushValue: (() => void) | null = null;
  const chipFlushes = new Set<() => void>();
  const flushAll = (): void => {
    if (flushValue !== null) flushValue();
    for (const f of Array.from(chipFlushes)) f();
  };

  const structuralCommit = (): void => {
    if (handlers === undefined) return;
    flushAll();
    const s = serializeBlock();
    lastCommitted = s ?? '';
    handlers.commit(s);
  };
  const commitFinal = (): void => {
    if (handlers === undefined) return;
    flushAll();
    const s = serializeBlock();
    if ((s ?? '') !== lastCommitted) {
      lastCommitted = s ?? '';
      handlers.commit(s);
    }
  };

  const removeEntry = (entry: PropEntry): void => {
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
  };
  const replaceEntry = (oldEntry: PropEntry, newEntry: PropEntry): void => {
    const i = entries.indexOf(oldEntry);
    if (i >= 0) entries[i] = newEntry;
  };
  const keyedKeys = (): Set<string> => {
    const s = new Set<string>();
    for (const e of entries) if (e.kind !== 'raw') s.add(e.key);
    return s;
  };

  // ---- 畳む/開くトグル + 畳み時の値要約バー (Sd13ab1-1 / AC-1) ------------------
  // 本文直前に `>` トグル (常時可視) と、畳み時のみ値の要約バー (properties-summary)。
  // 要約は値チップ/テキストのみ (『プロパティ』というラベル語は出さない — AC-1-1)。

  const head = document.createElement('div');
  head.className = 'pc-head';

  const setOpen = (next: boolean): void => {
    propsOpenState.set(notePathKey, next);
    wrap.dataset.open = next ? 'true' : 'false';
    toggleBtn.setAttribute('aria-expanded', String(next));
    toggleBtn.title = next ? 'プロパティを畳む' : 'プロパティを展開';
    summaryEl.setAttribute('aria-expanded', String(next));
  };

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'pc-toggle';
  toggleBtn.setAttribute('data-testid', 'properties-toggle');
  toggleBtn.setAttribute('aria-expanded', String(open));
  toggleBtn.title = open ? 'プロパティを畳む' : 'プロパティを展開';
  toggleBtn.innerHTML = ICON_CHEVRON;
  toggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(wrap.dataset.open !== 'true');
  });
  head.append(toggleBtn);

  // 値要約バー (畳み時のみ表示。クリックで展開/畳みトグル — AC-1-2)
  const summaryEl = document.createElement('button');
  summaryEl.type = 'button';
  summaryEl.className = 'pc-summary';
  summaryEl.setAttribute('data-testid', 'properties-summary');
  summaryEl.setAttribute('aria-expanded', String(open));
  summaryEl.title = 'プロパティを展開';
  summaryEl.addEventListener('mousedown', (e) => e.preventDefault());
  summaryEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(wrap.dataset.open !== 'true');
  });
  buildSummary(summaryEl, entries, resolve);
  head.append(summaryEl);

  if (editable && handlers?.editSource !== undefined) {
    const editSource = handlers.editSource.bind(handlers);
    const srcBtn = document.createElement('button');
    srcBtn.type = 'button';
    srcBtn.className = 'md-props-edit-source';
    srcBtn.setAttribute('data-testid', 'properties-edit-source');
    srcBtn.title = 'frontmatter を YAML ソースとして編集';
    srcBtn.innerHTML = `${ICON_CODE}<span>ソースを編集</span>`;
    srcBtn.addEventListener('mousedown', (e) => e.preventDefault());
    srcBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      flushAll();
      const s = serializeBlock();
      if (s !== null) editSource(s);
    });
    head.append(srcBtn);
  }
  wrap.append(head);

  // ---- 開いた中身 (密行グリッド + 追加) --------------------------------------

  const openBox = document.createElement('div');
  openBox.className = 'pc-open';
  wrap.append(openBox);

  const rows = document.createElement('dl');
  rows.className = 'pc-rows md-props-rows';
  openBox.append(rows);

  const gotoSource = (): void => {
    if (handlers?.editSource === undefined) return;
    flushAll();
    const s = serializeBlock();
    if (s !== null) handlers.editSource(s);
  };

  // ---- スカラー値の input 差し替え編集 ----------------------------------------

  function beginValueEdit(
    cell: HTMLElement,
    body: HTMLElement,
    ref: { entry: PropEntry },
    resolved: ResolvedPropertyType,
  ): void {
    if (!editable) return;
    if (body.dataset.editing === '1') return;
    const cur = ref.entry;
    if (cur.kind !== 'scalar') return;
    body.dataset.editing = '1';

    const input = document.createElement('input');
    input.className = 'md-prop-input';
    input.setAttribute('data-testid', 'properties-value-input');
    input.setAttribute('data-key', cur.key);
    input.type =
      resolved.type === 'date' && (isDateLike(cur.value) || cur.value === null)
        ? 'date'
        : resolved.type === 'number' || resolved.type === 'progress'
          ? 'number'
          : 'text';
    input.value = scalarText(cur.value);
    body.style.display = 'none';
    cell.insertBefore(input, body);

    // select の選択肢メニュー (options があれば — AC-2-2「選択肢+色」)
    let optionMenu: HTMLElement | null = null;
    if (resolved.type === 'select' || resolved.type === 'multi-select') {
      const opts = resolved.options ?? [];
      if (opts.length > 0) {
        optionMenu = document.createElement('div');
        optionMenu.className = 'pc-select-menu';
        optionMenu.setAttribute('data-testid', 'properties-select-menu');
        for (const opt of opts) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'pc-select-option';
          b.setAttribute('data-testid', 'properties-select-option');
          b.setAttribute('data-value', opt.value);
          b.dataset.color = selectColorFor(opt.value, opts);
          b.innerHTML = `<span class="dot"></span><span>${escapeHtml(opt.value)}</span>`;
          b.addEventListener('mousedown', (e) => e.preventDefault());
          b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            input.value = opt.value;
            finish();
            commitFinal();
          });
          optionMenu.append(b);
        }
        cell.append(optionMenu);
      }
    }

    input.focus();
    if (input.type === 'text') {
      const len = input.value.length;
      try {
        input.setSelectionRange(len, len);
      } catch {
        // input 種別によっては失敗しうる。無視して継続。
      }
    }
    const initialText = input.value;

    const apply = (): void => {
      const prev = ref.entry;
      if (prev.kind !== 'scalar') return;
      // 無変更の blur では再解釈しない (引用符付き "5"/"true" の型化けを防ぐ — S9df823)
      if (input.value === initialText) return;
      let next: PropScalar;
      if (resolved.type === 'progress') {
        next = input.value.trim() === '' ? null : clampProgress(Number(input.value));
      } else {
        next = parsePropInput(input.value);
      }
      const updated: PropEntry = { kind: 'scalar', key: prev.key, value: next };
      replaceEntry(prev, updated);
      ref.entry = updated;
    };
    flushValue = apply;

    const cleanup = (): void => {
      flushValue = null;
      if (input.parentElement !== null) input.parentElement.removeChild(input);
      if (optionMenu !== null && optionMenu.parentElement !== null) {
        optionMenu.parentElement.removeChild(optionMenu);
      }
      body.style.display = '';
    };

    function finish(): void {
      if (body.dataset.editing !== '1') return;
      body.dataset.editing = '';
      apply();
      cleanup();
      // 型に沿って body を作り直す (値と型が変わりうる)
      rebuildValueCell(cell, ref);
    }
    const cancel = (): void => {
      if (body.dataset.editing !== '1') return;
      body.dataset.editing = '';
      cleanup();
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return; // IME 変換中はブラウザに委ねる
      if (e.key === 'Enter') {
        e.preventDefault();
        finish();
        commitFinal();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('beforeinput', (e) => e.stopPropagation());
    input.addEventListener('input', (e) => e.stopPropagation());
    input.addEventListener('blur', (e) => {
      const rt = e.relatedTarget;
      // select オプションボタン等 widget 内へ移るときはコミットしない
      const stayingInWidget = rt instanceof Node && wrap.contains(rt);
      finish();
      if (!stayingInWidget) commitFinal();
    });
  }

  // ---- 型ごとの値セル描画 -----------------------------------------------------

  /** value セルの中身を作り直す (編集確定後の再描画に使う)。 */
  function rebuildValueCell(cell: HTMLElement, ref: { entry: PropEntry }): void {
    cell.replaceChildren();
    cell.className = 'md-prop-value pc-value-cell';
    fillValueCell(cell, ref);
  }

  function fillValueCell(cell: HTMLElement, ref: { entry: PropEntry }): void {
    const entry = ref.entry;
    const resolved = resolve(entry);

    if (entry.kind === 'complex') {
      const ro = document.createElement('span');
      ro.className = 'md-prop-value-readonly';
      ro.setAttribute('data-testid', 'properties-value-readonly');
      ro.textContent = complexPreview(entry.source);
      ro.title = '複雑な値のためここでは編集できません — クリックでソースを編集';
      if (editable) {
        ro.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          gotoSource();
        });
      }
      const hint = document.createElement('span');
      hint.className = 'md-prop-ro-hint';
      hint.textContent = 'ソースで編集';
      cell.append(ro, hint);
      return;
    }

    if (entry.kind === 'list') {
      renderChips(cell, ref, resolved.type);
      return;
    }

    if (entry.kind !== 'scalar') return; // raw は行として描画しない

    // scalar — 意味型ごとの描画
    if (resolved.type === 'checkbox' || typeof entry.value === 'boolean') {
      renderCheckbox(cell, ref);
      return;
    }
    if (resolved.type === 'star') {
      renderStars(cell, ref);
      return;
    }
    if (resolved.type === 'progress') {
      renderProgress(cell, ref, resolved);
      return;
    }
    if (resolved.type === 'select' || resolved.type === 'multi-select') {
      renderSelect(cell, ref, resolved);
      return;
    }
    if (resolved.type === 'url') {
      renderUrl(cell, ref, resolved);
      return;
    }
    if (resolved.type === 'note-link') {
      renderNoteLink(cell, ref, resolved);
      return;
    }
    // text / number / date
    renderScalar(cell, ref, resolved);
  }

  function makeBody(type: BuiltinPropertyType, className: string): HTMLElement {
    const body = document.createElement('span');
    body.className = className;
    body.setAttribute('data-testid', 'properties-value-body');
    body.setAttribute('data-type', type);
    return body;
  }

  function renderScalar(
    cell: HTMLElement,
    ref: { entry: PropEntry },
    resolved: ResolvedPropertyType,
  ): void {
    const entry = ref.entry;
    if (entry.kind !== 'scalar') return;
    const body = makeBody(resolved.type, 'md-prop-value-body');
    body.textContent = scalarText(entry.value);
    if (entry.value === null) body.classList.add('pc-null');
    cell.append(body);
    if (editable) attachEditClick(cell, body, ref, resolved);
  }

  function renderStars(cell: HTMLElement, ref: { entry: PropEntry }): void {
    const entry = ref.entry;
    if (entry.kind !== 'scalar') return;
    const body = makeBody('star', 'pc-stars');
    const cur = clampStar(typeof entry.value === 'number' ? entry.value : Number(entry.value) || 0);
    body.setAttribute('data-value', String(cur));
    for (let i = 1; i <= STAR_MAX; i++) {
      const s = document.createElement('button');
      s.type = 'button';
      s.className = 'pc-star';
      s.setAttribute('data-index', String(i));
      s.innerHTML = i <= cur ? STAR_ON : STAR_OFF;
      if (i <= cur) s.classList.add('on');
      if (editable) {
        s.addEventListener('mousedown', (e) => e.preventDefault());
        s.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const prev = ref.entry;
          if (prev.kind !== 'scalar') return;
          const now = clampStar(typeof prev.value === 'number' ? prev.value : Number(prev.value) || 0);
          const nextVal = now === i ? i - 1 : i; // 同じ星の再クリックで 1 減らす
          const updated: PropEntry = { kind: 'scalar', key: prev.key, value: nextVal };
          replaceEntry(prev, updated);
          ref.entry = updated;
          rebuildValueCell(cell, ref);
          structuralCommit();
        });
      } else {
        s.disabled = true;
      }
      body.append(s);
    }
    cell.append(body);
  }

  function renderProgress(
    cell: HTMLElement,
    ref: { entry: PropEntry },
    resolved: ResolvedPropertyType,
  ): void {
    const entry = ref.entry;
    if (entry.kind !== 'scalar') return;
    const pct = clampProgress(typeof entry.value === 'number' ? entry.value : Number(entry.value) || 0);
    const body = makeBody('progress', 'pc-progress');
    body.setAttribute('data-value', String(pct));
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    const label = document.createElement('span');
    label.className = 'pct';
    label.textContent = `${pct}%`;
    body.append(bar, label);
    cell.append(body);
    if (editable) attachEditClick(cell, body, ref, resolved);
  }

  function renderSelect(
    cell: HTMLElement,
    ref: { entry: PropEntry },
    resolved: ResolvedPropertyType,
  ): void {
    const entry = ref.entry;
    if (entry.kind !== 'scalar') return;
    const val = scalarText(entry.value);
    const body = makeBody('select', 'pc-select');
    body.dataset.color = selectColorFor(val, resolved.options);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.textContent = val;
    body.append(dot, text);
    cell.append(body);
    if (editable) attachEditClick(cell, body, ref, resolved);
  }

  function renderUrl(
    cell: HTMLElement,
    ref: { entry: PropEntry },
    resolved: ResolvedPropertyType,
  ): void {
    const entry = ref.entry;
    if (entry.kind !== 'scalar') return;
    const val = scalarText(entry.value);
    const body = makeBody('url', 'pc-url');
    body.textContent = val;
    cell.append(body);
    if (editable) attachEditClick(cell, body, ref, resolved);
  }

  function renderNoteLink(
    cell: HTMLElement,
    ref: { entry: PropEntry },
    resolved: ResolvedPropertyType,
  ): void {
    const entry = ref.entry;
    if (entry.kind !== 'scalar') return;
    const val = scalarText(entry.value);
    const body = makeBody('note-link', 'pc-notelink');
    body.setAttribute('data-target', noteLinkTarget(val));
    body.textContent = val;
    cell.append(body);
    if (editable) {
      attachEditClick(cell, body, ref, resolved);
    } else if (openNoteLink !== undefined) {
      body.addEventListener('click', (e) => {
        e.preventDefault();
        openNoteLink(noteLinkTarget(val));
      });
    }
  }

  function renderCheckbox(cell: HTMLElement, ref: { entry: PropEntry }): void {
    const entry = ref.entry;
    if (entry.kind !== 'scalar') return;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'md-prop-bool pc-check-input';
    cb.setAttribute('data-testid', 'properties-bool');
    cb.setAttribute('data-key', entry.key);
    cb.setAttribute('data-type', 'checkbox');
    cb.checked = entry.value === true;
    if (!editable) cb.disabled = true;
    cb.addEventListener('change', () => {
      const prev = ref.entry;
      if (prev.kind !== 'scalar') return;
      const updated: PropEntry = { kind: 'scalar', key: prev.key, value: cb.checked };
      replaceEntry(prev, updated);
      ref.entry = updated;
      structuralCommit();
    });
    cell.append(cb);
  }

  /** 値本体クリックで input 編集を開く共通ハンドラ。 */
  function attachEditClick(
    cell: HTMLElement,
    body: HTMLElement,
    ref: { entry: PropEntry },
    resolved: ResolvedPropertyType,
  ): void {
    cell.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const t = e.target;
      if (t instanceof Element && (t.closest('button') !== null || t.closest('input') !== null)) return;
      e.preventDefault();
      e.stopPropagation();
      beginValueEdit(cell, body, ref, resolved);
    });
  }

  /**
   * list エントリのチップ列 + 追加入力を描画する (tags / multi-select)。
   * チップの追加/削除は DOM を増分更新する (input 再生成でフォーカスが落ちるのを防ぐ)。
   */
  function renderChips(cell: HTMLElement, ref: { entry: PropEntry }, type: BuiltinPropertyType): void {
    cell.replaceChildren();
    cell.classList.add('md-prop-chips');
    cell.dataset.type = type;
    const entry = ref.entry;
    if (entry.kind !== 'list') return;

    const makeChip = (item: PropScalar): HTMLElement => {
      const chip = document.createElement('span');
      chip.className = 'md-prop-chip pc-tag';
      chip.setAttribute('data-testid', 'properties-chip');
      chip.setAttribute('data-value', scalarText(item));
      const text = document.createElement('span');
      text.textContent = type === 'tags' ? `#${scalarText(item)}` : scalarText(item);
      chip.append(text);
      if (editable) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'md-prop-chip-remove';
        del.setAttribute('data-testid', 'properties-chip-remove');
        del.setAttribute('data-value', scalarText(item));
        del.title = '削除';
        del.innerHTML = ICON_TIMES;
        del.addEventListener('mousedown', (e) => e.preventDefault());
        del.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const prev = ref.entry;
          if (prev.kind !== 'list') return;
          const chips = Array.from(cell.querySelectorAll('[data-testid="properties-chip"]'));
          const idx = chips.indexOf(chip);
          if (idx < 0) return;
          const items = prev.items.filter((_, j) => j !== idx);
          const updated: PropEntry = { kind: 'list', key: prev.key, items };
          replaceEntry(prev, updated);
          ref.entry = updated;
          structuralCommit();
        });
        chip.append(del);
      }
      return chip;
    };

    for (const item of entry.items) cell.append(makeChip(item ?? null));

    if (!editable) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'md-prop-chip-input';
    input.setAttribute('data-testid', 'properties-chip-input');
    input.setAttribute('data-key', entry.key);
    input.placeholder = '追加…';
    /** value v で新チップを 1 件追加する (tags 値は先頭 `#` を落として保存 — ピュア Markdown)。 */
    const commitChip = (v: string): boolean => {
      const t = v.trim().replace(/^#+/, '');
      if (t === '') return false;
      const prev = ref.entry;
      if (prev.kind !== 'list') return false;
      const updated: PropEntry = { kind: 'list', key: prev.key, items: [...prev.items, t] };
      replaceEntry(prev, updated);
      ref.entry = updated;
      return true;
    };
    const insertLastChip = (): void => {
      const prev = ref.entry;
      if (prev.kind === 'list') {
        const added = prev.items[prev.items.length - 1] ?? null;
        cell.insertBefore(makeChip(added), input);
      }
    };
    const addPending = (): boolean => {
      if (!commitChip(input.value)) return false;
      input.value = '';
      return true;
    };
    chipFlushes.add(addPending);

    // tags 値の `#` 候補補完 (S45fa45-1)。共通ソース (GET /api/tags) を filterTagSuggestions で絞り込む。
    const tagSuggest =
      type === 'tags' && options?.getTags !== undefined
        ? attachTagInputSuggest(input, {
            getTags: options.getTags,
            onPick: (tag) => {
              input.value = ''; // structuralCommit の flush(addPending) による二重追加を防ぐ
              if (commitChip(tag)) {
                insertLastChip();
                structuralCommit();
              }
            },
          })
        : null;

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (tagSuggest !== null && tagSuggest.handleKeydown(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (addPending()) insertLastChip();
      } else if (e.key === 'Backspace' && input.value === '') {
        const prev = ref.entry;
        if (prev.kind !== 'list' || prev.items.length === 0) return;
        e.preventDefault();
        const updated: PropEntry = { kind: 'list', key: prev.key, items: prev.items.slice(0, -1) };
        replaceEntry(prev, updated);
        ref.entry = updated;
        const chips = cell.querySelectorAll('[data-testid="properties-chip"]');
        chips[chips.length - 1]?.remove();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = '';
        input.blur();
      }
    });
    input.addEventListener('beforeinput', (e) => e.stopPropagation());
    input.addEventListener('input', (e) => {
      e.stopPropagation();
      tagSuggest?.refresh();
    });
    input.addEventListener('blur', (e) => {
      const rt = e.relatedTarget;
      const stayingInWidget = rt instanceof Node && wrap.contains(rt);
      tagSuggest?.close();
      if (!stayingInWidget) commitFinal();
    });
    cell.append(input);
  }

  // ---- 行の描画 (dt: キー / dd: 値) -------------------------------------------

  function makeRow(entry: PropEntry): { dt: HTMLElement; dd: HTMLElement } {
    const ref = { entry };
    const resolved = resolve(entry);

    const dt = document.createElement('dt');
    dt.className = 'md-prop-key';
    dt.setAttribute('data-testid', 'properties-key');
    const icon = document.createElement('span');
    icon.className = 'ico md-prop-type-icon';
    const iconKey = entry.kind === 'complex' ? 'complex' : resolved.type;
    icon.innerHTML = TYPE_ICONS[iconKey] ?? TYPE_ICONS['text'] ?? '';
    const keyText = document.createElement('span');
    keyText.className = 'md-prop-key-text';
    keyText.textContent = entry.kind !== 'raw' ? entry.key : '';
    dt.append(icon, keyText);

    const dd = document.createElement('dd');
    dd.className = 'md-prop-value pc-value-cell';
    dd.setAttribute('data-testid', 'properties-row');
    if (entry.kind !== 'raw') dd.setAttribute('data-key', entry.key);

    const valueCell = document.createElement('div');
    valueCell.className = 'md-prop-value-inner';
    valueCell.setAttribute('data-testid', 'properties-value');
    fillValueCell(valueCell, ref);
    dd.append(valueCell);

    if (editable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'md-prop-del pc-row-del';
      del.setAttribute('data-testid', 'properties-row-delete');
      if (entry.kind !== 'raw') del.setAttribute('data-key', entry.key);
      del.title = entry.kind !== 'raw' ? `この行(${entry.key})を削除` : 'プロパティを削除';
      del.innerHTML = ICON_TIMES;
      del.addEventListener('mousedown', (e) => e.preventDefault());
      del.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeEntry(ref.entry);
        structuralCommit(); // 最後の 1 件ならブロックごと除去 (commit(null))
      });
      dd.append(del);
    }
    return { dt, dd };
  }

  for (const entry of entries) {
    if (entry.kind === 'raw') continue; // コメント・空行は表示しない (verbatim 保持のみ)
    const { dt, dd } = makeRow(entry);
    rows.append(dt, dd);
  }

  // ---- プロパティ追加 (キーファースト候補メニュー — Sd13ab1-2) ----------------
  // 型ファーストを廃し、まず「どのプロパティ(キー)か」を選ぶ。既知/一意キーは
  // 選ぶだけで即追加 (型は D方式でキーから決まる)。一致しない名前は新規作成 →
  // 汎用型を選び、その型を .loamium/property-types.json へ永続化する。

  if (editable) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pc-add md-props-add';
    addBtn.setAttribute('data-testid', 'properties-add');
    addBtn.innerHTML = `<span class="plus">+</span> プロパティを追加`;
    openBox.append(addBtn);

    /** 型に沿った新エントリを追加してコミットする (キー名の再入力なし)。 */
    const addForKey = (key: string, type: BuiltinPropertyType): void => {
      if (key === '' || keyedKeys().has(key)) return;
      entries.push(makeNewEntry(type, key, ''));
      handlers?.requestFocus?.({ kind: 'add' });
      structuralCommit();
    };

    const menu = createAddMenu({
      typeDefs,
      getPropertyKeys: () => options?.getPropertyKeys?.() ?? null,
      existingKeys: () => keyedKeys(),
      onPickKnown: (key) => {
        menu.close();
        // 型はキーから決まる (D方式)。既知キーの解決結果を使う。
        const type = resolvePropertyType(key, defaultValueForType('text'), typeDefs).type;
        addForKey(key, type);
      },
      onPickNew: (key, type) => {
        menu.close();
        // 汎用型を .loamium/property-types.json へ永続化 (D方式の横断固定)。
        options?.persistType?.(key, { type });
        addForKey(key, type);
      },
      onClose: () => {
        addBtn.classList.remove('active');
      },
    });
    openBox.append(menu.el);

    addBtn.addEventListener('mousedown', (e) => e.preventDefault());
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      addBtn.classList.add('active');
      menu.open();
    });

    // フォーカスが widget 外へ抜けたら最終コミット (widget 内の移動では抜けない)
    wrap.addEventListener('focusout', (e) => {
      const rt = e.relatedTarget;
      if (rt instanceof Node && wrap.contains(rt)) return;
      commitFinal();
    });

    // コミット後のフォーカス復元 (requestFocus → DOM 位置で特定した widget へ配送)
    wrap.addEventListener(PROPS_FOCUS_EVENT, (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const d: unknown = e.detail;
      if (typeof d !== 'object' || d === null) return;
      const target = d as { kind?: unknown; key?: unknown };
      if (target.kind === 'chip' && typeof target.key === 'string') {
        const input = wrap.querySelector<HTMLInputElement>(
          `[data-testid="properties-chip-input"][data-key="${CSS.escape(target.key)}"]`,
        );
        input?.focus();
      }
    });
  }

  return wrap;
}

/** 型に沿った新エントリ (標準 YAML スカラー/配列) を作る。 */
function makeNewEntry(type: BuiltinPropertyType, key: string, valueText: string): PropEntry {
  const t = valueText.trim();
  if (type === 'tags' || type === 'multi-select') {
    const items = t === '' ? [] : t.split(/[\s,、]+/).filter((s) => s !== '');
    return { kind: 'list', key, items };
  }
  let value: PropScalar;
  if (type === 'star') value = clampStar(Number(t) || 0);
  else if (type === 'progress') value = clampProgress(Number(t) || 0);
  else if (type === 'number') {
    const p = parsePropInput(t);
    value = typeof p === 'number' ? p : t === '' ? 0 : p;
  } else if (type === 'checkbox') {
    value = t === 'true';
  } else {
    // date / select / url / note-link / text: 素朴解釈 (空は null = `key:`)
    value = parsePropInput(t);
  }
  return { kind: 'scalar', key, value };
}

// ---- キーファースト追加メニュー (Sd13ab1-2) ---------------------------------

/** 新規キーで選べる汎用型 (chosen-v2.html D 準拠。一意な既知キーは ① で型が決まる)。 */
const GENERIC_NEW_TYPES: readonly BuiltinPropertyType[] = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'star',
];

interface AddMenuParams {
  typeDefs: Record<string, PropertyTypeDef>;
  /** vault 横断のキー候補 (件数付き)。null なら内蔵 + JSON定義のみ。 */
  getPropertyKeys: () => readonly PropertyKeyCount[] | null;
  /** この文書に既にあるキー (重複不可・淡色無効)。 */
  existingKeys: () => Set<string>;
  /** 既知/一意キーを選んだ (キー名の再入力なし・型は D方式で解決)。 */
  onPickKnown: (key: string) => void;
  /** 新規キー + 汎用型を選んだ (型を永続化して追加)。 */
  onPickNew: (key: string, type: BuiltinPropertyType) => void;
  onClose: () => void;
}

interface AddMenuHandle {
  el: HTMLElement;
  open(): void;
  close(): void;
}

/**
 * キーファーストの追加候補メニュー。① 既知/一意 (内蔵 well-known + JSON定義 +
 * vault 実使用キー・件数付き) と ② 新規作成 (名前 → 汎用型セレクタ) の 2 ゾーン。
 * 上部入力でインクリメンタル絞り込み。既存キーは disabled (一意)。
 */
function createAddMenu(params: AddMenuParams): AddMenuHandle {
  const el = document.createElement('div');
  el.className = 'type-picker add-menu';
  el.setAttribute('data-testid', 'property-add-menu');
  el.style.display = 'none';

  const searchLabel = document.createElement('label');
  searchLabel.className = 'type-picker-search';
  searchLabel.innerHTML = ICON_SEARCH;
  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'type-picker-filter';
  filter.setAttribute('data-testid', 'property-add-filter');
  filter.placeholder = 'プロパティ名で絞り込み / 新しい名前を入力…';
  filter.autocomplete = 'off';
  searchLabel.append(filter);
  el.append(searchLabel);

  const list = document.createElement('div');
  list.className = 'type-picker-list';
  el.append(list);
  const empty = document.createElement('div');
  empty.className = 'type-picker-empty';
  empty.textContent = '一致するプロパティがありません — 名前を入力して「新規作成」できます';
  empty.style.display = 'none';
  el.append(empty);

  let selectableBtns: HTMLElement[] = [];
  let selectedIdx = 0;
  // 新規キーの型セレクタ表示中は、検索入力を隠すことによる blur で閉じない (guard)。
  let selectingType = false;

  const group = (text: string): HTMLElement => {
    const g = document.createElement('div');
    g.className = 'type-picker-group';
    g.textContent = text;
    return g;
  };

  const makeKnownOption = (opt: KeyOption): HTMLElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = opt.existing ? 'type-opt is-existing' : 'type-opt';
    b.setAttribute('data-testid', 'property-add-known');
    b.setAttribute('data-key', opt.key);
    b.setAttribute('data-source', opt.source);
    if (opt.existing) {
      b.setAttribute('data-existing', 'true');
      b.disabled = true;
    }
    const ico = document.createElement('span');
    ico.className = 'type-ico';
    ico.innerHTML = TYPE_ICONS[opt.type] ?? TYPE_ICONS['text'] ?? '';
    const main = document.createElement('span');
    main.className = 'type-main';
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = opt.key;
    const desc = document.createElement('span');
    desc.className = 'type-desc';
    desc.textContent = opt.count !== undefined ? `${opt.desc} · vault ${opt.count} 件` : opt.desc;
    main.append(name, desc);
    b.append(ico, main);
    if (opt.existing) {
      const badge = document.createElement('span');
      badge.className = 'exists-badge';
      badge.textContent = '既存';
      b.append(badge);
    } else if (opt.source === 'json') {
      const badge = document.createElement('span');
      badge.className = 'json-badge';
      badge.textContent = 'JSON定義';
      b.append(badge);
    }
    if (!opt.existing) {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        params.onPickKnown(opt.key);
      });
    } else {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => e.preventDefault());
    }
    return b;
  };

  const makeCreateOption = (key: string): HTMLElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'type-opt create-new';
    b.setAttribute('data-testid', 'property-add-new');
    b.setAttribute('data-key', key);
    const ico = document.createElement('span');
    ico.className = 'type-ico';
    ico.innerHTML = '<span class="plus">+</span>';
    const main = document.createElement('span');
    main.className = 'type-main';
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = `新規作成: 「${key}」`;
    const desc = document.createElement('span');
    desc.className = 'type-desc';
    desc.textContent = '新しいキー。型を次で選ぶ(text/number/date…)';
    main.append(name, desc);
    b.append(ico, main);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTypeSelector(key);
    });
    return b;
  };

  /** 新規キーの汎用型セレクタ (② を選んだ後)。型を選ぶと onPickNew。 */
  const showTypeSelector = (key: string): void => {
    // 検索入力を隠す前に guard を立てる (hide による filter blur で close しない)
    selectingType = true;
    list.replaceChildren();
    empty.style.display = 'none';
    searchLabel.style.display = 'none';
    const wrap = document.createElement('div');
    wrap.className = 'pc-typesel';
    wrap.setAttribute('data-testid', 'property-new-type-wrap');
    const nameEl = document.createElement('span');
    nameEl.className = 'newkey-name';
    nameEl.textContent = key;
    wrap.append(nameEl);
    for (const type of GENERIC_NEW_TYPES) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'type-chip';
      chip.setAttribute('data-testid', 'property-new-type');
      chip.setAttribute('data-type', type);
      chip.innerHTML = `${TYPE_ICONS[type] ?? ''}<span>${type}</span>`;
      chip.addEventListener('mousedown', (e) => e.preventDefault());
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        params.onPickNew(key, type);
      });
      wrap.append(chip);
    }
    list.append(wrap);
    // 型セレクタへフォーカスを移す (キーボードでも選べる。blur→close も防ぐ)
    (wrap.querySelector<HTMLElement>('.type-chip'))?.focus();
  };

  const render = (): void => {
    selectingType = false;
    searchLabel.style.display = '';
    const q = filter.value;
    const allOptions = buildKeyOptions(
      params.typeDefs,
      params.getPropertyKeys() ?? [],
      params.existingKeys(),
    );
    const hits = filterKeyOptions(allOptions, q);
    list.replaceChildren();
    selectableBtns = [];
    selectedIdx = 0;

    if (hits.length > 0) {
      list.append(group('① 既知のプロパティ(選ぶだけ・型はキーから決まる)'));
      for (const o of hits) {
        const b = makeKnownOption(o);
        list.append(b);
        if (!o.existing) selectableBtns.push(b);
      }
    }

    const showCreate = canCreateNewKey(q, allOptions);
    if (showCreate) {
      list.append(group('② 新規プロパティ(汎用型 — 名前を付けて作成)'));
      const b = makeCreateOption(q.trim());
      list.append(b);
      selectableBtns.push(b);
    }

    empty.style.display = hits.length === 0 && !showCreate ? '' : 'none';
    highlight();
  };

  const highlight = (): void => {
    selectableBtns.forEach((b, i) => b.classList.toggle('sel', i === selectedIdx));
    selectableBtns[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  };

  filter.addEventListener('input', (e) => {
    e.stopPropagation();
    render();
  });
  filter.addEventListener('beforeinput', (e) => e.stopPropagation());
  filter.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, Math.max(0, selectableBtns.length - 1));
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectableBtns[selectedIdx]?.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  filter.addEventListener('blur', (e) => {
    if (selectingType) return; // 型セレクタ表示中は閉じない
    const rt = e.relatedTarget;
    if (rt instanceof Node && el.contains(rt)) return;
    close();
  });

  function open(): void {
    selectingType = false;
    filter.value = '';
    searchLabel.style.display = '';
    render();
    el.style.display = '';
    filter.focus();
  }
  function close(): void {
    if (el.style.display === 'none') return;
    selectingType = false;
    el.style.display = 'none';
    params.onClose();
  }

  return { el, open, close };
}

/**
 * frontmatter が一切無いノートへの控えめな追加入口 (Sd13ab1-3 / AC-3-2)。
 * 『+ プロパティを追加』を押すとキーファーストメニューが開き、最初のプロパティを
 * 選ぶと handlers.commit に標準 YAML の frontmatter ブロック文字列を渡す。
 */
export interface EmptyPropertiesHandlers {
  /** 最初のプロパティから生成した frontmatter ブロック (--- ... ---) をコミットする。 */
  commit(block: string): void;
}

export function renderEmptyPropertiesEntry(
  handlers: EmptyPropertiesHandlers,
  options?: PropertiesRenderOptions,
): HTMLElement {
  const typeDefs = options?.typeDefs ?? {};
  const wrap = document.createElement('div');
  wrap.className = 'pc-empty';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pc-empty-add';
  addBtn.setAttribute('data-testid', 'properties-empty-add');
  addBtn.title = '最初のプロパティを追加(frontmatter を作成)';
  addBtn.innerHTML = `<span class="chev">${ICON_CHEVRON}</span><span class="plus">+</span> プロパティを追加`;
  wrap.append(addBtn);

  const commitFirst = (key: string, type: BuiltinPropertyType): void => {
    const entry = makeNewEntry(type, key, '');
    const block = serializeFrontmatterBlock([entry]);
    if (block !== null) {
      // 空ノートへの初回追加時は詳細を自動展開する。既定は畳み (S87f4b7-1-AC1)
      // だが、追加直後にすぐ値を入力できるよう開いておく。
      propsOpenState.set(options?.notePath ?? '', true);
      handlers.commit(block);
    }
  };

  const menu = createAddMenu({
    typeDefs,
    getPropertyKeys: () => options?.getPropertyKeys?.() ?? null,
    existingKeys: () => new Set<string>(), // frontmatter が無いので既存キーは無し
    onPickKnown: (key) => {
      menu.close();
      const type = resolvePropertyType(key, defaultValueForType('text'), typeDefs).type;
      commitFirst(key, type);
    },
    onPickNew: (key, type) => {
      menu.close();
      options?.persistType?.(key, { type });
      commitFirst(key, type);
    },
    onClose: () => addBtn.classList.remove('active'),
  });
  wrap.append(menu.el);

  addBtn.addEventListener('mousedown', (e) => e.preventDefault());
  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addBtn.classList.add('active');
    menu.open();
  });

  return wrap;
}

/** 最小限の HTML エスケープ (テキストノード相当。属性は使わない)。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
