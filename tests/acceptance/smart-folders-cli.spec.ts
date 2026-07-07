/**
 * Story S32940c-2「スマートフォルダ CLI」受け入れテスト。
 * scenario-S32940c-2.json scenario-4-cli を機械的に実行する。
 *
 * test-discipline Rule 2 (cli): packages/cli/bin/loamium.js をサブプロセスとして
 * 起動し、stdout / stderr / exit code を観測する。
 * サーバーも実プロセス (tsx サブプロセス) で、CLI → HTTP → サーバー → ファイルの
 * 全経路を通す。
 *
 * カバー: AC-S32940c-2-6
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { runCli } from './helpers/cli.js';

let server: TestServer;

/** このテストファイル内の全 CLI 呼び出しは LOAMIUM_URL でテストサーバーを指す。 */
function cli(args: string[]): ReturnType<typeof runCli> {
  return runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
}

beforeAll(async () => {
  const vault = await makeTempVault();
  // note を 1 件作成してクエリ解決が空でないことを確認
  await mkdir(path.join(vault, '.'), { recursive: true });
  await writeFile(path.join(vault, 'readme.md'), '# Readme\n', 'utf8');
  server = await startServer({ vault });
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

describe('[AC-S32940c-2-6] CLI 1:1 対応 — smart-folders / smart-folder コマンド (scenario-4)', () => {
  /** テスト用の定義 JSON を一時ファイルとして書き出すヘルパー。 */
  async function writeTempJson(obj: unknown): Promise<string> {
    const dir = tmpdir();
    const file = path.join(dir, `sf-test-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(obj), 'utf8');
    return file;
  }

  it('smart-folders set <json-file> が PUT /api/smart-folders と 1:1 (scenario-4 step 1)', async () => {
    const def = {
      version: 1,
      items: [
        {
          kind: 'query',
          id: 'recent',
          name: '最近の更新',
          dql: 'LIST SORT file.mtime DESC LIMIT 5',
        },
        { kind: 'pin', id: 'readme', name: 'README', path: 'readme.md' },
      ],
    };
    const jsonFile = await writeTempJson(def);
    const result = await cli(['smart-folders', 'set', jsonFile]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    // human-readable output contains saved count
    expect(result.stdout).toContain('2');
  });

  it('smart-folders --json が GET /api/smart-folders の生 JSON を返す (scenario-4 step 2)', async () => {
    const result = await cli(['smart-folders', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as unknown;
    expect(parsed).toMatchObject({ version: expect.any(Number), items: expect.any(Array) });
  });

  it('smart-folders (no --json) が id/kind/name 形式で一覧を表示する', async () => {
    const result = await cli(['smart-folders']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    // each line: id TAB kind TAB name
    expect(result.stdout).toContain('recent\tquery');
    expect(result.stdout).toContain('readme\tpin');
  });

  it('smart-folder <id> --json が解決された NoteMeta 配列を stdout に返す (scenario-4 step 3)', async () => {
    const result = await cli(['smart-folder', 'recent', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as unknown;
    expect(parsed).toMatchObject({ notes: expect.any(Array) });
  });

  it('smart-folder <id> (no --json) がパスを 1 行ずつ表示する', async () => {
    // pin の readme が存在するので少なくとも 1 件
    const result = await cli(['smart-folder', 'readme']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('readme.md');
  });

  it('smart-folders set で空定義に戻せる (cleanup)', async () => {
    const emptyDef = { version: 1, items: [] };
    const jsonFile = await writeTempJson(emptyDef);
    const result = await cli(['smart-folders', 'set', jsonFile]);
    expect(result.code).toBe(0);

    // 確認: GET で空になっている
    const getResult = await cli(['smart-folders', '--json']);
    expect(getResult.code).toBe(0);
    const parsed = JSON.parse(getResult.stdout) as { version: number; items: unknown[] };
    expect(parsed.items).toHaveLength(0);
  });

  it('存在しない id で smart-folder は exit 1 + stderr に機械可読エラー', async () => {
    const result = await cli(['smart-folder', 'no-such-id']);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).not.toBe('');
    const err = JSON.parse(result.stderr.trim()) as { error: string };
    expect(err.error).toBe('not_found');
  });

  it('存在しないファイルを smart-folders set に渡すと exit 1', async () => {
    const result = await cli(['smart-folders', 'set', '/tmp/no-such-file-xyz.json']);
    expect(result.code).toBe(1);
  });
});
