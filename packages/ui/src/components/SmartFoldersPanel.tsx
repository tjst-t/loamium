/**
 * スマートフォルダ管理 master-detail パネル (Sa100c6-2)。
 *
 * - 左ペイン: スマートフォルダ一覧 (絞り込み + ドラッグ並べ替え) + 新規ボタン
 * - 右ペイン: 選択項目を既存 SmartFolderForm で編集 + 編集可能タイトルヘッダ + フッタ
 * - 保存: PUT /api/smart-folders (CRUD + 並べ替え order 保持)
 * - read-only モードでは書込 UI disabled。
 * - agent 非公開 + 監査ログはサーバー側で保証 (Sa100c6-2 AC-2)。
 *
 * SmartFolderForm の hideActions=true + ref.current.triggerSave() でフッタボタンと連動。
 *
 * [AC-Sa100c6-2-1] [AC-Sa100c6-2-2]
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type JSX,
} from 'react';
import { api } from '../api.js';
import { SmartFolderForm, generateSmartFolderId, type SmartFolderFormHandle } from './SmartFolderForm.js';
import { SmartIcon } from './SmartIcons.js';
import type { SmartViewItem, SmartViewConfig } from '@loamium/shared';

// ---- 型 ----

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SmartFoldersPanelProps {
  mode: 'full' | 'append-only' | 'read-only';
}

/** 表示名: query → name, pin → name || path */
function displayName(item: SmartViewItem): string {
  if (item.kind === 'query') return item.name;
  return item.name ?? item.path;
}

/** サブテキスト: query → dql の先頭50文字, pin → path */
function subText(item: SmartViewItem): string {
  if (item.kind === 'query') return item.dql.slice(0, 50);
  return item.path;
}

// ---- アイコン ----

function IconSearch(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M14 14l-3.5-3.5" />
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

function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M3 4.5h10M6.5 4V3h3v1M5 4.5l.5 8h5l.5-8" />
    </svg>
  );
}

function IconSmartFolder(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M2.5 5.5l1-2h3l1 1.5h5v6a1.5 1.5 0 01-1.5 1.5h-8A1.5 1.5 0 011 11z" />
    </svg>
  );
}

function IconGrip(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <circle cx="6" cy="4" r="1.3" />
      <circle cx="10" cy="4" r="1.3" />
      <circle cx="6" cy="8" r="1.3" />
      <circle cx="10" cy="8" r="1.3" />
      <circle cx="6" cy="12" r="1.3" />
      <circle cx="10" cy="12" r="1.3" />
    </svg>
  );
}

// ---- SmartFoldersPanel (main) ----

export function SmartFoldersPanel({ mode }: SmartFoldersPanelProps): JSX.Element {
  const readonly = mode === 'read-only' || mode === 'append-only';

  const [items, setItems] = useState<SmartViewItem[]>([]);
  const [version, setVersion] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');

  // 選択中
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 右ペイン: 編集中のタイトル (表示名)
  const [draftTitle, setDraftTitle] = useState('');

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  // SmartFolderForm への命令的ハンドル (フッタ保存ボタンから triggerSave を呼ぶ)
  const formRef = useRef<SmartFolderFormHandle | null>(null);

  // ドラッグ状態
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // ---- スマートフォルダ一覧のロード ----

  const loadSmartFolders = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res: SmartViewConfig = await api.listSmartFolders();
      setItems(res.items);
      setVersion(res.version);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSmartFolders();
  }, [loadSmartFolders]);

  // ---- アイテム選択 ----

  const selectItem = useCallback((item: SmartViewItem): void => {
    setSelectedId(item.id);
    setDraftTitle(displayName(item));
    setSaveStatus('idle');
    setSaveError(null);
  }, []);

  // 初期選択
  useEffect(() => {
    const first = items[0];
    if (first !== undefined && selectedId === null) {
      selectItem(first);
    }
  }, [items, selectedId, selectItem]);

  // ---- 既存 ID/名前セット (SmartFolderForm に渡す) ----
  const selectedItem = items.find((i) => i.id === selectedId) ?? null;

  const existingIds = new Set(
    items
      .filter((i) => i.id !== selectedId)
      .map((i) => i.id),
  );
  const existingNames = new Set(
    items
      .filter((i) => i.id !== selectedId)
      .map((i) => displayName(i)),
  );

  // ---- 新規作成 ----

  const createNew = useCallback(async (): Promise<void> => {
    const newName = '新しいスマートフォルダ';
    const newId = generateSmartFolderId(newName, new Set(items.map((i) => i.id)));
    const newItem: SmartViewItem = {
      kind: 'query',
      id: newId,
      name: newName,
      dql: 'LIST SORT file.mtime DESC LIMIT 10',
    };
    const newItems = [...items, newItem];
    try {
      await api.putSmartFolders({ version, items: newItems });
      setItems(newItems);
      selectItem(newItem);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [items, version, selectItem]);

  // ---- 保存 (SmartFolderForm の onSave コールバックから呼ばれる) ----
  // フッタ保存ボタン → formRef.triggerSave() → SmartFolderForm.handleSave → onSave(item)

  const handleFormSave = useCallback(async (updatedItem: SmartViewItem): Promise<void> => {
    if (selectedId === null) return;

    setSaveStatus('saving');
    setSaveError(null);

    // タイトルヘッダの draftTitle を name に反映
    let finalItem: SmartViewItem;
    const trimmedTitle = draftTitle.trim();
    if (updatedItem.kind === 'query') {
      finalItem = {
        ...updatedItem,
        name: trimmedTitle !== '' ? trimmedTitle : updatedItem.name,
      };
    } else {
      finalItem = {
        ...updatedItem,
        name: trimmedTitle !== '' ? trimmedTitle : updatedItem.name,
      };
    }

    const newItems = items.map((i) => (i.id === selectedId ? finalItem : i));

    try {
      await api.putSmartFolders({ version, items: newItems });
      setItems(newItems);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId, items, version, draftTitle]);

  // ---- キャンセル ----

  const cancel = useCallback((): void => {
    if (selectedItem !== null) {
      // SmartFolderForm は key で再マウントするためタイトルのリセットのみ
      setDraftTitle(displayName(selectedItem));
    }
    setSaveStatus('idle');
    setSaveError(null);
  }, [selectedItem]);

  // ---- 削除 ----

  const deleteItem = useCallback(async (): Promise<void> => {
    if (selectedId === null) return;
    const currentItem = items.find((i) => i.id === selectedId);
    if (currentItem === undefined) return;

    if (!window.confirm(`「${displayName(currentItem)}」を削除しますか？`)) return;

    const newItems = items.filter((i) => i.id !== selectedId);

    try {
      await api.putSmartFolders({ version, items: newItems });
      setItems(newItems);
      const firstRemaining = newItems[0];
      if (firstRemaining !== undefined) {
        selectItem(firstRemaining);
      } else {
        setSelectedId(null);
        setDraftTitle('');
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId, items, version, selectItem]);

  // ---- ドラッグ並べ替え (order 再採番: items 配列の順序が order) ----

  const handleDragStart = useCallback((e: DragEvent<HTMLButtonElement>, index: number): void => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLButtonElement>, index: number): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLButtonElement>, dropIndex: number): Promise<void> => {
    e.preventDefault();
    const fromIndex = dragIndexRef.current;
    dragIndexRef.current = null;
    setDragOverIndex(null);

    if (fromIndex === null || fromIndex === dropIndex) return;

    // 並べ替え: items 配列の順序が order を表す (API に渡す順序が永続化される)
    const reordered = [...items];
    const [moved] = reordered.splice(fromIndex, 1);
    if (moved === undefined) return;
    reordered.splice(dropIndex, 0, moved);

    setItems(reordered);

    try {
      await api.putSmartFolders({ version, items: reordered });
    } catch (err) {
      // 失敗時はリロードして元に戻す
      setSaveError(err instanceof Error ? err.message : String(err));
      await loadSmartFolders();
    }
  }, [items, version, loadSmartFolders]);

  const handleDragEnd = useCallback((): void => {
    dragIndexRef.current = null;
    setDragOverIndex(null);
  }, []);

  // ---- フィルタ ----

  const filteredItems = filterText.trim() === ''
    ? items
    : items.filter((item) => {
        const q = filterText.trim().toLowerCase();
        const nm = displayName(item).toLowerCase();
        const dql = item.kind === 'query' ? item.dql.toLowerCase() : '';
        const pt = item.kind === 'pin' ? item.path.toLowerCase() : '';
        return nm.includes(q) || dql.includes(q) || pt.includes(q);
      });

  // ---- render ----

  return (
    <section
      className="md-panel active"
      data-testid="md-panel"
      data-group="smart-folders"
    >
      {/* 左: master */}
      <div className="md-master" data-testid="md-master">
        <div className="md-master-head">
          <h2>スマートフォルダ</h2>
          <button
            type="button"
            className="md-new"
            data-testid="md-new"
            title="新規スマートフォルダ"
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
            aria-label="スマートフォルダを絞り込み"
          />
        </div>
        <div className="md-items" data-testid="md-items" data-items="smart-folders">
          {loading && (
            <div className="md-items-empty">読み込み中…</div>
          )}
          {!loading && filteredItems.length === 0 && (
            <div className="md-items-empty">スマートフォルダがありません</div>
          )}
          {filteredItems.map((item) => {
            // filteredItems 内 index を元の items 配列の index に変換 (ドラッグ用)
            const originalIndex = items.indexOf(item);
            return (
              <button
                key={item.id}
                type="button"
                className={`md-item${selectedId === item.id ? ' active' : ''}${dragOverIndex === originalIndex ? ' drag-over' : ''}`}
                data-testid="md-item"
                data-id={item.id}
                draggable={!readonly}
                onClick={() => selectItem(item)}
                onDragStart={(e) => handleDragStart(e, originalIndex)}
                onDragOver={(e) => handleDragOver(e, originalIndex)}
                onDrop={(e) => void handleDrop(e, originalIndex)}
                onDragEnd={handleDragEnd}
              >
                <span
                  className="drag"
                  aria-hidden="true"
                  style={{ color: 'var(--text-faint)', opacity: 0.6, display: 'inline-flex', width: 14 }}
                  data-testid="sf-drag-handle"
                >
                  <IconGrip />
                </span>
                <span className="ic">
                  {(item.icon !== undefined && item.icon !== '') ? (
                    <SmartIcon icon={item.icon} />
                  ) : (
                    <IconSmartFolder />
                  )}
                </span>
                <span className="txt">
                  <div className="nm">{displayName(item)}</div>
                  <div className="sb">{subText(item)}</div>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右: detail */}
      {selectedItem !== null ? (
        <div className="md-detail" data-testid="md-detail">
          {/* ヘッダ: 編集可能タイトル */}
          <div className="md-detail-header">
            <div className="detail-title-wrap">
              <input
                type="text"
                className="detail-title"
                data-testid="detail-title"
                aria-label="スマートフォルダ名"
                value={draftTitle}
                disabled={readonly}
                onChange={(e) => setDraftTitle(e.target.value)}
              />
              <div className="detail-path" data-testid="detail-path">
                {`system/smart-folders/${selectedItem.id}.yaml`}
              </div>
            </div>
            {saveStatus === 'error' && (
              <span className="md-save-error">{saveError}</span>
            )}
            {saveStatus === 'saved' && (
              <span className="md-save-ok">保存済み</span>
            )}
          </div>

          {/* 本体: 既存 SmartFolderForm を埋め込み — hideActions=true でフッタを非表示 */}
          <div className="md-detail-body" data-testid="sf-detail-body" style={{ padding: '16px 28px', overflowY: 'auto' }}>
            <SmartFolderForm
              key={selectedItem.id}
              ref={formRef}
              initial={selectedItem}
              existingIds={existingIds}
              existingNames={existingNames}
              onSave={(item) => void handleFormSave(item)}
              onCancel={cancel}
              hideActions={true}
              readonly={readonly}
            />
          </div>

          {/* フッタ */}
          <div className="md-detail-footer" data-testid="md-detail-footer">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="md-save"
              disabled={readonly || saveStatus === 'saving'}
              onClick={() => {
                formRef.current?.triggerSave();
              }}
            >
              {saveStatus === 'saving' ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="md-cancel"
              onClick={cancel}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="btn btn-ghost danger"
              data-testid="md-delete"
              style={{ marginLeft: 'auto' }}
              disabled={readonly}
              onClick={() => void deleteItem()}
            >
              <IconTrash />
              削除
            </button>
          </div>
        </div>
      ) : (
        <div className="md-detail md-detail-empty" data-testid="md-detail">
          <div className="md-empty-msg">
            {loading ? '読み込み中…' : 'スマートフォルダを選択するか、新規作成してください'}
          </div>
        </div>
      )}
    </section>
  );
}
