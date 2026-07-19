/**
 * ツリー項目の右クリックメニュー (tree-rename.html プロトタイプ準拠)。
 * フォルダ対象のときは「このフォルダに新規ノート/新規フォルダ」を表示する
 * (S79c210-1 ネスト作成)。ノート対象のときは開く/リネーム/削除も表示する。
 * 画面下端・右端の項目ではメニューがビューポート外にはみ出さないよう位置を
 * 補正する (ノート数が増えるとツリー下部の項目で操作不能になるバグの修正)。
 */
import { useLayoutEffect, useRef, type JSX } from 'react';
import { FileIcon, FolderIcon, NewFolderIcon, PencilIcon, PlusIcon, TrashIcon } from '../icons.js';

export interface ContextMenuProps {
  x: number;
  y: number;
  path: string;
  isFolder: boolean;
  onOpen: () => void;
  onNewNote: () => void;
  /** フォルダ対象時のみ: このフォルダに新規フォルダを作る (S79c210-1) */
  onNewFolder?: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** 移動ダイアログを開く (S2e8a4c-7) */
  onMove?: () => void;
  onClose: () => void;
}

export function ContextMenu(props: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 描画後に実寸で位置を補正 (ちらつき防止のため paint 前に実行する)
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (el === null) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;
    el.style.left = `${String(Math.max(margin, Math.min(props.x, maxLeft)))}px`;
    el.style.top = `${String(Math.max(margin, Math.min(props.y, maxTop)))}px`;
  }, [props.x, props.y]);
  return (
    <>
      {/* 透明バックドロップ: メニュー外クリックで閉じる */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 49 }}
        onClick={props.onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onClose();
        }}
      />
      <div
        ref={menuRef}
        className="context-menu"
        data-testid="tree-context-menu"
        style={{ top: props.y, left: props.x }}
      >
        {!props.isFolder && (
          <button className="menu-item" data-testid="context-open" onClick={props.onOpen}>
            <FileIcon />
            開く
          </button>
        )}
        <button className="menu-item" data-testid="context-new-note" onClick={props.onNewNote}>
          <PlusIcon />
          {props.isFolder ? 'このフォルダに新規ノート' : '同じフォルダに新規ノート'}
        </button>
        {props.isFolder && props.onNewFolder !== undefined && (
          <button className="menu-item" data-testid="context-new-folder" onClick={props.onNewFolder}>
            <NewFolderIcon />
            このフォルダに新規フォルダ
          </button>
        )}
        {!props.isFolder && (
          <>
            <div className="menu-sep" />
            <button className="menu-item" data-testid="context-rename" onClick={props.onRename}>
              <PencilIcon />
              リネーム… <span className="shortcut">F2</span>
            </button>
            <div className="menu-sep" />
            <button className="menu-item danger" data-testid="context-delete" onClick={props.onDelete}>
              <TrashIcon />
              削除…
            </button>
          </>
        )}
        {props.onMove !== undefined && (
          <>
            <div className="menu-sep" />
            <button className="menu-item" data-testid="context-move" onClick={props.onMove}>
              <FolderIcon />
              移動…
            </button>
          </>
        )}
      </div>
    </>
  );
}
