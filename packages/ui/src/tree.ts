/**
 * GET /api/notes のフラットな一覧からファイルツリーのモデルを組み立てる。
 * フォルダは .md ファイルのパスから導出する (空フォルダは vault に存在しないため、
 * UI 上の一時フォルダ extraFolders として合成する — decisions.json 参照)。
 */
import type { FileMeta, NoteMeta } from '@loamium/shared';

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

/** 非 .md の添付ファイル行 (Sf53ad6-2 — prototype/upload.html の tree-file)。 */
export interface TreeAttachmentNode {
  kind: 'attachment';
  /** 表示名 (拡張子込みのファイル名) */
  name: string;
  /** vault 相対のファイルパス */
  path: string;
}

export type TreeNode = TreeFolderNode | TreeFileNode | TreeAttachmentNode;

function displayName(path: string): string {
  const base = path.split('/').at(-1) ?? path;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/** パス文字列の照合順 (日本語対応の locale 比較)。 */
const collator = new Intl.Collator('ja');

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    // フォルダ先頭。ノートと添付は名前順で混在させる (Obsidian のツリーと同じ)
    if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

export function buildTree(
  notes: NoteMeta[],
  files: FileMeta[],
  extraFolders: string[],
): TreeNode[] {
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

  // 非 .md の添付ファイル (Sf53ad6-2): 拡張子込みの名前で表示する
  for (const f of files) {
    const folder = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const node: TreeAttachmentNode = {
      kind: 'attachment',
      name: f.path.split('/').at(-1) ?? f.path,
      path: f.path,
    };
    if (folder === '') {
      roots.push(node);
    } else {
      ensureFolder(folder).children.push(node);
    }
  }

  const sortDeep = (nodes: TreeNode[]): TreeNode[] =>
    sortNodes(nodes).map((n) => (n.kind === 'folder' ? { ...n, children: sortDeep(n.children) } : n));

  return sortDeep(roots);
}

/**
 * ツリー内に現れる全フォルダパス (各フォルダとその全祖先) を列挙する。
 * 「すべて折りたたむ」で collapsedFolders に一括投入するために使う (S79c210-1 の逆操作)。
 * ノートの folder と extraFolders の両方から祖先を含めて集める。
 */
export function collectFolderPaths(notes: NoteMeta[], extraFolders: string[]): string[] {
  const set = new Set<string>();
  const addWithAncestors = (folder: string): void => {
    if (folder === '') return;
    const parts = folder.split('/');
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  };
  for (const note of notes) addWithAncestors(note.folder);
  for (const folder of extraFolders) addWithAncestors(folder);
  return [...set];
}
