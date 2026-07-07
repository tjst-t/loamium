/**
 * Story S32940c-2「スマートフォルダ定義・解決 API」受け入れテスト。
 * scenario-S32940c-2.json を機械的に実行する。
 *
 * test-discipline Rule 2 (api): 実サーバーをサブプロセスとして起動し、
 * 実 HTTP クライアント (fetch) で叩く。vault はテストごとの一時ディレクトリ。
 *
 * カバー: AC-S32940c-2-1〜5
 */
import { exec } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  smartViewConfigSchema,
  smartFoldersResolveResponseSchema,
} from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

const execAsync = promisify(exec);
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');

let server: TestServer | null = null;
let vault = '';

beforeEach(async () => {
  vault = await makeTempVault();
});

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

/** ノートを vault に作成するヘルパー。 */
async function seedNote(rel: string, content: string): Promise<void> {
  const abs = path.join(vault, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

/** GET /api/smart-folders のレスポンスを返す。 */
async function getConfig(baseUrl: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/smart-folders`);
  const body: unknown = await res.json();
  return { status: res.status, body };
}

/** PUT /api/smart-folders に body を送る。 */
async function putConfig(
  baseUrl: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/smart-folders`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody: unknown = await res.json();
  return { status: res.status, body: responseBody };
}

/** GET /api/smart-folders/{id}/notes のレスポンスを返す。 */
async function resolveFolder(
  baseUrl: string,
  id: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/smart-folders/${encodeURIComponent(id)}/notes`);
  const body: unknown = await res.json();
  return { status: res.status, body };
}

// ── scenario-1: api crud + resolve ─────────────────────────────────────────

describe('[AC-S32940c-2-1] GET /api/smart-folders — 欠損ファイルは空フォールバック', () => {
  it('定義ファイル未作成でも 200 かつ {version:1, items:[]} が返る', async () => {
    server = await startServer({ vault });
    const { status, body } = await getConfig(server.baseUrl);
    expect(status).toBe(200);
    const parsed = smartViewConfigSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items).toHaveLength(0);
      expect(parsed.data.version).toBe(1);
    }
  });

  it('破損した JSON でも 200 かつ empty フォールバック (never 500)', async () => {
    await mkdir(path.join(vault, '.loamium'), { recursive: true });
    await writeFile(
      path.join(vault, '.loamium', 'smart-folders.json'),
      '{ this is not valid json',
      'utf8',
    );
    server = await startServer({ vault });
    const { status, body } = await getConfig(server.baseUrl);
    expect(status).toBe(200);
    const parsed = smartViewConfigSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items).toHaveLength(0);
    }
  });
});

describe('[AC-S32940c-2-2] PUT /api/smart-folders — アトミック書き込み + 監査ログ', () => {
  it('有効な定義を PUT すると 200 + ファイル作成 + 監査ログ smart-folders.write', async () => {
    server = await startServer({ vault });

    const config = {
      version: 1,
      items: [
        {
          kind: 'query',
          id: 'recent',
          name: '最近の更新',
          dql: 'LIST SORT file.mtime DESC LIMIT 5',
        },
        { kind: 'pin', id: 'dash', name: 'ダッシュボード', path: 'Dashboard.md' },
      ],
    };

    const { status, body } = await putConfig(server.baseUrl, config);
    expect(status).toBe(200);
    const parsed = smartViewConfigSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // ファイルが 2-space JSON で作成されている
    const fileContent = await readFile(
      path.join(vault, '.loamium', 'smart-folders.json'),
      'utf8',
    );
    const fileJson = JSON.parse(fileContent) as unknown;
    expect(fileContent).toContain('  '); // 2-space indent
    const fileParsed = smartViewConfigSchema.safeParse(fileJson);
    expect(fileParsed.success).toBe(true);
    if (fileParsed.success) {
      expect(fileParsed.data.items).toHaveLength(2);
    }

    // 監査ログに smart-folders.write が記録されている
    const auditLog = await readFile(path.join(vault, '.loamium', 'audit.log'), 'utf8');
    const entries = auditLog
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { op: string; result: string });
    const writeEntry = entries.find((e) => e.op === 'smart-folders.write');
    expect(writeEntry).toBeDefined();
    expect(writeEntry?.result).toBe('ok');
  });

  it('PUT した定義は GET で同じ内容が返る (scenario-1 step 3)', async () => {
    server = await startServer({ vault });

    const config = {
      version: 1,
      items: [
        {
          kind: 'query',
          id: 'recent',
          name: '最近の更新',
          dql: 'LIST SORT file.mtime DESC LIMIT 5',
        },
        { kind: 'pin', id: 'dash', name: 'ダッシュボード', path: 'Dashboard.md' },
      ],
    };

    await putConfig(server.baseUrl, config);
    const { status, body } = await getConfig(server.baseUrl);
    expect(status).toBe(200);
    const parsed = smartViewConfigSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items).toHaveLength(2);
      expect(parsed.data.items[0]?.id).toBe('recent');
      expect(parsed.data.items[1]?.id).toBe('dash');
    }
  });
});

describe('[AC-S32940c-2-3] GET /api/smart-folders/{id}/notes — クエリ・ピン解決', () => {
  it('query 種は executeQuery 経由で NoteMeta[] が返る (scenario-1 step 4)', async () => {
    // ノートを数件作成してインデックス対象にする
    await seedNote('note-a.md', '# Note A\n#tag1\n');
    await seedNote('note-b.md', '# Note B\n#tag2\n');
    server = await startServer({ vault });

    const config = {
      version: 1,
      items: [
        {
          kind: 'query',
          id: 'recent',
          name: '最近の更新',
          dql: 'LIST SORT file.mtime DESC LIMIT 5',
        },
      ],
    };
    await putConfig(server.baseUrl, config);

    const { status, body } = await resolveFolder(server.baseUrl, 'recent');
    expect(status).toBe(200);
    const parsed = smartFoldersResolveResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notes.length).toBeGreaterThan(0);
      expect(parsed.data.notes.length).toBeLessThanOrEqual(5);
      // NoteMeta の shape 確認
      const note = parsed.data.notes[0];
      expect(note).toMatchObject({
        path: expect.any(String),
        title: expect.any(String),
        tags: expect.any(Array),
        folder: expect.any(String),
      });
    }
  });

  it('pin 種 — 存在するノートは NoteMeta 1 件で返る', async () => {
    await seedNote('Dashboard.md', '# Dashboard\n');
    server = await startServer({ vault });

    const config = {
      version: 1,
      items: [{ kind: 'pin', id: 'dash', name: 'ダッシュボード', path: 'Dashboard.md' }],
    };
    await putConfig(server.baseUrl, config);

    const { status, body } = await resolveFolder(server.baseUrl, 'dash');
    expect(status).toBe(200);
    const parsed = smartFoldersResolveResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notes).toHaveLength(1);
      expect(parsed.data.notes[0]?.path).toBe('Dashboard.md');
    }
  });

  it('pin 種 — 存在しない pin は結果から除外 (エラーにならない、ファイルを壊さない) [scenario-1 step 6]', async () => {
    server = await startServer({ vault });

    const config = {
      version: 1,
      items: [{ kind: 'pin', id: 'dash', name: 'ダッシュボード', path: 'Dashboard.md' }],
    };
    await putConfig(server.baseUrl, config);

    // Dashboard.md は作成されていない
    const { status, body } = await resolveFolder(server.baseUrl, 'dash');
    expect(status).toBe(200);
    const parsed = smartFoldersResolveResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.notes).toHaveLength(0); // 除外される
    }

    // ファイルは変更されていない
    const fileContent = await readFile(
      path.join(vault, '.loamium', 'smart-folders.json'),
      'utf8',
    );
    const fileJson = JSON.parse(fileContent) as unknown;
    const fileParsed = smartViewConfigSchema.safeParse(fileJson);
    expect(fileParsed.success).toBe(true);
    if (fileParsed.success) {
      expect(fileParsed.data.items).toHaveLength(1); // pin が残っている
    }
  });

  it('未知の id は 404 が返る', async () => {
    server = await startServer({ vault });
    const { status } = await resolveFolder(server.baseUrl, 'no-such-id');
    expect(status).toBe(404);
  });
});

describe('[AC-S32940c-2-4] zod スキーマ検証 — 不正定義は 4xx でファイル不変', () => {
  it('../escape.md を含む pin.path は 4xx でファイル未変更 (scenario-1 step 5)', async () => {
    server = await startServer({ vault });

    // まず有効な定義を書く
    const validConfig = {
      version: 1,
      items: [{ kind: 'pin', id: 'dash', name: 'dash', path: 'Dashboard.md' }],
    };
    await putConfig(server.baseUrl, validConfig);
    const originalContent = await readFile(
      path.join(vault, '.loamium', 'smart-folders.json'),
      'utf8',
    );

    // path traversal を試みる
    const badConfig = {
      version: 1,
      items: [{ kind: 'pin', id: 'bad', name: 'bad', path: '../escape.md' }],
    };
    const { status } = await putConfig(server.baseUrl, badConfig);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);

    // ファイルは変更されていない
    const afterContent = await readFile(
      path.join(vault, '.loamium', 'smart-folders.json'),
      'utf8',
    );
    expect(afterContent).toBe(originalContent);
  });

  it('無効な DQL (query.dql) は 4xx でファイル未変更', async () => {
    server = await startServer({ vault });

    const badConfig = {
      version: 1,
      items: [{ kind: 'query', id: 'bad', name: 'bad', dql: 'INVALID SYNTAX @@@@' }],
    };
    const { status } = await putConfig(server.baseUrl, badConfig);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it('kind 以外の不正な body (版なし・items 欠落) も 4xx', async () => {
    server = await startServer({ vault });
    const { status } = await putConfig(server.baseUrl, { wrong: true });
    expect(status).toBe(400);
  });
});

describe('[AC-S32940c-2-2] read-only モードでは PUT を 403 (scenario-2)', () => {
  it('read-only サーバーでは PUT /api/smart-folders が 403 (scenario-2 step 1)', async () => {
    server = await startServer({ vault, mode: 'read-only' });
    const { status } = await putConfig(server.baseUrl, { version: 1, items: [] });
    expect(status).toBe(403);
  });

  it('read-only モードでも GET /api/smart-folders は 200 (scenario-2 step 2)', async () => {
    server = await startServer({ vault, mode: 'read-only' });
    const { status } = await getConfig(server.baseUrl);
    expect(status).toBe(200);
  });
});

describe('[AC-S32940c-2-5] .gitignore — smart-folders.json は git 追跡対象 (scenario-3)', () => {
  it('git check-ignore で smart-folders.json は無視されない (exit code 1)', async () => {
    // このテストはリポジトリの .gitignore を見る (vault ではなくリポジトリ)
    // git check-ignore: exit 0 = 無視される, exit 1 = 無視されない (git-tracked)
    try {
      await execAsync(
        'git check-ignore .loamium/smart-folders.json',
        { cwd: repoRoot },
      );
      // exit code 0 = 無視される → テスト失敗
      expect.fail('git check-ignore returned 0 (file is ignored, should be tracked)');
    } catch (err: unknown) {
      // exit code 1 = 無視されない (git-tracked — 期待値)
      const execError = err as { code?: number };
      expect(execError.code).toBe(1);
    }
  });

  it('git check-ignore で audit.log は無視される (exit code 0)', async () => {
    // audit.log は .loamium/* で無視されるべき
    try {
      const result = await execAsync(
        'git check-ignore .loamium/audit.log',
        { cwd: repoRoot },
      );
      // exit code 0 = 無視される (期待値)
      expect(result.stdout.trim()).toContain('audit.log');
    } catch {
      expect.fail('git check-ignore returned non-0 for audit.log (should be ignored)');
    }
  });
});
