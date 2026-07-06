/**
 * Story Sd13ab1-2「キーファースト追加 — vault 横断キー集約 + 型永続化」受け入れテスト。
 *
 * test-discipline Rule 2 (api): 実サーバーをサブプロセスとして起動し、実 HTTP
 * クライアント (fetch) で GET /api/property-keys と PUT /api/property-types を叩く。
 * vault はテストごとの一時ディレクトリ。
 *
 * カバー:
 *  - AC-Sd13ab1-2-4: 全ノートの frontmatter キーを件数付き集約。あるノートで作った
 *    キー(hoge)が別ノートの候補として集約に出る。chokidar による外部追加に追従。
 *  - AC-Sd13ab1-2-3(サーバー側): 新規プロパティの型を .loamium/property-types.json へ
 *    永続化し、別ファイルでその型に解決される (D方式の横断固定)。ノートには書かない。
 */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parsePropertyTypesJson,
  propertyKeysResponseSchema,
  propertyTypeWriteResponseSchema,
  resolvePropertyType,
} from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

let server: TestServer | null = null;
let vault = '';

const POLL_TIMEOUT_MS = 20_000;

afterEach(async () => {
  if (server !== null) {
    await server.stop();
    server = null;
  }
  if (vault !== '') {
    await cleanupVault(vault);
    vault = '';
  }
});

async function pollUntil<T>(fetchValue: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = await fetchValue();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    last = await fetchValue();
  }
  return last;
}

async function getKeys(baseUrl: string): Promise<{ key: string; count: number }[]> {
  const res = await fetch(`${baseUrl}/api/property-keys`);
  const body: unknown = await res.json();
  return propertyKeysResponseSchema.parse(body).keys;
}

async function putNote(baseUrl: string, rel: string, content: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/notes/${encodeURIComponent(rel)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

describe('[AC-Sd13ab1-2-4] vault 横断のプロパティキー集約 (件数付き)', () => {
  it('全ノートの frontmatter キーを件数付きで集約する (tags() と同型)', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault });
    const base = server.baseUrl;

    await putNote(base, 'a.md', '---\ntags: [x]\nstatus: 読了\n---\n\n本文A\n');
    await putNote(base, 'b.md', '---\ntags: [y]\nrating: 4\n---\n\n本文B\n');

    const keys = await pollUntil(
      () => getKeys(base),
      (k) => k.some((e) => e.key === 'tags'),
    );
    const byKey = new Map(keys.map((k) => [k.key, k.count]));
    // tags は 2 ノートで使用 → 件数 2。status / rating は 1 件ずつ
    expect(byKey.get('tags')).toBe(2);
    expect(byKey.get('status')).toBe(1);
    expect(byKey.get('rating')).toBe(1);
    // 件数降順 → キー昇順で並ぶ (先頭は最多の tags)
    expect(keys[0]?.key).toBe('tags');
  });

  it('あるノートで作った任意キー(hoge)が別ノートの候補として集約に出る', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault });
    const base = server.baseUrl;

    // ノート a で独自キー hoge を作成 (API 経由 = UI の書き込みと同じ経路)
    await putNote(base, 'a.md', '---\nhoge: 42\n---\n\n本文A\n');
    // ノート b には hoge は無い
    await putNote(base, 'b.md', '---\ntags: [z]\n---\n\n本文B\n');

    const keys = await pollUntil(
      () => getKeys(base),
      (k) => k.some((e) => e.key === 'hoge'),
    );
    // hoge は集約に現れる (別ノート b の追加メニューでサジェストされるソース)
    expect(keys.some((e) => e.key === 'hoge')).toBe(true);
  });

  it('chokidar による外部追加 (API を経由しない frontmatter) にも追従する', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault });
    const base = server.baseUrl;

    // ウォームアップ: API 経由でノートを 1 件作り、集約に現れるまで待つ
    // (index / watcher が完全に立ち上がったことを保証してから外部書き込みを検証)
    await putNote(base, 'seed.md', '---\nシード鍵: 1\n---\n\nシード本文\n');
    await pollUntil(
      () => getKeys(base),
      (k) => k.some((e) => e.key === 'シード鍵'),
    );

    // 外部エディタ相当: fs で直接ノートを書く (chokidar が拾う)
    await writeFile(
      path.join(vault, 'external.md'),
      '---\n外部キー独自: 1\n---\n\n外部本文\n',
      'utf8',
    );
    const keys = await pollUntil(
      () => getKeys(base),
      (k) => k.some((e) => e.key === '外部キー独自'),
    );
    expect(keys.some((e) => e.key === '外部キー独自')).toBe(true);
  });

  it('read-only モードでも GET /api/property-keys は許可される (read 分類)', async () => {
    vault = await makeTempVault();
    await mkdir(path.join(vault, 'x'), { recursive: true });
    await writeFile(path.join(vault, 'x/n.md'), '---\nk1: 1\n---\n\n本文\n', 'utf8');
    server = await startServer({ vault, mode: 'read-only' });

    const res = await fetch(`${server.baseUrl}/api/property-keys`);
    expect(res.status).toBe(200);
    const keys = propertyKeysResponseSchema.parse(await res.json()).keys;
    expect(keys.some((e) => e.key === 'k1')).toBe(true);
  });
});

describe('[AC-Sd13ab1-2-3] 新規キーの型を property-types.json へ永続化 (D方式の横断固定)', () => {
  it('PUT /api/property-types で型を永続化し、別ファイルで同じ型に解決される', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault });
    const base = server.baseUrl;

    // ノート a で新規キー『レビュー』を number として作った、を PUT で永続化
    const res = await fetch(`${base}/api/property-types`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'レビュー', def: { type: 'number' } }),
    });
    expect(res.ok).toBe(true);
    const written = propertyTypeWriteResponseSchema.parse(await res.json());
    expect(written.key).toBe('レビュー');

    // GET でも取得でき、別ファイルの値 '3' が number 型 (source=json) に解決される
    const getRes = await fetch(`${base}/api/property-types`);
    const defs = parsePropertyTypesJson(
      (await getRes.json() as { types: unknown }).types,
    );
    expect(resolvePropertyType('レビュー', '3', defs)).toEqual({ type: 'number', source: 'json' });

    // ディスク: 型情報は .loamium/property-types.json にのみ存在する
    const onDisk: unknown = JSON.parse(
      await readFile(path.join(vault, '.loamium', 'property-types.json'), 'utf8'),
    );
    expect((onDisk as Record<string, unknown>)['レビュー']).toEqual({ type: 'number' });
    // vault 直下 .md には型情報は書かれない
    const rootEntries = await readdir(vault);
    expect(rootEntries).not.toContain('property-types.json');
  });

  it('既存の型定義を保ったまま 1 キー分だけマージ書き込みする', async () => {
    vault = await makeTempVault();
    await mkdir(path.join(vault, '.loamium'), { recursive: true });
    await writeFile(
      path.join(vault, '.loamium', 'property-types.json'),
      JSON.stringify({ 既存キー: { type: 'star' } }),
      'utf8',
    );
    server = await startServer({ vault });
    const base = server.baseUrl;

    const res = await fetch(`${base}/api/property-types`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: '新キー', def: { type: 'date' } }),
    });
    expect(res.ok).toBe(true);
    const defs = parsePropertyTypesJson(propertyTypeWriteResponseSchema.parse(await res.json()).types);
    // 既存キーは保持、新キーが追加されている
    expect(defs['既存キー']?.type).toBe('star');
    expect(defs['新キー']?.type).toBe('date');
  });

  it('read-only モードでは PUT /api/property-types が 403 で拒否される (mutate 分類)', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'read-only' });

    const res = await fetch(`${server.baseUrl}/api/property-types`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'k', def: { type: 'text' } }),
    });
    expect(res.status).toBe(403);
    // ファイルは書かれていない
    let exists = true;
    try {
      await readFile(path.join(vault, '.loamium', 'property-types.json'), 'utf8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('書き込み系 PUT は監査ログ (.loamium/audit.log) に記録される', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault });

    await fetch(`${server.baseUrl}/api/property-types`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: '監査対象', def: { type: 'text' } }),
    });
    const log = await pollUntil(
      async () => {
        try {
          return await readFile(path.join(vault, '.loamium', 'audit.log'), 'utf8');
        } catch {
          return '';
        }
      },
      (s) => s.includes('property-types.write'),
    );
    expect(log).toContain('property-types.write');
    expect(log).toContain('"result":"ok"');
  });
});
