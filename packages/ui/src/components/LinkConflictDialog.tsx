/**
 * LinkConflictDialog — 初回リンク競合ダイアログ (Sf17a4c-5 / ADR-0034)。
 *
 * 衝突ファイルごと、または全件まとめて解決方法を選ぶダイアログ。
 * 選択肢はドロップダウンを使わず、セグメント型スイッチ (排他ボタン群) で示す:
 *   [両方保持(既定) | 3-wayで統合 | ローカル採用 | リモート採用]
 *
 * 決め方ラジオ:
 *   - ファイルごとに決める (per-file): 各ファイル行にスイッチを表示
 *   - 全部まとめて決める (all): 1つのスイッチで全件に適用、行スイッチは非表示
 *
 * testids:
 *   link-conflict-dialog / link-conflict-mode-perfile / link-conflict-mode-all /
 *   link-conflict-row / link-conflict-switch / link-conflict-apply-all /
 *   link-conflict-confirm
 *
 * モバイル: @media (max-width: 680px) で縦積み。タップターゲット ≥44px。
 */

import { useState, useCallback, useMemo, type JSX } from 'react';
import type { SyncLinkConflictResolution } from '../api.js';
import { ConflictResolverDialog } from './ConflictResolverDialog.js';
import { diff3Merge, type ConflictHunk } from '@loamium/shared';

/** 操作アクション (REST 境界と一致) */
type LinkAction = 'keep-both' | 'merge' | 'local' | 'remote';

/** 衝突ファイル1件 (サーバ preview が返す ours/theirs 内容付き)。 */
export interface ConflictFileInfo {
  file: string;
  /** ローカル内容 (テキスト)。バイナリ・取得失敗時は undefined。 */
  ours?: string | undefined;
  /** リモート内容 (テキスト)。バイナリ・取得失敗時は undefined。 */
  theirs?: string | undefined;
}

/** ours/theirs を1ファイルに結合する (両方保持: ローカル → リモート)。 */
function combineBoth(ours: string, theirs: string): string {
  const parts = [ours, theirs].map((s) => s.trim()).filter((s) => s.length > 0);
  const joined = parts.join('\n\n');
  return joined.length > 0 && !joined.endsWith('\n') ? joined + '\n' : joined;
}

const ACTIONS: { key: LinkAction; label: string }[] = [
  { key: 'keep-both', label: '両方保持' },
  { key: 'merge', label: '3-way統合' },
  { key: 'local', label: 'ローカル採用' },
  { key: 'remote', label: 'リモート採用' },
];

/** ファイルごとのアクション map */
type FileActions = Record<string, LinkAction>;

interface ThreeWayState {
  file: string;
  conflicts: ConflictHunk[];
  /** diff3Merge が返したプレースホルダ入り merged テキスト。 */
  merged: string;
}

/** セグメント型スイッチ (4ボタン排他選択) */
function SegmentedSwitch({
  value,
  onChange,
  disabled,
  mergeAvailable = true,
  label,
}: {
  value: LinkAction;
  onChange: (a: LinkAction) => void;
  disabled?: boolean;
  /** false のとき「3-way統合」ボタンを無効化する (内容が取れないバイナリ等)。 */
  mergeAvailable?: boolean;
  label?: string;
}): JSX.Element {
  return (
    <div
      className="link-conflict-seg-toggle"
      role="group"
      aria-label={label ?? '解決方法'}
    >
      {ACTIONS.map((a) => (
        <button
          key={a.key}
          type="button"
          className={`link-conflict-seg-btn${value === a.key ? ' selected' : ''}`}
          data-testid="link-conflict-switch"
          data-action={a.key}
          aria-pressed={value === a.key}
          disabled={disabled || (a.key === 'merge' && !mergeAvailable)}
          title={a.key === 'merge' && !mergeAvailable ? 'このファイルはテキストとして統合できません' : undefined}
          onClick={() => onChange(a.key)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

export interface LinkConflictDialogProps {
  /** 衝突ファイル一覧 (ours/theirs 内容付き) */
  conflicts: ConflictFileInfo[];
  /** 確定: resolutions を返してウィザードに渡す */
  onConfirm: (resolutions: SyncLinkConflictResolution[]) => void;
  /** キャンセル */
  onCancel: () => void;
}

export function LinkConflictDialog({
  conflicts,
  onConfirm,
  onCancel,
}: LinkConflictDialogProps): JSX.Element {
  const conflictByFile = useMemo(() => {
    const m = new Map<string, ConflictFileInfo>();
    for (const c of conflicts) m.set(c.file, c);
    return m;
  }, [conflicts]);
  /** ファイルの ours/theirs いずれかがテキストとして取得できれば統合可能。 */
  const mergeAvailableFor = useCallback(
    (file: string): boolean => {
      const c = conflictByFile.get(file);
      return c !== undefined && (c.ours !== undefined || c.theirs !== undefined);
    },
    [conflictByFile],
  );
  // 決め方: per-file or all
  const [mode, setMode] = useState<'perfile' | 'all'>('perfile');
  // 全部まとめて決める用のアクション
  const [allAction, setAllAction] = useState<LinkAction>('keep-both');
  // ファイルごとのアクション (初期値: 全て keep-both)
  const [fileActions, setFileActions] = useState<FileActions>(() => {
    const init: FileActions = {};
    for (const c of conflicts) init[c.file] = 'keep-both';
    return init;
  });
  // 3-way 統合で生成した mergedText (ファイルパス→テキスト)
  const [mergedTexts, setMergedTexts] = useState<Record<string, string>>({});
  // 3-way 統合モーダル表示状態
  const [threeWayState, setThreeWayState] = useState<ThreeWayState | null>(null);

  const setFileAction = useCallback((file: string, action: LinkAction): void => {
    if (action === 'merge') {
      // 実内容から 3-way を構築する。初回リンクは共通祖先が無いため base='' で
      // diff3Merge を呼ぶと「ファイル全体が1件の競合ハンク (ours/theirs)」になる。
      const c = conflictByFile.get(file);
      const ours = c?.ours ?? '';
      const theirs = c?.theirs ?? '';
      const result = diff3Merge('', ours, theirs);
      if (result.conflicts.length === 0) {
        // 正規化で一致 → そのまま統合済みとして採用 (ダイアログは出さない)
        setFileActions((prev) => ({ ...prev, [file]: 'merge' }));
        setMergedTexts((prev) => ({ ...prev, [file]: result.merged }));
      } else {
        setThreeWayState({ file, conflicts: result.conflicts, merged: result.merged });
      }
    } else {
      setFileActions((prev) => ({ ...prev, [file]: action }));
    }
  }, [conflictByFile]);

  const handleAllAction = useCallback((action: LinkAction): void => {
    if (action === 'merge') {
      // 全件一括 3-way: 各ファイルを「両方保持 (1ファイルに結合)」で自動統合する
      // (データ喪失ゼロ)。内容が取れないファイルは mergedText 無し → サーバが keep-both。
      const texts: Record<string, string> = {};
      for (const c of conflicts) {
        if (c.ours !== undefined || c.theirs !== undefined) {
          texts[c.file] = combineBoth(c.ours ?? '', c.theirs ?? '');
        }
      }
      setMergedTexts(texts);
      setAllAction('merge');
      return;
    }
    setAllAction(action);
  }, [conflicts]);

  const handleConfirm = useCallback((): void => {
    const resolutions: SyncLinkConflictResolution[] = conflicts.map((c) => {
      const file = c.file;
      const action = mode === 'all' ? allAction : (fileActions[file] ?? 'keep-both');
      if (action === 'merge') {
        return { file, action: 'merge', mergedText: mergedTexts[file] };
      }
      return { file, action };
    });
    onConfirm(resolutions);
  }, [conflicts, mode, allAction, fileActions, mergedTexts, onConfirm]);

  // 3-way マージ完了
  const handleThreeWaySave = useCallback((resolvedText: string): void => {
    if (threeWayState === null) return;
    const { file } = threeWayState;
    setFileActions((prev) => ({ ...prev, [file]: 'merge' }));
    setMergedTexts((prev) => ({ ...prev, [file]: resolvedText }));
    setThreeWayState(null);
  }, [threeWayState]);

  // 3-way キャンセル
  const handleThreeWayCancel = useCallback((): void => {
    setThreeWayState(null);
  }, []);

  // 3-way 統合ダイアログが開いているとき
  if (threeWayState !== null) {
    return (
      <ConflictResolverDialog
        path={threeWayState.file}
        conflicts={threeWayState.conflicts}
        merged={threeWayState.merged}
        onSave={handleThreeWaySave}
        onCancel={handleThreeWayCancel}
      />
    );
  }

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="初回リンク競合"
      data-testid="link-conflict-dialog"
    >
      <div className="dialog-panel link-conflict-panel">
        <h2 className="dialog-title">初回リンク競合の解決</h2>
        <p className="dialog-subtitle hint">
          ローカルとリモートで同名・内容違いのファイルがあります。それぞれ解決方法を選んでください。
        </p>

        {/* 決め方ラジオ */}
        <div className="link-conflict-mode-row" role="radiogroup" aria-label="決め方">
          <span className="link-conflict-mode-label">決め方:</span>
          <label className="link-conflict-radio-label">
            <input
              type="radio"
              name="link-conflict-mode"
              data-testid="link-conflict-mode-perfile"
              checked={mode === 'perfile'}
              onChange={() => setMode('perfile')}
            />
            ファイルごとに決める
          </label>
          <label className="link-conflict-radio-label">
            <input
              type="radio"
              name="link-conflict-mode"
              data-testid="link-conflict-mode-all"
              checked={mode === 'all'}
              onChange={() => setMode('all')}
            />
            全部まとめて決める
          </label>
        </div>

        {/* 全部まとめて: 上部スイッチ */}
        {mode === 'all' && (
          <div className="link-conflict-all-switch" data-testid="link-conflict-apply-all">
            <span className="link-conflict-mode-label">全件に適用:</span>
            <SegmentedSwitch
              value={allAction}
              onChange={handleAllAction}
              label="全件の解決方法"
            />
          </div>
        )}

        {/* ファイル一覧 */}
        <div className="link-conflict-file-list">
          {conflicts.map((c) => {
            const file = c.file;
            const action = fileActions[file] ?? 'keep-both';
            const isMerged = action === 'merge' && mergedTexts[file] !== undefined;
            return (
              <div
                key={file}
                className="link-conflict-row"
                data-testid="link-conflict-row"
                data-file={file}
              >
                <span className="link-conflict-file-name" title={file}>
                  {file}
                  {isMerged && <span className="link-conflict-merged-badge"> (3-way統合済)</span>}
                </span>
                {mode === 'perfile' ? (
                  <SegmentedSwitch
                    value={action}
                    onChange={(a) => setFileAction(file, a)}
                    mergeAvailable={mergeAvailableFor(file)}
                    label={`${file} の解決方法`}
                  />
                ) : (
                  <span className="link-conflict-action-badge">
                    {ACTIONS.find((a) => a.key === allAction)?.label ?? '両方保持'}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* フッタ */}
        <div className="dialog-footer">
          <button
            type="button"
            className="btn"
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="link-conflict-confirm"
            onClick={handleConfirm}
          >
            解決して適用
          </button>
        </div>
      </div>
    </div>
  );
}
