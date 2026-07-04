/**
 * サイドバーの直近ファイル一覧 (Sf1a90a-3 / prototype/shell-routing.html)。
 *
 * フォルダツリーではなく mtime 降順の直近 N 件フラット一覧。ノートは tree-item、
 * 非 .md の添付は tree-file (data-path で個体特定 — TESTIDS 契約に従う)。
 * 全件の閲覧は「すべて表示」(sidebar-show-all) からファイル一覧ページ (/files) へ。
 */
import type { JSX, MouseEvent } from 'react';
import { fileCategoryOf } from '../file-kind.js';
import { DataFileIcon, FileIcon, ImageFileIcon, PdfFileIcon } from '../icons.js';

export interface RecentEntry {
  path: string;
  name: string;
  kind: 'note' | 'attachment';
}

export interface RecentFilesProps {
  entries: RecentEntry[];
  activePath: string | null;
  error: string | null;
  loaded: boolean;
  onOpenNote: (path: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string, kind: 'note' | 'attachment') => void;
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

export function RecentFiles(props: RecentFilesProps): JSX.Element {
  const { entries, activePath, error, loaded, onOpenNote, onOpenFile, onContextMenu } = props;
  return (
    <div className="tree" data-testid="file-tree">
      {error !== null ? (
        <div className="tree-error" data-testid="tree-error">
          ノート一覧を読み込めませんでした。
          <br />
          {error}
        </div>
      ) : loaded && entries.length === 0 ? (
        <div className="tree-empty" data-testid="tree-empty">
          まだノートがありません。
          <br />
          vault に .md ファイルを置くか、上の＋から作成できます。
        </div>
      ) : (
        entries.map((entry) =>
          entry.kind === 'attachment' ? (
            <button
              key={`a:${entry.path}`}
              className={entry.path === activePath ? 'tree-item active' : 'tree-item'}
              data-testid="tree-file"
              data-path={entry.path}
              onClick={() => onOpenFile(entry.path)}
              onContextMenu={(e) => onContextMenu(e, entry.path, 'attachment')}
            >
              <AttachmentIcon path={entry.path} />
              <span className="name">{entry.name}</span>
            </button>
          ) : (
            <button
              key={`f:${entry.path}`}
              className={entry.path === activePath ? 'tree-item active' : 'tree-item'}
              data-testid="tree-item"
              data-path={entry.path}
              onClick={() => onOpenNote(entry.path)}
              onContextMenu={(e) => onContextMenu(e, entry.path, 'note')}
            >
              <FileIcon className="file-ico" />
              <span className="name">{entry.name}</span>
            </button>
          ),
        )
      )}
    </div>
  );
}
