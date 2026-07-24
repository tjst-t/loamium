/**
 * CodeMirror 6 Markdown ソースエディタ。
 *
 * - 正本は Markdown 文字列 1 本 (C 方式)。この Sprint はソース編集のみで、
 *   ライブプレビュー / アウトライン操作は S9ab6c3 で拡張する。
 * - IME (日本語入力) は CodeMirror 6 のネイティブ composition 対応に任せる。
 * - Mod-s (Cmd/Ctrl+S) は onSave を呼ぶ (ブラウザの保存ダイアログは抑止)。
 */
import { useEffect, useRef, type JSX } from 'react';
import { EditorState, EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { foldedRanges, unfoldEffect } from '@codemirror/language';
export type { EditorView };
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  parseNote,
  type FileMeta,
  type NoteMeta,
  type PropertyKeyCount,
  type PropertyTypeDef,
  type TagCount,
} from '@loamium/shared';
import { toggleBold } from '../bold-toggle.js';
import { outlineExtension } from '../outline.js';
import { uploadEnvFacet, uploadExtension, type UploadEnv } from '../upload.js';
import {
  livePreviewExtension,
  notePathFacet,
  persistPropertyTypeFacet,
  propertyKeysFacet,
  propertyTypesFacet,
} from '../live-preview.js';
import { slashMenuExtension } from '../slash-menu.js';
import {
  bodyTagSuggestExtension,
  tagSuggestEnvFacet,
  type TagSuggestEnv,
} from '../tag-suggest.js';
import {
  notesUpdatedAnnotation,
  wikilinkAutocomplete,
  wikilinkEnvFacet,
  type WikilinkEnv,
} from '../wikilink.js';

/**
 * ノートを開いたときの初期カーソル位置 (S9df823-1)。
 * frontmatter 付きノートで先頭 (pos 0) にカーソルを置くと frontmatter が
 * ソース表示になってしまうため、本文の先頭 (frontmatter の直後) に置く。
 */
function initialAnchor(content: string): number {
  const parsed = parseNote(content);
  if (parsed.frontmatter === null) return 0;
  return content.length - parsed.body.length;
}

// ---- エディタ位置保存 / 復元 (localStorage) ---------------------------------
/** 保存するエントリ一件 */
interface EditorPosEntry {
  top: number;
  head: number;
}
const EDITOR_POS_KEY = 'loamium.editorPos.v1';
const EDITOR_POS_MAX = 50;

function loadEditorPos(): Record<string, EditorPosEntry> {
  try {
    const raw = localStorage.getItem(EDITOR_POS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, EditorPosEntry>;
  } catch {
    return {};
  }
}

function saveEditorPos(path: string, entry: EditorPosEntry): void {
  try {
    const all = loadEditorPos();
    // 既存エントリを削除してから先頭へ追加することで LRU 順を維持する
    delete all[path];
    const keys = Object.keys(all);
    // 上限超えたら末尾(最古)を削除
    if (keys.length >= EDITOR_POS_MAX) {
      const oldest = keys[keys.length - 1];
      if (oldest !== undefined) delete all[oldest];
    }
    // 先頭に追加するため: 新しいオブジェクトにマージ
    const next: Record<string, EditorPosEntry> = { [path]: entry, ...all };
    localStorage.setItem(EDITOR_POS_KEY, JSON.stringify(next));
  } catch {
    // localStorage が使えない環境は無視
  }
}

function getEditorPos(path: string): EditorPosEntry | null {
  const all = loadEditorPos();
  return all[path] ?? null;
}
// ---------------------------------------------------------------------------

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-md-heading cm-md-h1' },
  { tag: tags.heading2, class: 'cm-md-heading cm-md-h2' },
  { tag: tags.heading3, class: 'cm-md-heading cm-md-h3' },
  { tag: tags.heading4, class: 'cm-md-heading' },
  { tag: tags.heading5, class: 'cm-md-heading' },
  { tag: tags.heading6, class: 'cm-md-heading' },
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.emphasis, class: 'cm-md-em' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: tags.link, class: 'cm-md-link' },
  { tag: tags.url, class: 'cm-md-link' },
  { tag: tags.quote, class: 'cm-md-quote' },
  { tag: tags.processingInstruction, class: 'cm-md-mark' },
  { tag: tags.meta, class: 'cm-md-mark' },
]);

export interface EditorProps {
  /** 開いているノートのパス。変化したらドキュメントを差し替える */
  docPath: string;
  /** docPath / resetToken が変わったときに反映される本文 */
  content: string;
  /** 同一パスのまま外部内容で置き換えたいとき (競合の再読込等) に増やす */
  resetToken: number;
  /**
   * 全文検索ヒット等で該当行 (1 始まり) へカーソルを移動する (Sbd061c-1)。
   * token が変わるたびに適用。行番号が本文の行数を超える場合は最終行へクランプ。
   */
  seek?: { line: number; token: number } | null;
  /** ノート一覧 (オートコンプリート候補 + 壊れリンク判定)。null = 未ロード */
  notes: NoteMeta[] | null;
  /** 添付ファイル一覧 (![[file]] プレビューの解決・サイズ表示)。null = 未ロード */
  files: FileMeta[] | null;
  /** 意味型スキーマ (.loamium/property-types.json → キー→型定義)。既定 {} (S87f4b7-2) */
  propertyTypes: Record<string, PropertyTypeDef>;
  /** vault 横断のプロパティキー候補 (件数付き — Sd13ab1-2)。null = 未ロード */
  propertyKeys: PropertyKeyCount[] | null;
  /** 新規プロパティの型を .loamium/property-types.json へ永続化する (Sd13ab1-2) */
  onPersistPropertyType: (key: string, def: PropertyTypeDef) => void;
  /** タグ一覧 (件数付き — `#` 候補補完のソース)。null = 未ロード (S45fa45) */
  tags: TagCount[] | null;
  onChange: (text: string) => void;
  onSave: () => void;
  /**
   * EditorView が生成されたときに呼ばれる (Sb6f1d3-2)。
   * App が editorViewRef に保持し、TOC クリックの unfoldEffect dispatch に使う。
   * destroy 時は null を渡す。
   */
  onViewReady?: (view: EditorView | null) => void;
  /** 解決済み [[リンク]] クリック — 対象ノートを開く */
  onOpenNote: (path: string) => void;
  /** dataview TASK 結果クリック — 対象ノートを開いて該当行へ (Sb1593c-2) */
  onOpenNoteAtLine: (path: string, line: number) => void;
  /** 壊れ [[リンク]] クリック — ノートを作成して開く */
  onCreateAndOpenNote: (target: string) => void;
  /** オートコンプリートの「作成してリンク」— ノートを作成する (移動しない) */
  onCreateNote: (target: string) => void;
  /** 本文タグのクリック — タグで絞り込んだ検索へ遷移する (S45fa45-2) */
  onOpenTag: (tag: string) => void;
  /** D&D / ペーストのアップロード実体 (Sf53ad6-2)。保存された vault パスを返す */
  onUploadFiles: (uploads: File[]) => Promise<string[]>;
  /** ファイルドラッグ中のドロップオーバーレイ表示切替 */
  onDragActive: (active: boolean) => void;
}

export function Editor({
  docPath,
  content,
  resetToken,
  seek,
  notes,
  files,
  propertyTypes,
  propertyKeys,
  onPersistPropertyType,
  tags,
  onChange,
  onSave,
  onOpenNote,
  onOpenNoteAtLine,
  onCreateAndOpenNote,
  onCreateNote,
  onOpenTag,
  onUploadFiles,
  onDragActive,
  onViewReady,
}: EditorProps): JSX.Element {
  const onViewReadyRef = useRef(onViewReady);
  onViewReadyRef.current = onViewReady;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const suppressRef = useRef(false);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  // seek の現在値を ref で保持 (位置復元スクロールとの競合回避に使う)
  const seekRef = useRef(seek);
  seekRef.current = seek;

  // [[リンク]] 環境: すべて ref 読みの安定オブジェクト (拡張の作り直し不要)
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const filesRef = useRef(files);
  filesRef.current = files;
  const propertyTypesRef = useRef(propertyTypes);
  propertyTypesRef.current = propertyTypes;
  const propertyKeysRef = useRef(propertyKeys);
  propertyKeysRef.current = propertyKeys;
  const onPersistPropertyTypeRef = useRef(onPersistPropertyType);
  onPersistPropertyTypeRef.current = onPersistPropertyType;
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  const onOpenTagRef = useRef(onOpenTag);
  onOpenTagRef.current = onOpenTag;
  const onOpenNoteRef = useRef(onOpenNote);
  const onOpenNoteAtLineRef = useRef(onOpenNoteAtLine);
  const onCreateAndOpenNoteRef = useRef(onCreateAndOpenNote);
  const onCreateNoteRef = useRef(onCreateNote);
  onOpenNoteRef.current = onOpenNote;
  onOpenNoteAtLineRef.current = onOpenNoteAtLine;
  onCreateAndOpenNoteRef.current = onCreateAndOpenNote;
  onCreateNoteRef.current = onCreateNote;
  const wikilinkEnvRef = useRef<WikilinkEnv>({
    getNotes: () => notesRef.current,
    openNote: (path) => onOpenNoteRef.current(path),
    openNoteAtLine: (path, line) => onOpenNoteAtLineRef.current(path, line),
    createAndOpenNote: (target) => onCreateAndOpenNoteRef.current(target),
    createNote: (target) => onCreateNoteRef.current(target),
    getFiles: () => filesRef.current,
  });

  // タグ補完環境 (S45fa45): 実体は App、拡張は ref 読みの安定オブジェクト
  const tagSuggestEnvRef = useRef<TagSuggestEnv>({
    getTags: () => tagsRef.current,
    openTag: (tag) => onOpenTagRef.current(tag),
  });

  // アップロード環境 (Sf53ad6-2): 実体は App、拡張は ref 読みの安定オブジェクト
  const onUploadFilesRef = useRef(onUploadFiles);
  const onDragActiveRef = useRef(onDragActive);
  onUploadFilesRef.current = onUploadFiles;
  onDragActiveRef.current = onDragActive;
  const uploadEnvRef = useRef<UploadEnv>({
    uploadFiles: (uploads) => onUploadFilesRef.current(uploads),
    setDragActive: (active) => onDragActiveRef.current(active),
  });

  // ノート/添付一覧の変化を装飾へ伝える (壊れリンク⇄解決済み・![[file]] メタの切替)
  useEffect(() => {
    viewRef.current?.dispatch({ annotations: notesUpdatedAnnotation.of(true) });
  }, [notes, files]);

  // ノートパスに依存する拡張があるため (notePathFacet)、setState での
  // ドキュメント差し替え時も同じビルダーで拡張を作り直す。
  const buildExtensionsRef = useRef((path: string): Extension[] => [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          onSaveRef.current();
          return true;
        },
      },
      {
        key: 'Mod-b',
        preventDefault: true,
        run: toggleBold,
      },
      // ESC: エディタのフォーカスを外す (どの行もアクティブでない状態にする)。
      // ライブプレビューではカーソル行だけソース表示になり、その行のタスクチェックボックスや
      // 各種インライン widget が描画されずクリックできない。ESC で blur するとアクティブ行が
      // 無くなり、全行が widget 表示に戻ってクリック (トグル) できる。
      // autocompletion の ESC (高優先度) が開いているときは先に閉じるため、このハンドラは
      // 閉じた後にのみ効く (defaultKeymap の後ろに登録)。選択があれば畳んでから blur する。
      {
        key: 'Escape',
        run: (view) => {
          const sel = view.state.selection;
          if (sel.ranges.length > 1 || sel.main.anchor !== sel.main.head) {
            view.dispatch({ selection: EditorSelection.cursor(sel.main.head) });
          }
          view.contentDOM.blur();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(mdHighlight),
    notePathFacet.of(path),
    propertyTypesFacet.of(propertyTypesRef.current),
    propertyKeysFacet.of(propertyKeysRef.current ?? []),
    persistPropertyTypeFacet.of((key, def) => onPersistPropertyTypeRef.current(key, def)),
    wikilinkEnvFacet.of(wikilinkEnvRef.current),
    tagSuggestEnvFacet.of(tagSuggestEnvRef.current),
    uploadEnvFacet.of(uploadEnvRef.current),
    uploadExtension(),
    // slashMenuExtension は wikilinkAutocomplete より前に置く: どちらも Prec.highest
    // の keymap を持ち、同一 Prec 内では登録順が早いほうが優先される。/ メニューの
    // ↑↓/Enter/Esc を補完キーマップより先に処理させるため。同様に本文タグ補完 (#) も
    // 補完キーマップより先に ↑↓/Enter/Esc を奪う (# と / は排他なので相互干渉しない)。
    slashMenuExtension(),
    bodyTagSuggestExtension(),
    wikilinkAutocomplete(),
    outlineExtension(),
    livePreviewExtension(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !suppressRef.current) {
        onChangeRef.current(update.state.doc.toString());
      }
    }),
  ]);

  // 現在開いているノート path を ref で追跡 (アンマウント時の保存に使う)
  const currentPathRef = useRef(docPath);
  currentPathRef.current = docPath;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    // 初回表示: 保存済み位置があれば復元カーソルで初期化する (seek がある場合は後 effect が上書き)
    const savedPos = getEditorPos(docPath);
    const initialSel = savedPos !== null
      ? { anchor: Math.min(savedPos.head, content.length) }
      : { anchor: initialAnchor(content) };

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        selection: initialSel,
        extensions: buildExtensionsRef.current(docPath),
      }),
      parent: host,
    });
    viewRef.current = view;

    // 保存されたスクロール位置を 1 フレーム後に反映 (レイアウト確定後)。
    // seek が指定されているときは seek effect がスクロールするため復元しない。
    if (savedPos !== null) {
      requestAnimationFrame(() => {
        if (seekRef.current == null) {
          view.scrollDOM.scrollTop = savedPos.top;
        }
      });
    }

    // テスト / デバッグ用: グローバルに EditorView と unfold ヘルパーを公開する。
    // Playwright ではブラウザプロセス内から ESM モジュールを動的 import できないため、
    // アプリ側でバインドした関数を expose して Playwright test から呼ぶ。
    const g = window as unknown as {
      __loamiumEditorView__: EditorView | null;
      __loamiumUnfoldAtCursor__: (() => boolean) | null;
    };
    g.__loamiumEditorView__ = view;
    g.__loamiumUnfoldAtCursor__ = (): boolean => {
      const s = view.state;
      const head = s.selection.main.head;
      let found: { from: number; to: number } | null = null;
      // カーソルを含む fold range を探す (from <= head <= to)
      // 見出し fold は [heading.line.to, sectionEnd] の範囲で保持される
      foldedRanges(s).between(0, s.doc.length, (from, to) => {
        if (from <= head && head <= to) { found = { from, to }; return false; }
        return undefined;
      });
      if (found !== null) {
        view.dispatch({ effects: unfoldEffect.of(found) });
        return true;
      }
      return false;
    };
    onViewReadyRef.current?.(view);

    return () => {
      // アンマウント時: 現在の位置を保存する
      saveEditorPos(currentPathRef.current, {
        top: view.scrollDOM.scrollTop,
        head: view.state.selection.main.head,
      });
      view.destroy();
      viewRef.current = null;
      const gc = window as unknown as {
        __loamiumEditorView__: EditorView | null;
        __loamiumUnfoldAtCursor__: (() => boolean) | null;
      };
      gc.__loamiumEditorView__ = null;
      gc.__loamiumUnfoldAtCursor__ = null;
      onViewReadyRef.current?.(null);
    };
    // 初回のみ生成。ドキュメント差し替えは下の effect で行う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mountedDocRef = useRef<{ path: string; token: number } | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const prev = mountedDocRef.current;
    if (prev !== null && prev.path === docPath && prev.token === resetToken) return;

    // ノートパスが変わった場合のみ位置の保存・復元を行う。
    // 同一パスで resetToken だけ変わる場合 (ブックマーク後の再取得 / 競合マージ後の強制リロード等)
    // は位置を保存せず、初期カーソル (initialAnchor) をそのまま使う。
    const isPathChange = prev !== null && prev.path !== docPath;

    // ノート切替前: 前のノートの位置を保存する (パスが変わったときのみ)
    if (isPathChange) {
      saveEditorPos(prev.path, {
        top: view.scrollDOM.scrollTop,
        head: view.state.selection.main.head,
      });
    }

    mountedDocRef.current = { path: docPath, token: resetToken };
    if (prev === null) return; // 初期内容は EditorState.create で反映済み

    // パス変更時のみ保存済み位置を復元する。同一パスの再読込は initialAnchor を使う。
    const savedPos = isPathChange ? getEditorPos(docPath) : null;
    const restoredAnchor = savedPos !== null
      ? Math.min(savedPos.head, content.length)
      : initialAnchor(content);

    // setState で undo 履歴ごと差し替える: ノート切替後の Ctrl+Z で
    // 前ノートの本文が復活して誤保存される事故を防ぐ (データ安全性)。
    suppressRef.current = true;
    view.setState(
      EditorState.create({
        doc: content,
        selection: { anchor: restoredAnchor },
        extensions: buildExtensionsRef.current(docPath),
      }),
    );
    suppressRef.current = false;
    view.focus();

    // 保存されたスクロール位置を 1 フレーム後に反映 (レイアウト確定後)。
    // seek が指定されているときは seek effect がスクロールするため復元しない。
    if (savedPos !== null) {
      requestAnimationFrame(() => {
        if (seekRef.current == null) {
          view.scrollDOM.scrollTop = savedPos.top;
        }
      });
    }
  }, [docPath, content, resetToken]);

  // 全文検索ヒットの該当行へカーソル移動 (Sbd061c-1)。上のドキュメント差し替え
  // effect より後に宣言されているため、ノート切替と同時でも新しい本文に適用される。
  const seekAppliedRef = useRef(0);
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || seek === null || seek === undefined) return;
    if (seekAppliedRef.current === seek.token) return;
    seekAppliedRef.current = seek.token;
    // インデックスとファイルがずれていても壊さない: 行番号は本文の範囲にクランプ
    const lineNo = Math.min(Math.max(1, seek.line), view.state.doc.lines);
    const pos = view.state.doc.line(lineNo).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    view.focus();
  }, [seek]);

  return <div className="editor-host" data-testid="editor" ref={hostRef} />;
}
