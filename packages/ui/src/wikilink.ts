/**
 * [[リンク]] 機構 (Story S6fbf45-1 — prototype/wikilink-autocomplete.html 準拠)。
 *
 * - wikilinkEnvFacet: エディタ拡張が App のノート一覧・ナビゲーション・
 *   ノート作成へアクセスするための注入点 (値は安定オブジェクト、実体は ref 読み)
 * - wikilinkAutocomplete(): CodeMirror autocompletion。[[ 入力で既存ノート名を
 *   部分一致絞り込みし、選択で [[ノート名]] を挿入する。一致ゼロ時も
 *   「新規ノートを作成してリンク」項目を出す
 * - notesUpdatedAnnotation: ノート一覧が変わったとき (作成・リネーム等) に
 *   装飾を再構築させるためのアノテーション (live-preview が監視する)
 *
 * ファイルへは記法どおりの [[...]] しか書かない (priority 1: ピュア Markdown)。
 */
import { Annotation, type EditorState, Facet } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import {
  autocompletion,
  insertCompletionText,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { preferredLinkTarget, type FileMeta, type NoteMeta } from '@loamium/shared';

/** App から注入する [[リンク]] 環境。実装はすべて ref を読む安定関数にすること。 */
export interface WikilinkEnv {
  /** 現在のノート一覧。null = 未ロード (取得失敗・起動直後) */
  getNotes: () => readonly NoteMeta[] | null;
  /** 解決済みリンクのクリック — ノートを開く */
  openNote: (path: string) => void;
  /** 壊れリンクのクリック — ノートを作成して開く */
  createAndOpenNote: (target: string) => void;
  /** オートコンプリートの「作成してリンク」— ノートを作成する (移動しない) */
  createNote: (target: string) => void;
  /**
   * 添付 (非 .md) ファイル一覧 (Sf53ad6 で追加 — additive)。null = 未ロード。
   * ![[file]] プレビューの解決・サイズ表示が使う (live-preview の RenderEnv 経由)。
   */
  getFiles?: () => readonly FileMeta[] | null;
}

export const wikilinkEnvFacet = Facet.define<WikilinkEnv, WikilinkEnv | null>({
  combine: (values) => values[0] ?? null,
});

/** ノート一覧の更新を装飾再構築に伝えるアノテーション */
export const notesUpdatedAnnotation = Annotation.define<boolean>();

/** [[target]] の data-target 値 (記法どおり + .md 補完、NFC 正規化) */
export function wikilinkTarget(raw: string): string {
  const t = raw.trim().normalize('NFC');
  return /\.[A-Za-z0-9]+$/.test(t) ? t : `${t}.md`;
}

// ---- オートコンプリート -------------------------------------------------------

interface WikilinkCompletion extends Completion {
  /** 候補ノートのパス (作成項目は target + .md) */
  notePath: string;
  /** 「新規ノートを作成してリンク」項目か */
  isCreate: boolean;
  /** 表示タイトル中の部分一致範囲 (mark ハイライト用) */
  matchRange: [number, number] | null;
}

/** カーソル直前の未クローズ [[部分入力 を検出する。 */
const OPEN_LINK_RE = /(!?)\[\[([^\[\]|#\n]*)$/;

function comparable(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

function wikilinkCompletionSource(context: CompletionContext): CompletionResult | null {
  const env = context.state.facet(wikilinkEnvFacet);
  if (env === null) return null;
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = OPEN_LINK_RE.exec(before);
  if (m === null) return null;
  const query = m[2] ?? '';
  const from = context.pos - query.length;

  const notes = env.getNotes() ?? [];
  const paths = notes.map((n) => n.path);
  const q = comparable(query.trim());
  const options: WikilinkCompletion[] = [];
  for (const note of notes) {
    let matchRange: [number, number] | null = null;
    if (q.length > 0) {
      const inTitle = comparable(note.title).indexOf(q);
      if (inTitle >= 0) {
        matchRange = [inTitle, inTitle + q.length];
      } else if (comparable(note.path).includes(q)) {
        matchRange = null; // パス側の一致はハイライトなしで候補に残す
      } else {
        continue; // 部分一致しない候補は出さない (AC-S6fbf45-1-1)
      }
    }
    const insert = preferredLinkTarget(note.path, paths);
    options.push({
      label: note.title,
      ...(note.folder === '' ? {} : { detail: `${note.folder}/` }),
      notePath: note.path,
      isCreate: false,
      matchRange,
      apply: (view, _completion, applyFrom, applyTo) => {
        view.dispatch(insertCompletionText(view.state, `${insert}]]`, applyFrom, applyTo));
      },
    });
  }
  // タイトル一致を先に、次いでパス昇順 (決定的な並び)
  options.sort((a, b) => {
    const am = a.matchRange !== null || q.length === 0 ? 0 : 1;
    const bm = b.matchRange !== null || q.length === 0 ? 0 : 1;
    if (am !== bm) return am - bm;
    return a.notePath < b.notePath ? -1 : a.notePath > b.notePath ? 1 : 0;
  });

  const trimmed = query.trim();
  if (trimmed.length > 0) {
    // 「新規ノートを作成してリンク」(prototype: wikilink-autocomplete-create)
    options.push({
      label: `新規ノート「${trimmed}」を作成してリンク`,
      notePath: wikilinkTarget(trimmed),
      isCreate: true,
      matchRange: null,
      apply: (view, _completion, applyFrom, applyTo) => {
        view.dispatch(insertCompletionText(view.state, `${trimmed}]]`, applyFrom, applyTo));
        env.createNote(trimmed);
      },
    });
  }
  if (options.length === 0) return null;

  return {
    from,
    options,
    // 絞り込みは上の部分一致で自前実装済み (CodeMirror の fuzzy 並べ替えは使わない)。
    // validFor は指定しない: filter:false の結果を再利用させず、
    // 1 打鍵ごとにソースを再実行して候補を絞り込む (個人 vault 規模で十分軽い)
    filter: false,
  };
}

/** 候補 1 件分の表示 DOM (prototype の .autocomplete-option 構造 + testid 契約)。 */
function renderOption(completion: Completion): Node {
  const c = completion as WikilinkCompletion;
  const span = document.createElement('span');
  span.className = c.isCreate ? 'wl-option create-new' : 'wl-option';
  span.setAttribute(
    'data-testid',
    c.isCreate ? 'wikilink-autocomplete-create' : 'wikilink-autocomplete-option',
  );
  span.setAttribute('data-note', c.notePath);
  if (c.isCreate) {
    const plus = document.createElement('span');
    plus.className = 'plus';
    plus.textContent = '＋';
    span.append(plus, document.createTextNode(c.label));
    return span;
  }
  const name = document.createElement('span');
  name.className = 'wl-name';
  if (c.matchRange !== null) {
    const [s, e] = c.matchRange;
    name.append(document.createTextNode(c.label.slice(0, s)));
    const mark = document.createElement('mark');
    mark.textContent = c.label.slice(s, e);
    name.append(mark, document.createTextNode(c.label.slice(e)));
  } else {
    name.textContent = c.label;
  }
  span.append(name);
  if (c.detail !== undefined) {
    const path = document.createElement('span');
    path.className = 'wl-path';
    path.textContent = c.detail;
    span.append(path);
  }
  return span;
}

/**
 * ポップアップコンテナへ data-testid="wikilink-autocomplete" を付与する
 * (CodeMirror の tooltip DOM は属性注入 API を持たないため MutationObserver で追従)。
 */
const tooltipTestidPlugin = ViewPlugin.fromClass(
  class {
    private readonly observer: MutationObserver;

    constructor(view: EditorView) {
      const tag = (): void => {
        for (const el of view.dom.querySelectorAll('.cm-tooltip-autocomplete')) {
          if (!el.hasAttribute('data-testid')) el.setAttribute('data-testid', 'wikilink-autocomplete');
        }
      };
      this.observer = new MutationObserver(tag);
      this.observer.observe(view.dom, { childList: true, subtree: true });
      tag();
    }

    destroy(): void {
      this.observer.disconnect();
    }
  },
);

/** [[リンク]] オートコンプリート一式 (Editor に登録する)。 */
export function wikilinkAutocomplete() {
  return [
    autocompletion({
      override: [wikilinkCompletionSource],
      icons: false,
      // 表示はすべて renderOption が担う (既定ラベルは CSS で隠す)
      addToOptions: [{ render: renderOption, position: 50 }],
      activateOnTyping: true,
      defaultKeymap: true,
      selectOnOpen: true,
    }),
    tooltipTestidPlugin,
  ];
}

/** state から現在のノートパス一覧を引く (live-preview の解決用ヘルパー)。 */
export function notePathsOf(state: EditorState): readonly string[] | null {
  const env = state.facet(wikilinkEnvFacet);
  const notes = env?.getNotes() ?? null;
  return notes === null ? null : notes.map((n) => n.path);
}
