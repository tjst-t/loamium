/**
 * system/ 設定ファイルの一覧 + source read/write API テスト (Sa10026-9 #1)。
 *
 * - GET /api/system-files が system/** の yaml + md をフォルダ構造付きで列挙する
 *   (settings.yaml / smart-folders/*.yaml / templates/*.md / commands/*.yaml を含む)。
 * - GET/PUT /api/system-files/{path}/source が yaml / md の生テキストを読み書きする。
 * - system/ 外・traversal・hidden は 400 invalid_path。
 * - read-only モードでは PUT が 403 (permissionMiddleware が mutate として止める)。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../app.js';
import { VaultIndex } from '../noteIndex.js';
import type { ServerConfig } from '../config.js';

async function makeApp(mode: ServerConfig['mode']): Promise<{
  app: ReturnType<typeof createApp>;
  vaultRoot: string;
}> {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-system-files-'));
  const sys = path.join(vaultRoot, 'system');
  await mkdir(path.join(sys, 'smart-folders'), { recursive: true });
  await mkdir(path.join(sys, 'templates'), { recursive: true });
  await mkdir(path.join(sys, 'commands'), { recursive: true });
  await writeFile(path.join(sys, 'settings.yaml'), 'theme: system\ndefaultFolder: hoge\n', 'utf8');
  await writeFile(path.join(sys, 'smart-folders', 'recent.yaml'), 'title: recent\nquery: file.mtime\n', 'utf8');
  await writeFile(path.join(sys, 'templates', 'journal.md'), '---\ntitle: J\n---\n# hi\n', 'utf8');
  await writeFile(path.join(sys, 'commands', 'todo.yaml'), 'name: todo\n', 'utf8');
  // .loamium は隠し領域 (列挙されないことの確認用)
  await mkdir(path.join(vaultRoot, '.loamium'), { recursive: true });
  const index = new VaultIndex(vaultRoot);
  await index.build();
  const config: ServerConfig = { vaultRoot, mode, maxUploadBytes: 1024 };
  return { app: createApp(config, index), vaultRoot };
}

describe('GET /api/system-files (Sa10026-9 #1)', () => {
  let vaultRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const made = await makeApp('full');
    app = made.app;
    vaultRoot = made.vaultRoot;
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('settings.yaml / smart-folders/*.yaml / templates/*.md / commands/*.yaml をすべて列挙する', async () => {
    const res = await app.request('/api/system-files');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { path: string; size: number; mtime: number }[] };
    const paths = body.files.map((f) => f.path);
    expect(paths).toContain('system/settings.yaml');
    expect(paths).toContain('system/smart-folders/recent.yaml');
    expect(paths).toContain('system/templates/journal.md');
    expect(paths).toContain('system/commands/todo.yaml');
    // 昇順・size/mtime 付き
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const f of body.files) {
      expect(typeof f.size).toBe('number');
      expect(typeof f.mtime).toBe('number');
      // 隠し領域は含まない
      expect(f.path.startsWith('.loamium')).toBe(false);
    }
  });

  it('GET source で yaml の生テキストを返す', async () => {
    const res = await app.request('/api/system-files/system/settings.yaml/source');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; content: string; mtime: number };
    expect(body.path).toBe('system/settings.yaml');
    expect(body.content).toContain('defaultFolder: hoge');
  });

  it('PUT source で yaml を書き込み、ディスクに反映される', async () => {
    const res = await app.request('/api/system-files/system/settings.yaml/source', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'theme: dark\ndefaultFolder: fuga\n' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; created: boolean; mtime: number };
    expect(body.path).toBe('system/settings.yaml');
    expect(body.created).toBe(false);
    const onDisk = await readFile(path.join(vaultRoot, 'system', 'settings.yaml'), 'utf8');
    expect(onDisk).toContain('defaultFolder: fuga');
  });

  it('system/ 外のパスは 400 invalid_path', async () => {
    const res = await app.request('/api/system-files/projects/foo.md/source');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_path');
  });

  it('traversal は 400 invalid_path', async () => {
    const res = await app.request('/api/system-files/system/..%2F..%2Fetc%2Fpasswd/source');
    expect(res.status).toBe(400);
  });

  it('存在しない system ファイルは 404', async () => {
    const res = await app.request('/api/system-files/system/nope.yaml/source');
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/system-files/{path}/source in read-only mode', () => {
  let vaultRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const made = await makeApp('read-only');
    app = made.app;
    vaultRoot = made.vaultRoot;
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('read-only では書き込みが 403 で拒否される', async () => {
    const res = await app.request('/api/system-files/system/settings.yaml/source', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x: 1\n' }),
    });
    expect(res.status).toBe(403);
    // 元の内容が保たれている
    const onDisk = await readFile(path.join(vaultRoot, 'system', 'settings.yaml'), 'utf8');
    expect(onDisk).toContain('defaultFolder: hoge');
  });
});
