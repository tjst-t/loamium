/**
 * frontmatter のプロパティブロック描画 + WYSIWYG 編集 (S9df823-1 — Obsidian Properties 風)。
 *
 * 文書冒頭の YAML frontmatter (--- ... ---) を「キーと値の整った一覧」として表示する。
 * 正本は常に標準 YAML frontmatter のまま (表示層のみ — DESIGN_PRINCIPLES priority 1 / 4)。
 * handlers を渡すと値のその場編集・tags 等のチップ追加削除・プロパティの追加削除ができ、
 * 編集結果は @loamium/shared の serializeFrontmatterBlock で標準 YAML へ直列化して
 * handlers.commit に渡す (ブロック ID・独自記法・不可視文字を一切混入しない)。
 *
 * UX はテーブル WYSIWYG (table.ts — Sd40b63-1 / Sa629e2-1) で確立したパターンを踏襲:
 * - 値クリックで input 差し替え、commit は blur の relatedTarget 判定 (widget 内は保留)
 * - 構造変更 (チップ削除・行削除・真偽切替・プロパティ追加) は即コミット
 * - コミット後のフォーカス復元は DOM 位置ベースの CustomEvent (インスタンス非依存)
 *
 * ネスト等の複雑な値 (round-trip を保証できないもの) は読み取り専用表示にし、
 * クリックでソース編集へ誘導する (壊さないことが最優先 — AC4)。
 */
import {
  isDateLike,
  parsePropInput,
  parsePropertiesModel,
  serializeFrontmatterBlock,
  type PropEntry,
  type PropScalar,
} from '@loamium/shared';

/** 編集結果を元ドキュメントへ書き戻すためのハンドラ (エディタ側が dispatch を担う)。 */
export interface PropertiesEditHandlers {
  /**
   * 変更後の frontmatter ブロック (--- ... --- の複数行文字列) をコミットする。
   * null = 全プロパティが削除された → ブロック自体を除去する。
   */
  commit(newBlock: string | null): void;
  /**
   * コミット直後に再構築される widget でフォーカスを復元する (テーブルの
   * requestFocus と同じ経路)。現状は「プロパティ追加フォームを開き直す」のみ。
   */
  requestFocus?(target: PropsFocusTarget): void;
  /**
   * 『ソースを編集』— カーソルを frontmatter へ移して生 YAML 表示に切り替える。
   * currentBlock は編集中の値を flush した最新の直列化結果 (null は起こらない想定
   * だが、全削除直後は commit(null) 側の経路を使う)。
   */
  editSource?(currentBlock: string): void;
}

/** コミット後の widget へフォーカス復元を配送する CustomEvent 名。detail: PropsFocusTarget */
export const PROPS_FOCUS_EVENT = 'loamium:props-focus';

/** フォーカス復元先。 */
export type PropsFocusTarget = { kind: 'add' } | { kind: 'chip'; key: string };

// ---- SVG アイコン ------------------------------------------------------------

const ICON_TIMES =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>';
const ICON_CODE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/></svg>';
/** 型アイコン (キー左)。Obsidian Properties と同様の控えめなヒント。 */
const TYPE_ICONS: Record<string, string> = {
  text: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4h10M5.5 4v8M10.5 4v8" transform="translate(0 0)"/><path d="M4 12h3M9 12h3"/></svg>',
  number:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6 2 5 14M11 2l-1 12M3 6h11M2 10h11"/></svg>',
  boolean:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="12" height="6" rx="3"/><circle cx="11" cy="8" r="1.6"/></svg>',
  date: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 2v2.5M11 2v2.5"/></svg>',
  list: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6 4h8M6 8h8M6 12h8"/><circle cx="3" cy="4" r="0.9" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="0.9" fill="currentColor" stroke="none"/></svg>',
  complex:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H5a2 2 0 0 0-2 2v1.5A1.5 1.5 0 0 1 1.5 8 1.5 1.5 0 0 1 3 9.5V11a2 2 0 0 0 2 2h1M10 3h1a2 2 0 0 1 2 2v1.5A1.5 1.5 0 0 0 14.5 8 1.5 1.5 0 0 0 13 9.5V11a2 2 0 0 1-2 2h-1"/></svg>',
};

/** スカラー値の素朴な型名 (表示・アイコン用)。 */
function scalarTypeOf(value: PropScalar): string {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (isDateLike(value)) return 'date';
  return 'text';
}

/** スカラー値の表示テキスト (null は空)。 */
function scalarText(value: PropScalar): string {
  return value === null ? '' : String(value);
}

/** complex エントリの値プレビュー (1 行目の値部分 + 続きがあれば省略記号)。 */
function complexPreview(source: string[]): string {
  const first = source[0] ?? '';
  const idx = first.indexOf(':');
  const head = idx >= 0 ? first.slice(idx + 1).trim() : '';
  const multi = source.length > 1;
  if (head === '') return multi ? '…' : '';
  return multi ? `${head} …` : head;
}

/**
 * frontmatter のソース行配列 (--- 区切りを含む) をプロパティブロック要素へ描画する。
 * handlers を渡すと編集が有効になる (エディタ内)。省略時は読み取り専用。
 * モデル化できない frontmatter (壊れた YAML 等) は呼び出し側で widget 化しない
 * こと (parsePropertiesModel で事前判定する)。ここでは Error を投げる。
 */
export function renderProperties(lines: string[], handlers?: PropertiesEditHandlers): HTMLElement {
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

  const wrap = document.createElement('div');
  wrap.className = editable ? 'md-props-wrap editable' : 'md-props-wrap';
  wrap.setAttribute('data-testid', 'properties-widget');
  if (editable) wrap.setAttribute('data-editable', 'true');

  // ---- コミット基盤 (table.ts と同じ: flush → 直列化 → 変化時のみ dispatch) ----

  const serializeBlock = (): string | null => serializeFrontmatterBlock(entries);
  let lastCommitted = serializeBlock() ?? '';
  /** 編集中 input / チップ入力 / 追加フォームの未確定値をモデルへ反映する。 */
  let flushValue: (() => void) | null = null;
  const chipFlushes = new Set<() => void>();
  let flushAdd: (() => void) | null = null;
  const flushAll = (): void => {
    if (flushValue !== null) flushValue();
    for (const f of Array.from(chipFlushes)) f();
    if (flushAdd !== null) flushAdd();
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

  // ---- ヘッダ (ラベル + ソースを編集) -----------------------------------------

  const head = document.createElement('div');
  head.className = 'md-props-head';
  const label = document.createElement('span');
  label.className = 'md-props-label';
  label.textContent = 'プロパティ';
  head.append(label);

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

  const rows = document.createElement('div');
  rows.className = 'md-props-rows';
  wrap.append(rows);

  /** 複雑値の行クリック → ソース編集へ誘導 (編集はソースで行う — AC4)。 */
  const gotoSource = (): void => {
    if (handlers?.editSource === undefined) return;
    flushAll();
    const s = serializeBlock();
    if (s !== null) handlers.editSource(s);
  };

  // ---- スカラー値の input 差し替え編集 (table.ts の beginEdit と同型) ----------

  function beginScalarEdit(body: HTMLElement, ref: { entry: PropEntry }): void {
    if (!editable) return;
    if (body.dataset.editing === '1') return;
    const cur = ref.entry;
    if (cur.kind !== 'scalar') return;
    body.dataset.editing = '1';
    const cell = body.parentElement;
    if (cell === null) return;
    const input = document.createElement('input');
    input.type = isDateLike(cur.value) ? 'date' : 'text';
    input.className = 'md-prop-input';
    input.setAttribute('data-testid', 'properties-value-input');
    input.setAttribute('data-key', cur.key);
    input.value = scalarText(cur.value);
    body.style.display = 'none';
    cell.insertBefore(input, body);
    input.focus();
    if (input.type === 'text') {
      const len = input.value.length;
      try {
        input.setSelectionRange(len, len);
      } catch {
        // input 種別によっては失敗しうる。キャレット位置は無視して継続。
      }
    }
    const initialText = input.value;
    const apply = (): void => {
      const prev = ref.entry;
      if (prev.kind !== 'scalar') return;
      // テキストが実際に変わったときだけ再解釈する。無変更の blur で素朴な型解釈を
      // 通すと、引用符付き文字列 ("5" / "true") が数値/真偽へ化けてしまうため。
      if (input.value === initialText) return;
      const next = parsePropInput(input.value);
      const updated: PropEntry = { kind: 'scalar', key: prev.key, value: next };
      replaceEntry(prev, updated);
      ref.entry = updated;
    };
    flushValue = apply;

    // フォーカス中 input の removeChild は blur を同期再入させる (table.ts 参照)。
    // 先に editing フラグを畳み、再入した finish/cancel を no-op にする。
    const finish = (): void => {
      if (body.dataset.editing !== '1') return;
      body.dataset.editing = '';
      apply();
      flushValue = null;
      if (input.parentElement !== null) input.parentElement.removeChild(input);
      body.style.display = '';
      const e = ref.entry;
      if (e.kind === 'scalar') {
        body.textContent = scalarText(e.value);
        body.setAttribute('data-type', scalarTypeOf(e.value));
      }
    };
    const cancel = (): void => {
      if (body.dataset.editing !== '1') return;
      body.dataset.editing = '';
      flushValue = null;
      if (input.parentElement !== null) input.parentElement.removeChild(input);
      body.style.display = '';
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
    // beforeinput / input は CodeMirror の DOM 監視へ伝播させない (誤同期防止)
    input.addEventListener('beforeinput', (e) => e.stopPropagation());
    input.addEventListener('input', (e) => e.stopPropagation());
    input.addEventListener('blur', (e) => {
      const rt = e.relatedTarget;
      const stayingInWidget = rt instanceof Node && wrap.contains(rt);
      finish();
      if (!stayingInWidget) commitFinal();
    });
  }

  // ---- 行の描画 ---------------------------------------------------------------

  function makeValueCell(ref: { entry: PropEntry }): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'md-prop-value';
    cell.setAttribute('data-testid', 'properties-value');
    const entry = ref.entry;

    if (entry.kind === 'scalar' && typeof entry.value === 'boolean') {
      // 真偽値はチェックボックスで直接切替 (即コミット)
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'md-prop-bool';
      cb.setAttribute('data-testid', 'properties-bool');
      cb.setAttribute('data-key', entry.key);
      cb.checked = entry.value;
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
      return cell;
    }

    if (entry.kind === 'scalar') {
      const body = document.createElement('span');
      body.className = 'md-prop-value-body';
      body.setAttribute('data-testid', 'properties-value-body');
      body.setAttribute('data-type', scalarTypeOf(entry.value));
      body.textContent = scalarText(entry.value);
      cell.append(body);
      if (editable) {
        cell.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          const t = e.target;
          if (t instanceof Element && (t.closest('button') !== null || t.closest('input') !== null)) return;
          e.preventDefault();
          e.stopPropagation();
          beginScalarEdit(body, ref);
        });
      }
      return cell;
    }

    if (entry.kind === 'list') {
      renderChips(cell, ref);
      return cell;
    }

    // complex: 読み取り専用 + ソース編集へ誘導 (AC4)
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
    return cell;
  }

  /**
   * list エントリのチップ列 + 追加入力を描画する。
   * チップの追加/削除は DOM を増分更新する (input を作り直すとフォーカスが落ち、
   * blur → 早期コミット → widget 再構築で連続追加が壊れるため)。
   */
  function renderChips(cell: HTMLElement, ref: { entry: PropEntry }): void {
    cell.replaceChildren();
    cell.classList.add('md-prop-chips');
    const entry = ref.entry;
    if (entry.kind !== 'list') return;

    const makeChip = (item: PropScalar): HTMLElement => {
      const chip = document.createElement('span');
      chip.className = 'md-prop-chip';
      chip.setAttribute('data-testid', 'properties-chip');
      chip.setAttribute('data-value', scalarText(item));
      const text = document.createElement('span');
      text.textContent = scalarText(item);
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
          // インデックスはクリック時点の DOM 位置から求める (追加/削除でずれないように)
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
    /** 未確定テキストをチップとしてモデルへ足す (コミットは呼ばない — 呼出側で)。 */
    const addPending = (): boolean => {
      const t = input.value.trim();
      if (t === '') return false;
      const prev = ref.entry;
      if (prev.kind !== 'list') return false;
      // チップは素朴に文字列として追加する (P-8)。クオートは直列化側が判断。
      const updated: PropEntry = { kind: 'list', key: prev.key, items: [...prev.items, t] };
      replaceEntry(prev, updated);
      ref.entry = updated;
      input.value = '';
      return true;
    };
    chipFlushes.add(addPending);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return; // IME 変換確定の Enter は取り込まない
      if (e.key === 'Enter') {
        e.preventDefault();
        // コミットはフォーカスが widget を離れるときに行う (連続追加を邪魔しない)。
        // input は作り直さず、チップだけを増分挿入する (フォーカス維持)。
        if (addPending()) {
          const prev = ref.entry;
          if (prev.kind === 'list') {
            const added = prev.items[prev.items.length - 1] ?? null;
            cell.insertBefore(makeChip(added), input);
          }
        }
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
    input.addEventListener('input', (e) => e.stopPropagation());
    input.addEventListener('blur', (e) => {
      const rt = e.relatedTarget;
      const stayingInWidget = rt instanceof Node && wrap.contains(rt);
      if (!stayingInWidget) commitFinal(); // flushAll が未確定チップを取り込む
    });
    cell.append(input);
  }

  function makeRow(entry: PropEntry): HTMLElement {
    const ref = { entry };
    const row = document.createElement('div');
    row.className = 'md-prop-row';
    row.setAttribute('data-testid', 'properties-row');
    if (entry.kind !== 'raw') row.setAttribute('data-key', entry.key);

    const keyEl = document.createElement('span');
    keyEl.className = 'md-prop-key';
    keyEl.setAttribute('data-testid', 'properties-key');
    const icon = document.createElement('span');
    icon.className = 'md-prop-type-icon';
    const type =
      entry.kind === 'list'
        ? 'list'
        : entry.kind === 'scalar'
          ? scalarTypeOf(entry.value)
          : 'complex';
    icon.innerHTML = TYPE_ICONS[type] ?? TYPE_ICONS['text'] ?? '';
    const keyText = document.createElement('span');
    keyText.textContent = entry.kind !== 'raw' ? entry.key : '';
    keyEl.append(icon, keyText);

    row.append(keyEl, makeValueCell(ref));

    if (editable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'md-prop-del';
      del.setAttribute('data-testid', 'properties-del');
      if (entry.kind !== 'raw') del.setAttribute('data-key', entry.key);
      del.title = 'プロパティを削除';
      del.innerHTML = ICON_TIMES;
      del.addEventListener('mousedown', (e) => e.preventDefault());
      del.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeEntry(ref.entry);
        structuralCommit(); // 最後の 1 件ならブロックごと除去 (commit(null))
      });
      row.append(del);
    }
    return row;
  }

  for (const entry of entries) {
    if (entry.kind === 'raw') continue; // コメント・空行は表示しない (verbatim 保持のみ)
    rows.append(makeRow(entry));
  }

  // ---- プロパティ追加 (キー + 値) ----------------------------------------------

  if (editable) {
    const addWrap = document.createElement('div');
    addWrap.className = 'md-props-add-wrap';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'md-props-add';
    addBtn.setAttribute('data-testid', 'properties-add');
    addBtn.innerHTML = `${ICON_PLUS}<span>プロパティを追加</span>`;

    const form = document.createElement('div');
    form.className = 'md-props-add-form';
    form.style.display = 'none';
    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'md-prop-input';
    keyInput.setAttribute('data-testid', 'properties-new-key');
    keyInput.placeholder = 'キー';
    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.className = 'md-prop-input';
    valInput.setAttribute('data-testid', 'properties-new-value');
    valInput.placeholder = '値';
    form.append(keyInput, valInput);
    addWrap.append(addBtn, form);
    wrap.append(addWrap);

    const closeForm = (): void => {
      flushAdd = null;
      keyInput.value = '';
      valInput.value = '';
      keyInput.classList.remove('invalid');
      form.style.display = 'none';
      addBtn.style.display = '';
    };
    /** キーが有効なら新しいスカラーエントリを追加する。true = 追加した。 */
    const applyAdd = (): boolean => {
      const key = keyInput.value.trim();
      if (key === '') return false;
      if (keyedKeys().has(key)) {
        keyInput.classList.add('invalid');
        keyInput.title = '同名のプロパティが既にあります';
        return false;
      }
      entries.push({ kind: 'scalar', key, value: parsePropInput(valInput.value) });
      keyInput.value = '';
      valInput.value = '';
      return true;
    };
    const openForm = (): void => {
      addBtn.style.display = 'none';
      form.style.display = '';
      flushAdd = () => {
        applyAdd();
      };
      keyInput.focus();
    };

    addBtn.addEventListener('mousedown', (e) => e.preventDefault());
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openForm();
    });

    const formKeydown = (e: KeyboardEvent): void => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (applyAdd()) {
          flushAdd = null;
          // コミットで widget が再構築されるため、追加フォームの再オープンを予約する
          handlers?.requestFocus?.({ kind: 'add' });
          structuralCommit();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeForm();
      }
    };
    keyInput.addEventListener('keydown', formKeydown);
    valInput.addEventListener('keydown', formKeydown);
    for (const inp of [keyInput, valInput]) {
      inp.addEventListener('beforeinput', (e) => e.stopPropagation());
      inp.addEventListener('input', (e) => e.stopPropagation());
      inp.addEventListener('blur', (e) => {
        const rt = e.relatedTarget;
        const stayingInForm = rt instanceof Node && form.contains(rt);
        if (stayingInForm) return;
        const stayingInWidget = rt instanceof Node && wrap.contains(rt);
        if (!stayingInWidget) {
          commitFinal(); // flushAdd 経由で未確定の追加を取り込む
        } else {
          closeForm();
        }
      });
    }
    keyInput.addEventListener('input', () => keyInput.classList.remove('invalid'));

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
      if (target.kind === 'add') {
        openForm();
      } else if (target.kind === 'chip' && typeof target.key === 'string') {
        const input = wrap.querySelector<HTMLInputElement>(
          `[data-testid="properties-chip-input"][data-key="${CSS.escape(target.key)}"]`,
        );
        input?.focus();
      }
    });
  }

  return wrap;
}
