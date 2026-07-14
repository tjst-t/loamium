/**
 * SystemFolderSection — system/ 設定ファイルのネストしたフォルダツリー (Sa10026-9 #4/#5)。
 *
 * Sa10026-4 の表示/非表示トグル + 平坦グループ表示を廃止し (#5)、
 * 上のノートツリー (FileTree) と同じネストのフォルダ構造で常時表示する (#4):
 *   system/
 *     smart-folders/  *.yaml
 *     templates/      *.md
 *     commands/       *.yaml
 *     settings.yaml
 *
 * - ファイル一覧は GET /api/system-files (App が listSystemFiles で取得) から受け取る。
 * - フォルダは折りたたみ可能 (通常フォルダと同じ操作感)。
 * - ファイルクリックで編集エディタ (yaml / md とも) で開く (onOpenNote → App.loadNote →
 *   system-files source 経由)。
 *
 * ピュア Markdown 原則: このコンポーネントはファイルを書き換えない (表示と遷移のみ)。
 */
import type { JSX } from 'react';
import type { SystemFileMeta } from '@loamium/shared';
import { ChevronDownIcon, FileIcon, FolderIcon } from '../icons.js';

export interface SystemFolderSectionProps {
  /** system/ 配下の全ファイル (yaml + md)。null = 未ロード。 */
  systemFiles: SystemFileMeta[] | null;
  /** 現在開いているファイルのパス (active 表示) */
  activePath: string | null;
  /** 折りたたみ中のフォルダパス集合 */
  collapsed: ReadonlySet<string>;
  /** フォルダ折りたたみトグル */
  onToggleFolder: (path: string) => void;
  /** ファイルクリックで編集エディタを開くハンドラ */
  onOpenNote: (path: string) => void;
}

interface FolderNode {
  kind: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}
interface FileNode {
  kind: 'file';
  name: string;
  path: string;
}
type TreeNode = FolderNode | FileNode;

const collator = new Intl.Collator('ja');

/** system/ 配下のファイルパス一覧からネストしたツリーを組み立てる。 */
function buildSystemTree(files: SystemFileMeta[]): TreeNode[] {
  const folders = new Map<string, FolderNode>();
  const roots: TreeNode[] = [];

  const ensureFolder = (folderPath: string): FolderNode => {
    const existing = folders.get(folderPath);
    if (existing) return existing;
    const node: FolderNode = {
      kind: 'folder',
      name: folderPath.split('/').at(-1) ?? folderPath,
      path: folderPath,
      children: [],
    };
    folders.set(folderPath, node);
    const parent = folderPath.includes('/')
      ? folderPath.slice(0, folderPath.lastIndexOf('/'))
      : '';
    // system 直下 (parent === 'system') は roots へ、それ以外は親フォルダへ
    if (parent === '' || parent === 'system') {
      roots.push(node);
    } else {
      ensureFolder(parent).children.push(node);
    }
    return node;
  };

  for (const f of files) {
    const folder = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const name = f.path.split('/').at(-1) ?? f.path;
    const fileNode: FileNode = { kind: 'file', name, path: f.path };
    // system/ 直下のファイル (settings.yaml 等) は roots へ
    if (folder === '' || folder === 'system') {
      roots.push(fileNode);
    } else {
      ensureFolder(folder).children.push(fileNode);
    }
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
    [...nodes]
      .sort((a, b) => {
        if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
        return collator.compare(a.name, b.name);
      })
      .map((n) => (n.kind === 'folder' ? { ...n, children: sortNodes(n.children) } : n));

  return sortNodes(roots);
}

function SystemTreeNodes({
  nodes,
  props,
}: {
  nodes: TreeNode[];
  props: SystemFolderSectionProps;
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
              >
                <ChevronDownIcon className={isCollapsed ? 'chev closed' : 'chev'} />
                <FolderIcon className="tree-folder-ico" />
                <span className="name">{node.name}</span>
              </button>
              {!isCollapsed && (
                <div className="tree-children">
                  <SystemTreeNodes nodes={node.children} props={props} />
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            key={`f:${node.path}`}
            className={node.path === props.activePath ? 'tree-item active' : 'tree-item'}
            data-testid="tree-item"
            data-path={node.path}
            onClick={() => props.onOpenNote(node.path)}
          >
            <FileIcon className="file-ico" />
            <span className="name">{node.name}</span>
          </button>
        );
      })}
    </>
  );
}

export function SystemFolderSection(props: SystemFolderSectionProps): JSX.Element {
  const { systemFiles } = props;
  const rootCollapsed = props.collapsed.has('system');
  const tree = systemFiles === null ? [] : buildSystemTree(systemFiles);

  return (
    <div className="tree tree-system" data-testid="tree-system">
      {/* system/ ルートフォルダ (常時表示・折りたたみ可) */}
      <button
        className="tree-item"
        data-testid="tree-system-root"
        data-path="system"
        aria-expanded={!rootCollapsed}
        onClick={() => props.onToggleFolder('system')}
      >
        <ChevronDownIcon className={rootCollapsed ? 'chev closed' : 'chev'} />
        <FolderIcon className="tree-folder-ico" />
        <span className="name">
          設定 <code style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>system/</code>
        </span>
      </button>
      {!rootCollapsed && (
        <div className="tree-children">
          {systemFiles !== null && tree.length === 0 ? (
            <div className="tree-empty" data-testid="tree-system-empty">
              設定ファイルがありません。
            </div>
          ) : (
            <SystemTreeNodes nodes={tree} props={props} />
          )}
        </div>
      )}
    </div>
  );
}
