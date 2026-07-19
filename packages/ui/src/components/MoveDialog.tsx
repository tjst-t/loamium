/**
 * 移動先フォルダ選択ダイアログ (S2e8a4c-7)。
 *
 * ノートまたはフォルダを別フォルダへ移動する際に使う確認ダイアログ。
 * vault 内のフォルダ一覧を <select> で表示し、ルート ('' = /ルート) も選択可能。
 */
import { useState, type JSX } from 'react';
import type { NoteMeta } from '@loamium/shared';

export interface MoveDialogProps {
  /** 移動対象の表示名 (ファイル名またはフォルダ名) */
  targetName: string;
  /** vault 内の全ノート一覧 (フォルダ候補の導出に使う) */
  notes: NoteMeta[] | null;
  /** 確定時に選択されたフォルダパスを渡す ('' = ルート) */
  onConfirm: (targetFolder: string) => void;
  onCancel: () => void;
}

/** vault 内のフォルダ候補を昇順で返す */
function deriveFolderCandidates(notes: NoteMeta[] | null): string[] {
  const set = new Set<string>();
  for (const n of notes ?? []) {
    if (n.folder === '') continue;
    const parts = n.folder.split('/');
    for (let i = 1; i <= parts.length; i++) {
      set.add(parts.slice(0, i).join('/'));
    }
  }
  return Array.from(set).sort();
}

export function MoveDialog({ targetName, notes, onConfirm, onCancel }: MoveDialogProps): JSX.Element {
  const folders = deriveFolderCandidates(notes);
  const [selected, setSelected] = useState('');

  return (
    <div className="dialog-backdrop" data-testid="move-dialog" role="dialog" aria-modal="true">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>移動</h2>
        <div className="dialog-body">
          <p style={{ marginBottom: 8 }}>
            <strong>{targetName}</strong> の移動先フォルダを選択してください。
          </p>
          <select
            className="dialog-input"
            data-testid="move-dialog-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">/ (ルート)</option>
            {folders.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>
        <div className="dialog-actions">
          <button
            className="btn"
            data-testid="move-dialog-cancel"
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            className="btn primary"
            data-testid="move-dialog-confirm"
            onClick={() => onConfirm(selected)}
          >
            移動
          </button>
        </div>
      </div>
    </div>
  );
}
