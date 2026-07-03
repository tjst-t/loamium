/**
 * ファイルツリー (左ペイン)。data-testid は prototype/TESTIDS.md の契約に従う:
 * tree-folder / tree-item + data-path で個体を特定する。
 */
import type { JSX, MouseEvent } from 'react';
import type { TreeNode } from '../tree.js';
import { ChevronDownIcon, FileIcon } from '../icons.js';

export interface FileTreeProps {
  nodes: TreeNode[];
  activePath: string | null;
  collapsed: ReadonlySet<string>;
  error: string | null;
  loaded: boolean;
  onToggleFolder: (path: string) => void;
  onOpenNote: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string, isFolder: boolean) => void;
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
  const { nodes, activePath, collapsed, onToggleFolder, onOpenNote, onContextMenu } = props;
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
              onContextMenu={(e) => onContextMenu(e, node.path, true)}
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
        ) : (
          <button
            key={`f:${node.path}`}
            className={node.path === activePath ? 'tree-item active' : 'tree-item'}
            data-testid="tree-item"
            data-path={node.path}
            onClick={() => onOpenNote(node.path)}
            onContextMenu={(e) => onContextMenu(e, node.path, false)}
          >
            <FileIcon className="file-ico" />
            <span className="name">{node.name}</span>
          </button>
        ),
      )}
    </>
  );
}
