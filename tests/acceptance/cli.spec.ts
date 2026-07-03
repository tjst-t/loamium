/**
 * Story S0c9a48-1「loamium CLI」受け入れテスト。
 * scenario-S0c9a48-1.json を機械的に実行する。
 *
 * test-discipline Rule 2 (cli): packages/cli/bin/loamium.js をサブプロセスとして
 * 起動し、stdout / stderr / exit code / vault 内ファイルを観測する。
 * サーバーも実プロセス (tsx サブプロセス) で、CLI → HTTP → サーバー → ファイルの
 * 全経路を通す。
 */
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { parseStderrJson, runCli } from './helpers/cli.js';

let server: TestServer;

function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** このテストファイル内の全 CLI 呼び出しは LOAMIUM_URL でテストサーバーを指す。 */
function cli(args: string[]): ReturnType<typeof runCli> {
  return runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
}

beforeAll(async () => {
  const vault = await makeTempVault();
  server = await startServer({ vault });
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

describe('[AC-S0c9a48-1-1] loamium の 10 サブコマンドが API と 1:1 で動作する', () => {
  it('write → read → append → patch のノート往復 (ファイルにも反映される)', async () => {
    const write = await cli(['write', 'projects/hydra.md', '# Hydra\n監査ログ設計。[[meeting]] 参照 #dev']);
    expect(write.code).toBe(0);
    expect(write.stdout).toContain('created projects/hydra.md');
    expect(write.stderr).toBe('');

    // ファイルが正本: vault に実ファイルができている
    const onDisk = await readFile(path.join(server.vault, 'projects/hydra.md'), 'utf8');
    expect(onDisk).toContain('監査ログ設計');

    const read = await cli(['read', 'projects/hydra.md']);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain('# Hydra');
    expect(read.stdout).toContain('監査ログ設計');

    const append = await cli(['append', 'projects/hydra.md', '追記行']);
    expect(append.code).toBe(0);
    expect(append.stdout).toContain('appended to projects/hydra.md');
    const afterAppend = await cli(['read', 'projects/hydra.md']);
    expect(afterAppend.stdout).toContain('追記行');

    const patch = await cli([
      'patch',
      'projects/hydra.md',
      '--old',
      '監査ログ設計',
      '--new',
      '監査ログ設計 v2',
    ]);
    expect(patch.code).toBe(0);
    expect(patch.stdout).toContain('patched projects/hydra.md');
    const afterPatch = await cli(['read', 'projects/hydra.md']);
    expect(afterPatch.stdout).toContain('監査ログ設計 v2');

    // 2 回目の write は上書き (updated)
    const overwrite = await cli(['write', 'projects/hydra.md', '# Hydra\n監査ログ設計 v2。[[meeting]] 参照 #dev\n追記行']);
    expect(overwrite.code).toBe(0);
    expect(overwrite.stdout).toContain('updated projects/hydra.md');
  });

  it('journal が今日の YYYY-MM-DD.md を自動生成し、journal-append が追記する (日付指定込み)', async () => {
    const today = localToday();
    const journal = await cli(['journal']);
    expect(journal.code).toBe(0);

    const jappend = await cli(['journal-append', '作業ログ: CLI 実装完了']);
    expect(jappend.code).toBe(0);
    expect(jappend.stdout).toContain(`appended to journal ${today}`);
    expect(jappend.stdout).toContain(`journals/${today}.md`);

    const journalAfter = await cli(['journal']);
    expect(journalAfter.code).toBe(0);
    expect(journalAfter.stdout).toContain('作業ログ: CLI 実装完了');

    // ファイルが正本: journals/{today}.md に実際に追記されている
    const onDisk = await readFile(path.join(server.vault, 'journals', `${today}.md`), 'utf8');
    expect(onDisk).toContain('作業ログ: CLI 実装完了');

    // 過去日付の指定 (journal-append <content> [date] / journal [date])
    const past = await cli(['journal-append', '過去分メモ', '2026-01-15']);
    expect(past.code).toBe(0);
    expect(past.stdout).toContain('appended to journal 2026-01-15');
    const readPast = await cli(['journal', '2026-01-15']);
    expect(readPast.code).toBe(0);
    expect(readPast.stdout).toContain('過去分メモ');
  });

  it('search / backlinks / list / tags がインデックス系 API と 1:1 で動作する', async () => {
    // backlinks のターゲットと絞り込み用のノートを CLI で用意する
    expect((await cli(['write', 'meeting.md', '# Meeting\n#work メモ'])).code).toBe(0);
    expect((await cli(['write', 'inbox/idea.md', 'アイデアメモ #idea'])).code).toBe(0);

    const search = await cli(['search', '監査ログ']);
    expect(search.code).toBe(0);
    expect(search.stdout).toContain('projects/hydra.md');
    expect(search.stdout).toContain('監査ログ設計 v2'); // マッチ行スニペット

    const backlinks = await cli(['backlinks', 'meeting.md']);
    expect(backlinks.code).toBe(0);
    expect(backlinks.stdout).toContain('projects/hydra.md');
    expect(backlinks.stdout).toContain('[[meeting]]');

    const listAll = await cli(['list']);
    expect(listAll.code).toBe(0);
    expect(listAll.stdout).toContain('projects/hydra.md');
    expect(listAll.stdout).toContain('meeting.md');
    expect(listAll.stdout).toContain('inbox/idea.md');

    const listTag = await cli(['list', '--tag', 'dev']);
    expect(listTag.code).toBe(0);
    expect(listTag.stdout).toContain('projects/hydra.md');
    expect(listTag.stdout).not.toContain('inbox/idea.md');

    const listFolder = await cli(['list', '--folder', 'inbox']);
    expect(listFolder.code).toBe(0);
    expect(listFolder.stdout).toContain('inbox/idea.md');
    expect(listFolder.stdout).not.toContain('projects/hydra.md');

    const tags = await cli(['tags']);
    expect(tags.code).toBe(0);
    expect(tags.stdout).toContain('dev\t1');
    expect(tags.stdout).toContain('work\t1');
    expect(tags.stdout).toContain('idea\t1');
  });

  it('--json フラグで API レスポンスの生 JSON をそのまま stdout に出す (全系統)', async () => {
    // 読み取り系: API レスポンスと一致する
    const readJson = await cli(['read', 'projects/hydra.md', '--json']);
    expect(readJson.code).toBe(0);
    const readParsed = JSON.parse(readJson.stdout) as unknown;
    const apiRes = (await (await fetch(`${server.baseUrl}/api/notes/projects/hydra.md`)).json()) as unknown;
    expect(readParsed).toEqual(apiRes);

    // 検索系
    const searchJson = await cli(['search', '監査ログ', '--json']);
    expect(searchJson.code).toBe(0);
    const searchParsed = JSON.parse(searchJson.stdout) as { query: string; results: Array<{ path: string }> };
    expect(searchParsed.query).toBe('監査ログ');
    expect(searchParsed.results.map((r) => r.path)).toContain('projects/hydra.md');

    // 書き込み系
    const writeJson = await cli(['write', 'json-check.md', 'x', '--json']);
    expect(writeJson.code).toBe(0);
    expect(JSON.parse(writeJson.stdout)).toEqual({ path: 'json-check.md', created: true });

    // 構造系
    const tagsJson = await cli(['tags', '--json']);
    expect(tagsJson.code).toBe(0);
    const tagsParsed = JSON.parse(tagsJson.stdout) as { tags: Array<{ tag: string; count: number }> };
    expect(tagsParsed.tags.map((t) => t.tag)).toContain('dev');

    const journalJson = await cli(['journal', '--json']);
    expect(journalJson.code).toBe(0);
    const journalParsed = JSON.parse(journalJson.stdout) as { date: string; path: string };
    expect(journalParsed.date).toBe(localToday());
  });
});

describe('[AC-S0c9a48-1-1] サーバー URL の解決順: LOAMIUM_URL → portman → デフォルト', () => {
  /** `portman port --name loamium` に応答するフェイク portman を PATH 先頭に置く。 */
  async function makeFakePortman(script: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'loamium-fake-portman-'));
    const bin = path.join(dir, 'portman');
    await writeFile(bin, script, 'utf8');
    await chmod(bin, 0o755);
    return dir;
  }

  it('LOAMIUM_URL 未設定なら portman port --name loamium のポートで解決される', async () => {
    const port = new URL(server.baseUrl).port;
    const fakeDir = await makeFakePortman(
      `#!/bin/sh\nif [ "$1" = "port" ] && [ "$3" = "loamium" ]; then echo ${port}; exit 0; fi\nexit 1\n`,
    );
    const res = await runCli(['read', 'projects/hydra.md'], {
      unsetLoamiumUrl: true,
      env: { PATH: `${fakeDir}:${process.env.PATH ?? ''}` },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('# Hydra');
  });

  it('LOAMIUM_URL は portman より優先される', async () => {
    // フェイク portman は誰も listen していないポートを返す — LOAMIUM_URL が勝てば成功する
    const fakeDir = await makeFakePortman('#!/bin/sh\necho 1\nexit 0\n');
    const res = await runCli(['read', 'projects/hydra.md'], {
      env: {
        LOAMIUM_URL: server.baseUrl,
        PATH: `${fakeDir}:${process.env.PATH ?? ''}`,
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('# Hydra');
  });

  it('LOAMIUM_URL も portman も無ければデフォルト http://127.0.0.1:3000 に接続を試みる', async () => {
    // PATH に portman が存在しないディレクトリだけを置く
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'loamium-empty-path-'));
    await mkdir(emptyDir, { recursive: true });
    const res = await runCli(['read', 'anything.md'], {
      unsetLoamiumUrl: true,
      env: { PATH: emptyDir },
    });
    // テスト環境では 3000 に loamium は立っていない前提 — デフォルト URL への到達試行が観測できる
    expect(res.code).not.toBe(0);
    const err = parseStderrJson(res.stderr);
    expect(err.error).toBe('server_unreachable');
    expect(err.message).toContain('http://127.0.0.1:3000');
  });
});

describe('[AC-S0c9a48-1-2] 成功は exit 0 + stdout、失敗は非 0 + stderr に機械可読エラー', () => {
  it('成功時: exit 0、結果は stdout、stderr は空', async () => {
    const res = await cli(['read', 'projects/hydra.md']);
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(0);
    expect(res.stderr).toBe('');
  });

  it('ノート不在: exit 1、stderr に {error: "not_found"} の 1 行 JSON、stdout は空', async () => {
    const res = await cli(['read', 'no-such-note.md']);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    const err = parseStderrJson(res.stderr);
    expect(err.error).toBe('not_found');
    expect(err.message).toContain('no-such-note.md');
  });

  it('patch の old 不在 / 曖昧一致はサーバーの機械可読コードを透過する', async () => {
    const notFound = await cli(['patch', 'projects/hydra.md', '--old', 'zzz存在しない文字列', '--new', 'x']);
    expect(notFound.code).toBe(1);
    expect(parseStderrJson(notFound.stderr).error).toBe('old_not_found');

    expect((await cli(['write', 'dup.md', '同じ行\n同じ行'])).code).toBe(0);
    const ambiguous = await cli(['patch', 'dup.md', '--old', '同じ行', '--new', 'x']);
    expect(ambiguous.code).toBe(1);
    expect(parseStderrJson(ambiguous.stderr).error).toBe('ambiguous_match');
  });

  it('vault 外パス (../ / 絶対パス) は invalid_path で拒否される', async () => {
    const traversal = await cli(['write', '../escape.md', 'x']);
    expect(traversal.code).toBe(1);
    expect(parseStderrJson(traversal.stderr).error).toBe('invalid_path');

    const absolute = await cli(['read', '/etc/passwd']);
    expect(absolute.code).toBe(1);
    expect(parseStderrJson(absolute.stderr).error).toBe('invalid_path');
  });

  it('read-only モードのサーバーへの write は権限拒否 (forbidden) で非 0 終了する', async () => {
    const vault = await makeTempVault();
    const ro = await startServer({ vault, mode: 'read-only' });
    try {
      const res = await runCli(['write', 'a.md', 'x'], { env: { LOAMIUM_URL: ro.baseUrl } });
      expect(res.code).toBe(1);
      const err = parseStderrJson(res.stderr);
      expect(err.error).toBe('forbidden');
      expect(err.message).toContain('read-only');
    } finally {
      await ro.stop();
      await cleanupVault(vault);
    }
  });

  it('サーバー未起動: exit 1、stderr に {error: "server_unreachable"} と起動ヒント', async () => {
    const res = await runCli(['read', 'a.md'], { env: { LOAMIUM_URL: 'http://127.0.0.1:9' } });
    expect(res.code).toBe(1);
    const err = parseStderrJson(res.stderr);
    expect(err.error).toBe('server_unreachable');
    expect(err.message).toContain('http://127.0.0.1:9');
    expect(err.message).toContain('make serve');
  });

  it('使い方エラー (引数不足・不明コマンド・不明フラグ) は exit 2 + {error: "usage"}', async () => {
    const missing = await cli(['read']);
    expect(missing.code).toBe(2);
    const missingErr = parseStderrJson(missing.stderr);
    expect(missingErr.error).toBe('usage');
    expect(missingErr.message).toContain('path');

    const unknown = await cli(['bogus-command']);
    expect(unknown.code).toBe(2);
    expect(parseStderrJson(unknown.stderr).error).toBe('usage');

    const missingOpt = await cli(['patch', 'a.md', '--old', 'x']);
    expect(missingOpt.code).toBe(2);
    expect(parseStderrJson(missingOpt.stderr).error).toBe('usage');
  });

  it('--help は exit 0 で全 10 サブコマンドを表示する', async () => {
    const res = await cli(['--help']);
    expect(res.code).toBe(0);
    for (const cmd of [
      'read',
      'write',
      'append',
      'patch',
      'journal',
      'journal-append',
      'search',
      'backlinks',
      'list',
      'tags',
    ]) {
      expect(res.stdout).toContain(cmd);
    }
  });
});
