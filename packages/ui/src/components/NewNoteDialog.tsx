/**
 * 新規ノート作成ダイアログ — パス入力・フォルダ補完・defaultFolder prefill の統一コンポーネント。
 *
 * Sa10026-8: smart-newfile と new-note を同一ロジックに統合する。
 *   - folder/note-name 形式のパス入力 (.md は自動補完)
 *   - 既存ノートの folder から deriveFolderCandidates でドロップダウン補完
 *   - settings.yaml の defaultFolder があれば初期値に prefill
 *
 * data-testid はプロトタイプ prototype/new-note-modal.html に準拠:
 *   new-note-dialog / new-note-path / new-note-path-dropdown /
 *   new-note-path-option / new-note-cancel / new-note-confirm
 *
 * [AC-Sa10026-8-1] [AC-Sa10026-8-2] [AC-Sa10026-8-3]
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { NoteMeta } from '@loamium/shared';
import { FolderIcon } from '../icons.js';

// ---- フォルダ候補導出 (smart-newfile / new-note 共通ロジック) ----

/**
 * ノート一覧からフォルダ候補を導出する。
 * フォルダ階層を展開し、重複なし・昇順で最大 maxCount 件返す。
 * smart-newfile ダイアログと同じロジックを共有する (Sa10026-8)。
 *
 * @param notes   ノート一覧
 * @param query   現在の入力文字列 (小文字でフィルタリング)
 * @param maxCount 最大件数 (既定 15)
 */
export function deriveFolderCandidates(
  notes: NoteMeta[],
  query: string,
  maxCount = 15,
): string[] {
  const folderSet = new Set<string>();
  for (const note of notes) {
    const f = note.folder;
    if (f === '') continue;
    const parts = f.split('/');
    for (let i = 1; i <= parts.length; i++) {
      folderSet.add(parts.slice(0, i).join('/'));
    }
  }
  const q = query.toLowerCase().trim();
  return Array.from(folderSet)
    .sort()
    .filter((f) => q.length === 0 || f.toLowerCase().includes(q))
    .slice(0, maxCount);
}

// ---- コンポーネント ----

export interface NewNoteDialogProps {
  /**
   * 初期パス値 (defaultFolder prefill 済みの値を渡す)。
   * 例: "notes/" / ""
   */
  initialPath: string;
  /**
   * フォルダ補完の候補ソース (起動後に非同期で渡される)。
   * null = まだ未ロード (ドロップダウンは表示しない)。
   */
  notes: NoteMeta[] | null;
  /** defaultFolder の値 (サブテキスト表示用)。 */
  defaultFolder: string;
  /** 「作成」確定コールバック — 完全パス (例: "notes/アイデア.md") を渡す。 */
  onConfirm: (notePath: string) => void;
  /** キャンセルコールバック。 */
  onCancel: () => void;
  /**
   * ノート一覧の遅延ロードを要求するコールバック。
   * ダイアログが初めてフォーカスされたときに呼び出す。
   */
  onRequestNotes: () => void;
}

export function NewNoteDialog(props: NewNoteDialogProps): JSX.Element {
  const [pathValue, setPathValue] = useState(props.initialPath);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // 末尾にカーソルを置く (prefill があれば末尾にファイル名を追記しやすい)
    const len = inputRef.current?.value.length ?? 0;
    inputRef.current?.setSelectionRange(len, len);
  }, []);

  // フォルダ候補計算
  // pathValue が "folder/" で終わる場合はフォルダ部分のみをクエリとして使う
  // (選択済みフォルダ prefix → 全候補を表示し、"既定" マークも見せる)
  const folderQuery = pathValue.endsWith('/') ? pathValue.slice(0, -1) : pathValue;
  const folderCandidates =
    props.notes === null
      ? []
      : deriveFolderCandidates(props.notes, folderQuery);

  const confirm = (): void => {
    const trimmed = pathValue.trim();
    if (!trimmed) {
      setError('パスを入力してください');
      return;
    }
    // フォルダのみ (trailing /) は不可
    if (trimmed.endsWith('/')) {
      setError('ファイル名を入力してください (例: notes/アイデア)');
      return;
    }
    // .md を自動補完
    const notePath = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    props.onConfirm(notePath);
  };

  // サブテキスト: defaultFolder の有無で変える
  const subText =
    props.defaultFolder !== ''
      ? `パス込みで作成できます。既定フォルダ「${props.defaultFolder}/」を入れてあります(消せば任意の場所に作成)。`
      : 'パス込みで作成できます(既定フォルダ未設定)。folder/name で任意の場所に作成。';

  return (
    <div
      className="dialog-backdrop"
      data-testid="new-note-dialog"
      role="dialog"
      aria-modal="true"
      onClick={props.onCancel}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>新規ノート</h2>
        <p className="dialog-sub">{subText}</p>
        <div className="nn-combobox">
          <input
            ref={inputRef}
            type="text"
            className="nn-input"
            data-testid="new-note-path"
            placeholder="folder/note-name(.md は自動補完)"
            value={pathValue}
            autoComplete="off"
            spellCheck={false}
            onFocus={() => {
              if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
              props.onRequestNotes();
              setDropdownOpen(true);
            }}
            onBlur={() => {
              blurTimerRef.current = setTimeout(() => setDropdownOpen(false), 150);
            }}
            onChange={(e) => {
              setPathValue(e.target.value);
              setError(null);
              setDropdownOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) confirm();
              if (e.key === 'Escape') props.onCancel();
            }}
          />
          {dropdownOpen && folderCandidates.length > 0 && (
            <div className="nn-dropdown" data-testid="new-note-path-dropdown">
              <div className="nn-dd-label">既存フォルダ</div>
              {folderCandidates.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  className={`nn-option${pathValue === `${folder}/` ? ' active' : ''}`}
                  data-testid="new-note-path-option"
                  data-path={folder}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setPathValue(`${folder}/`);
                    setDropdownOpen(false);
                    if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
                  }}
                >
                  <FolderIcon />
                  {folder}/
                  {folder === props.defaultFolder && (
                    <span className="mark">既定</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {error !== null && <div className="dialog-error">{error}</div>}
        <p className="nn-hint">.md は自動補完されます。folder/name 形式でフォルダも指定できます。</p>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn"
            data-testid="new-note-cancel"
            onClick={props.onCancel}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="new-note-confirm"
            disabled={pathValue.trim() === '' || pathValue.trim().endsWith('/')}
            onClick={confirm}
          >
            作成
          </button>
        </div>
      </div>
    </div>
  );
}
