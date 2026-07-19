/**
 * SSEBroadcaster ユニットテスト (Sd5c9f4-3)。
 *
 * AC-Sd5c9f4-3-4: 接続→切断を 5 回繰り返してもメモリリークしない。
 * broadcast が全クライアントへ送信されること。
 * 書き込みエラーのクライアントは Map から除去されること。
 */
import { describe, expect, it, vi } from 'vitest';
import { SSEBroadcaster } from './sse-broadcaster.js';

/** テスト用モック StreamWriter */
function makeWriter(): { write: (data: string) => Promise<void>; received: string[] } {
  const received: string[] = [];
  return {
    write: (data: string) => {
      received.push(data);
      return Promise.resolve();
    },
    received,
  };
}

describe('SSEBroadcaster', () => {
  it('subscribe→broadcast で全クライアントへ送信される', async () => {
    const broadcaster = new SSEBroadcaster();
    const w1 = makeWriter();
    const w2 = makeWriter();

    broadcaster.subscribe(w1);
    broadcaster.subscribe(w2);

    await broadcaster.broadcast({ type: 'test', value: 42 });

    expect(w1.received).toHaveLength(1);
    expect(w2.received).toHaveLength(1);
    expect(w1.received[0]).toBe('data: {"type":"test","value":42}\n\n');
  });

  it('unsubscribe 後はそのクライアントへ送信されない', async () => {
    const broadcaster = new SSEBroadcaster();
    const w1 = makeWriter();
    const w2 = makeWriter();

    const unsub1 = broadcaster.subscribe(w1);
    broadcaster.subscribe(w2);

    unsub1(); // w1 を登録解除

    await broadcaster.broadcast({ type: 'after-unsub' });

    expect(w1.received).toHaveLength(0);
    expect(w2.received).toHaveLength(1);
  });

  it('書き込みエラーのクライアントは Map から除去される', async () => {
    const broadcaster = new SSEBroadcaster();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let failureMode = false;
    const errorWriter = {
      write: (data: string): Promise<void> => {
        void data;
        if (failureMode) return Promise.reject(new Error('write failed'));
        return Promise.resolve();
      },
    };
    const goodWriter = makeWriter();

    broadcaster.subscribe(errorWriter);
    broadcaster.subscribe(goodWriter);
    expect(broadcaster.clientCount).toBe(2);

    // 最初の broadcast は成功
    await broadcaster.broadcast({ type: 'ok' });
    expect(broadcaster.clientCount).toBe(2);

    // 次の broadcast でエラー writer が失敗
    failureMode = true;
    await broadcaster.broadcast({ type: 'fail' });

    // エラーのあったクライアントは除去される
    expect(broadcaster.clientCount).toBe(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // [AC-Sd5c9f4-3-4] 接続→切断を 5 回繰り返してもメモリリークしない ---------

  it('[AC-Sd5c9f4-3-4] 接続→切断 x5 でクライアント数が 0 に戻る', async () => {
    const broadcaster = new SSEBroadcaster();
    const unsubs: (() => void)[] = [];

    // 5 回接続
    for (let i = 0; i < 5; i++) {
      const w = makeWriter();
      const unsub = broadcaster.subscribe(w);
      unsubs.push(unsub);
    }
    expect(broadcaster.clientCount).toBe(5);

    // 全て切断
    for (const unsub of unsubs) {
      unsub();
    }
    expect(broadcaster.clientCount).toBe(0);
  });

  it('接続→切断を繰り返しても broadcast は正常に動作する', async () => {
    const broadcaster = new SSEBroadcaster();
    const persistent = makeWriter();
    broadcaster.subscribe(persistent);

    for (let i = 0; i < 5; i++) {
      const w = makeWriter();
      const unsub = broadcaster.subscribe(w);
      await broadcaster.broadcast({ round: i });
      unsub();
    }

    // persistent クライアントは全 5 ラウンドのイベントを受け取っている
    expect(persistent.received).toHaveLength(5);
    // 残りのクライアントは 1 つ (persistent のみ)
    expect(broadcaster.clientCount).toBe(1);
  });

  it('クライアントが 0 件でも broadcast はエラーにならない', async () => {
    const broadcaster = new SSEBroadcaster();
    await expect(broadcaster.broadcast({ type: 'noop' })).resolves.toBeUndefined();
  });
});
