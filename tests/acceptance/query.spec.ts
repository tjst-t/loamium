/**
 * Story Sb1593c-1「クエリエンジン (API)」受け入れテスト。
 * scenario-Sb1593c-1.json (api) を機械的に実行する。
 *
 * test-discipline Rule 2 (api): 実サーバー + 実 HTTP クライアント (fetch)。
 * ハンドラ直接呼び出しはしない。vault はテストごとの一時ディレクトリ。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryResponseSchema } from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

let server: TestServer;
let vault: string;

async function postQuery(query: string, baseUrl = server.baseUrl): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

/** 成功レスポンスを共有スキーマで検証して返す。 */
async function queryOk(query: string) {
  const { status, body } = await postQuery(query);
  expect(status, `query should succeed: ${query} -> ${JSON.stringify(body)}`).toBe(200);
  return queryResponseSchema.parse(body);
}

const POLL_TIMEOUT_MS = 10_000;
async function pollUntil<T>(fetchValue: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = await fetchValue();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    last = await fetchValue();
  }
  return last;
}

beforeAll(async () => {
  vault = await makeTempVault();
  await mkdir(path.join(vault, 'projects'), { recursive: true });
  await mkdir(path.join(vault, 'reading'), { recursive: true });
  await writeFile(
    path.join(vault, 'projects/Hydra 移行手順.md'),
    [
      '---',
      'status: in-progress',
      'updated: "2026-07-03"',
      'priority: 2',
      '---',
      '# Hydra 移行手順',
      '',
      '#project #infra の作業。',
      '',
      '- [ ] DNS TTL を 300 秒へ短縮する',
      '    - [x] レジストラ側は設定済み',
      '- [ ] NAS の NFS エクスポートを Hydra に許可',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(vault, 'projects/庭の自動潅水.md'),
    ['---', 'status: paused', 'updated: "2026-06-21"', 'tags: [project]', '---', '# 庭の自動潅水', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(vault, 'reading/積読.md'),
    ['#reading', '', '- [x] 第 1 章', '- [ ] 第 2 章', ''].join('\n'),
    'utf8',
  );
  await writeFile(path.join(vault, 'inbox.md'), '# inbox\n\nタグなし。\n', 'utf8');
  server = await startServer({ vault });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await cleanupVault(vault);
});

describe('[AC-Sb1593c-1-1] POST /api/query — LIST / TABLE / TASK + from / where / sort', () => {
  it('LIST from #tag はタグ付きノートのみ返す (インライン + frontmatter tags)', async () => {
    const res = await queryOk('LIST from #project');
    expect(res.type).toBe('list');
    if (res.type !== 'list') return;
    expect(res.results.map((r) => r.path)).toEqual([
      'projects/Hydra 移行手順.md',
      'projects/庭の自動潅水.md',
    ]);
    expect(res.results[0]).toEqual({
      path: 'projects/Hydra 移行手順.md',
      title: 'Hydra 移行手順',
      folder: 'projects',
    });
  });

  it('TABLE fields from "folder" where != sort desc (prototype のクエリ例そのまま)', async () => {
    const res = await queryOk('TABLE status, updated from "projects" where status != "done" sort updated desc');
    expect(res.type).toBe('table');
    if (res.type !== 'table') return;
    expect(res.fields).toEqual(['status', 'updated']);
    expect(res.results.map((r) => r.title)).toEqual(['Hydra 移行手順', '庭の自動潅水']);
    expect(res.results[0]?.values).toEqual(['in-progress', '2026-07-03']);
  });

  it('where の組み込みフィールド file.name / file.folder / file.mtime が使える', async () => {
    const byName = await queryOk('LIST where file.name = "inbox"');
    if (byName.type === 'list') expect(byName.results.map((r) => r.path)).toEqual(['inbox.md']);

    const byFolder = await queryOk('LIST where file.folder = "reading"');
    if (byFolder.type === 'list') expect(byFolder.results.map((r) => r.path)).toEqual(['reading/積読.md']);

    // 全ファイルはたった今書かれた (mtime ≒ 現在)。過去日付との比較で全件 / 0 件が切り替わる
    const after = await queryOk('LIST where file.mtime >= "2020-01-01"');
    if (after.type === 'list') expect(after.results).toHaveLength(4);
    const before = await queryOk('LIST where file.mtime < "2020-01-01"');
    if (before.type === 'list') expect(before.results).toHaveLength(0);
  });

  it('演算子 contains (タグ配列 / 文字列) と and 結合が効く', async () => {
    const tag = await queryOk('LIST where tags contains "infra"');
    if (tag.type === 'list') expect(tag.results.map((r) => r.path)).toEqual(['projects/Hydra 移行手順.md']);

    const combined = await queryOk('LIST from #project where status contains "progress" and priority <= 2');
    if (combined.type === 'list') {
      expect(combined.results.map((r) => r.path)).toEqual(['projects/Hydra 移行手順.md']);
    }
  });

  it('構文エラーは 400 + 位置情報付きメッセージ (line / column フィールド込み)', async () => {
    const { status, body } = await postQuery('LIST form #reading');
    expect(status).toBe(400);
    const err = body as { error: string; message: string; line: number; column: number; length: number };
    expect(err.error).toBe('query_syntax');
    expect(err.message).toContain('1 行 6 列');
    expect(err.message).toContain("'form'");
    expect(err.line).toBe(1);
    expect(err.column).toBe(6);
    expect(err.length).toBe(4);
  });

  it('対応外の構文 (or / 不明演算子) は明確な 400 エラー', async () => {
    const orQuery = await postQuery('LIST where a = "x" or b = "y"');
    expect(orQuery.status).toBe(400);
    expect((orQuery.body as { error: string }).error).toBe('query_syntax');

    const badOp = await postQuery('LIST where status ~ "done"');
    expect(badOp.status).toBe(400);
  });

  it('query 欠落 / 空文字は 400 invalid_request', async () => {
    const res = await fetch(`${server.baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('read-only モードでも POST /api/query は実行できる (純読み取り)', async () => {
    const roVault = await makeTempVault();
    await writeFile(path.join(roVault, 'note.md'), '#tag\n\n- [ ] task\n', 'utf8');
    const ro = await startServer({ vault: roVault, mode: 'read-only' });
    try {
      const { status, body } = await postQuery('TASK where !completed', ro.baseUrl);
      expect(status).toBe(200);
      const parsed = queryResponseSchema.parse(body);
      if (parsed.type === 'task') expect(parsed.results).toHaveLength(1);
    } finally {
      await ro.stop();
      await cleanupVault(roVault);
    }
  });
});

describe('[AC-Sb1593c-1-2] タスクのインデックス化 — TASK クエリと変更追従', () => {
  it('TASK where !completed が vault 横断の未完了タスクを行番号・ネスト付きで返す', async () => {
    const res = await queryOk('TASK where !completed');
    expect(res.type).toBe('task');
    if (res.type !== 'task') return;
    expect(res.results).toEqual([
      {
        path: 'projects/Hydra 移行手順.md',
        title: 'Hydra 移行手順',
        line: 10,
        text: 'DNS TTL を 300 秒へ短縮する',
        checked: false,
        indent: 0,
        status: null,
        priority: null,
        due: null,
      },
      {
        path: 'projects/Hydra 移行手順.md',
        title: 'Hydra 移行手順',
        line: 12,
        text: 'NAS の NFS エクスポートを Hydra に許可',
        checked: false,
        indent: 0,
        status: null,
        priority: null,
        due: null,
      },
      { path: 'reading/積読.md', title: '積読', line: 4, text: '第 2 章', checked: false, indent: 0, status: null, priority: null, due: null },
    ]);
  });

  it('TASK where completed は完了タスクのみ (ネストの indent 付き)', async () => {
    const res = await queryOk('TASK from "projects" where completed');
    if (res.type !== 'task') return;
    expect(res.results).toEqual([
      {
        path: 'projects/Hydra 移行手順.md',
        title: 'Hydra 移行手順',
        line: 11,
        text: 'レジストラ側は設定済み',
        checked: true,
        indent: 4,
        status: null,
        priority: null,
        due: null,
      },
    ]);
  });

  it('API 経由の書き込み (write-through) が即座に TASK クエリへ反映される', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/inbox.md/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '- [ ] write-through のタスク' }),
    });
    expect(res.ok).toBe(true);
    const q = await queryOk('TASK where text contains "write-through"');
    if (q.type !== 'task') return;
    expect(q.results).toHaveLength(1);
    expect(q.results[0]?.path).toBe('inbox.md');
    expect(q.results[0]?.checked).toBe(false);
  });

  it('API を経由しない外部編集 (fs 直書き) にも chokidar 追従で反映される', async () => {
    await writeFile(
      path.join(vault, 'reading/積読.md'),
      ['#reading', '', '- [x] 第 1 章', '- [x] 第 2 章', '- [ ] 外部編集で足した章', ''].join('\n'),
      'utf8',
    );
    const res = await pollUntil(
      () => queryOk('TASK from "reading"'),
      (r) => r.type === 'task' && r.results.some((t) => t.text === '外部編集で足した章'),
    );
    if (res.type !== 'task') return;
    expect(res.results.map((t) => [t.text, t.checked])).toEqual([
      ['第 1 章', true],
      ['第 2 章', true],
      ['外部編集で足した章', false],
    ]);
  });
});
