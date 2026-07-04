/**
 * 添付ファイルのプレビューペイン (Sf53ad6-2: ツリーの tree-file クリックで表示)。
 *
 * 描画は ![[file]] 埋め込みと同じ拡張子ディスパッチ (renderers/embed.ts) を
 * 再利用する — 画像 / PDF / テキスト / ファイルカードの見た目・testid
 * (embed-image / file-embed) はエディタ内プレビューと同一になる。
 */
import { useEffect, useRef, type JSX } from 'react';
import type { FileMeta } from '@loamium/shared';
import { renderFileEmbedFor } from '../renderers/embed.js';

export interface FilePreviewProps {
  /** vault 相対のファイルパス */
  path: string;
  /** 添付一覧 (サイズ表示・存在判定)。null = 未ロード */
  files: FileMeta[] | null;
}

export function FilePreview({ path, files }: FilePreviewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const el = renderFileEmbedFor(path, {
      notePath: path,
      env: {
        getNotePaths: () => null,
        openNote: () => {},
        getFiles: () => filesRef.current,
      },
    });
    host.replaceChildren(el);
  }, [path, files]);

  return <div className="file-preview-pane" data-testid="file-preview-pane" ref={hostRef} />;
}
