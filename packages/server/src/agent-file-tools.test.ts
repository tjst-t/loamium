/**
 * エージェント添付ファイルツールのユニットテスト (agent-write-coverage / ADR-0016)。
 *
 * file_write (作成/上書き・サイズ超過・deny・base64)、file_move (移動 + ![[リンク]] 追従・
 * 衝突・deny)、file_delete (削除・対象なし・deny)、無効ケーパビリティ非広告。
 * すべて REST と同一の file-service を経由し、成功時に audit.log を記録する。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { VaultIndex } from './noteIndex.js';
import { createFileTools, FILE_TOOL_NAMES } from './agent-file-tools.js';
import type { ServerConfig } from './config.js';
import type { Capability } from '@loamium/shared';

const noSignal = undefined;
const noUpdate = undefined;
const fakeCtx = {} as Parameters<
  ReturnType<typeof createFileTools>[number]['execute']
>[4];

type ExecResult = Awaited<ReturnType<ReturnType<typeof createFileTools>[number]['execute']>>;

function textOf(result: ExecResult): string {
  const first = result.content[0];
  if (first && first.type === 'text') return first.text;
  return '';
}

function detailsOf(
  result: ExecResult,
): { error?: boolean; created?: boolean; deleted?: boolean; path?: string } {
  const d = result.details;
  if (typeof d === 'object' && d !== null) {
    return d as { error?: boolean; created?: boolean; deleted?: boolean; path?: string };
  }
  return {};
}

function makeConfig(vaultRoot: string, maxUploadBytes = 1024): ServerConfig {
  return { vaultRoot, mode: 'full', maxUploadBytes };
}

async function readAudit(vaultRoot: string): Promise<{ op: string; path: string }[]> {
  try {
    const raw = await readFile(path.join(vaultRoot, '.loamium', 'audit.log'), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { op: string; path: string });
  } catch {
    return [];
  }
}

describe('createFileTools', () => {
  let vaultRoot: string;
  let index: VaultIndex;
  let config: ServerConfig;
  const noDeny = (_rel: string): boolean => false;
  const CAPS: Capability[] = ['file_write'];

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agent-file-test-'));
    index = new VaultIndex(vaultRoot);
    config = makeConfig(vaultRoot);
  });

  function tool(name: string, caps: Capability[] = CAPS, isDenied = noDeny, cfg = config) {
    const tools = createFileTools(cfg, index, isDenied, caps);
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not generated: ${name}`);
    return t;
  }

  // ---- 広告制御 ---------------------------------------------------------------

  it('file_write cap で 3 ツールが生成される (sorted 一致)', () => {
    const names = createFileTools(config, index, noDeny, CAPS)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([...FILE_TOOL_NAMES].sort());
  });

  it('file_write cap が無いと広告されない (0 個)', () => {
    expect(createFileTools(config, index, noDeny, ['note_create'])).toHaveLength(0);
    expect(createFileTools(config, index, noDeny, [])).toHaveLength(0);
  });

  // ---- file_write -------------------------------------------------------------

  it('file_write が添付ファイルを作成する (utf8 既定)', async () => {
    const res = await tool('file_write').execute(
      't1',
      { path: 'assets/note.txt', content: 'hello' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).created).toBe(true);
    expect(await readFile(path.join(vaultRoot, 'assets', 'note.txt'), 'utf8')).toBe('hello');
    expect((await readAudit(vaultRoot)).map((e) => e.op)).toContain('agent.file_write');
  });

  it('file_write は既存を overwrite なしでは拒否、overwrite:true で上書きする', async () => {
    await mkdir(path.join(vaultRoot, 'assets'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'assets', 'x.txt'), 'OLD', 'utf8');
    const ft = tool('file_write');
    const denied = await ft.execute(
      't1',
      { path: 'assets/x.txt', content: 'NEW' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(denied).error).toBe(true);
    expect(await readFile(path.join(vaultRoot, 'assets', 'x.txt'), 'utf8')).toBe('OLD');
    const ok = await ft.execute(
      't2',
      { path: 'assets/x.txt', content: 'NEW', overwrite: true },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(ok).error).toBeUndefined();
    expect(detailsOf(ok).created).toBe(false);
    expect(await readFile(path.join(vaultRoot, 'assets', 'x.txt'), 'utf8')).toBe('NEW');
  });

  it('file_write は base64 でバイナリを書ける', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const res = await tool('file_write').execute(
      't1',
      { path: 'assets/img.png', content: bytes.toString('base64'), encoding: 'base64' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).created).toBe(true);
    const written = await readFile(path.join(vaultRoot, 'assets', 'img.png'));
    expect(Buffer.compare(written, bytes)).toBe(0);
  });

  it('file_write はサイズ上限超過をエラーにする', async () => {
    const small = makeConfig(vaultRoot, 4);
    const res = await tool('file_write', CAPS, noDeny, small).execute(
      't1',
      { path: 'big.bin', content: 'abcdefgh' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/サイズ上限/);
    await expect(readFile(path.join(vaultRoot, 'big.bin'))).rejects.toThrow();
  });

  it('file_write は .md を拒否 (ノート API へ誘導)', async () => {
    const res = await tool('file_write').execute(
      't1',
      { path: 'note.md', content: '# x' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/ノート API/);
  });

  it('file_write は deny / vault 脱出を拒否する', async () => {
    const denyPrivate = (rel: string): boolean => rel.startsWith('private/');
    const ft = tool('file_write', CAPS, denyPrivate);
    const d = await ft.execute(
      't1',
      { path: 'private/a.txt', content: 'x' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(d).error).toBe(true);
    const esc = await tool('file_write').execute(
      't2',
      { path: '../escape.txt', content: 'x' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(esc).error).toBe(true);
  });

  // ---- file_move --------------------------------------------------------------

  it('file_move が移動 + ![[リンク]]追従する', async () => {
    await mkdir(path.join(vaultRoot, 'assets'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'assets', 'old.png'), 'IMG', 'utf8');
    await writeFile(path.join(vaultRoot, 'ref.md'), 'embed ![[old.png]]\n', 'utf8');
    const res = await tool('file_move').execute(
      't1',
      { from: 'assets/old.png', to: 'assets/new.png' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBeUndefined();
    await expect(readFile(path.join(vaultRoot, 'assets', 'old.png'), 'utf8')).rejects.toThrow();
    expect(await readFile(path.join(vaultRoot, 'assets', 'new.png'), 'utf8')).toBe('IMG');
    expect(await readFile(path.join(vaultRoot, 'ref.md'), 'utf8')).toBe('embed ![[new.png]]\n');
    expect((await readAudit(vaultRoot)).map((e) => e.op)).toContain('agent.file_move');
  });

  it('file_move は移動先が既存なら拒否する', async () => {
    await mkdir(path.join(vaultRoot, 'assets'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'assets', 'a.png'), 'A', 'utf8');
    await writeFile(path.join(vaultRoot, 'assets', 'b.png'), 'B', 'utf8');
    const res = await tool('file_move').execute(
      't1',
      { from: 'assets/a.png', to: 'assets/b.png' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
    expect(await readFile(path.join(vaultRoot, 'assets', 'a.png'), 'utf8')).toBe('A');
  });

  it('file_move は from が存在しないとエラー', async () => {
    const res = await tool('file_move').execute(
      't1',
      { from: 'nope.png', to: 'dst.png' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
  });

  it('file_move は from/to の deny を両方拒否する', async () => {
    await mkdir(path.join(vaultRoot, 'private'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'private', 's.png'), 'S', 'utf8');
    await writeFile(path.join(vaultRoot, 'pub.png'), 'P', 'utf8');
    const denyPrivate = (rel: string): boolean => rel.startsWith('private/');
    const mt = tool('file_move', CAPS, denyPrivate);
    const r1 = await mt.execute(
      't1',
      { from: 'private/s.png', to: 'moved.png' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(r1).error).toBe(true);
    const r2 = await mt.execute(
      't2',
      { from: 'pub.png', to: 'private/x.png' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(r2).error).toBe(true);
    expect(await readFile(path.join(vaultRoot, 'pub.png'), 'utf8')).toBe('P');
  });

  // ---- file_delete ------------------------------------------------------------

  it('file_delete が既存の添付を削除する', async () => {
    await mkdir(path.join(vaultRoot, 'assets'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'assets', 'gone.png'), 'G', 'utf8');
    const res = await tool('file_delete').execute(
      't1',
      { path: 'assets/gone.png' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).deleted).toBe(true);
    await expect(readFile(path.join(vaultRoot, 'assets', 'gone.png'), 'utf8')).rejects.toThrow();
    expect((await readAudit(vaultRoot)).map((e) => e.op)).toContain('agent.file_delete');
  });

  it('file_delete は存在しない path をエラーにせず「対象なし」を返す', async () => {
    const res = await tool('file_delete').execute(
      't1',
      { path: 'assets/nope.png' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBeUndefined();
    expect(detailsOf(res).deleted).toBeUndefined();
    expect(textOf(res)).toMatch(/対象なし/);
  });

  it('file_delete は deny を拒否する (ファイルは残る)', async () => {
    await mkdir(path.join(vaultRoot, 'private'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'private', 'keep.png'), 'K', 'utf8');
    const denyPrivate = (rel: string): boolean => rel.startsWith('private/');
    const res = await tool('file_delete', CAPS, denyPrivate).execute(
      't1',
      { path: 'private/keep.png' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
    expect(await readFile(path.join(vaultRoot, 'private', 'keep.png'), 'utf8')).toBe('K');
  });
});
