/**
 * 内蔵 LLM モデル管理の監査ログ + 権限モード配線の integration テスト
 * (S8a3f2e-3 / AC-S8a3f2e-3-4)。
 *
 * createApp 経由で auditMiddleware / permissionMiddleware を本物通しし、
 * - 書き込み系 (delete) が .loamium/audit.log に記録される (AC-S8a3f2e-3-4)。
 * - read-only モードで POST download / DELETE が 403 (permissionMiddleware)。
 * を検証する。ネットワークには発信しない (delete は FS のみ、download は 403 で
 * ハンドラに到達しない)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../app.js';
import { VaultIndex } from '../noteIndex.js';
import type { ServerConfig } from '../config.js';
import { modelKindDir } from '../model-paths.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loamium-llm-audit-'));
});
afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

async function makeApp(mode: ServerConfig['mode']): Promise<ReturnType<typeof createApp>> {
  const index = new VaultIndex(vaultRoot);
  await index.build();
  const config: ServerConfig = { vaultRoot, mode, maxUploadBytes: 1024 };
  return createApp(config, index);
}

async function readAudit(): Promise<{ op: string; result: string; status: number }[]> {
  const file = path.join(vaultRoot, '.loamium', 'audit.log');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { op: string; result: string; status: number });
}

describe('モデル削除の監査ログ (AC-S8a3f2e-3-4)', () => {
  it('DELETE 成功が audit.log に op=llm.model.delete result=ok で残る', async () => {
    const dir = modelKindDir(vaultRoot, 'llm');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'gone.gguf'), 'x');

    const app = await makeApp('full');
    const res = await app.request('/api/llm/models/gone.gguf', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const entries = await readAudit();
    const del = entries.find((e) => e.op === 'llm.model.delete');
    expect(del).toBeDefined();
    expect(del?.result).toBe('ok');
  });

  it('GET 一覧は監査ログに記録しない (読み取り系)', async () => {
    const app = await makeApp('full');
    await app.request('/api/llm/models');
    const entries = await readAudit();
    expect(entries.find((e) => e.op.startsWith('llm.'))).toBeUndefined();
  });
});

describe('権限モード配線 (read-only)', () => {
  it('read-only で POST download / DELETE は 403 (ハンドラに到達しない)', async () => {
    const app = await makeApp('read-only');

    const dl = await app.request('/api/llm/models/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/a.gguf' }),
    });
    expect(dl.status).toBe(403);

    const del = await app.request('/api/llm/models/x.gguf', { method: 'DELETE' });
    expect(del.status).toBe(403);

    // 403 拒否も監査ログに result=denied で残る。
    const entries = await readAudit();
    expect(entries.some((e) => e.result === 'denied' && e.op.startsWith('llm.'))).toBe(true);
  });
});
