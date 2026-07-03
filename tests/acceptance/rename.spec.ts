/**
 * Story S6fbf45-3「リネーム時のリンク追従」受け入れテスト。
 * scenario-S6fbf45-3.json を機械的に実行する。
 *
 * test-discipline Rule 2 (api / cli): 実サーバー (tsx サブプロセス) を実 HTTP
 * クライアントで叩き、CLI は配布 bin (packages/cli/bin/loamium.js) の
 * サブプロセスで検証する。vault はテストごとの一時ディレクトリ。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { parseStderrJson, runCli } from './helpers/cli.js';

interface RenameResponse {
  oldPath: string;
  path: string;
  mtime: number;
  updatedNotes: { path: string; links: number }[];
  updatedLinks: number;
}

interface ErrorBody {
  error: string;
  message: string;
}

let server: TestServer;
let vault: string;

async function postRename(rel: string, newPath: string): Promise<Response> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return fetch(`${server.baseUrl}/api/notes/${encoded}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newPath }),
  });
}

async function readVaultFile(rel: string): Promise<string> {
  return readFile(path.join(vault, rel), 'utf8');
}

async function fileExists(rel: string): Promise<boolean> {
  try {
    return (await stat(path.join(vault, rel))).isFile();
  } catch {
    return false;
  }
}

const REF_A = [
  'プレーン [[旧トピック]] 参照。',
  '見出し付き [[旧トピック#設計]] 参照。',
  'エイリアス [[旧トピック|別名]] 参照。',
  '埋め込み ![[旧トピック]] 参照。',
  '',
].join('\n');

const REF_B = [
  'フルパス [[topic/旧トピック]] 参照。',
  '',
  '```text',
  'コードフェンス内 [[旧トピック]] は不変。',
  '```',
  '',
  'インラインコード `[[旧トピック]]` も不変。',
  '',
].join('\n');

beforeAll(async () => {
  vault = await makeTempVault();
  await mkdir(path.join(vault, 'topic'), { recursive: true });
  await mkdir(path.join(vault, 'refs'), { recursive: true });
  await mkdir(path.join(vault, 'dup'), { recursive: true });
  await writeFile(
    path.join(vault, 'topic/旧トピック.md'),
    '# 旧トピック\n\n自己参照 [[旧トピック]] も追従する。\n',
    'utf8',
  );
  await writeFile(path.join(vault, 'refs/a.md'), REF_A, 'utf8');
  await writeFile(path.join(vault, 'refs/b.md'), REF_B, 'utf8');
  // 曖昧リンク: [[メモ]] は浅いパス優先でルートの メモ.md に解決される
  await writeFile(path.join(vault, 'メモ.md'), 'ルートのメモ。\n', 'utf8');
  await writeFile(path.join(vault, 'dup/メモ.md'), 'フォルダ内のメモ。\n', 'utf8');
  await writeFile(path.join(vault, 'amb.md'), '曖昧参照 [[メモ]] はルート向き。\n', 'utf8');
  // 409 用
  await writeFile(path.join(vault, 'existing.md'), '既存ノート。\n', 'utf8');
  await writeFile(path.join(vault, 'other.md'), 'リネーム元 [[existing]]。\n', 'utf8');
  server = await startServer({ vault });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  if (vault) await cleanupVault(vault);
});

describe('[AC-S6fbf45-3-1] POST /api/notes/{path}/rename が vault 内の全 [[旧名]] を書き換える', () => {
  it('リネームでファイルが移動し、plain/heading/alias/embed/フルパス形式のリンクが追従する', async () => {
    const res = await postRename('topic/旧トピック.md', 'topic/新トピック.md');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RenameResponse;
    expect(body.oldPath).toBe('topic/旧トピック.md');
    expect(body.path).toBe('topic/新トピック.md');
    expect(body.mtime).toBeGreaterThan(0);

    // ファイル移動 (旧パス消滅・新パスに本文 + 自己リンクも書き換え)
    expect(await fileExists('topic/旧トピック.md')).toBe(false);
    expect(await readVaultFile('topic/新トピック.md')).toBe(
      '# 旧トピック\n\n自己参照 [[新トピック]] も追従する。\n',
    );

    // 参照元: 4 形式すべて追従、装飾 (heading / alias / embed) は保存
    expect(await readVaultFile('refs/a.md')).toBe(
      [
        'プレーン [[新トピック]] 参照。',
        '見出し付き [[新トピック#設計]] 参照。',
        'エイリアス [[新トピック|別名]] 参照。',
        '埋め込み ![[新トピック]] 参照。',
        '',
      ].join('\n'),
    );

    // フルパス形式も追従。コードフェンス・インラインコード内は不変
    expect(await readVaultFile('refs/b.md')).toBe(
      [
        'フルパス [[新トピック]] 参照。',
        '',
        '```text',
        'コードフェンス内 [[旧トピック]] は不変。',
        '```',
        '',
        'インラインコード `[[旧トピック]]` も不変。',
        '',
      ].join('\n'),
    );

    // レスポンスの内訳 (自己リンク 1 + refs/a 4 + refs/b 1 = 6)
    expect(body.updatedLinks).toBe(6);
    const byPath = new Map(body.updatedNotes.map((u) => [u.path, u.links]));
    expect(byPath.get('topic/新トピック.md')).toBe(1);
    expect(byPath.get('refs/a.md')).toBe(4);
    expect(byPath.get('refs/b.md')).toBe(1);
  });

  it('バックリンクインデックスが新パスに追従する', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/backlinks?path=${encodeURIComponent('topic/新トピック.md')}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backlinks: { source: string }[] };
    const sources = body.backlinks.map((b) => b.source).sort();
    expect(sources).toEqual(['refs/a.md', 'refs/b.md']);

    const old = await fetch(
      `${server.baseUrl}/api/backlinks?path=${encodeURIComponent('topic/旧トピック.md')}`,
    );
    const oldBody = (await old.json()) as { backlinks: { source: string }[] };
    expect(oldBody.backlinks).toEqual([]);
  });

  it('リネームが監査ログに note.rename として記録される', async () => {
    const log = await readFile(path.join(vault, '.loamium/audit.log'), 'utf8');
    const entries = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { op: string; path: string; result: string });
    const rename = entries.filter((e) => e.op === 'note.rename' && e.result === 'ok');
    expect(rename.length).toBeGreaterThanOrEqual(1);
    expect(rename.at(-1)?.path).toBe('topic/旧トピック.md');
  });

  it('別ノートに解決される同名 basename の曖昧リンクは書き換えない (データ安全性)', async () => {
    const res = await postRename('dup/メモ.md', 'dup/メモ2.md');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RenameResponse;
    // amb.md の [[メモ]] はルートの メモ.md に解決されるので対象外
    expect(body.updatedLinks).toBe(0);
    expect(await readVaultFile('amb.md')).toBe('曖昧参照 [[メモ]] はルート向き。\n');
    expect(await fileExists('dup/メモ2.md')).toBe(true);
  });

  it('リネーム先が既存なら 409 で拒否し、ファイル・リンクを一切変更しない (部分適用なし)', async () => {
    const res = await postRename('other.md', 'existing.md');
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe('conflict');
    expect(await readVaultFile('other.md')).toBe('リネーム元 [[existing]]。\n');
    expect(await readVaultFile('existing.md')).toBe('既存ノート。\n');
  });

  it('存在しないノートのリネームは 404、不正な newPath は 400', async () => {
    const notFound = await postRename('no-such-note.md', 'anything.md');
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as ErrorBody).error).toBe('not_found');

    const invalid = await postRename('existing.md', '../escape.md');
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as ErrorBody).error).toBe('invalid_path');
    expect(await fileExists('existing.md')).toBe(true);
  });

  it('同名へのリネームは no-op (冪等)', async () => {
    const res = await postRename('existing.md', 'existing.md');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RenameResponse;
    expect(body.path).toBe('existing.md');
    expect(body.updatedLinks).toBe(0);
    expect(await readVaultFile('existing.md')).toBe('既存ノート。\n');
  });

  it('read-only モードでは 403 で拒否され、監査ログに denied が残る', async () => {
    const roVault = await makeTempVault();
    await writeFile(path.join(roVault, 'note.md'), '本文。\n', 'utf8');
    const ro = await startServer({ vault: roVault, mode: 'read-only' });
    try {
      const res = await fetch(`${ro.baseUrl}/api/notes/note.md/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newPath: 'renamed.md' }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorBody).error).toBe('forbidden');
      const log = await readFile(path.join(roVault, '.loamium/audit.log'), 'utf8');
      const entries = log
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { op: string; result: string });
      expect(entries.some((e) => e.op === 'note.rename' && e.result === 'denied')).toBe(true);
    } finally {
      await ro.stop();
      await cleanupVault(roVault);
    }
  }, 30_000);
});

describe('[AC-S6fbf45-3-1] loamium rename CLI (REST と 1:1)', () => {
  it('rename が成功し、書き換えの内訳を stdout に出す', async () => {
    await writeFile(path.join(vault, 'cli-old.md'), '# CLI\n', 'utf8');
    await writeFile(path.join(vault, 'cli-ref.md'), '参照 [[cli-old]]。\n', 'utf8');
    const res = await runCli(['rename', 'cli-old.md', 'cli-new.md'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('renamed cli-old.md -> cli-new.md');
    expect(res.stdout).toContain('cli-ref.md');
    expect(await readVaultFile('cli-ref.md')).toBe('参照 [[cli-new]]。\n');
    expect(await fileExists('cli-new.md')).toBe(true);
  });

  it('--json で API レスポンスの生 JSON をそのまま出す', async () => {
    await writeFile(path.join(vault, 'cli-json-old.md'), '# J\n', 'utf8');
    const res = await runCli(['rename', 'cli-json-old.md', 'cli-json-new.md', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as RenameResponse;
    expect(body.oldPath).toBe('cli-json-old.md');
    expect(body.path).toBe('cli-json-new.md');
    expect(Array.isArray(body.updatedNotes)).toBe(true);
  });

  it('リネーム先が既存なら exit 1 + stderr に 1 行 JSON (conflict)', async () => {
    const res = await runCli(['rename', 'cli-new.md', 'existing.md'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(1);
    expect(parseStderrJson(res.stderr).error).toBe('conflict');
  });
});
