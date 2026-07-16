/**
 * egress-guard.ts のユニットテスト (S8a3f2e-5 / AC-S8a3f2e-5-2)。
 *
 * ループバック判定と、install 後の fetch 差し替え (外部はブロック・ループバックは委譲)
 * を検証する。実ネットワークへは発信しない (元 fetch をスパイに差し替える)。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  isLoopbackHost,
  installEgressGuard,
  egressGuardStats,
  ExternalEgressBlockedError,
} from './egress-guard.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  // 各テスト後に必ず元へ戻す (install が globalThis を差し替えるため)。
  globalThis.fetch = originalFetch;
});

describe('isLoopbackHost', () => {
  it('ループバック系ホストを true と判定する', () => {
    for (const h of ['localhost', 'sub.localhost', '127.0.0.1', '127.0.0.5', '::1', '[::1]']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });
  it('外部ホストを false と判定する', () => {
    for (const h of ['api.example.com', '8.8.8.8', '192.168.0.1', '10.0.0.1', '0.0.0.0']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe('installEgressGuard', () => {
  it('外部ホストへの fetch を ExternalEgressBlockedError で拒否しカウントする', async () => {
    // 元 fetch を「呼ばれたら記録するスパイ」に差し替えてから install する。
    let delegated = 0;
    globalThis.fetch = (() => {
      delegated += 1;
      return Promise.resolve(new Response('ok'));
    }) as typeof fetch;

    const handle = installEgressGuard();
    try {
      await expect(globalThis.fetch('https://api.example.com/v1/chat')).rejects.toBeInstanceOf(
        ExternalEgressBlockedError,
      );
      // 外部はスパイ (素の fetch) へ委譲されない。
      expect(delegated).toBe(0);
      expect(handle.blockedCount).toBe(1);
      expect(egressGuardStats()?.blockedCount).toBe(1);
    } finally {
      handle.uninstall();
    }
  });

  it('ループバックへの fetch は素の fetch へ委譲し allowedCount を数える', async () => {
    let delegated = 0;
    globalThis.fetch = (() => {
      delegated += 1;
      return Promise.resolve(new Response('ok'));
    }) as typeof fetch;

    const handle = installEgressGuard();
    try {
      const res = await globalThis.fetch('http://127.0.0.1:3000/api/llm/v1/models');
      expect(res.status).toBe(200);
      expect(delegated).toBe(1); // 素の fetch へ委譲された
      expect(handle.blockedCount).toBe(0);
      expect(handle.allowedCount).toBe(1);
    } finally {
      handle.uninstall();
    }
  });

  it('uninstall で元の fetch に戻る', () => {
    const spy = (() => Promise.resolve(new Response('ok'))) as typeof fetch;
    globalThis.fetch = spy;
    const handle = installEgressGuard();
    expect(globalThis.fetch).not.toBe(spy); // ガードに差し替わっている
    handle.uninstall();
    expect(globalThis.fetch).toBe(spy); // 元へ戻る
    expect(egressGuardStats()).toBeNull();
  });
});
