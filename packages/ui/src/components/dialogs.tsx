/**
 * ダイアログ群 (リネーム / 新規ノート / 新規フォルダ / 削除確認 / 保存競合)。
 * rename-* は prototype/TESTIDS.md の契約 testid。new-note-* / new-folder-* /
 * delete-* / conflict-* は Sa704c3 実装時に契約へ追記した testid (TESTIDS.md 参照)。
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

interface NameDialogProps {
  title: string;
  sub: string;
  initial: string;
  placeholder?: string;
  confirmLabel: string;
  testids: { dialog: string; input: string; confirm: string; cancel: string };
  /** 入力欄の下に差し込む補足表示 (リネームのリンク更新数など) */
  extra?: ReactNode;
  /** 入力を検証し、エラー文字列 (null = OK) を返す */
  validate: (name: string) => string | null;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function NameDialog(props: NameDialogProps): JSX.Element {
  const [name, setName] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const confirm = (): void => {
    const trimmed = name.trim();
    const err = props.validate(trimmed);
    if (err !== null) {
      setError(err);
      return;
    }
    props.onConfirm(trimmed);
  };

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div
        className="dialog"
        data-testid={props.testids.dialog}
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{props.title}</h2>
        <p className="dialog-sub">{props.sub}</p>
        <input
          ref={inputRef}
          type="text"
          value={name}
          placeholder={props.placeholder ?? ''}
          data-testid={props.testids.input}
          aria-label={props.title}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) confirm();
            if (e.key === 'Escape') props.onCancel();
          }}
        />
        {error !== null && <div className="dialog-error">{error}</div>}
        {props.extra}
        <div className="dialog-actions">
          <button className="btn" data-testid={props.testids.cancel} onClick={props.onCancel}>
            キャンセル
          </button>
          <button className="btn primary" data-testid={props.testids.confirm} onClick={confirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface DeleteDialogProps {
  path: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteDialog(props: DeleteDialogProps): JSX.Element {
  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div
        className="dialog"
        data-testid="delete-dialog"
        role="dialog"
        aria-label="ノートを削除"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>ノートを削除</h2>
        <p className="dialog-sub">{props.path}</p>
        <div className="dialog-warn">
          <span>
            このノートをディスクから削除します。vault が Git 管理されていれば履歴から復元できます。
          </span>
        </div>
        <div className="dialog-actions">
          <button className="btn" data-testid="delete-cancel" onClick={props.onCancel}>
            キャンセル
          </button>
          <button className="btn danger" data-testid="delete-confirm" onClick={props.onConfirm}>
            削除する
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ConflictDialogProps {
  path: string;
  onOverwrite: () => void;
  onReload: () => void;
}

export function ConflictDialog(props: ConflictDialogProps): JSX.Element {
  return (
    <div className="dialog-backdrop">
      <div
        className="dialog"
        data-testid="conflict-dialog"
        role="dialog"
        aria-label="保存の競合"
      >
        <h2>保存の競合</h2>
        <p className="dialog-sub">{props.path}</p>
        <div className="dialog-warn">
          <span>
            このノートは読み込み後に別のプロセス (エージェント / 外部エディタ) によって変更されています。
            上書き保存すると相手の変更は失われます。
          </span>
        </div>
        <div className="dialog-actions">
          <button className="btn" data-testid="conflict-reload" onClick={props.onReload}>
            再読み込み (自分の編集を破棄)
          </button>
          <button className="btn danger" data-testid="conflict-overwrite" onClick={props.onOverwrite}>
            上書き保存
          </button>
        </div>
      </div>
    </div>
  );
}
