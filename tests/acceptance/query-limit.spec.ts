/**
 * Story S32940c-1「DQL 拡張 (LIMIT + 未完了タスク・フィールド)」受け入れテスト。
 * scenario-S32940c-1.json を機械的に実行する。
 *
 * test-discipline Rule 2 (api): 実サーバー + 実 HTTP クライアント (fetch)。
 * vault はテストごとの一時ディレクトリ。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryResponseSchema } from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

let server: TestServer;
let vault: string;

async function postQuery(query: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

async function queryOk(query: string) {
  const { status, body } = await postQuery(query);
  expect(status, `query should succeed: ${query} -> ${JSON.stringify(body)}`).toBe(200);
  return queryResponseSchema.parse(body);
}

beforeAll(async () => {
  vault = await makeTempVault();
  await mkdir(path.join(vault, 'notes'), { recursive: true });

  // 6 ノートを mtime が順番に区別しやすいよう書き込む
  // (実際の mtime は OS が付けるが、frontmatter の updated フィールドと
  //  file.mtime はほぼ同時刻になる。LIMIT テストでは全件 vs. 部分集合で検証する)
  for (let i = 1; i <= 6; i++) {
    await writeFile(
      path.join(vault, 'notes', `note${String(i).padStart(2, '0')}.md`),
      `# Note ${i}\n\nContent of note ${i}.\n`,
      'utf8',
    );
    // 少し待って mtime を確実に区別させる
    await new Promise((r) => setTimeout(r, 10));
  }

  // タスク用ノート
  // ノート A: 未完了タスクあり
  await writeFile(
    path.join(vault, 'notes/noteA-opentasks.md'),
    '# Note A\n\n- [ ] 未完了タスク\n- [x] 完了済みタスク\n',
    'utf8',
  );
  // ノート B: 完了タスクのみ
  await writeFile(
    path.join(vault, 'notes/noteB-donetasks.md'),
    '# Note B\n\n- [x] 完了タスクのみ\n',
    'utf8',
  );
  // ノート C: タスク無し
  await writeFile(
    path.join(vault, 'notes/noteC-notasks.md'),
    '# Note C\n\nタスク無し。\n',
    'utf8',
  );

  server = await startServer({ vault });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await cleanupVault(vault);
});

describe('[AC-S32940c-1-1][AC-S32940c-1-4] POST /api/query — LIMIT 節', () => {
  it(
    'scenario-1-step-1: LIST SORT file.mtime DESC LIMIT 5 は SORT 後の先頭 5 件のみ返す',
    async () => {
      const withLimit = await queryOk('LIST SORT file.mtime DESC LIMIT 5');
      expect(withLimit.type).toBe('list');
      if (withLimit.type !== 'list') return;
      // vault には 9 件のノートがあるので LIMIT 5 なら 5 件
      expect(withLimit.results).toHaveLength(5);
    },
  );

  it(
    'scenario-1-step-2: LIMIT を外すと全件返り、LIMIT あり結果は全件の部分集合',
    async () => {
      const withLimit = await queryOk('LIST SORT file.mtime DESC LIMIT 5');
      const withoutLimit = await queryOk('LIST SORT file.mtime DESC');
      expect(withLimit.type).toBe('list');
      expect(withoutLimit.type).toBe('list');
      if (withLimit.type !== 'list' || withoutLimit.type !== 'list') return;

      // LIMIT あり < 全件
      expect(withLimit.results.length).toBeLessThan(withoutLimit.results.length);
      // LIMIT あり結果は全件の先頭部分集合
      const limitedPaths = withLimit.results.map((r) => r.path);
      const allPaths = withoutLimit.results.map((r) => r.path);
      expect(allPaths.slice(0, limitedPaths.length)).toEqual(limitedPaths);
    },
  );

  it('[AC-S32940c-1-4] LIMIT n の構文エラー (負値) は 400 DqlParseError', async () => {
    const { status, body } = await postQuery('LIST LIMIT -1');
    expect(status).toBe(400);
    const err = body as { error: string; message: string; line: number; column: number; length: number };
    expect(err.error).toBe('query_syntax');
    expect(err.line).toBe(1);
    expect(err.column).toBeGreaterThan(0);
  });

  it('[AC-S32940c-1-4] LIMIT n の構文エラー (非整数ワード) は 400 DqlParseError', async () => {
    const { status, body } = await postQuery('LIST SORT file.mtime DESC LIMIT abc');
    expect(status).toBe(400);
    const err = body as { error: string; message: string; line: number; column: number };
    expect(err.error).toBe('query_syntax');
    expect(err.line).toBe(1);
  });
});

describe('[AC-S32940c-1-2][AC-S32940c-1-4] POST /api/query — file.open_tasks / file.tasks', () => {
  it(
    'scenario-2-step-1: LIST WHERE file.open_tasks は未完了タスクを持つノート A のみ返す',
    async () => {
      const res = await queryOk('LIST WHERE file.open_tasks');
      expect(res.type).toBe('list');
      if (res.type !== 'list') return;
      const paths = res.results.map((r) => r.path);
      // ノート A を含む
      expect(paths).toContain('notes/noteA-opentasks.md');
      // ノート B (完了のみ) を含まない
      expect(paths).not.toContain('notes/noteB-donetasks.md');
      // ノート C (タスク無し) を含まない
      expect(paths).not.toContain('notes/noteC-notasks.md');
    },
  );

  it(
    'scenario-2-step-2: LIST WHERE file.tasks はタスクを持つ A と B を返し、C を除外',
    async () => {
      const res = await queryOk('LIST WHERE file.tasks');
      expect(res.type).toBe('list');
      if (res.type !== 'list') return;
      const paths = res.results.map((r) => r.path);
      // ノート A (未完了あり) を含む
      expect(paths).toContain('notes/noteA-opentasks.md');
      // ノート B (完了のみ) を含む
      expect(paths).toContain('notes/noteB-donetasks.md');
      // ノート C (タスク無し) を含まない
      expect(paths).not.toContain('notes/noteC-notasks.md');
    },
  );
});
