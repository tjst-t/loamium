/**
 * 移動先フォルダ選択ダイアログ (S2e8a4c-7)。
 *
 * ノートまたはフォルダを別フォルダへ移動する際に使う確認ダイアログ。
 * フォルダ名テキスト入力 + 候補リスト (オートコンプリート) で移動先を選択する。
 * NewNoteDialog と同じ deriveFolderCandidates ロジックを再利用し、
 * ルート ('' = /ルート) も選択可能。
 *
 * testids:
 *   move-dialog / move-dialog-input (= move-dialog-select 後方互換エイリアス) /
 *   move-dialog-confirm / move-dialog-cancel / move-dialog-dropdown / move-dialog-option
 */
import { useRef, useState, type JSX } from 'react';
import type { NoteMeta } from '@loamium/shared';
import { deriveFolderCandidates } from './NewNoteDialog.js';
import { FolderIcon } from '../icons.js';

export interface MoveDialogProps {
  /** 移動対象の表示名 (ファイル名またはフォルダ名) */
  targetName: string;
  /** vault 内の全ノート一覧 (フォルダ候補の導出に使う) */
  notes: NoteMeta[] | null;
  /** 確定時に選択されたフォルダパスを渡す ('' = ルート) */
  onConfirm: (targetFolder: string) => void;
  onCancel: () => void;
}

export function MoveDialog({ targetName, notes, onConfirm, onCancel }: MoveDialogProps): JSX.Element {
  const [inputValue, setInputValue] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // '' = ルート を候補の先頭として追加し、入力文字列で絞り込む
  const folderCandidates =
    notes === null
      ? []
      : deriveFolderCandidates(notes, inputValue);

  // 確定値: 入力が空またはルートを意味するときは ''
  const selectedFolder = inputValue.trim() === '' || inputValue.trim() === '/' ? '' : inputValue.trim().replace(/\/$/, '');

  return (
    <div className="dialog-backdrop" data-testid="move-dialog" role="dialog" aria-modal="true">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>移動</h2>
        <div className="dialog-body">
          <p style={{ marginBottom: 8 }}>
            <strong>{targetName}</strong> の移動先フォルダを入力してください。
          </p>
          <div className="nn-combobox">
            <input
              type="text"
              className="nn-input"
              data-testid="move-dialog-input"
              /* 後方互換エイリアス */
              data-testid-alias="move-dialog-select"
              placeholder="フォルダ名（空白 = /ルート）"
              value={inputValue}
              autoComplete="off"
              spellCheck={false}
              onFocus={() => {
                if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
                setDropdownOpen(true);
              }}
              onBlur={() => {
                blurTimerRef.current = setTimeout(() => setDropdownOpen(false), 150);
              }}
              onChange={(e) => {
                setInputValue(e.target.value);
                setDropdownOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) onConfirm(selectedFolder);
                if (e.key === 'Escape') onCancel();
              }}
            />
            {dropdownOpen && (
              <div className="nn-dropdown" data-testid="move-dialog-dropdown">
                {/* ルート選択肢は常に表示 */}
                <button
                  key="__root__"
                  type="button"
                  className={`nn-option${selectedFolder === '' ? ' active' : ''}`}
                  data-testid="move-dialog-option"
                  data-path=""
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setInputValue('');
                    setDropdownOpen(false);
                    if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
                  }}
                >
                  <FolderIcon />
                  / (ルート)
                </button>
                {folderCandidates.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`nn-option${inputValue.replace(/\/$/, '') === f ? ' active' : ''}`}
                    data-testid="move-dialog-option"
                    data-path={f}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setInputValue(f);
                      setDropdownOpen(false);
                      if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
                    }}
                  >
                    <FolderIcon />
                    {f}/
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="nn-hint" style={{ marginTop: 6 }}>空白のままにするとルート (/) に移動します。</p>
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
            onClick={() => onConfirm(selectedFolder)}
          >
            移動
          </button>
        </div>
      </div>
    </div>
  );
}
