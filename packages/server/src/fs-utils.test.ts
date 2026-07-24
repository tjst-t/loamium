import { describe, it, expect, vi, afterEach } from 'vitest';

// node:fs/promises の mkdir を差し替えて、bun/Windows の EEXIST 挙動を決定的に再現する
// (実環境の bun-on-Windows を用意せずに ensureDir の分岐を検証する)。
const mkdirMock = vi.fn<(dir: string, opts: unknown) => Promise<void>>();
vi.mock('node:fs/promises', () => ({
  mkdir: (dir: string, opts: unknown) => mkdirMock(dir, opts),
}));

const { ensureDir } = await import('./fs-utils.js');

afterEach(() => {
  mkdirMock.mockReset();
});

describe('ensureDir', () => {
  it('mkdir を recursive:true で呼ぶ', async () => {
    mkdirMock.mockResolvedValue(undefined);
    await ensureDir('/x/y');
    expect(mkdirMock).toHaveBeenCalledWith('/x/y', { recursive: true });
  });

  it('EEXIST (bun on Windows で既存ディレクトリ) を握りつぶして解決する', async () => {
    const err = Object.assign(new Error('file already exists'), { code: 'EEXIST' });
    mkdirMock.mockRejectedValue(err);
    await expect(ensureDir('/x/y')).resolves.toBeUndefined();
  });

  it('EEXIST 以外 (EACCES 等) はそのまま投げる', async () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mkdirMock.mockRejectedValue(err);
    await expect(ensureDir('/x/y')).rejects.toThrow('permission denied');
  });
});
