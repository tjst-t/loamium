/**
 * useVaultEvents — サーバー SSE イベント購読フック (Sd5c9f4-4)。
 *
 * GET /api/events を EventSource で購読し、以下のコールバックを呼ぶ:
 *   onSfInvalidated(ids: string[])      — sf_invalidated イベント
 *   onNotesChanged(path, op)            — notes_changed イベント
 *
 * 切断 (onerror) 時: 3 秒後に自動再接続する (useRef タイマー)。
 * コンポーネントアンマウント時: EventSource.close() でクリーンアップ。
 * JSON.parse 失敗: console.warn して無視する。
 *
 * eventSourceFactory 引数: テスト時に EventSource のモックを差し込む。
 */
import { useEffect, useRef } from 'react';
import { getVaultEventsUrl } from './api.js';

/** sf_invalidated イベントのペイロード */
interface SfInvalidatedPayload {
  type: 'sf_invalidated';
  affectedIds: string[];
}

/** notes_changed イベントのペイロード */
interface NotesChangedPayload {
  type: 'notes_changed';
  path: string;
  op: 'upsert' | 'delete';
}

type VaultEventPayload = SfInvalidatedPayload | NotesChangedPayload;

/** EventSource インターフェース (テスト用モック可) */
export interface EventSourceLike {
  onmessage: ((evt: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const defaultEventSourceFactory: EventSourceFactory = (url: string) =>
  new EventSource(url) as EventSourceLike;

export interface UseVaultEventsOptions {
  onSfInvalidated?: (ids: string[]) => void;
  onNotesChanged?: (path: string, op: 'upsert' | 'delete') => void;
  /** テスト用 EventSource ファクトリ (省略時は window.EventSource) */
  eventSourceFactory?: EventSourceFactory;
}

const RECONNECT_DELAY_MS = 3000;

export function useVaultEvents({
  onSfInvalidated,
  onNotesChanged,
  eventSourceFactory = defaultEventSourceFactory,
}: UseVaultEventsOptions = {}): void {
  // コールバックは描画のたびに変わる可能性があるため ref で保持
  const onSfInvalidatedRef = useRef(onSfInvalidated);
  onSfInvalidatedRef.current = onSfInvalidated;
  const onNotesChangedRef = useRef(onNotesChanged);
  onNotesChangedRef.current = onNotesChanged;

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSourceLike | null>(null);

  useEffect(() => {
    let cancelled = false;

    function connect(): void {
      if (cancelled) return;
      const es = eventSourceFactory(getVaultEventsUrl());
      esRef.current = es;

      es.onmessage = (evt: { data: string }): void => {
        let payload: unknown;
        try {
          payload = JSON.parse(evt.data);
        } catch {
          console.warn('[loamium] useVaultEvents: JSON.parse failed:', evt.data);
          return;
        }
        // 型ガードで判定
        if (
          typeof payload === 'object' &&
          payload !== null &&
          'type' in payload
        ) {
          const p = payload as VaultEventPayload;
          if (p.type === 'sf_invalidated' && Array.isArray(p.affectedIds)) {
            onSfInvalidatedRef.current?.(p.affectedIds);
          } else if (
            p.type === 'notes_changed' &&
            typeof p.path === 'string' &&
            (p.op === 'upsert' || p.op === 'delete')
          ) {
            onNotesChangedRef.current?.(p.path, p.op);
          }
        }
      };

      es.onerror = (): void => {
        // 切断 → 3 秒後に再接続
        es.close();
        esRef.current = null;
        if (!cancelled) {
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, RECONNECT_DELAY_MS);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      // クリーンアップ: タイマーキャンセル + 接続クローズ
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      esRef.current?.close();
      esRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventSourceFactory]);
}
