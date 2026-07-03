/**
 * ツリー項目の右クリックメニュー (tree-rename.html プロトタイプ準拠)。
 * フォルダ対象のときは「新規ノート」のみ表示する。
 */
import type { JSX } from 'react';
import { FileIcon, PencilIcon, PlusIcon, TrashIcon } from '../icons.js';

export interface ContextMenuProps {
  x: number;
  y: number;
  path: string;
  isFolder: boolean;
  onOpen: () => void;
  onNewNote: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ContextMenu(props: ContextMenuProps): JSX.Element {
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
          同じフォルダに新規ノート
        </button>
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
      </div>
    </>
  );
}
