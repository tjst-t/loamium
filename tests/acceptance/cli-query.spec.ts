/**
 * Story Sb1593c-1「loamium query」受け入れテスト。
 * scenario-Sb1593c-1.json (cli) を機械的に実行する。
 *
 * test-discipline Rule 2 (cli): packages/cli/bin/loamium.js をサブプロセスとして
 * 起動し、stdout / stderr / exit code を観測する (POST /api/query と 1:1)。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryResponseSchema } from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { parseStderrJson, runCli } from './helpers/cli.js';

let server: TestServer;

function cli(args: string[]): ReturnType<typeof runCli> {
  return runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
}

beforeAll(async () => {
  const vault = await makeTempVault();
  await mkdir(path.join(vault, 'projects'), { recursive: true });
  await writeFile(
    path.join(vault, 'projects/hydra.md'),
    ['---', 'status: in-progress', '---', '# hydra', '', '#project', '', '- [ ] DNS を切り替える', '- [x] 設計を書く', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(vault, 'projects/garden.md'),
    ['---', 'status: done', 'tags: [project]', '---', '# garden', ''].join('\n'),
    'utf8',
  );
  server = await startServer({ vault });
}, 30_000);

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

describe('[AC-Sb1593c-1-3] loamium query が API と 1:1 で動作する', () => {
  it('LIST from #tag: 対象ノートのパスを 1 行ずつ出力する', async () => {
    const res = await cli(['query', 'LIST from #project']);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('projects/garden.md\nprojects/hydra.md\n');
  });

  it('TABLE where sort: ヘッダ + タブ区切りで出力する', async () => {
    const res = await cli(['query', 'TABLE status from "projects" where status != "done" sort status']);
    expect(res.code).toBe(0);
    const lines = res.stdout.trim().split('\n');
    expect(lines[0]).toBe('path\tstatus');
    expect(lines[1]).toBe('projects/hydra.md\tin-progress');
    expect(lines).toHaveLength(2);
  });

  it('TASK: path:line: [x] text 形式で出力する', async () => {
    const res = await cli(['query', 'TASK where !completed']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('projects/hydra.md:8: [ ] DNS を切り替える\n');

    const done = await cli(['query', 'TASK where completed']);
    expect(done.code).toBe(0);
    expect(done.stdout).toBe('projects/hydra.md:9: [x] 設計を書く\n');
  });

  it('--json は API レスポンスの生 JSON をそのまま出力する (スキーマ適合)', async () => {
    const res = await cli(['query', 'LIST from #project', '--json']);
    expect(res.code).toBe(0);
    const parsed = queryResponseSchema.parse(JSON.parse(res.stdout));
    expect(parsed.type).toBe('list');
    if (parsed.type === 'list') {
      expect(parsed.results.map((r) => r.path)).toEqual(['projects/garden.md', 'projects/hydra.md']);
    }
  });

  it('構文エラーは非 0 exit + stderr に位置情報付きの 1 行 JSON', async () => {
    const res = await cli(['query', 'LIST form #reading']);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    const err = parseStderrJson(res.stderr);
    expect(err.error).toBe('query_syntax');
    expect(err.message).toContain('1 行 6 列');
    expect(err.message).toContain("'form'");
  });

  it('引数なしは exit 2 の usage エラー', async () => {
    const res = await cli(['query']);
    expect(res.code).toBe(2);
    const err = parseStderrJson(res.stderr);
    expect(err.error).toBe('usage');
  });

  it('サーバー未起動は server_unreachable (exit 1)', async () => {
    const res = await runCli(['query', 'LIST'], {
      env: { LOAMIUM_URL: 'http://127.0.0.1:9' },
    });
    expect(res.code).toBe(1);
    expect(parseStderrJson(res.stderr).error).toBe('server_unreachable');
  });
});
