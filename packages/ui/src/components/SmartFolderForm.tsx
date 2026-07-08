/**
 * スマートフォルダ 作成/編集フォーム (S7b2f22-1)。
 *
 * testid 契約:
 *   sf-form, sf-form-name, sf-form-icon, sf-form-kind-query, sf-form-kind-pin,
 *   sf-form-preset, sf-form-preset-n, sf-form-preset-tag, sf-form-dql,
 *   sf-form-path, sf-form-save, sf-form-cancel.
 *
 * プリセット → DQL 変換 (ADR-0001: DQL 文字列が正本):
 *   recent(N) → LIST SORT file.mtime DESC LIMIT {N}
 *   tag(X)    → LIST FROM #{X}
 *   journal(N)→ LIST FROM "journals" SORT file.name DESC LIMIT {N}
 *   todo      → LIST WHERE file.open_tasks SORT file.mtime DESC
 *   custom    → ユーザーが直接入力した DQL 文字列
 */
import { useState, type ChangeEvent, type JSX } from 'react';
import type { SmartViewItem } from '@loamium/shared';

// --------------------------------------------------------------------------
// プリセット / DQL 生成
// --------------------------------------------------------------------------

type PresetKind = 'recent' | 'tag' | 'journal' | 'todo' | 'custom';

function buildDql(preset: PresetKind, n: number, tag: string): string {
  switch (preset) {
    case 'recent':
      return `LIST SORT file.mtime DESC LIMIT ${n}`;
    case 'tag':
      return `LIST FROM #${tag}`;
    case 'journal':
      return `LIST FROM "journals" SORT file.name DESC LIMIT ${n}`;
    case 'todo':
      return 'LIST WHERE file.open_tasks SORT file.mtime DESC';
    case 'custom':
      return '';
  }
}

// --------------------------------------------------------------------------
// ID 生成 (スラッグ + ランダムサフィックス、重複回避)
// --------------------------------------------------------------------------

export function generateSmartFolderId(name: string, existingIds: ReadonlySet<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9぀-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'item';
  const makeCandidate = (): string => `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  let candidate = makeCandidate();
  while (existingIds.has(candidate)) {
    candidate = makeCandidate();
  }
  return candidate;
}

// --------------------------------------------------------------------------
// コンポーネント
// --------------------------------------------------------------------------

export interface SmartFolderFormProps {
  /** 編集時: 既存アイテム。undefined = 新規作成モード */
  initial?: SmartViewItem;
  /** ID 重複チェック用 (編集中の自 ID は除外済みで渡すこと) */
  existingIds: ReadonlySet<string>;
  onSave: (item: SmartViewItem) => void;
  onCancel: () => void;
}

export function SmartFolderForm({
  initial,
  existingIds,
  onSave,
  onCancel,
}: SmartFolderFormProps): JSX.Element {
  const isEdit = initial !== undefined;

  // --- 共通フィールド ---
  const [kind, setKind] = useState<'query' | 'pin'>(initial?.kind ?? 'query');
  const [name, setName] = useState<string>(initial?.name ?? '');
  const [icon, setIcon] = useState<string>(initial?.icon ?? '');

  // --- query フィールド ---
  const [preset, setPreset] = useState<PresetKind>('custom');
  const [presetN, setPresetN] = useState<number>(10);
  const [presetTag, setPresetTag] = useState<string>('');
  // カスタム DQL: 編集時は既存 dql、新規時は空
  const [customDql, setCustomDql] = useState<string>(
    initial?.kind === 'query' ? initial.dql : '',
  );

  // --- pin フィールド ---
  const [path, setPath] = useState<string>(
    initial?.kind === 'pin' ? initial.path : '',
  );

  const [error, setError] = useState<string | null>(null);

  // プリセットが custom 以外なら自動生成、custom なら入力値
  const computedDql: string =
    preset === 'custom' ? customDql : buildDql(preset, presetN, presetTag);

  // プリセット変更
  const handlePresetChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    setPreset(e.target.value as PresetKind);
  };

  // DQL 直接編集 → custom モードに切替
  const handleDqlChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setPreset('custom');
    setCustomDql(e.target.value);
  };

  const handleSave = (): void => {
    const trimName = name.trim();
    const trimPath = path.trim();
    const trimDql = computedDql.trim();
    const trimIcon = icon.trim();

    if (kind === 'query') {
      if (!trimName) {
        setError('名前を入力してください');
        return;
      }
      if (!trimDql) {
        setError('DQL を入力してください');
        return;
      }
    } else {
      if (!trimPath) {
        setError('パスを入力してください');
        return;
      }
    }

    const id = isEdit
      ? initial.id
      : generateSmartFolderId(trimName || trimPath, existingIds);

    if (kind === 'query') {
      onSave({
        kind: 'query',
        id,
        name: trimName,
        dql: trimDql,
        icon: trimIcon || undefined,
      });
    } else {
      onSave({
        kind: 'pin',
        id,
        path: trimPath,
        name: trimName || undefined,
        icon: trimIcon || undefined,
      });
    }
  };

  return (
    <div className="sf-form" data-testid="sf-form">
      {/* 名前 */}
      <div className="sf-form-row">
        <label className="sf-form-label">名前</label>
        <input
          type="text"
          className="sf-form-input"
          data-testid="sf-form-name"
          value={name}
          placeholder={kind === 'pin' ? '表示名 (省略可)' : 'フォルダ名'}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </div>

      {/* アイコン */}
      <div className="sf-form-row">
        <label className="sf-form-label">アイコン</label>
        <input
          type="text"
          className="sf-form-input"
          data-testid="sf-form-icon"
          value={icon}
          placeholder="clock / star / 📝 など"
          onChange={(e) => setIcon(e.target.value)}
        />
      </div>

      {/* 種別 */}
      <div className="sf-form-row">
        <label className="sf-form-label">種別</label>
        <div className="sf-form-kind-row">
          <button
            type="button"
            className={`sf-form-kind-btn${kind === 'query' ? ' active' : ''}`}
            data-testid="sf-form-kind-query"
            aria-pressed={kind === 'query'}
            onClick={() => {
              setKind('query');
              setError(null);
            }}
          >
            クエリ
          </button>
          <button
            type="button"
            className={`sf-form-kind-btn${kind === 'pin' ? ' active' : ''}`}
            data-testid="sf-form-kind-pin"
            aria-pressed={kind === 'pin'}
            onClick={() => {
              setKind('pin');
              setError(null);
            }}
          >
            ピン
          </button>
        </div>
      </div>

      {/* query フィールド */}
      {kind === 'query' && (
        <>
          {/* プリセット選択 */}
          <div className="sf-form-row">
            <label className="sf-form-label">プリセット</label>
            <select
              className="sf-form-select"
              data-testid="sf-form-preset"
              value={preset}
              onChange={handlePresetChange}
            >
              <option value="recent">最近更新 N 件</option>
              <option value="tag">タグ</option>
              <option value="journal">ジャーナル N 件</option>
              <option value="todo">未完了 TODO</option>
              <option value="custom">カスタム DQL</option>
            </select>
          </div>

          {/* N 件数 (recent / journal) */}
          {(preset === 'recent' || preset === 'journal') && (
            <div className="sf-form-row">
              <label className="sf-form-label">件数</label>
              <input
                type="number"
                className="sf-form-input sf-form-input-n"
                data-testid="sf-form-preset-n"
                value={presetN}
                min={1}
                max={999}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setPresetN(Number.isNaN(v) || v < 1 ? 1 : v);
                }}
              />
            </div>
          )}

          {/* タグ名 */}
          {preset === 'tag' && (
            <div className="sf-form-row">
              <label className="sf-form-label">タグ名</label>
              <input
                type="text"
                className="sf-form-input"
                data-testid="sf-form-preset-tag"
                value={presetTag}
                placeholder="example"
                onChange={(e) => setPresetTag(e.target.value)}
              />
            </div>
          )}

          {/* 生 DQL (常時表示・編集可) */}
          <div className="sf-form-row sf-form-row-col">
            <label className="sf-form-label">DQL</label>
            <textarea
              className="sf-form-textarea"
              data-testid="sf-form-dql"
              value={computedDql}
              rows={3}
              onChange={handleDqlChange}
            />
          </div>
        </>
      )}

      {/* pin フィールド */}
      {kind === 'pin' && (
        <div className="sf-form-row">
          <label className="sf-form-label">パス</label>
          <input
            type="text"
            className="sf-form-input"
            data-testid="sf-form-path"
            value={path}
            placeholder="notes/example.md"
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
          />
        </div>
      )}

      {error !== null && <div className="sf-form-error">{error}</div>}

      <div className="sf-form-actions">
        <button
          type="button"
          className="btn"
          data-testid="sf-form-cancel"
          onClick={onCancel}
        >
          キャンセル
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="sf-form-save"
          onClick={handleSave}
        >
          {isEdit ? '更新' : '追加'}
        </button>
      </div>
    </div>
  );
}
