/**
 * Story S87f4b7-2「意味型システム (D方式)」受け入れテスト。
 *
 * test-discipline Rule 2 (api): 実サーバーをサブプロセスとして起動し、実 HTTP
 * クライアント (fetch) で GET /api/property-types を叩く。vault はテストごとの
 * 一時ディレクトリ。型解決 (resolvePropertyType) は shared の公開 API 経由で検証し、
 * サーバーが返した JSON でヒューリスティックが上書きされる end-to-end を確認する。
 *
 * カバー: AC-S87f4b7-2-1(解決 + JSON上書き)/ AC-S87f4b7-2-3(壊れ JSON の
 * フォールバック・型情報をノートに書かない)。
 */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parsePropertyTypesJson,
  propertyTypesResponseSchema,
  resolvePropertyType,
} from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

let server: TestServer | null = null;
let vault = '';

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

async function writeTypesJson(content: string): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'property-types.json'), content, 'utf8');
}

async function getTypes(baseUrl: string): Promise<{ status: number; types: unknown }> {
  const res = await fetch(`${baseUrl}/api/property-types`);
  const body: unknown = await res.json();
  const parsed = propertyTypesResponseSchema.parse(body);
  return { status: res.status, types: parsed.types };
}

describe('[AC-S87f4b7-2-1] 意味型の解決 + JSON定義による上書き', () => {
  it('内蔵ヒューリスティックがキー名/値の形から意味型を解決する', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault });

    // 型定義ファイル無し → 空 {}
    const { status, types } = await getTypes(server.baseUrl);
    expect(status).toBe(200);
    expect(types).toEqual({});
    const defs = parsePropertyTypesJson(types);

    // ノートの frontmatter に相当するキー/値をヒューリスティック解決
    expect(resolvePropertyType('rating', 4, defs)).toEqual({ type: 'star', source: 'builtin' });
    expect(resolvePropertyType('status', '読了', defs)).toEqual({
      type: 'select',
      source: 'builtin',
    });
    expect(resolvePropertyType('created', '2026-05-20', defs)).toEqual({
      type: 'date',
      source: 'builtin',
    });
    expect(resolvePropertyType('tags', ['a', 'b'], defs).type).toBe('tags');
    expect(resolvePropertyType('参考', 'https://example.com', defs).type).toBe('url');
    expect(resolvePropertyType('関連', '[[Note]]', defs).type).toBe('note-link');
  });

  it('.loamium/property-types.json のキー→型定義でヒューリスティックを上書きする', async () => {
    vault = await makeTempVault();
    await writeTypesJson(
      JSON.stringify({
        優先度: { type: 'select', options: [{ value: '高', color: 'red' }, '中', '低'] },
        status: { type: 'text' },
      }),
    );
    server = await startServer({ vault });

    const { types } = await getTypes(server.baseUrl);
    // サーバーはファイルの生 JSON をそのまま返す
    expect((types as Record<string, unknown>)['優先度']).toBeDefined();
    const defs = parsePropertyTypesJson(types);

    // status は本来 select だが JSON定義 text で上書き (source=json)
    expect(resolvePropertyType('status', 'x', defs)).toEqual({ type: 'text', source: 'json' });
    // 優先度 は JSON定義の select + options(色つき)で解決
    expect(resolvePropertyType('優先度', '高', defs)).toEqual({
      type: 'select',
      source: 'json',
      options: [{ value: '高', color: 'red' }, { value: '中' }, { value: '低' }],
    });
  });

  it('read-only モードでも GET /api/property-types は許可される (read 分類)', async () => {
    vault = await makeTempVault();
    await writeTypesJson(JSON.stringify({ 難易度: { type: 'star' } }));
    server = await startServer({ vault, mode: 'read-only' });

    const { status, types } = await getTypes(server.baseUrl);
    expect(status).toBe(200);
    expect((types as Record<string, unknown>)['難易度']).toEqual({ type: 'star' });
  });
});

describe('[AC-S87f4b7-2-3] 壊れた JSON でもクラッシュせずフォールバック / 型情報は非永続', () => {
  it('壊れた JSON はサーバーが 200 で {} を返し、ヒューリスティックへフォールバック', async () => {
    vault = await makeTempVault();
    await writeTypesJson('{ this is : not valid json ,,, ');
    server = await startServer({ vault });

    const { status, types } = await getTypes(server.baseUrl);
    expect(status).toBe(200);
    expect(types).toEqual({}); // パース不能でも空で返る (クラッシュしない)
    const defs = parsePropertyTypesJson(types);
    expect(defs).toEqual({});
    // フォールバック: ヒューリスティックが効く
    expect(resolvePropertyType('rating', 5, defs).type).toBe('star');
  });

  it('一部が壊れた JSON は妥当なエントリだけ採用する', async () => {
    vault = await makeTempVault();
    await writeTypesJson(
      JSON.stringify({
        良い: { type: 'progress' },
        不明: { type: 'rainbow' },
        色不正: { type: 'select', options: [{ value: 'a', color: 'octarine' }] },
      }),
    );
    server = await startServer({ vault });

    const { types } = await getTypes(server.baseUrl);
    const defs = parsePropertyTypesJson(types);
    expect(Object.keys(defs)).toEqual(['良い']);
    expect(resolvePropertyType('良い', 50, defs)).toEqual({ type: 'progress', source: 'json' });
    // 不明キーは JSON定義が無効 → ヒューリスティックにフォールバック
    expect(resolvePropertyType('不明', 'x', defs).source).toBe('builtin');
  });

  it('型定義を読んでもノートファイル (.md) には型情報が書かれない (ピュア Markdown)', async () => {
    vault = await makeTempVault();
    await writeTypesJson(JSON.stringify({ 優先度: { type: 'select', options: ['高', '低'] } }));
    server = await startServer({ vault });

    // ノートを PUT (標準 YAML frontmatter)
    const note = '---\n優先度: 高\nrating: 4\n---\n\n# 本文\n';
    const res = await fetch(`${server.baseUrl}/api/notes/${encodeURIComponent('t.md')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: note }),
    });
    expect(res.ok).toBe(true);

    // 型解決を行っても、ディスク上のノートはバイト単位でそのまま (型情報なし)
    await getTypes(server.baseUrl);
    const onDisk = await readFile(path.join(vault, 't.md'), 'utf8');
    expect(onDisk).toBe(note);
    // 独自記法・型メタが混入していないこと
    expect(onDisk).not.toContain('type:');
    expect(onDisk).not.toMatch(/\^[A-Za-z0-9]{6}/);

    // property-types.json は .loamium 配下にのみ存在し、vault 直下 .md には現れない
    const rootEntries = await readdir(vault);
    expect(rootEntries).not.toContain('property-types.json');
  });
});
