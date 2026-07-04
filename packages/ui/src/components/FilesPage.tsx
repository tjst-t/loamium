/**
 * ファイル/アセット一覧ページのプレースホルダ (/files ルート)。
 *
 * ページ本体 (フィルタ・一覧テーブル・プレビュー) は次 Sprint Seac77a で実装する。
 * 本 Sprint はルーティング (Sf1a90a-1) と「すべて表示」導線 (Sf1a90a-3) を成立させる
 * ための到達先だけを用意する。Seac77a の testid (files-list 等) はまだ名乗らない。
 */
import type { JSX } from 'react';
import { DocumentIcon } from '../icons.js';

export function FilesPage(): JSX.Element {
  return (
    <div className="empty-state" data-testid="files-page-placeholder">
      <div className="glyph">
        <DocumentIcon />
      </div>
      <h2>ファイル一覧</h2>
      <p>
        すべてのノートと添付ファイルの一覧ページは次のアップデートで利用できるようになります。
        それまでは左のサイドバーの直近ファイル、または <kbd>Ctrl</kbd>+<kbd>K</kbd> の検索から目的の
        ファイルを開いてください。
      </p>
    </div>
  );
}
