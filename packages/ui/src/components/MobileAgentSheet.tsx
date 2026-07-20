/**
 * モバイル Agent フルスクリーンシート (Sa6c3b0-6)。
 *
 * モバイル (≤680px) のボトムバー「Agent」タップで下からスライドアップする。
 * 既存の AgentPane (pi SDK チャット) を再利用し、新しい実行経路を作らない。
 * ノート (workspace) は閉じず背面に残る。
 */
import { type JSX, useRef, useCallback, useEffect, useState } from 'react';
import { type HealthResponse, type NoteMeta } from '@loamium/shared';
import { api } from '../api.js';
import { AgentPane } from './AgentPane.js';
import { AgentNavIcon, CloseIcon } from '../icons.js';

export interface MobileAgentSheetProps {
  open: boolean;
  /** 現在開いているノートのパス (コンテキストバッジ表示用) */
  currentNotePath: string | null;
  notes: NoteMeta[] | null;
  onOpenNote: (path: string) => void;
  onNotesChanged: () => void;
  onClose: () => void;
}

/**
 * 下スワイプ判定のための最小距離 (px)。
 * ドラッグハンドルで下に 80px 以上スワイプすると閉じる。
 */
const SWIPE_CLOSE_THRESHOLD = 80;

export function MobileAgentSheet({
  open,
  currentNotePath,
  notes,
  onOpenNote,
  onNotesChanged,
  onClose,
}: MobileAgentSheetProps): JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getHealth().then(
      (res) => { if (!cancelled) setHealth(res); },
      () => { /* health 取得失敗時はエージェント無効として扱う */ },
    );
    return () => { cancelled = true; };
  }, []);
  const handleRef = useRef<HTMLDivElement>(null);
  const touchStartYRef = useRef<number | null>(null);

  const onTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>): void => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>): void => {
      const startY = touchStartYRef.current;
      if (startY === null) return;
      const endY = e.changedTouches[0]?.clientY ?? startY;
      if (endY - startY > SWIPE_CLOSE_THRESHOLD) {
        onClose();
      }
      touchStartYRef.current = null;
    },
    [onClose],
  );

  return (
    <div
      className="mobile-agent-sheet"
      data-testid="mobile-agent-sheet"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Agent チャット"
      aria-modal="true"
    >
      {/* ドラッグハンドル (下スワイプで閉じる) */}
      <div
        ref={handleRef}
        className="agent-sheet-handle"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        aria-hidden="true"
      >
        <div className="handle-bar" />
      </div>

      {/* シートヘッダ */}
      <div className="agent-sheet-header">
        <div className="agent-sheet-title">
          <span className="agent-ico">
            <AgentNavIcon />
          </span>
          Agent
        </div>

        {/* 閉じるボタン (AC-6-3) */}
        <button
          className="agent-sheet-close-btn"
          data-testid="mobile-agent-sheet-close"
          aria-label="Agent シートを閉じる"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>

      {/* 現在のノートコンテキストバッジ */}
      {currentNotePath !== null && (
        <div className="agent-context-badge" style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          margin: '8px 14px 2px',
          padding: '7px 11px',
          background: 'var(--accent-soft)',
          border: '1px solid #e2dcf7',
          borderRadius: 9,
          fontSize: '11.5px',
          color: 'var(--accent-hover)',
          flexShrink: 0,
        }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ width: 13, height: 13, flexShrink: 0 }}>
            <path d="M4 1.8h5.2L12.2 4.8v9.4H4z"/><path d="M9.2 1.8v3h3"/>
          </svg>
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentNotePath.split('/').at(-1)?.replace(/\.md$/, '') ?? currentNotePath}
          </span>
        </div>
      )}

      {/* AgentPane 本体: 既存実装をそのまま再利用 (AC-6-2) */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <AgentPane
          health={health}
          notes={notes}
          onOpenNote={onOpenNote}
          onNotesChanged={onNotesChanged}
          currentNotePath={currentNotePath}
        />
      </div>
    </div>
  );
}
