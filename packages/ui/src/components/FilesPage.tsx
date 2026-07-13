/**
 * ファイル/フォルダブラウザページ (/files ルート — Seac77a-1)。
 *
 * vault 全体を見渡す受け皿。Sf1a90a でサイドバーが直近 N 件に絞られた分の
 * 「フォルダ横断閲覧」をここが担う (サイドバー「すべて表示」の遷移先)。
 *
 * レイアウト (ビジュアルの正: prototype/files-page.html):
 *   [フォルダツリー] | [ファイル一覧テーブル files-list] | [プレビューペイン files-preview-pane]
 * - ツリー: buildTree 由来のフォルダのみ。クリックで表をそのサブツリーへスコープ (AC-1-1)。
 * - 表: ノート(.md)と添付を name/種別/size/mtime 付きで一覧、名前で絞り込み (AC-1-1)。
 *   ノート行クリック→エディタで開く、添付行クリック→プレビューペイン (AC-1-2)。
 * - パスコピー: ノート=[[path]]、添付=![[path]] (DESIGN_PRINCIPLES ui_ux)。
 * - 削除: 確認ダイアログ(App の delete-dialog を共用)経由、サーバーが監査ログ記録 (AC-1-2)。
 *
 * 正本は常にピュア Markdown — このページは content を書き換えない。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from 'react';
import type { FileMeta, NoteMeta } from '@loamium/shared';
import { buildTree, type TreeNode } from '../tree.js';
import { fileCategoryOf, formatDateTime, formatSize, kindLabelOf } from '../file-kind.js';
import { isCommandFile } from '../commandEditorUtils.js';
import { renderFileEmbedFor } from '../renderers/embed.js';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DataFileIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  ImageFileIcon,
  PdfFileIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from '../icons.js';

export interface FilesPageProps {
  /** ノート一覧 (null = 未ロード)。 */
  notes: NoteMeta[] | null;
  /** 添付一覧 (null = 未ロード)。 */
  files: FileMeta[] | null;
  /** ノートをエディタ (/n/…) で開く (履歴に積む — AC-1-3)。 */
  onOpenNote: (path: string) => void;
  /** 削除確認ダイアログを開く (App の DeleteDialog を共用。監査ログはサーバーが記録)。 */
  onRequestDelete: (path: string, kind: 'note' | 'file') => void;
  /**
   * リネームダイアログを開く (App の NameDialog を共用。![[リンク]]/[[リンク]] 追従つき)。
   * 添付のリネーム UI はサイドバー撤去 (S79c210-1) に伴いここへ集約する。
   */
  onRequestRename: (path: string, kind: 'note' | 'file') => void;
}

interface Entry {
  path: string;
  /** 表示名 (ノートは .md を除く / 添付は拡張子込み) */
  name: string;
  /** vault 相対の親フォルダ ("" = ルート直下) */
  folder: string;
  kind: 'note' | 'attachment';
  size: number;
  mtime: number;
}

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

/** buildTree の結果からフォルダ階層だけを取り出す (ノート/添付の葉は落とす)。 */
function foldersOnly(nodes: TreeNode[]): FolderNode[] {
  const out: FolderNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'folder') {
      out.push({ name: n.name, path: n.path, children: foldersOnly(n.children) });
    }
  }
  return out;
}

function basenameOf(path: string): string {
  return path.split('/').at(-1) ?? path;
}

/** 種別アイコン (prototype の fn-ico: 画像=緑 / PDF=赤 / データ=琥珀)。 */
function KindIcon({ entry }: { entry: Entry }): JSX.Element {
  if (entry.kind === 'note') {
    return (
      <span className="fn-ico">
        <FileIcon />
      </span>
    );
  }
  switch (fileCategoryOf(entry.path)) {
    case 'image':
      return (
        <span className="fn-ico ico-img">
          <ImageFileIcon />
        </span>
      );
    case 'pdf':
      return (
        <span className="fn-ico ico-pdf">
          <PdfFileIcon />
        </span>
      );
    case 'text':
      return (
        <span className="fn-ico ico-data">
          <DataFileIcon />
        </span>
      );
    default:
      return (
        <span className="fn-ico">
          <FileIcon />
        </span>
      );
  }
}

export function FilesPage({
  notes,
  files,
  onOpenNote,
  onRequestDelete,
  onRequestRename,
}: FilesPageProps): JSX.Element {
  const [selectedFolder, setSelectedFolder] = useState('');
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const filesRef = useRef(files);
  filesRef.current = files;
  const previewBodyRef = useRef<HTMLDivElement | null>(null);

  const loaded = notes !== null || files !== null;

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const n of notes ?? []) {
      out.push({
        path: n.path,
        name: basenameOf(n.path).replace(/\.md$/i, ''),
        folder: n.folder,
        kind: 'note',
        size: n.size ?? 0,
        mtime: n.mtime ?? 0,
      });
    }
    for (const f of files ?? []) {
      out.push({
        path: f.path,
        name: basenameOf(f.path),
        folder: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
        kind: 'attachment',
        size: f.size,
        mtime: f.mtime,
      });
    }
    return out;
  }, [notes, files]);

  const folderTree = useMemo(
    () => foldersOnly(buildTree(notes ?? [], files ?? [], [])),
    [notes, files],
  );

  const inScope = useCallback(
    (folder: string): boolean => {
      if (selectedFolder === '') return true;
      return folder === selectedFolder || folder.startsWith(`${selectedFolder}/`);
    },
    [selectedFolder],
  );

  const visible = useMemo<Entry[]>(() => {
    const f = filter.trim().normalize('NFC').toLowerCase();
    return entries
      .filter((e) => inScope(e.folder))
      .filter(
        (e) =>
          f === '' ||
          e.name.toLowerCase().includes(f) ||
          e.path.toLowerCase().includes(f),
      )
      .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path, 'ja'));
  }, [entries, filter, inScope]);

  const totalSize = useMemo(() => visible.reduce((s, e) => s + e.size, 0), [visible]);

  const previewEntry = useMemo(
    () => (previewPath === null ? null : (entries.find((e) => e.path === previewPath) ?? null)),
    [entries, previewPath],
  );

  // ---- プレビュー本文 (添付の埋め込みプレビューを renderFileEmbedFor で再利用) ----
  useEffect(() => {
    const host = previewBodyRef.current;
    if (host === null || previewEntry === null) return;
    const el = renderFileEmbedFor(previewEntry.path, {
      notePath: previewEntry.path,
      env: {
        getNotePaths: () => null,
        openNote: () => {},
        getFiles: () => filesRef.current,
      },
    });
    host.replaceChildren(el);
  }, [previewEntry, files]);

  const toggleCollapse = useCallback((path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openEntry = useCallback(
    (entry: Entry): void => {
      // ノート(.md)、および commands/*.yaml スマートコマンド定義は編集エディタで開く。
      // それ以外の添付は読取プレビュー。
      if (entry.kind === 'note' || isCommandFile(entry.path)) onOpenNote(entry.path);
      else setPreviewPath(entry.path);
    },
    [onOpenNote],
  );

  const copyPath = useCallback((entry: Entry): void => {
    const text =
      entry.kind === 'note' ? `[[${entry.path.replace(/\.md$/i, '')}]]` : `![[${entry.path}]]`;
    // 実コピー (writeText) を試みつつ、成否に関わらず可観測な copied 表示を出す (decisions I5)
    try {
      void navigator.clipboard?.writeText(text).catch(() => {});
    } catch {
      // clipboard 不可環境でも UI フィードバックは出す
    }
    setCopied(entry.path);
    window.setTimeout(() => setCopied((c) => (c === entry.path ? null : c)), 2000);
  }, []);

  const renderFolders = (nodes: FolderNode[], depth: number): JSX.Element[] =>
    nodes.map((node) => {
      const expanded = !collapsed.has(node.path);
      const hasChildren = node.children.length > 0;
      return (
        <div key={node.path}>
          <button
            className={selectedFolder === node.path ? 'files-tree-item active' : 'files-tree-item'}
            data-testid="tree-folder"
            data-path={node.path}
            style={{ paddingLeft: `${String(8 + depth * 14)}px` }}
            onClick={() => setSelectedFolder(node.path)}
          >
            <span
              className="chev"
              onClick={(e: MouseEvent) => {
                if (!hasChildren) return;
                e.stopPropagation();
                toggleCollapse(node.path);
              }}
            >
              {hasChildren ? expanded ? <ChevronDownIcon /> : <ChevronRightIcon /> : null}
            </span>
            <FolderIcon className="tree-folder-ico" />
            <span className="name">{node.name}</span>
          </button>
          {hasChildren && expanded ? renderFolders(node.children, depth + 1) : null}
        </div>
      );
    });

  return (
    <div className="files-page">
      <div className="files-toolbar">
        <div className="files-filter-wrap">
          <SearchIcon className="filter-ico" />
          <input
            type="text"
            data-testid="files-filter"
            aria-label="名前で絞り込み"
            placeholder="名前で絞り込み(例: .png, projects)"
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
        </div>
        <span className="files-count" data-testid="files-count">
          {visible.length} 件のファイル · 合計 {formatSize(totalSize)}
        </span>
      </div>

      <div className="files-main">
        <div className="files-tree-col" data-testid="files-tree">
          <button
            className={selectedFolder === '' ? 'files-tree-item root active' : 'files-tree-item root'}
            data-testid="files-tree-root"
            onClick={() => setSelectedFolder('')}
          >
            <FolderIcon className="tree-folder-ico" />
            <span className="name">すべてのファイル</span>
          </button>
          {renderFolders(folderTree, 0)}
        </div>

        <div className="files-list-col">
          <table className="files-table" data-testid="files-list">
            <thead>
              <tr>
                <th>名前</th>
                <th className="col-kind">種別</th>
                <th className="col-size">サイズ</th>
                <th className="col-mtime">更新日時</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr
                  key={entry.path}
                  className={entry.path === previewPath ? 'active' : undefined}
                  data-testid="file-row"
                  data-path={entry.path}
                  data-kind={entry.kind}
                  onClick={() => openEntry(entry)}
                >
                  <td>
                    <div className="fn-cell">
                      <KindIcon entry={entry} />
                      <span className="fn-name">{entry.name}</span>
                    </div>
                  </td>
                  <td className="col-kind">{kindLabelOf(entry.path, entry.kind)}</td>
                  <td className="col-size">{formatSize(entry.size)}</td>
                  <td className="col-mtime">{formatDateTime(entry.mtime)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="row-act-btn"
                        data-testid="file-preview-btn"
                        title={entry.kind === 'note' || isCommandFile(entry.path) ? 'エディタで開く' : 'プレビュー'}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEntry(entry);
                        }}
                      >
                        <EyeIcon />
                      </button>
                      <button
                        className={copied === entry.path ? 'row-act-btn copied-flash' : 'row-act-btn'}
                        data-testid="file-copy-path"
                        title={entry.kind === 'note' ? '[[...]] 用パスをコピー' : '![[...]] 用パスをコピー'}
                        aria-label={
                          copied === entry.path ? 'パスをコピーしました' : 'パスをコピー'
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          copyPath(entry);
                        }}
                      >
                        <CopyIcon />
                      </button>
                      <button
                        className="row-act-btn"
                        data-testid="file-rename-btn"
                        title="リネーム(リンク追従)"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRequestRename(entry.path, entry.kind === 'note' ? 'note' : 'file');
                        }}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        className="row-act-btn danger"
                        data-testid="file-delete-btn"
                        title="削除"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRequestDelete(entry.path, entry.kind === 'note' ? 'note' : 'file');
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {loaded && visible.length === 0 && (
            <div className="files-empty" data-testid="files-empty">
              {entries.length === 0
                ? 'このフォルダにはまだファイルがありません。ノートを作成するか、assets/ にファイルをアップロードしてください。'
                : '絞り込み条件に一致するファイルはありません。'}
            </div>
          )}
        </div>

        {previewEntry !== null && (
          <aside className="files-preview-pane" data-testid="files-preview-pane" data-path={previewEntry.path}>
            <div className="files-preview-head">
              <KindIcon entry={previewEntry} />
              <span className="fp-name">{basenameOf(previewEntry.path)}</span>
              <button
                className="icon-btn fp-close"
                data-testid="files-preview-close"
                title="プレビューを閉じる"
                onClick={() => setPreviewPath(null)}
              >
                <CloseIcon />
              </button>
            </div>
            <div className="files-preview-body">
              <ul className="fp-meta-list">
                <li>
                  <span className="k">パス</span>
                  <span className="v">{previewEntry.path}</span>
                </li>
                <li>
                  <span className="k">サイズ</span>
                  <span className="v">
                    {formatSize(previewEntry.size)} ({previewEntry.size.toLocaleString('en-US')} B)
                  </span>
                </li>
                <li>
                  <span className="k">更新</span>
                  <span className="v">{formatDateTime(previewEntry.mtime)}</span>
                </li>
              </ul>
              <div className="fp-embed" ref={previewBodyRef} />
              <div className="file-embed-footer">
                <button
                  className={copied === previewEntry.path ? 'open-full-btn copied-flash' : 'open-full-btn'}
                  data-testid="file-copy-path"
                  onClick={() => copyPath(previewEntry)}
                >
                  <CopyIcon />
                  {copied === previewEntry.path
                    ? 'コピーしました'
                    : `![[${previewEntry.path}]] をコピー`}
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
