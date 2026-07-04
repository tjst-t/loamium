/**
 * ファイルツリー (左ペイン)。data-testid は prototype/TESTIDS.md の契約に従う:
 * tree-folder / tree-item (+ tree-file: 非 .md の添付 — Sf53ad6-2) + data-path で
 * 個体を特定する。添付はアイコン色で種別を区別 (画像=緑 / PDF=赤 / データ=琥珀)。
 */
import type { JSX, MouseEvent } from 'react';
import type { TreeNode } from '../tree.js';
import { fileCategoryOf } from '../file-kind.js';
import { ChevronDownIcon, DataFileIcon, FileIcon, ImageFileIcon, PdfFileIcon } from '../icons.js';

export interface FileTreeProps {
  nodes: TreeNode[];
  activePath: string | null;
  collapsed: ReadonlySet<string>;
  error: string | null;
  loaded: boolean;
  onToggleFolder: (path: string) => void;
  onOpenNote: (path: string) => void;
  /** 添付ファイル行のクリック — プレビューを開く (Sf53ad6-2) */
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string, kind: 'folder' | 'note' | 'attachment') => void;
}

function AttachmentIcon({ path }: { path: string }): JSX.Element {
  switch (fileCategoryOf(path)) {
    case 'image':
      return <ImageFileIcon className="file-ico ico-img" />;
    case 'pdf':
      return <PdfFileIcon className="file-ico ico-pdf" />;
    case 'text':
      return <DataFileIcon className="file-ico ico-data" />;
    default:
      return <FileIcon className="file-ico" />;
  }
}

export function FileTree(props: FileTreeProps): JSX.Element {
  const { nodes, error, loaded } = props;
  return (
    <div className="tree" data-testid="file-tree">
      {error !== null ? (
        <div className="tree-error" data-testid="tree-error">
          ノート一覧を読み込めませんでした。
          <br />
          {error}
        </div>
      ) : loaded && nodes.length === 0 ? (
        <div className="tree-empty" data-testid="tree-empty">
          まだノートがありません。
          <br />
          vault に .md ファイルを置くか、上の＋から作成できます。
        </div>
      ) : (
        <TreeLevel {...props} nodes={nodes} />
      )}
    </div>
  );
}

function TreeLevel(props: FileTreeProps): JSX.Element {
  const { nodes, activePath, collapsed, onToggleFolder, onOpenNote, onOpenFile, onContextMenu } =
    props;
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <div key={`d:${node.path}`}>
            <button
              className="tree-item"
              data-testid="tree-folder"
              data-path={node.path}
              onClick={() => onToggleFolder(node.path)}
              onContextMenu={(e) => onContextMenu(e, node.path, 'folder')}
            >
              <ChevronDownIcon className={collapsed.has(node.path) ? 'chev closed' : 'chev'} />
              <span className="name">{node.name}</span>
            </button>
            {!collapsed.has(node.path) && node.children.length > 0 && (
              <div className="tree-children">
                <TreeLevel {...props} nodes={node.children} />
              </div>
            )}
          </div>
        ) : node.kind === 'attachment' ? (
          <button
            key={`a:${node.path}`}
            className={node.path === activePath ? 'tree-item active' : 'tree-item'}
            data-testid="tree-file"
            data-path={node.path}
            onClick={() => onOpenFile(node.path)}
            onContextMenu={(e) => onContextMenu(e, node.path, 'attachment')}
          >
            <AttachmentIcon path={node.path} />
            <span className="name">{node.name}</span>
          </button>
        ) : (
          <button
            key={`f:${node.path}`}
            className={node.path === activePath ? 'tree-item active' : 'tree-item'}
            data-testid="tree-item"
            data-path={node.path}
            onClick={() => onOpenNote(node.path)}
            onContextMenu={(e) => onContextMenu(e, node.path, 'note')}
          >
            <FileIcon className="file-ico" />
            <span className="name">{node.name}</span>
          </button>
        ),
      )}
    </>
  );
}
