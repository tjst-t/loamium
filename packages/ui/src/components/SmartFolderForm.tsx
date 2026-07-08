/**
 * スマートフォルダ 作成/編集フォーム (S7b2f22-1 / S7b2f22-2 / Sebf6b0-2)。
 *
 * testid 契約:
 *   sf-form, sf-form-name, sf-form-icon, sf-form-kind-query, sf-form-kind-pin,
 *   sf-form-preset, sf-form-preset-n, sf-form-preset-tag, sf-form-dql,
 *   sf-form-path, sf-form-path-option (data-path), sf-form-icon-option (data-icon),
 *   sf-form-error, sf-form-save, sf-form-cancel.
 *
 * プリセット → DQL 変換 (ADR-0001: DQL 文字列が正本):
 *   recent(N) → LIST SORT file.mtime DESC LIMIT {N}
 *   tag(X)    → LIST FROM #{X}
 *   journal(N)→ LIST FROM "journals" SORT file.name DESC LIMIT {N}
 *   todo      → LIST WHERE file.open_tasks SORT file.mtime DESC
 *   custom    → ユーザーが直接入力した DQL 文字列
 *
 * Sebf6b0-2: pin パスコンボボックスはノートに加えてフォルダ候補も表示する。
 *   フォルダ候補: notes の folder フィールドから派生 (祖先フォルダを含む)。
 *   パスが `.md` 末尾 → note-pin (葉)。それ以外 → folder-pin (展開可能)。
 *   保存時: パスが既存ノートパスでも既存フォルダでもない場合はエラーを表示してブロック。
 */
import { useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react';
import type { NoteMeta, SmartViewItem, TagCount } from '@loamium/shared';
import { filterTagSuggestions } from '@loamium/shared';
import { api } from '../api.js';
import { FolderIcon } from '../icons.js';
import { BUILTIN_ICON_NAMES, SmartIcon } from './SmartIcons.js';

// --------------------------------------------------------------------------
// フォルダ候補の派生
// --------------------------------------------------------------------------

/**
 * notes のリストからフォルダ候補を導出する。
 * 各ノートの folder フィールド + その祖先フォルダを収集し、
 * ルート直下 ("") は除く (意味を持たないため)。
 */
export function deriveFolderCandidates(notes: NoteMeta[]): string[] {
  const folderSet = new Set<string>();
  for (const note of notes) {
    const f = note.folder;
    if (f === '') continue;
    // folder とその祖先を追加
    const parts = f.split('/');
    for (let i = 1; i <= parts.length; i++) {
      folderSet.add(parts.slice(0, i).join('/'));
    }
  }
  return Array.from(folderSet).sort();
}

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

  // --- アイコンコンボボックス ---
  const [iconOpen, setIconOpen] = useState(false);
  const iconBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filteredIcons = BUILTIN_ICON_NAMES.filter((n) =>
    n.includes(icon.toLowerCase().trim()),
  );

  const handleIconFocus = (): void => {
    if (iconBlurTimerRef.current !== null) clearTimeout(iconBlurTimerRef.current);
    setIconOpen(true);
  };
  const handleIconBlur = (): void => {
    iconBlurTimerRef.current = setTimeout(() => setIconOpen(false), 150);
  };
  const selectIcon = (name: string): void => {
    setIcon(name);
    setIconOpen(false);
  };

  // --- タグコンボボックス (Sebf6b0-4 AC-4-1) ---
  const [tags, setTags] = useState<TagCount[] | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const tagBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTags = (): void => {
    if (tags !== null) return;
    void api.getTags().then(
      (res) => setTags(res.tags),
      () => setTags([]),
    );
  };

  const tagSuggestions = filterTagSuggestions(tags ?? [], presetTag);
  // タグコンボは既存タグ候補のみ (isCreate の新規作成項目は除外 — フォーム用)
  const filteredTagSuggestions = tagSuggestions.filter((s) => !s.isCreate);

  const handleTagFocus = (): void => {
    if (tagBlurTimerRef.current !== null) clearTimeout(tagBlurTimerRef.current);
    loadTags();
    setTagOpen(true);
  };
  const handleTagBlur = (): void => {
    tagBlurTimerRef.current = setTimeout(() => setTagOpen(false), 150);
  };
  const selectTag = (tag: string): void => {
    setPresetTag(tag);
    setTagOpen(false);
  };

  // --- パスコンボボックス (Sebf6b0-2: ノート + フォルダ候補) ---
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [pathOpen, setPathOpen] = useState(false);
  const pathBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNotes = (): void => {
    if (notes !== null) return;
    void api.listNotes().then(
      (res) => setNotes(res.notes),
      () => setNotes([]),
    );
  };

  // ノートパスの Set (存在検証用)
  const notePathSet = new Set(notes?.map((n) => n.path) ?? []);
  // フォルダ候補 (notes から導出)
  const folderCandidates = notes === null ? [] : deriveFolderCandidates(notes);
  const folderSet = new Set(folderCandidates);

  const q = path.toLowerCase().trim();

  const filteredNotes =
    notes === null
      ? []
      : notes
          .filter((n) => {
            if (q.length === 0) return true;
            return (
              n.path.toLowerCase().includes(q) || n.title.toLowerCase().includes(q)
            );
          })
          .slice(0, 15);

  const filteredFolders =
    notes === null
      ? []
      : folderCandidates
          .filter((f) => {
            if (q.length === 0) return true;
            return f.toLowerCase().includes(q);
          })
          .slice(0, 10);

  const handlePathFocus = (): void => {
    if (pathBlurTimerRef.current !== null) clearTimeout(pathBlurTimerRef.current);
    loadNotes();
    setPathOpen(true);
  };
  const handlePathBlur = (): void => {
    pathBlurTimerRef.current = setTimeout(() => setPathOpen(false), 150);
  };
  const selectPath = (p: string): void => {
    setPath(p);
    setError(null);
    setPathOpen(false);
  };

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (iconBlurTimerRef.current !== null) clearTimeout(iconBlurTimerRef.current);
      if (pathBlurTimerRef.current !== null) clearTimeout(pathBlurTimerRef.current);
      if (tagBlurTimerRef.current !== null) clearTimeout(tagBlurTimerRef.current);
    };
  }, []);

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
      // Sebf6b0-2 AC-2-2: ノートパスまたはフォルダパスとして存在するか検証
      // notes がロード済みの場合のみ検証 (未ロードなら楽観的に通過)
      if (notes !== null) {
        const isExistingNote = notePathSet.has(trimPath);
        const isExistingFolder = folderSet.has(trimPath);
        if (!isExistingNote && !isExistingFolder) {
          setError('存在しないパスです');
          return;
        }
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

      {/* アイコン (コンボボックス) */}
      <div className="sf-form-row">
        <label className="sf-form-label">アイコン</label>
        <div className="sf-form-combobox">
          <input
            type="text"
            className="sf-form-input"
            data-testid="sf-form-icon"
            value={icon}
            placeholder="clock / star / 📝 など"
            onFocus={handleIconFocus}
            onBlur={handleIconBlur}
            onChange={(e) => {
              setIcon(e.target.value);
              setIconOpen(true);
            }}
          />
          {iconOpen && filteredIcons.length > 0 && (
            <div className="sf-form-dropdown">
              {filteredIcons.map((iconName) => (
                <button
                  key={iconName}
                  type="button"
                  className="sf-form-option"
                  data-testid="sf-form-icon-option"
                  data-icon={iconName}
                  onMouseDown={(e) => { e.preventDefault(); selectIcon(iconName); }}
                >
                  <SmartIcon icon={iconName} />
                  <span>{iconName}</span>
                </button>
              ))}
            </div>
          )}
        </div>
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

          {/* タグ名 (コンボボックス — Sebf6b0-4 AC-4-1) */}
          {preset === 'tag' && (
            <div className="sf-form-row">
              <label className="sf-form-label">タグ名</label>
              <div className="sf-form-combobox">
                <input
                  type="text"
                  className="sf-form-input"
                  data-testid="sf-form-preset-tag"
                  value={presetTag}
                  placeholder="example"
                  onFocus={handleTagFocus}
                  onBlur={handleTagBlur}
                  onChange={(e) => {
                    setPresetTag(e.target.value);
                    setTagOpen(true);
                  }}
                />
                {tagOpen && filteredTagSuggestions.length > 0 && (
                  <div className="sf-form-dropdown">
                    {filteredTagSuggestions.map((s) => (
                      <button
                        key={s.tag}
                        type="button"
                        className="sf-form-option"
                        data-testid="sf-form-preset-tag-option"
                        onMouseDown={(e) => { e.preventDefault(); selectTag(s.tag); }}
                      >
                        <span className="sf-form-option-path">#{s.tag}</span>
                        {s.count > 0 && (
                          <span className="sf-form-option-title">{s.count}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
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

      {/* pin フィールド (パスコンボボックス — Sebf6b0-2: フォルダ + ノート候補) */}
      {kind === 'pin' && (
        <div className="sf-form-row">
          <label className="sf-form-label">パス</label>
          <div className="sf-form-combobox">
            <input
              type="text"
              className="sf-form-input"
              data-testid="sf-form-path"
              value={path}
              placeholder="notes/example.md または projects/"
              onFocus={handlePathFocus}
              onBlur={handlePathBlur}
              onChange={(e) => {
                setPath(e.target.value);
                setError(null);
                setPathOpen(true);
              }}
            />
            {pathOpen && (filteredFolders.length > 0 || filteredNotes.length > 0) && (
              <div className="sf-form-dropdown">
                {/* フォルダ候補 (視覚的に区別: FolderIcon + 末尾 /) */}
                {filteredFolders.map((folder) => (
                  <button
                    key={`folder:${folder}`}
                    type="button"
                    className="sf-form-option sf-form-option-folder"
                    data-testid="sf-form-path-option"
                    data-path={folder}
                    onMouseDown={(e) => { e.preventDefault(); selectPath(folder); }}
                  >
                    <FolderIcon className="sf-form-option-icon" />
                    <span className="sf-form-option-path">{folder}/</span>
                  </button>
                ))}
                {/* ノート候補 */}
                {filteredNotes.map((note) => (
                  <button
                    key={note.path}
                    type="button"
                    className="sf-form-option"
                    data-testid="sf-form-path-option"
                    data-path={note.path}
                    onMouseDown={(e) => { e.preventDefault(); selectPath(note.path); }}
                  >
                    <span className="sf-form-option-path">{note.path}</span>
                    {note.title !== note.path && note.title !== '' && (
                      <span className="sf-form-option-title">{note.title}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {error !== null && <div className="sf-form-error" data-testid="sf-form-error">{error}</div>}

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
