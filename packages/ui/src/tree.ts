/**
 * GET /api/notes のフラットな一覧からファイルツリーのモデルを組み立てる。
 * フォルダは .md ファイルのパスから導出する (空フォルダは vault に存在しないため、
 * UI 上の一時フォルダ extraFolders として合成する — decisions.json 参照)。
 */
import type { NoteMeta } from '@loamium/shared';

export interface TreeFolderNode {
  kind: 'folder';
  /** 表示名 (パスの末尾セグメント) */
  name: string;
  /** vault 相対のフォルダパス */
  path: string;
  children: TreeNode[];
}

export interface TreeFileNode {
  kind: 'file';
  /** 表示名 (.md を除いたファイル名) */
  name: string;
  /** vault 相対のノートパス */
  path: string;
}

export type TreeNode = TreeFolderNode | TreeFileNode;

function displayName(path: string): string {
  const base = path.split('/').at(-1) ?? path;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/** パス文字列の照合順 (日本語対応の locale 比較)。 */
const collator = new Intl.Collator('ja');

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

export function buildTree(notes: NoteMeta[], extraFolders: string[]): TreeNode[] {
  const folders = new Map<string, TreeFolderNode>();

  const ensureFolder = (folderPath: string): TreeFolderNode => {
    const existing = folders.get(folderPath);
    if (existing) return existing;
    const node: TreeFolderNode = {
      kind: 'folder',
      name: folderPath.split('/').at(-1) ?? folderPath,
      path: folderPath,
      children: [],
    };
    folders.set(folderPath, node);
    const parent = folderPath.includes('/')
      ? folderPath.slice(0, folderPath.lastIndexOf('/'))
      : '';
    if (parent === '') {
      roots.push(node);
    } else {
      ensureFolder(parent).children.push(node);
    }
    return node;
  };

  const roots: TreeNode[] = [];

  for (const folder of extraFolders) {
    if (folder !== '') ensureFolder(folder);
  }

  for (const note of notes) {
    const file: TreeFileNode = { kind: 'file', name: displayName(note.path), path: note.path };
    if (note.folder === '') {
      roots.push(file);
    } else {
      ensureFolder(note.folder).children.push(file);
    }
  }

  const sortDeep = (nodes: TreeNode[]): TreeNode[] =>
    sortNodes(nodes).map((n) => (n.kind === 'folder' ? { ...n, children: sortDeep(n.children) } : n));

  return sortDeep(roots);
}
