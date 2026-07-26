/**
 * SyncSetupWizard — 同期セットアップウィザード (Sf17a4c-5 / ADR-0034)。
 *
 * 状態機械:
 *   idle → probing → (conflicts>0 → conflict) → applying → done
 *                  → (conflicts=0) ────────────────────────↗
 *
 * - リモート URL を入力してリンク開始
 * - preview: plan !== 'merge' OR conflicts = 0 → 自動適用 → 完了ダイアログ
 * - conflicts > 0 → LinkConflictDialog → 解決後に適用 → 完了ダイアログ
 * - remoteState === 'unreachable' → エラー表示
 * - mid-merge 検出バナーもここで表示 (ウィザードが開いたとき /api/sync/link/status を呼ぶ)
 *
 * testids:
 *   sync-setup-wizard / sync-setup-remote-url / sync-setup-start /
 *   link-done-dialog / link-done-summary
 */

import { useState, useEffect, useCallback, type JSX } from 'react';
import { api, type SyncLinkPreviewResponse, type SyncLinkConflictResolution } from '../api.js';
import { LinkConflictDialog } from './LinkConflictDialog.js';

type WizardStep = 'idle' | 'probing' | 'conflict' | 'applying' | 'done' | 'error';

interface DoneSummary {
  addedFromRemote: number;
  addedFromLocal: number;
  conflictsResolved: number;
}

export interface SyncSetupWizardProps {
  /** ウィザードを閉じるコールバック */
  onClose: () => void;
}

export function SyncSetupWizard({ onClose }: SyncSetupWizardProps): JSX.Element {
  const [remoteUrl, setRemoteUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [step, setStep] = useState<WizardStep>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // preview 結果 (conflict ステップで参照)
  const [preview, setPreview] = useState<SyncLinkPreviewResponse | null>(null);
  // 完了サマリ
  const [doneSummary, setDoneSummary] = useState<DoneSummary | null>(null);

  // mid-merge バナー
  const [midMerge, setMidMerge] = useState<{ inProgress: boolean; kind: string | null } | null>(null);

  // ウィザード開いた時に mid-merge を確認 (ウィザード内限定のフェッチ: グローバルに飛ばさない)
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const status = await api.syncLinkStatus();
        setMidMerge(status.midMerge);
      } catch {
        // 取得失敗は無視 (サーバー未起動 / git 不在等)
      }
    })();
  }, []);

  const applyLink = useCallback(async (
    url: string,
    branchVal: string,
    resolutions: SyncLinkConflictResolution[],
  ): Promise<void> => {
    setStep('applying');
    setErrorMsg(null);
    try {
      const result = await api.syncLinkApply(url, resolutions, branchVal !== '' ? branchVal : undefined);
      if (!result.ok) {
        setErrorMsg(result.error ?? 'リンク適用に失敗しました');
        setStep('error');
        return;
      }
      setDoneSummary({
        addedFromRemote: result.summary.addedFromRemote,
        addedFromLocal: result.summary.addedFromLocal,
        conflictsResolved: result.summary.conflictsResolved,
      });
      setStep('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  }, []);

  const handleStart = useCallback(async (): Promise<void> => {
    const url = remoteUrl.trim();
    if (url === '') return;

    setStep('probing');
    setErrorMsg(null);
    setPreview(null);

    try {
      const prev = await api.syncLinkPreview(url, branch.trim() !== '' ? branch.trim() : undefined);
      setPreview(prev);

      if (prev.remoteState === 'unreachable') {
        setErrorMsg('リモートに到達できません。URL や認証 (PAT) を確認してください。');
        setStep('error');
        return;
      }

      const hasConflicts = (prev.counts?.conflicts ?? 0) > 0 && prev.plan === 'merge';

      if (hasConflicts) {
        setStep('conflict');
      } else {
        // 衝突0件または merge 以外の plan: 自動適用
        await applyLink(url, branch.trim(), []);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  }, [remoteUrl, branch, applyLink]);

  const handleConflictConfirm = useCallback(async (resolutions: SyncLinkConflictResolution[]): Promise<void> => {
    await applyLink(remoteUrl.trim(), branch.trim(), resolutions);
  }, [remoteUrl, branch, applyLink]);

  const handleConflictCancel = useCallback((): void => {
    setStep('idle');
    setPreview(null);
  }, []);

  // 完了ダイアログを表示
  if (step === 'done' && doneSummary !== null) {
    return (
      <div
        className="dialog-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="同期セットアップ完了"
        data-testid="link-done-dialog"
      >
        <div className="dialog-panel sync-setup-done-panel">
          <h2 className="dialog-title">同期セットアップ完了</h2>
          <div className="sync-setup-done-summary" data-testid="link-done-summary">
            <div className="done-summary-row">
              <span className="done-summary-icon">&#8595;</span>
              <span>リモートから <strong>{doneSummary.addedFromRemote}</strong> 件取得</span>
            </div>
            <div className="done-summary-row">
              <span className="done-summary-icon">&#8593;</span>
              <span>ローカルから <strong>{doneSummary.addedFromLocal}</strong> 件アップロード</span>
            </div>
            {doneSummary.conflictsResolved > 0 && (
              <div className="done-summary-row">
                <span className="done-summary-icon">&#10003;</span>
                <span>衝突 <strong>{doneSummary.conflictsResolved}</strong> 件を解決</span>
              </div>
            )}
            <p className="hint" style={{ marginTop: 12 }}>
              以降は自動同期が有効なとき、編集後に自動でコミット・push されます。
            </p>
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onClose}
            >
              閉じる
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 衝突ダイアログを表示
  if (step === 'conflict' && preview !== null) {
    const conflictFiles = (preview.conflicts ?? []).map((c) => c.file);
    return (
      <LinkConflictDialog
        conflicts={conflictFiles}
        onConfirm={(resolutions) => void handleConflictConfirm(resolutions)}
        onCancel={handleConflictCancel}
      />
    );
  }

  // ウィザード本体
  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="同期をセットアップ"
      data-testid="sync-setup-wizard"
    >
      <div className="dialog-panel sync-setup-panel">
        <h2 className="dialog-title">同期をセットアップ</h2>

        {/* mid-merge バナー */}
        {midMerge?.inProgress === true && (
          <div className="sync-setup-mid-merge-banner">
            <span>前回のリンク処理が途中です ({midMerge.kind ?? 'merge'})。</span>
            <span className="hint"> 再開または取り消しはコマンドラインで対応できます。</span>
          </div>
        )}


        {/* リモート URL */}
        <div className="settings-field" style={{ marginTop: 16 }}>
          <label htmlFor="sync-setup-remote-url">リモート URL</label>
          <input
            id="sync-setup-remote-url"
            type="text"
            className="sync-setup-url-input"
            data-testid="sync-setup-remote-url"
            value={remoteUrl}
            placeholder="git@github.com:you/vault.git / https://github.com/you/vault.git"
            disabled={step === 'probing' || step === 'applying'}
            onChange={(e) => setRemoteUrl(e.target.value)}
          />
          <p className="hint">GitHub / 自宅 bare / NAS など任意の git リモート</p>
        </div>

        {/* ブランチ (任意) */}
        <div className="settings-field">
          <label htmlFor="sync-setup-branch">ブランチ (省略時: main)</label>
          <input
            id="sync-setup-branch"
            type="text"
            data-testid="sync-setup-branch"
            value={branch}
            placeholder="main"
            disabled={step === 'probing' || step === 'applying'}
            onChange={(e) => setBranch(e.target.value)}
          />
        </div>

        {/* warnings / nameCollisions */}
        {preview !== null && preview.warnings.length > 0 && (
          <div className="sync-setup-warnings">
            <strong>注意:</strong>
            <ul>
              {preview.warnings.map((w) => (
                <li key={w.path}>{w.path}: {w.guidance}</li>
              ))}
            </ul>
          </div>
        )}
        {preview !== null && preview.nameCollisions.length > 0 && (
          <div className="sync-setup-warnings">
            <strong>大文字小文字 / Unicode 衝突:</strong>
            <ul>
              {preview.nameCollisions.map((nc) => (
                <li key={nc.paths.join(',')}>{nc.kind}: {nc.paths.join(', ')}</li>
              ))}
            </ul>
          </div>
        )}

        {/* エラー表示 */}
        {step === 'error' && errorMsg !== null && (
          <p className="sync-setup-error" role="alert">{errorMsg}</p>
        )}

        {/* フッタ */}
        <div className="dialog-footer">
          <button
            type="button"
            className="btn"
            disabled={step === 'probing' || step === 'applying'}
            onClick={onClose}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="sync-setup-start"
            disabled={remoteUrl.trim() === '' || step === 'probing' || step === 'applying'}
            onClick={() => void handleStart()}
          >
            {step === 'probing' || step === 'applying' ? '処理中…' : 'リンク開始'}
          </button>
        </div>
      </div>
    </div>
  );
}
