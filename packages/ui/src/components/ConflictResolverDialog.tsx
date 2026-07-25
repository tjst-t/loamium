/**
 * ConflictResolverDialog — 3-way マージ競合ダイアログ (S2df65d-1 / ADR-0030)。
 *
 * 競合ハンク単位に ours/theirs を並列表示し、各ハンクで解決方法を選択させる。
 * 全ハンクが解決されたら「マージ結果を保存」ボタンが有効になる。
 *
 * 解決方法:
 *   - こちらを使う (ours)
 *   - リモートを使う (theirs)
 *   - 両方保持 (ours の後に theirs を付加)
 *
 * 競合マーカー (<<<< ==== >>>>) はファイルにも UI 内にも表示しない。
 * 並列カードで視覚的に示す (ADR-0030 / D-S2df65d-3)。
 *
 * testids (scenario.json 参照):
 *   conflict-resolver-dialog / conflict-hunk-item / conflict-choose-ours /
 *   conflict-choose-theirs / conflict-choose-both / conflict-save-merge /
 *   conflict-cancel / conflict-hunk-count
 *
 * モバイル: @media (max-width: 680px) で縦積みレイアウト。タップターゲット 44px 以上。
 */

import { useState, type JSX } from 'react';
import type { ConflictHunk } from '@loamium/shared';

/** 各ハンクの解決方法 */
type Resolution = 'ours' | 'theirs' | 'both' | null;

interface ConflictResolverDialogProps {
  /** 競合が発生したノートのパス */
  path: string;
  /**
   * diff3Merge が返した merged テキスト。
   * 競合ハンクの位置には buildConflictPlaceholder 行が入っている。
   * 解決後はプレースホルダーを解決テキストで置換して保存する。
   * readOnly の場合は不要 (既定 '')。
   */
  merged?: string;
  /** 競合ハンク一覧 */
  conflicts: ConflictHunk[];
  /** 全ハンク解決後に「マージ結果を保存」ボタンが押されたときのコールバック (readOnly では未使用) */
  onSave?: (resolvedText: string) => void;
  /** キャンセル (後で解決) / readOnly では「閉じる」 */
  onCancel: () => void;
  /**
   * 読み取り専用モード (Se29635-4)。git 同期由来の rebase 競合を人間に「渡す」用途。
   * abort でローカル編集を保護済みのため、ここでの選択はファイルへ書き戻さない
   * (abort ベースの解決は再生時に再競合し収束しないため、UI 内解決は後続 sprint)。
   * ours/theirs を並べて表示し、ユーザーはエディタで編集して再同期する。
   */
  readOnly?: boolean;
}

/**
 * 解決済みハンクを merged テキストに適用して最終テキストを生成する。
 * プレースホルダー行 (\u{1F4AC}CONFLICT:<n>) を解決テキストで置換する。
 */
function applyResolutions(
  merged: string,
  conflicts: ConflictHunk[],
  resolutions: Resolution[],
): string {
  let result = merged;
  // conflicts を startLine 降順で処理することで行オフセットのズレを防ぐ
  const pairs = conflicts
    .map((c, i) => ({ conflict: c, idx: i }))
    .sort((a, b) => b.conflict.startLine - a.conflict.startLine);

  const lines = result.split('\n');
  for (const { conflict, idx } of pairs) {
    const resolution = resolutions[idx];
    if (resolution === null) continue;

    const placeholder = `\u{1F4AC}CONFLICT:${conflict.startLine}`;
    const lineIdx = lines.findIndex((l) => l === placeholder);
    if (lineIdx < 0) continue;

    let replacement: string[];
    if (resolution === 'ours') {
      replacement = conflict.ours;
    } else if (resolution === 'theirs') {
      replacement = conflict.theirs;
    } else {
      // both: ours の後に theirs を付加
      replacement = [...conflict.ours, ...conflict.theirs];
    }
    lines.splice(lineIdx, 1, ...replacement);
  }

  result = lines.join('\n');
  if (result.length > 0 && !result.endsWith('\n')) {
    result += '\n';
  }
  return result;
}

export function ConflictResolverDialog({
  path,
  merged = '',
  conflicts,
  onSave,
  onCancel,
  readOnly = false,
}: ConflictResolverDialogProps): JSX.Element {
  const [resolutions, setResolutions] = useState<Resolution[]>(() =>
    conflicts.map(() => null),
  );

  const allResolved = resolutions.every((r) => r !== null);
  const resolvedCount = resolutions.filter((r) => r !== null).length;

  const resolve = (idx: number, choice: 'ours' | 'theirs' | 'both'): void => {
    setResolutions((prev) => {
      const next = [...prev];
      next[idx] = choice;
      return next;
    });
  };

  const handleSave = (): void => {
    if (!allResolved || onSave === undefined) return;
    const resolved = applyResolutions(merged, conflicts, resolutions);
    onSave(resolved);
  };

  return (
    <div className="dialog-backdrop" style={{ zIndex: 300 }}>
      <div
        className="conflict-resolver-dialog"
        data-testid="conflict-resolver-dialog"
        role="dialog"
        aria-label="競合の解決"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* ヘッダ */}
        <div className="cr-header">
          <div className="cr-title">
            <span className="cr-icon">⚠</span>
            <span>マージ競合を解決してください</span>
          </div>
          <div className="cr-path">{path}</div>
          <div className="cr-subtitle">
            {readOnly ? (
              <span data-testid="conflict-hunk-count">{conflicts.length} 件の競合ハンク</span>
            ) : (
              <span data-testid="conflict-hunk-count">
                {resolvedCount} / {conflicts.length} ハンク解決済み
              </span>
            )}
          </div>
          {readOnly && (
            <div className="cr-readonly-note" data-testid="conflict-readonly-note">
              git 同期で競合しました。ローカル編集は保護されています(自動 abort 済み)。
              下の「ローカル」「リモート」を確認し、エディタで該当ファイルを編集してから
              再度同期して解決してください。
            </div>
          )}
        </div>

        {/* 競合ハンク一覧 */}
        <div className="cr-hunks">
          {conflicts.map((hunk, idx) => {
            const chosen = resolutions[idx] ?? null;
            return (
              <div
                key={idx}
                className={`cr-hunk-item${chosen !== null ? ' cr-hunk-resolved' : ''}`}
                data-testid="conflict-hunk-item"
              >
                <div className="cr-hunk-header">
                  <span className="cr-hunk-num">ハンク {idx + 1}</span>
                  {chosen !== null && (
                    <span className="cr-hunk-resolved-badge">
                      {chosen === 'ours' ? 'こちらを選択' : chosen === 'theirs' ? 'リモートを選択' : '両方保持'}
                    </span>
                  )}
                </div>

                {/* ours / theirs を並列表示 */}
                <div className="cr-diff-cols">
                  <div className={`cr-diff-col cr-diff-ours${chosen === 'ours' || chosen === 'both' ? ' cr-chosen' : ''}`}>
                    <div className="cr-diff-label">こちら (ローカル編集)</div>
                    <pre className="cr-diff-pre">{hunk.ours.join('\n') || '(内容なし)'}</pre>
                    {!readOnly && (
                      <button
                        className="btn cr-choice-btn"
                        data-testid="conflict-choose-ours"
                        aria-pressed={chosen === 'ours'}
                        onClick={() => resolve(idx, 'ours')}
                      >
                        こちらを使う
                      </button>
                    )}
                  </div>

                  <div className={`cr-diff-col cr-diff-theirs${chosen === 'theirs' || chosen === 'both' ? ' cr-chosen' : ''}`}>
                    <div className="cr-diff-label">リモート (外部変更)</div>
                    <pre className="cr-diff-pre">{hunk.theirs.join('\n') || '(内容なし)'}</pre>
                    {!readOnly && (
                      <button
                        className="btn cr-choice-btn"
                        data-testid="conflict-choose-theirs"
                        aria-pressed={chosen === 'theirs'}
                        onClick={() => resolve(idx, 'theirs')}
                      >
                        リモートを使う
                      </button>
                    )}
                  </div>
                </div>

                {/* 両方保持ボタン */}
                {!readOnly && (
                  <div className="cr-both-row">
                    <button
                      className="btn cr-choice-btn cr-both-btn"
                      data-testid="conflict-choose-both"
                      aria-pressed={chosen === 'both'}
                      onClick={() => resolve(idx, 'both')}
                    >
                      両方保持
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* フッタアクション */}
        <div className="cr-footer">
          <button
            className="btn"
            data-testid="conflict-cancel"
            onClick={onCancel}
          >
            {readOnly ? '閉じる' : '後で解決'}
          </button>
          {!readOnly && (
            <button
              className="btn primary"
              data-testid="conflict-save-merge"
              disabled={!allResolved}
              onClick={handleSave}
            >
              マージ結果を保存
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
