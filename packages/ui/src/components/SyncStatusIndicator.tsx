/**
 * SyncStatusIndicator — 同期ステータスインジケータ (Se29635-4 / ADR-0032)。
 *
 * GET /api/sync/status をポーリングし、最終同期時刻・未 push 件数・オフライン・
 * 競合バッジを表示する。「今すぐ同期」ボタンで POST /api/sync/now を呼ぶ。
 *
 * ## ウィンドウフォーカス連動 (AC-Se29635-3-2)
 * - focus 時: POST /api/sync/pull {reason:'focus'}
 * - blur / beforeunload 時: POST /api/sync/flush (best-effort)
 *
 * ## 競合ダイアログ (AC-Se29635-4-1)
 * conflicted=true の場合、GET /api/sync/conflicts で未解決ハンクを取得し、
 * 既存の ConflictResolverDialog (S2df65d) を再利用して人間に渡す。
 *
 * ## モバイル ≤680px (AC-Se29635-4-2)
 * タップターゲット 44px 以上、@media (max-width: 680px) でラベルを隠しアイコンのみ表示。
 *
 * data-testid 一覧 (gui-spec-Se29635-4.json):
 *   sync-status, sync-now-button, sync-last-time, sync-unpushed-count,
 *   sync-badge-offline, sync-badge-conflict
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { SyncStatusResponse, SyncConflictsResponse } from '@loamium/shared';
import { ConflictResolverDialog } from './ConflictResolverDialog.js';
import { api } from '../api.js';

// ポーリング間隔 (ms)
const POLL_INTERVAL_MS = 30_000;

/** 最終同期時刻を「N 分前」などの相対表示に変換する。 */
function formatRelativeTime(isoStr: string): string {
  try {
    const diff = Date.now() - new Date(isoStr).getTime();
    if (diff < 0) return '今'; // 時計のズレ
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${String(secs)}秒前`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${String(mins)}分前`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${String(hrs)}時間前`;
    const days = Math.floor(hrs / 24);
    return `${String(days)}日前`;
  } catch {
    return isoStr;
  }
}

interface SyncStatusIndicatorProps {
  /** sync 機能が有効 (git 存在 + remote 設定済み) かどうかを親から受け取ることも可能だが、
   * インジケータ自体が /api/sync/status を取得するため、props は任意。 */
  className?: string;
}

export function SyncStatusIndicator({ className }: SyncStatusIndicatorProps): JSX.Element {
  const [status, setStatus] = useState<SyncStatusResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [conflictData, setConflictData] = useState<SyncConflictsResponse | null>(null);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async (): Promise<void> => {
    try {
      const s = await api.syncStatus();
      setStatus(s);
    } catch {
      // ステータス取得失敗は無視 (表示が古いままになるだけ)
    }
  }, []);

  // 定期ポーリング + 初回取得
  useEffect(() => {
    void fetchStatus();
    pollTimerRef.current = setInterval(() => { void fetchStatus(); }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [fetchStatus]);

  // ウィンドウフォーカス → pull (AC-Se29635-3-2 UI トリガー)
  useEffect(() => {
    const onFocus = (): void => {
      if (status === null || !status.available || !status.remoteConfigured) return;
      // best-effort: エラーは無視
      void api.syncPull('focus').then(() => { void fetchStatus(); }).catch(() => undefined);
    };
    const onBlur = (): void => {
      if (status === null || !status.available || !status.remoteConfigured) return;
      void api.syncFlush().catch(() => undefined);
    };
    const onBeforeUnload = (): void => {
      if (status === null || !status.available || !status.remoteConfigured) return;
      // sendBeacon が使えれば、でなければ best-effort fetch
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/sync/flush');
      } else {
        void api.syncFlush().catch(() => undefined);
      }
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [status, fetchStatus]);

  // 競合バッジクリック → 競合ハンク取得 → ダイアログ表示
  const openConflictDialog = useCallback(async (): Promise<void> => {
    try {
      const data = await api.syncConflicts();
      setConflictData(data);
      setConflictDialogOpen(true);
    } catch {
      // 取得失敗 → ダイアログは開かない (バッジは残る)
    }
  }, []);

  const handleSyncNow = useCallback(async (): Promise<void> => {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.syncNow();
      await fetchStatus();
    } catch {
      // エラーは status.lastError に乗るため fetchStatus で反映される
      await fetchStatus();
    } finally {
      setSyncing(false);
    }
  }, [syncing, fetchStatus]);

  // ---- ConflictResolverDialog (readOnly) のコールバック ----
  // git rebase 競合は abort 済みでローカル編集は保護されている。ダイアログは
  // 競合内容を人間に「渡す」read-only 表示 (AC-Se29635-4-1)。UI から書き戻すと
  // abort ベースでは再生時に再競合し収束しないため、ユーザーはエディタで編集して
  // 再同期して解決する (収束する UI 内解決は後続 sprint)。
  const handleConflictClose = useCallback((): void => {
    setConflictDialogOpen(false);
    setConflictData(null);
    void fetchStatus();
  }, [fetchStatus]);

  // ---- 描画 ----

  if (status === null) {
    // 初回取得前は何も表示しない
    return <div className={`sync-status sync-status-loading${className ? ` ${className}` : ''}`} data-testid="sync-status" />;
  }

  if (!status.available) {
    return (
      <div className={`sync-status sync-status-unavailable${className ? ` ${className}` : ''}`} data-testid="sync-status">
        <span className="sync-label-text" title="git がインストールされていません">同期無効(git不在)</span>
        <button className="sync-now-button" data-testid="sync-now-button" disabled title="git 不在のため同期できません">
          同期
        </button>
      </div>
    );
  }

  if (!status.vaultIsRepo) {
    return (
      <div className={`sync-status sync-status-no-repo${className ? ` ${className}` : ''}`} data-testid="sync-status">
        <span className="sync-label-text" title="vault が git リポジトリではありません。vault ルートで git init してください">
          vault が git 未初期化
        </span>
        <button className="sync-now-button" data-testid="sync-now-button" disabled title="vault ルートで git init が必要です">
          同期
        </button>
      </div>
    );
  }

  if (!status.remoteConfigured) {
    return (
      <div className={`sync-status sync-status-no-remote${className ? ` ${className}` : ''}`} data-testid="sync-status">
        <span className="sync-label-text" title="同期先リモートが設定されていません">リモート未設定</span>
        <button className="sync-now-button" data-testid="sync-now-button" disabled title="リモートを設定してください">
          同期
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        className={`sync-status${syncing ? ' sync-status-syncing' : ''}${className ? ` ${className}` : ''}`}
        data-testid="sync-status"
      >
        {/* 最終同期時刻 */}
        {status.lastSyncAt !== null && (
          <span
            className="sync-last-time"
            data-testid="sync-last-time"
            title={`最終同期: ${status.lastSyncAt}`}
          >
            {formatRelativeTime(status.lastSyncAt)}
          </span>
        )}

        {/* 未 push 件数バッジ (0 のとき非表示) */}
        {status.ahead > 0 && (
          <span
            className="sync-unpushed-count"
            data-testid="sync-unpushed-count"
            title={`${String(status.ahead)} 件の未 push コミット`}
          >
            ↑{String(status.ahead)}
          </span>
        )}

        {/* オフラインバッジ */}
        {status.offline && (
          <span
            className="sync-badge sync-badge-offline"
            data-testid="sync-badge-offline"
            title="オフライン (ネットワーク到達不能)"
          >
            オフライン
          </span>
        )}

        {/* 競合バッジ */}
        {status.conflicted && (
          <button
            className="sync-badge sync-badge-conflict"
            data-testid="sync-badge-conflict"
            title="競合を解決してください"
            onClick={() => void openConflictDialog()}
          >
            競合
          </button>
        )}

        {/* エラー表示 */}
        {status.lastError !== null && !status.offline && !status.conflicted && (
          <span className="sync-error" title={status.lastError}>
            ⚠
          </span>
        )}

        {/* 同期ボタン */}
        <button
          className={`sync-now-button${syncing ? ' syncing' : ''}`}
          data-testid="sync-now-button"
          onClick={() => void handleSyncNow()}
          disabled={syncing}
          title={syncing ? '同期中...' : '今すぐ同期'}
        >
          {syncing ? '同期中...' : '今すぐ同期'}
        </button>
      </div>

      {/* 競合解決ダイアログ (S2df65d 再利用) */}
      {conflictDialogOpen && conflictData !== null && conflictData.conflicts.length > 0 && (
        <ConflictResolverDialog
          path={conflictData.conflicts[0]!.file}
          readOnly
          conflicts={conflictData.conflicts[0]!.hunks.map((h, i) => ({
            startLine: i,
            endLine: i,
            ours: h.ours,
            theirs: h.theirs,
          }))}
          onCancel={handleConflictClose}
        />
      )}
    </>
  );
}
