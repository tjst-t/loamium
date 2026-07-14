/**
 * テンプレート管理 master-detail パネル (Sa100c6-1)。
 *
 * - 左ペイン: テンプレート一覧 (絞り込み) + 新規作成ボタン
 * - 右ペイン: 選択テンプレートのタイトル編集 + 本体エディタ (CodeMirror 流用) + フッタ
 * - 保存/削除/作成は /api/system-files/{path}/source (PUT/DELETE)。
 * - read-only モードでは書込 UI が disabled。
 * - agent 非公開 + 監査ログはサーバー側で保証 (Sa100c6-1 AC-3)。
 *
 * [AC-Sa100c6-1-1] [AC-Sa100c6-1-2] [AC-Sa100c6-1-3]
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { outlineExtension } from '../outline.js';
import { api } from '../api.js';
import type { SystemFileMeta } from '@loamium/shared';

// ---- 型 ----

interface TemplateItem {
  /** ファイル stem (拡張子なし)。例: "journal" */
  id: string;
  /** vault 相対パス。例: "system/templates/journal.md" */
  path: string;
  mtime: number;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface TemplatesPanelProps {
  mode: 'full' | 'append-only' | 'read-only';
}

// ---- CodeMirror HighlightStyle (本体エディタと同様) ----

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

// ---- アイコン ----

function IconTemplate(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5 6h6M5 8.5h6M5 11h3.5" />
    </svg>
  );
}

function IconPlus(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function IconSearch(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M14 14l-3.5-3.5" />
    </svg>
  );
}

function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M3 4.5h10M6.5 4V3h3v1M5 4.5l.5 8h5l.5-8" />
    </svg>
  );
}

function IconDuplicate(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 11V4a1.5 1.5 0 011.5-1.5H11" />
    </svg>
  );
}

// ---- TemplateEditor (CodeMirror 流用) ----

interface TemplateEditorProps {
  content: string;
  onChange: (v: string) => void;
  onSave: () => void;
  disabled: boolean;
  /** content/itemId が変わったときに強制リセットするトークン */
  resetToken: number;
}

function TemplateEditor({
  content,
  onChange,
  onSave,
  disabled,
  resetToken,
}: TemplateEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const suppressRef = useRef(false);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // Compartment で editable を動的に切り替える
  const editableCompartmentRef = useRef(new Compartment());

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
          onSaveRef.current();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(mdHighlight),
    // 本体ノートエディタと同じライブ整形(見出し/タスク/箇条書きのアウトライン)を流用
    outlineExtension(),
    editableCompartmentRef.current.of(EditorView.editable.of(!disabled)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !suppressRef.current) {
        onChangeRef.current(update.state.doc.toString());
      }
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  // Mount
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: buildExtensions(),
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 初回のみ生成
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ドキュメント差し替え (アイテム切替 or リセット)
  const mountedTokenRef = useRef<number | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (mountedTokenRef.current === resetToken) return;
    mountedTokenRef.current = resetToken;
    suppressRef.current = true;
    view.setState(EditorState.create({
      doc: content,
      extensions: buildExtensions(),
    }));
    suppressRef.current = false;
  }, [resetToken, content, buildExtensions]);

  // disabled 状態の変化を Compartment で反映
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(!disabled)),
    });
  }, [disabled]);

  return (
    <div
      className="tmpl-editor-wrap editor-host"
      data-testid="template-editor"
      ref={hostRef}
    />
  );
}

// ---- TemplatesPanel (main) ----

export function TemplatesPanel({ mode }: TemplatesPanelProps): JSX.Element {
  const readonly = mode === 'read-only' || mode === 'append-only';

  const [items, setItems] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');

  // 選択中
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 右ペイン: 編集中のタイトル/本文
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [editorResetToken, setEditorResetToken] = useState(0);
  const [currentMtime, setCurrentMtime] = useState<number | undefined>(undefined);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- テンプレート一覧のロード ----

  const loadTemplates = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api.listSystemFiles();
      const tmplItems: TemplateItem[] = res.files
        .filter((f: SystemFileMeta) => f.path.startsWith('system/templates/') && f.path.endsWith('.md'))
        .sort((a: SystemFileMeta, b: SystemFileMeta) => a.path.localeCompare(b.path, 'ja'))
        .map((f: SystemFileMeta) => ({
          id: f.path.slice('system/templates/'.length, -'.md'.length),
          path: f.path,
          mtime: f.mtime,
        }));
      setItems(tmplItems);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  // ---- アイテム選択: 本文をロード ----

  const selectItem = useCallback(async (item: TemplateItem): Promise<void> => {
    setSelectedId(item.id);
    setDraftTitle(item.id);
    setSaveStatus('idle');
    setSaveError(null);
    try {
      const res = await api.getSystemFileSource(item.path);
      setDraftBody(res.content);
      setCurrentMtime(res.mtime);
    } catch {
      setDraftBody('');
      setCurrentMtime(undefined);
    }
    setEditorResetToken((t) => t + 1);
  }, []);

  // 初期選択
  useEffect(() => {
    const first = items[0];
    if (first !== undefined && selectedId === null) {
      void selectItem(first);
    }
  }, [items, selectedId, selectItem]);

  // ---- 新規作成 ----

  const createNew = useCallback(async (): Promise<void> => {
    const title = `新しいテンプレート_${Date.now().toString(36)}`;
    const path = `system/templates/${title}.md`;
    const body = `# ${title}\n\n`;
    try {
      await api.putSystemFileSource(path, body);
      await loadTemplates();
      // 新規作成したものを選択
      setSelectedId(title);
      setDraftTitle(title);
      setDraftBody(body);
      setCurrentMtime(undefined);
      setEditorResetToken((t) => t + 1);
      setSaveStatus('idle');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [loadTemplates]);

  // ---- 保存 ----

  const save = useCallback(async (): Promise<void> => {
    if (selectedId === null) return;
    const currentItem = items.find((i) => i.id === selectedId);
    if (currentItem === undefined) return;

    setSaveStatus('saving');
    setSaveError(null);

    // タイトルが変更された場合は新しいパスへ書き込み → 古いファイル削除
    const newPath = `system/templates/${draftTitle}.md`;
    const oldPath = currentItem.path;

    try {
      // 新しいパスへ本文を書き込む
      const writeRes = await api.putSystemFileSource(newPath, draftBody);
      // パスが変わった場合は旧ファイルを削除
      if (newPath !== oldPath) {
        await api.deleteSystemFile(oldPath);
      }
      setCurrentMtime(writeRes.mtime);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
      // 一覧を更新し、新しい ID で選択を維持
      await loadTemplates();
      setSelectedId(draftTitle);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId, items, draftTitle, draftBody, loadTemplates]);

  // ---- 複製 ----

  const duplicate = useCallback(async (): Promise<void> => {
    if (selectedId === null) return;
    const currentItem = items.find((i) => i.id === selectedId);
    if (currentItem === undefined) return;

    const newId = `${draftTitle}_コピー`;
    const newPath = `system/templates/${newId}.md`;
    try {
      await api.putSystemFileSource(newPath, draftBody);
      await loadTemplates();
      setSelectedId(newId);
      setDraftTitle(newId);
      setEditorResetToken((t) => t + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId, items, draftTitle, draftBody, loadTemplates]);

  // ---- 削除 ----

  const deleteTemplate = useCallback(async (): Promise<void> => {
    if (selectedId === null) return;
    const currentItem = items.find((i) => i.id === selectedId);
    if (currentItem === undefined) return;

    if (!window.confirm(`「${selectedId}」を削除しますか？`)) return;

    try {
      await api.deleteSystemFile(currentItem.path);
      const newItems = items.filter((i) => i.id !== selectedId);
      setItems(newItems);
      const firstRemaining = newItems[0];
      if (firstRemaining !== undefined) {
        void selectItem(firstRemaining);
      } else {
        setSelectedId(null);
        setDraftTitle('');
        setDraftBody('');
        setEditorResetToken((t) => t + 1);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId, items, selectItem]);

  // ---- キャンセル: 元の本文をリロード ----

  const cancel = useCallback(async (): Promise<void> => {
    if (selectedId === null) return;
    const currentItem = items.find((i) => i.id === selectedId);
    if (currentItem === undefined) return;
    setDraftTitle(currentItem.id);
    try {
      const res = await api.getSystemFileSource(currentItem.path);
      setDraftBody(res.content);
      setCurrentMtime(res.mtime);
    } catch {
      setDraftBody('');
    }
    setEditorResetToken((t) => t + 1);
    setSaveStatus('idle');
    setSaveError(null);
  }, [selectedId, items]);

  // ---- フィルタ ----

  const filteredItems = filterText.trim() === ''
    ? items
    : items.filter((item) =>
        item.id.toLowerCase().includes(filterText.trim().toLowerCase()),
      );

  // ---- 選択中アイテム情報 ----
  const selectedItem = items.find((i) => i.id === selectedId) ?? null;

  // ---- render ----

  return (
    <section
      className="md-panel active"
      data-testid="md-panel"
      data-group="templates"
    >
      {/* 左: master */}
      <div className="md-master" data-testid="md-master">
        <div className="md-master-head">
          <h2>テンプレート</h2>
          <button
            type="button"
            className="md-new"
            data-testid="md-new"
            title="新規テンプレート"
            disabled={readonly}
            onClick={() => void createNew()}
          >
            <IconPlus />
          </button>
        </div>
        <div className="md-filter" data-testid="md-filter">
          <IconSearch />
          <input
            type="text"
            placeholder="絞り込み"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            data-testid="md-filter-input"
            aria-label="テンプレートを絞り込み"
          />
        </div>
        <div className="md-items" data-testid="md-items" data-items="templates">
          {loading && (
            <div className="md-items-empty">読み込み中…</div>
          )}
          {!loading && filteredItems.length === 0 && (
            <div className="md-items-empty">テンプレートがありません</div>
          )}
          {filteredItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`md-item${selectedId === item.id ? ' active' : ''}`}
              data-testid="md-item"
              data-id={item.id}
              onClick={() => void selectItem(item)}
            >
              <span className="ic">
                <IconTemplate />
              </span>
              <span className="txt">
                <div className="nm">{item.id}</div>
                <div className="sb mono">{item.path.split('/').pop()}</div>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 右: detail */}
      {selectedItem !== null ? (
        <div className="md-detail" data-testid="md-detail">
          {/* ヘッダ: 編集可能タイトル + パス */}
          <div className="md-detail-header">
            <div className="detail-title-wrap">
              <input
                type="text"
                className="detail-title"
                data-testid="detail-title"
                aria-label="テンプレート名"
                value={draftTitle}
                disabled={readonly}
                onChange={(e) => setDraftTitle(e.target.value)}
              />
              <div className="detail-path" data-testid="detail-path">
                {`system/templates/${draftTitle}.md`}
              </div>
            </div>
            {saveStatus === 'error' && (
              <span className="md-save-error">{saveError}</span>
            )}
            {saveStatus === 'saved' && (
              <span className="md-save-ok">保存済み</span>
            )}
          </div>

          {/* 本体: CodeMirror エディタ */}
          <div className="md-detail-body">
            <TemplateEditor
              content={draftBody}
              onChange={setDraftBody}
              onSave={() => void save()}
              disabled={readonly}
              resetToken={editorResetToken}
            />
          </div>

          {/* フッタ */}
          <div className="md-detail-footer" data-testid="md-detail-footer">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="md-save"
              disabled={readonly || saveStatus === 'saving'}
              onClick={() => void save()}
            >
              {saveStatus === 'saving' ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="md-cancel"
              onClick={() => void cancel()}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="md-duplicate"
              disabled={readonly}
              onClick={() => void duplicate()}
            >
              <IconDuplicate />
              複製
            </button>
            <button
              type="button"
              className="btn btn-ghost danger"
              data-testid="md-delete"
              style={{ marginLeft: 'auto' }}
              disabled={readonly}
              onClick={() => void deleteTemplate()}
            >
              <IconTrash />
              削除
            </button>
          </div>
        </div>
      ) : (
        <div className="md-detail md-detail-empty" data-testid="md-detail">
          <div className="md-empty-msg">
            {loading ? '読み込み中…' : 'テンプレートを選択するか、新規作成してください'}
          </div>
        </div>
      )}
    </section>
  );
}
