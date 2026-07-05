/**
 * サイドバーのノート フォルダツリー (S79c210-1 — Sf1a90a-3 の直近フラット一覧を置換)。
 *
 * ノート (.md) のみをフォルダ階層 (展開/折りたたみ) で表示する。非ノートの asset
 * (画像・PDF 等) はツリーに載せず /files ページへ集約する (AC-S79c210-1-2) ため、
 * buildTree には notes だけを渡す (attachments は空)。空フォルダ (フォルダ内フォルダの
 * 新規作成) は vault にファイルを書かずに UI 状態 extraFolders として合成する
 * (ピュア Markdown 正本を汚さない — DESIGN_PRINCIPLES priority 1)。
 *
 * ルーティング (/n/{path}・戻る/進む) は onOpenNote 経由で既存のまま維持する。
 */
import type { JSX, MouseEvent } from 'react';
import type { NoteMeta } from '@loamium/shared';
import { buildTree, type TreeNode } from '../tree.js';
import { ChevronDownIcon, FileIcon } from '../icons.js';

export interface FileTreeProps {
  /** ノート一覧 (null = 未ロード)。asset はここに含めない */
  notes: NoteMeta[] | null;
  /** UI 状態としてのみ存在する空フォルダ (新規作成された未実体フォルダ) */
  extraFolders: string[];
  /** 現在開いているノートのパス (active 表示) */
  activePath: string | null;
  /** 折りたたみ中のフォルダパス集合 (既定は全展開) */
  collapsed: ReadonlySet<string>;
  error: string | null;
  onToggleFolder: (path: string) => void;
  onOpenNote: (path: string) => void;
  onContextMenuNote: (e: MouseEvent, path: string) => void;
  onContextMenuFolder: (e: MouseEvent, path: string) => void;
}

function TreeNodes({
  nodes,
  props,
}: {
  nodes: TreeNode[];
  props: FileTreeProps;
}): JSX.Element {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'folder') {
          const isCollapsed = props.collapsed.has(node.path);
          return (
            <div key={`d:${node.path}`}>
              <button
                className="tree-item"
                data-testid="tree-folder"
                data-path={node.path}
                aria-expanded={!isCollapsed}
                onClick={() => props.onToggleFolder(node.path)}
                onContextMenu={(e) => props.onContextMenuFolder(e, node.path)}
              >
                <ChevronDownIcon className={isCollapsed ? 'chev closed' : 'chev'} />
                <span className="name">{node.name}</span>
              </button>
              {!isCollapsed && (
                <div className="tree-children">
                  <TreeNodes nodes={node.children} props={props} />
                </div>
              )}
            </div>
          );
        }
        // node.kind === 'file' (ノート)。asset (attachment) は buildTree に渡していない
        return (
          <button
            key={`f:${node.path}`}
            className={node.path === props.activePath ? 'tree-item active' : 'tree-item'}
            data-testid="tree-item"
            data-path={node.path}
            onClick={() => props.onOpenNote(node.path)}
            onContextMenu={(e) => props.onContextMenuNote(e, node.path)}
          >
            <FileIcon className="file-ico" />
            <span className="name">{node.name}</span>
          </button>
        );
      })}
    </>
  );
}

export function FileTree(props: FileTreeProps): JSX.Element {
  const { notes, extraFolders, error } = props;
  // asset を除くため files 引数は空。ノートのフォルダ階層のみを組み立てる。
  const nodes = notes === null ? [] : buildTree(notes, [], extraFolders);
  return (
    <div className="tree" data-testid="file-tree">
      {error !== null ? (
        <div className="tree-error" data-testid="tree-error">
          ノート一覧を読み込めませんでした。
          <br />
          {error}
        </div>
      ) : notes !== null && nodes.length === 0 ? (
        <div className="tree-empty" data-testid="tree-empty">
          まだノートがありません。
          <br />
          vault に .md ファイルを置くか、上の＋から作成できます。
        </div>
      ) : (
        <TreeNodes nodes={nodes} props={props} />
      )}
    </div>
  );
}
