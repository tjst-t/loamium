/**
 * S31ba00-3 ファイル監視とインデックス再構築 — 受け入れテスト。
 *
 * API を経由せず fs で vault を直接変更し (外部エディタ / Git 相当)、
 * 実サーバーの検索・バックリンク結果に反映されることをポーリングで検証する。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

interface SearchResponse {
  results: { path: string; snippet: string }[];
}
interface BacklinksResponse {
  backlinks: { source: string }[];
}

let server: TestServer;
let vault: string;

const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

/** 条件が満たされるまでポーリングする。タイムアウトで最後の値を返す (アサートは呼び出し側)。 */
async function pollUntil<T>(fetchValue: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = await fetchValue();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    last = await fetchValue();
  }
  return last;
}

async function searchPaths(q: string): Promise<string[]> {
  const res = await fetch(`${server.baseUrl}/api/search?q=${encodeURIComponent(q)}`);
  const body = (await res.json()) as SearchResponse;
  return body.results.map((r) => r.path);
}

async function backlinkSources(target: string): Promise<string[]> {
  const res = await fetch(`${server.baseUrl}/api/backlinks?path=${encodeURIComponent(target)}`);
  const body = (await res.json()) as BacklinksResponse;
  return body.backlinks.map((b) => b.source);
}

beforeAll(async () => {
  vault = await makeTempVault();
  await mkdir(path.join(vault, 'notes'), { recursive: true });
  await writeFile(path.join(vault, 'notes/target.md'), '# Target\n\n本文。\n', 'utf8');
  server = await startServer({ vault });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await cleanupVault(vault);
});

describe('[AC-S31ba00-3-1] external file changes are reflected in search and backlinks', () => {
  it('picks up a file added outside the API (search + backlinks)', async () => {
    await writeFile(
      path.join(vault, 'notes/external.md'),
      '外部エディタで書いた固有語 aardvarkfirst と [[target]] リンク。\n',
      'utf8',
    );
    const found = await pollUntil(
      () => searchPaths('aardvarkfirst'),
      (paths) => paths.includes('notes/external.md'),
    );
    expect(found).toContain('notes/external.md');

    const sources = await pollUntil(
      () => backlinkSources('notes/target.md'),
      (s) => s.includes('notes/external.md'),
    );
    expect(sources).toContain('notes/external.md');
  });

  it('picks up an external modification (old content gone, new content searchable)', async () => {
    await writeFile(
      path.join(vault, 'notes/external.md'),
      '書き換え後の固有語 quokkasecond のみ。リンクは消した。\n',
      'utf8',
    );
    const found = await pollUntil(
      () => searchPaths('quokkasecond'),
      (paths) => paths.includes('notes/external.md'),
    );
    expect(found).toContain('notes/external.md');

    // 古い内容はもうヒットしない
    const stale = await pollUntil(
      () => searchPaths('aardvarkfirst'),
      (paths) => !paths.includes('notes/external.md'),
    );
    expect(stale).not.toContain('notes/external.md');

    // リンクを消したのでバックリンクからも消える
    const sources = await pollUntil(
      () => backlinkSources('notes/target.md'),
      (s) => !s.includes('notes/external.md'),
    );
    expect(sources).not.toContain('notes/external.md');
  });

  it('picks up an external deletion (gone from search and backlinks)', async () => {
    // まずリンク付きで復活させ、インデックスされたことを確認してから削除
    await writeFile(
      path.join(vault, 'notes/external.md'),
      '削除前の固有語 capybarathird と [[target]]。\n',
      'utf8',
    );
    await pollUntil(
      () => searchPaths('capybarathird'),
      (paths) => paths.includes('notes/external.md'),
    );

    await rm(path.join(vault, 'notes/external.md'));
    const afterDelete = await pollUntil(
      () => searchPaths('capybarathird'),
      (paths) => !paths.includes('notes/external.md'),
    );
    expect(afterDelete).not.toContain('notes/external.md');

    const sources = await pollUntil(
      () => backlinkSources('notes/target.md'),
      (s) => !s.includes('notes/external.md'),
    );
    expect(sources).not.toContain('notes/external.md');
  });

  it('does not index files under .loamium/ (watch exclusion)', async () => {
    await mkdir(path.join(vault, '.loamium'), { recursive: true });
    await writeFile(
      path.join(vault, '.loamium/cache.md'),
      'インデックスされてはいけない固有語 loamiumcacheword。\n',
      'utf8',
    );
    // 同時に通常ノートも書き、それが反映された時点を「監視イベントが処理済み」の基準にする
    await writeFile(
      path.join(vault, 'notes/canary.md'),
      '基準ノート固有語 canaryword。\n',
      'utf8',
    );
    const canary = await pollUntil(
      () => searchPaths('canaryword'),
      (paths) => paths.includes('notes/canary.md'),
    );
    expect(canary).toContain('notes/canary.md');

    const hidden = await searchPaths('loamiumcacheword');
    expect(hidden).toEqual([]);
  });
});
