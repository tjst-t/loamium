/**
 * ModelDownloadManager のユニットテスト (S8a3f2e-3 / AC-S8a3f2e-3-2)。
 * 封じ込め・進捗報告・完了/失敗を、スタブ fetch で検証する (実 URL へ発信しない)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import {
  ModelDownloadManager,
  deriveFilenameFromUrl,
  InvalidModelFilenameError,
  type FetchFn,
} from './model-download.js';
import { modelKindDir } from './model-paths.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loamium-dl-'));
});
afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

function bodyFetch(bytes: Buffer, withLength = true): FetchFn {
  return () =>
    Promise.resolve(
      new Response(Readable.toWeb(Readable.from([bytes])) as ReadableStream, {
        status: 200,
        headers: withLength ? { 'content-length': String(bytes.length) } : {},
      }),
    );
}

describe('deriveFilenameFromUrl', () => {
  it('URL 末尾からファイル名を取り出す', () => {
    expect(deriveFilenameFromUrl('https://hf.co/repo/qwen.gguf')).toBe('qwen.gguf');
    expect(deriveFilenameFromUrl('https://hf.co/a/b/model-q4.gguf?x=1')).toBe('model-q4.gguf');
  });
});

describe('ModelDownloadManager.start', () => {
  it('llm/ 配下に保存し completed + 進捗を記録する', async () => {
    const dm = new ModelDownloadManager(vaultRoot, bodyFetch(Buffer.from('HELLO')));
    const job = dm.start('https://ex.com/a.gguf');
    await job.done;
    expect(job.status).toBe('completed');
    expect(job.receivedBytes).toBe(5);
    expect(job.totalBytes).toBe(5);
    const saved = path.join(modelKindDir(vaultRoot, 'llm'), 'a.gguf');
    expect(await fs.readFile(saved, 'utf8')).toBe('HELLO');
  });

  it('Content-Length 無しでも受信バイトは計上し totalBytes=null', async () => {
    const dm = new ModelDownloadManager(vaultRoot, bodyFetch(Buffer.from('ABCD'), false));
    const job = dm.start('https://ex.com/b.gguf');
    await job.done;
    expect(job.status).toBe('completed');
    expect(job.receivedBytes).toBe(4);
    expect(job.totalBytes).toBeNull();
  });

  it('HTTP 非 2xx は failed + error、部分ファイルを残さない', async () => {
    const dm = new ModelDownloadManager(vaultRoot, () =>
      Promise.resolve(new Response('x', { status: 500 })),
    );
    const job = dm.start('https://ex.com/c.gguf');
    await job.done;
    expect(job.status).toBe('failed');
    expect(job.error).toContain('500');
    await expect(
      fs.stat(path.join(modelKindDir(vaultRoot, 'llm'), 'c.gguf.partial')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('封じ込め: パストラバーサル名は FS 前に投げる', () => {
    const dm = new ModelDownloadManager(vaultRoot, bodyFetch(Buffer.from('x')));
    expect(() => dm.start('https://ex.com/a.gguf', '../evil.gguf')).toThrow(
      InvalidModelFilenameError,
    );
    expect(() => dm.start('https://ex.com/a.gguf', 'sub/x.gguf')).toThrow(
      InvalidModelFilenameError,
    );
  });
});
