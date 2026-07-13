/**
 * CommandEditor — スマートコマンド定義の専用スプリットエディタ (S9e64e7-1)。
 *
 * レイアウト: 左ペイン (YAML/Markdown ソース CodeMirror) + 右ペイン (スキャフォールド)。
 * Story -2 で右ペインにリッチプレビューを追加する。本 Story では有効性ゲートのみ。
 *
 * AC-S9e64e7-1-1: commands/ + loamium-command のときのみ描画 (App.tsx 側で分岐)。
 * AC-S9e64e7-1-2: 保存ボタンは INVALID のとき aria-disabled。保存は PUT /api/notes/{path}。
 * AC-S9e64e7-1-3: testid は gui-spec / prototype V3 に準拠。
 *
 * prototype/command-editor.html V3 の split + validate バナー レイアウトを移植。
 * CSS は styles.css に追加済み (.cmd-editor-split など)。
 * Known past failure: inline SVG を `:where(svg)` ガード無しで使うと巨大化する。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { parseNote, parseLoamiumCommandWithError } from '@loamium/shared';
import { api } from '../api.js';

// ---- CodeMirror 構文ハイライト (Editor.tsx と同じセット) ----
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

/** frontmatter 先頭 (ノートを開いた直後の位置) に合わせる。 */
function initialAnchor(content: string): number {
  const parsed = parseNote(content);
  if (parsed.frontmatter === null) return 0;
  return content.length - parsed.body.length;
}

/** 現在のテキストから frontmatter を取り出し parseLoamiumCommandWithError を呼ぶ。 */
function validateText(
  text: string,
): { valid: true } | { valid: false; error: string } {
  const parsed = parseNote(text);
  const result = parseLoamiumCommandWithError(parsed.frontmatter);
  if (result.ok) return { valid: true };
  return { valid: false, error: result.error };
}

export interface CommandEditorProps {
  /** 開いているノートのパス */
  docPath: string;
  /** ノートの初期テキスト (frontmatter 含む完全ソース) */
  content: string;
  /** 同一パスのまま外部内容で置き換えたいとき増やす */
  resetToken: number;
  /** mtime (競合検出用) */
  mtime: number | null;
  /** テキスト変化のコールバック (App 側の contentRef / dirtyRef を更新) */
  onChange: (text: string) => void;
  /** 保存成功のコールバック (mtime 更新 + backlinksToken 更新等) */
  onSaved: (mtime: number) => void;
  /** 保存失敗のコールバック (error メッセージ) */
  onSaveError: (msg: string) => void;
}

export function CommandEditor({
  docPath,
  content,
  resetToken,
  mtime,
  onChange,
  onSaved,
  onSaveError,
}: CommandEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSavedRef = useRef(onSaved);
  const onSaveErrorRef = useRef(onSaveError);
  const suppressRef = useRef(false);
  onChangeRef.current = onChange;
  onSavedRef.current = onSaved;
  onSaveErrorRef.current = onSaveError;

  const mtimeRef = useRef(mtime);
  mtimeRef.current = mtime;

  // 現在のエディタテキスト (リアルタイム — CodeMirror の onChange から更新)
  const textRef = useRef(content);
  // バリデーション状態
  const [validation, setValidation] = useState<
    { valid: true } | { valid: false; error: string }
  >(() => validateText(content));
  // 保存中フラグ
  const savingRef = useRef(false);
  // dirty 状態 (保存ステータス表示用)
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);

  const buildExtensions = useCallback((): Extension[] => [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          void handleSave();
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
        const text = update.state.doc.toString();
        textRef.current = text;
        dirtyRef.current = true;
        setDirty(true);
        onChangeRef.current(text);
        // リアルタイムバリデーション
        setValidation(validateText(text));
      }
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  // 初回マウント: CodeMirror インスタンス生成
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        selection: { anchor: initialAnchor(content) },
        extensions: buildExtensions(),
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // docPath / resetToken 変化時: ドキュメント差し替え
  const mountedDocRef = useRef<{ path: string; token: number } | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const prev = mountedDocRef.current;
    if (prev !== null && prev.path === docPath && prev.token === resetToken) return;
    mountedDocRef.current = { path: docPath, token: resetToken };
    if (prev === null) return; // 初期内容は EditorState.create で反映済み
    suppressRef.current = true;
    view.setState(
      EditorState.create({
        doc: content,
        selection: { anchor: initialAnchor(content) },
        extensions: buildExtensions(),
      }),
    );
    suppressRef.current = false;
    textRef.current = content;
    dirtyRef.current = false;
    setDirty(false);
    setValidation(validateText(content));
    view.focus();
  }, [docPath, content, resetToken, buildExtensions]);

  // 保存ハンドラ (PUT /api/notes/{path})
  // Invalid のとき保存しない (UI ではボタンを aria-disabled にするが、防御的にも実装する)
  const handleSave = useCallback(async (): Promise<void> => {
    const v = validateText(textRef.current);
    if (!v.valid) return;
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const base = mtimeRef.current ?? undefined;
      const res = await api.putNote(docPath, textRef.current, base);
      dirtyRef.current = false;
      setDirty(false);
      onSavedRef.current(res.mtime);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onSaveErrorRef.current(msg);
    } finally {
      savingRef.current = false;
    }
  }, [docPath]);

  // ブレッドクラム (commands / {stem})
  const stem = docPath.split('/').at(-1)?.replace(/\.md$/, '') ?? docPath;

  const isValid = validation.valid;

  return (
    <div className="cmd-editor" data-testid="command-editor">
      {/* ヘッダ: ブレッドクラム + バッジ + 保存ステータス */}
      <div className="cmd-editor-header" data-testid="command-editor-header">
        <div className="cmd-editor-breadcrumb">
          <span>commands</span>
          <span className="cmd-editor-sep">/</span>
          <span className="cmd-editor-crumb-curr">{stem}</span>
        </div>

        {/* スマートコマンドバッジ */}
        <span className="cmd-mode-badge" data-testid="cmd-mode-badge">
          {/* SVG icon — `:where(svg)` ガードで 16×16 を基底に */}
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6"/>
            <path d="M8 5v3l2 2"/>
          </svg>
          スマートコマンド定義
        </span>

        {/* 保存ステータス */}
        <div
          className="save-status"
          data-testid="save-status"
          data-state={dirty ? 'dirty' : 'saved'}
        >
          <span className="dot" />
          <span>{dirty ? '未保存' : '保存済み'}</span>
        </div>
      </div>

      {/* スプリットレイアウト */}
      <div className="cmd-editor-split">
        {/* 左ペイン: YAML/Markdown ソース CodeMirror */}
        <div className="cmd-editor-left" data-testid="cmd-edit-yaml">
          <div className="cmd-editor-pane-bar">
            <span className="cmd-editor-pane-lang">YAML/MD</span>
            <span className="cmd-editor-pane-label">{docPath} · ソース</span>
          </div>
          <div className="cmd-editor-cm-host" ref={hostRef} />
        </div>

        {/* 右ペイン: バリデーション + 保存ボタン (Story -2 でリッチプレビューへ拡張) */}
        <div className="cmd-editor-right" data-testid="cmd-edit-preview">
          {/* バリデーション結果 */}
          <div
            className={`cmd-editor-validation${isValid ? ' valid' : ' invalid'}`}
            data-testid="cmd-edit-validation"
            data-valid={isValid ? 'true' : 'false'}
          >
            {isValid ? (
              <>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M3 8l3.5 3.5L13 4"/>
                </svg>
                <span>有効な定義</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M8 4v4M8 11v1"/>
                  <circle cx="8" cy="8" r="6"/>
                </svg>
                <span>定義にエラーがあります</span>
              </>
            )}
          </div>

          {/* エラー詳細バナー (invalid のときのみ表示) */}
          {!isValid && (
            <div className="cmd-editor-error-banner" data-testid="cmd-edit-error">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M8 4v4M8 11v1"/>
                <circle cx="8" cy="8" r="6"/>
              </svg>
              <span>{(validation as { valid: false; error: string }).error}</span>
            </div>
          )}

          {/* 右ペインの本体 — Story -2 でコンテンツを追加する (今はスキャフォールドのみ) */}
          <div className="cmd-editor-preview-body">
            <p className="cmd-editor-preview-placeholder">
              ライブプレビューは Story -2 で追加されます。
            </p>
          </div>

          {/* 保存ボタン */}
          <div className="cmd-editor-actions">
            {isValid ? (
              <button
                className="btn primary"
                data-testid="cmd-edit-save"
                onClick={() => void handleSave()}
              >
                保存
              </button>
            ) : (
              <button
                className="btn primary"
                data-testid="cmd-edit-save"
                aria-disabled="true"
                title="エラーを修正してください"
                onClick={(e) => e.preventDefault()}
              >
                保存
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
