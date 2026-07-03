/**
 * CodeMirror 6 Markdown ソースエディタ。
 *
 * - 正本は Markdown 文字列 1 本 (C 方式)。この Sprint はソース編集のみで、
 *   ライブプレビュー / アウトライン操作は S9ab6c3 で拡張する。
 * - IME (日本語入力) は CodeMirror 6 のネイティブ composition 対応に任せる。
 * - Mod-s (Cmd/Ctrl+S) は onSave を呼ぶ (ブラウザの保存ダイアログは抑止)。
 */
import { useEffect, useRef, type JSX } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

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
  onChange: (text: string) => void;
  onSave: () => void;
}

export function Editor({ docPath, content, resetToken, onChange, onSave }: EditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const extensionsRef = useRef<Extension[]>([]);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const suppressRef = useRef(false);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const extensions = [
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
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(mdHighlight),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressRef.current) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: host,
    });
    viewRef.current = view;
    extensionsRef.current = extensions;

    return () => {
      view.destroy();
      viewRef.current = null;
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
    mountedDocRef.current = { path: docPath, token: resetToken };
    if (prev === null) return; // 初期内容は EditorState.create で反映済み
    // setState で undo 履歴ごと差し替える: ノート切替後の Ctrl+Z で
    // 前ノートの本文が復活して誤保存される事故を防ぐ (データ安全性)。
    suppressRef.current = true;
    view.setState(EditorState.create({ doc: content, extensions: extensionsRef.current }));
    suppressRef.current = false;
    view.focus();
  }, [docPath, content, resetToken]);

  return <div className="editor-host" data-testid="editor" ref={hostRef} />;
}
