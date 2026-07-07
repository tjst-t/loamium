/**
 * Story S32940c-3「frontmatter プロパティ書込 API + CLI (スター基盤)」受け入れテスト。
 * scenario-S32940c-3.json を機械的に実行する。
 *
 * test-discipline Rule 2 (api): 実サーバー + 実 HTTP クライアント (fetch)。
 * vault はテストごとの一時ディレクトリ。
 *
 * カバー: AC-S32940c-3-1, AC-S32940c-3-2, AC-S32940c-3-3, AC-S32940c-3-4, AC-S32940c-3-5
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryResponseSchema } from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { runCli } from './helpers/cli.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postProperties(
  baseUrl: string,
  notePath: string,
  body: { set?: Record<string, unknown>; unset?: string[] },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/notes/${encodeURIComponent(notePath)}/properties`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

async function getNote(
  baseUrl: string,
  notePath: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/notes/${encodeURIComponent(notePath)}`);
  return { status: res.status, body: (await res.json()) as unknown };
}

async function postQuery(
  baseUrl: string,
  query: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

// ---------------------------------------------------------------------------
// Scenario 1 — API round-trip [AC-S32940c-3-1] [AC-S32940c-3-2]
// ---------------------------------------------------------------------------

describe('[AC-S32940c-3-1][AC-S32940c-3-2] POST /api/notes/{path}/properties — round-trip safety (scenario-1)', () => {
  let server: TestServer;
  let vault: string;

  /**
   * ノート本文 (frontmatter ブロック以外の部分) — 見出し・リスト・コードフェンスを含む。
   * parseNote.body は closing --- 行の「次の行」から末尾まで (leading \n は含まない)。
   * INITIAL_CONTENT に `\n` セパレータを挿入することで parseNote.body と一致させる。
   */
  const BODY_WITH_COMPLEX_CONTENT = [
    '# Heading 1',
    '',
    'Some paragraph text.',
    '',
    '## Heading 2',
    '',
    '- item A',
    '- item B',
    '  - nested',
    '',
    '```typescript',
    'const x = 1;',
    '// code fence content',
    '```',
    '',
    'Final paragraph.',
  ].join('\n');

  const INITIAL_CONTENT =
    '---\ntitle: My Note\nstatus: active\n---\n' + BODY_WITH_COMPLEX_CONTENT;

  beforeAll(async () => {
    vault = await makeTempVault();
    await writeFile(path.join(vault, 'note.md'), INITIAL_CONTENT, 'utf8');
    server = await startServer({ vault });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    await cleanupVault(vault);
  });

  it('scenario-1-step-1: set bookmark:true → 200, frontmatter.bookmark===true, body byte-identical [AC-S32940c-3-1]', async () => {
    const { status, body } = await postProperties(server.baseUrl, 'note.md', {
      set: { bookmark: true },
    });
    expect(status, `POST /properties should return 200, got: ${JSON.stringify(body)}`).toBe(200);

    const res = body as { path: string; frontmatter: Record<string, unknown>; mtime: number };
    expect(res.frontmatter.bookmark).toBe(true);

    // Verify via GET
    const { status: getStatus, body: getBody } = await getNote(server.baseUrl, 'note.md');
    expect(getStatus).toBe(200);
    const note = getBody as { content: string; frontmatter: Record<string, unknown>; body: string };
    expect(note.frontmatter.bookmark).toBe(true);
    // Other properties preserved
    expect(note.frontmatter.title).toBe('My Note');
    expect(note.frontmatter.status).toBe('active');
    // Body byte-identical [AC-S32940c-3-2]
    expect(note.body).toBe(BODY_WITH_COMPLEX_CONTENT);
  });

  it('scenario-1-step-2: unset bookmark → 200, bookmark key gone, other props preserved [AC-S32940c-3-1]', async () => {
    const { status, body } = await postProperties(server.baseUrl, 'note.md', {
      unset: ['bookmark'],
    });
    expect(status, `POST /properties (unset) should return 200, got: ${JSON.stringify(body)}`).toBe(200);

    const { status: getStatus, body: getBody } = await getNote(server.baseUrl, 'note.md');
    expect(getStatus).toBe(200);
    const note = getBody as { frontmatter: Record<string, unknown>; body: string };
    expect(note.frontmatter.bookmark).toBeUndefined();
    // Other properties still present [AC-S32940c-3-2]
    expect(note.frontmatter.title).toBe('My Note');
    expect(note.frontmatter.status).toBe('active');
    // Body preserved
    expect(note.body).toBe(BODY_WITH_COMPLEX_CONTENT);
  });

  it('scenario-1-step-3: note with only one key — unset removes frontmatter block entirely [AC-S32940c-3-2]', async () => {
    // Create a note with only bookmark as frontmatter
    const onlyBookmarkContent = '---\nbookmark: true\n---\n\n# Just a heading\n';
    await writeFile(path.join(vault, 'only-bookmark.md'), onlyBookmarkContent, 'utf8');

    const { status, body } = await postProperties(server.baseUrl, 'only-bookmark.md', {
      unset: ['bookmark'],
    });
    expect(status, `POST /properties (unset only key) should return 200, got: ${JSON.stringify(body)}`).toBe(200);

    const res = body as { frontmatter: unknown };
    expect(res.frontmatter).toBeNull();

    // Verify via GET — no frontmatter block
    const { status: getStatus, body: getBody } = await getNote(server.baseUrl, 'only-bookmark.md');
    expect(getStatus).toBe(200);
    const note = getBody as { frontmatter: unknown; content: string };
    expect(note.frontmatter).toBeNull();
    // Content must not start with ---
    expect(note.content).not.toMatch(/^---/);
    // The heading must still be present
    expect(note.content).toContain('# Just a heading');
  });

  it('scenario-1-step-4: complex / unmodelable frontmatter → 4xx, file unchanged [AC-S32940c-3-2]', async () => {
    // Broken YAML — unclosed quote makes it unmodelable (parseNote returns frontmatter:null)
    const complexContent = '---\ntitle: "unclosed string\n---\n\nBody content preserved.\n';
    await writeFile(path.join(vault, 'complex-fm.md'), complexContent, 'utf8');

    const { status } = await postProperties(server.baseUrl, 'complex-fm.md', {
      set: { bookmark: true },
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);

    // File must be unchanged [AC-S32940c-3-2 — priority 2]
    const onDisk = await readFile(path.join(vault, 'complex-fm.md'), 'utf8');
    expect(onDisk).toBe(complexContent);
  });

  it('note with no frontmatter — set creates frontmatter block, body preserved [AC-S32940c-3-1]', async () => {
    const noFmContent = '# No Frontmatter\n\nJust body content.\n';
    await writeFile(path.join(vault, 'no-fm.md'), noFmContent, 'utf8');

    const { status } = await postProperties(server.baseUrl, 'no-fm.md', { set: { bookmark: true } });
    expect(status).toBe(200);

    const { body: getBody } = await getNote(server.baseUrl, 'no-fm.md');
    const note = getBody as { frontmatter: Record<string, unknown>; content: string };
    expect(note.frontmatter.bookmark).toBe(true);
    // Body preserved
    expect(note.content).toContain('# No Frontmatter');
    expect(note.content).toContain('Just body content.');
  });

  it('404 for non-existent note [AC-S32940c-3-1]', async () => {
    const { status } = await postProperties(server.baseUrl, 'does-not-exist.md', {
      set: { bookmark: true },
    });
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Audit log & permissions [AC-S32940c-3-3]
// ---------------------------------------------------------------------------

describe('[AC-S32940c-3-3] 監査ログと権限 (scenario-2)', () => {
  it('scenario-2-step-1: full mode → 200 + audit.log has note.property.write', async () => {
    const vault = await makeTempVault();
    await writeFile(path.join(vault, 'audit-test.md'), '---\ntitle: Test\n---\n\nBody.\n', 'utf8');
    const server = await startServer({ vault, mode: 'full' });
    try {
      const { status } = await postProperties(server.baseUrl, 'audit-test.md', {
        set: { bookmark: true },
      });
      expect(status).toBe(200);

      // audit.log に note.property.write エントリが追記される
      const auditLog = await readFile(path.join(vault, '.loamium', 'audit.log'), 'utf8');
      const lines = auditLog.trim().split('\n').filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l) as { op: string; result: string; path: string });
      const propEntry = entries.find((e) => e.op === 'note.property.write');
      expect(propEntry, 'audit.log should contain note.property.write entry').toBeDefined();
      expect(propEntry?.result).toBe('ok');
      expect(propEntry?.path).toBe('audit-test.md');
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  }, 30_000);

  it('scenario-2-step-2: read-only mode → 403, file unchanged', async () => {
    const vault = await makeTempVault();
    const originalContent = '---\ntitle: Readonly\n---\n\nBody.\n';
    await writeFile(path.join(vault, 'readonly-test.md'), originalContent, 'utf8');
    const server = await startServer({ vault, mode: 'read-only' });
    try {
      const { status } = await postProperties(server.baseUrl, 'readonly-test.md', {
        set: { bookmark: true },
      });
      expect(status).toBe(403);

      // File must not be modified
      const onDisk = await readFile(path.join(vault, 'readonly-test.md'), 'utf8');
      expect(onDisk).toBe(originalContent);
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  }, 30_000);

  it('append-only mode → 403, file unchanged [AC-S32940c-3-3]', async () => {
    const vault = await makeTempVault();
    const originalContent = '---\ntitle: AppendOnly\n---\n\nBody.\n';
    await writeFile(path.join(vault, 'appendonly-test.md'), originalContent, 'utf8');
    const server = await startServer({ vault, mode: 'append-only' });
    try {
      const { status } = await postProperties(server.baseUrl, 'appendonly-test.md', {
        set: { bookmark: true },
      });
      expect(status).toBe(403);

      const onDisk = await readFile(path.join(vault, 'appendonly-test.md'), 'utf8');
      expect(onDisk).toBe(originalContent);
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 3 — CLI 1:1 対応 [AC-S32940c-3-4]
// ---------------------------------------------------------------------------

describe('[AC-S32940c-3-4] CLI prop set / prop unset (scenario-3)', () => {
  let server: TestServer;
  let vault: string;

  function cli(args: string[]): ReturnType<typeof runCli> {
    return runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
  }

  beforeAll(async () => {
    vault = await makeTempVault();
    await mkdir(path.join(vault, '.'), { recursive: true });
    await writeFile(
      path.join(vault, 'cli-note.md'),
      '---\ntitle: CLI Test\n---\n\nBody for CLI test.\n',
      'utf8',
    );
    server = await startServer({ vault });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    await cleanupVault(vault);
  });

  it('scenario-3-step-1: loamium prop set <path> <key> true → exit 0, bookmark===true', async () => {
    const result = await cli(['prop', 'set', 'cli-note.md', 'bookmark', 'true']);
    expect(result.code, `prop set should exit 0, stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');

    // Verify via API
    const { body } = await getNote(server.baseUrl, 'cli-note.md');
    const note = body as { frontmatter: Record<string, unknown> };
    expect(note.frontmatter.bookmark).toBe(true);
  });

  it('scenario-3-step-2: loamium prop unset <path> <key> → exit 0, bookmark removed', async () => {
    const result = await cli(['prop', 'unset', 'cli-note.md', 'bookmark']);
    expect(result.code, `prop unset should exit 0, stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');

    const { body } = await getNote(server.baseUrl, 'cli-note.md');
    const note = body as { frontmatter: Record<string, unknown> };
    expect(note.frontmatter.bookmark).toBeUndefined();
  });

  it('prop set --json returns raw API JSON', async () => {
    const result = await cli(['prop', 'set', 'cli-note.md', 'priority', '42', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { frontmatter: Record<string, unknown>; path: string };
    expect(parsed.frontmatter.priority).toBe(42);
    expect(parsed.path).toBe('cli-note.md');
  });

  it('prop unset on non-existent note → exit 1 with machine-readable error', async () => {
    const result = await cli(['prop', 'unset', 'no-such-note.md', 'bookmark']);
    expect(result.code).toBe(1);
    const err = JSON.parse(result.stderr.trim()) as { error: string };
    expect(err.error).toBe('not_found');
  });

  it('prop set with numeric value → parsed as number', async () => {
    const result = await cli(['prop', 'set', 'cli-note.md', 'rating', '5', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { frontmatter: Record<string, unknown> };
    expect(parsed.frontmatter.rating).toBe(5);
  });

  it('prop set with false → parsed as boolean false', async () => {
    const result = await cli(['prop', 'set', 'cli-note.md', 'archived', 'false', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { frontmatter: Record<string, unknown> };
    expect(parsed.frontmatter.archived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — End-to-end bookmark → LIST WHERE bookmark [AC-S32940c-3-5]
// ---------------------------------------------------------------------------

describe('[AC-S32940c-3-5] E2E: bookmark → LIST WHERE bookmark (scenario-4)', () => {
  let server: TestServer;
  let vault: string;

  function cli(args: string[]): ReturnType<typeof runCli> {
    return runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
  }

  beforeAll(async () => {
    vault = await makeTempVault();
    await writeFile(
      path.join(vault, 'bookmarkable.md'),
      '---\ntitle: Bookmarkable Note\n---\n\nContent.\n',
      'utf8',
    );
    // Another note that should NOT appear in bookmark query
    await writeFile(path.join(vault, 'other.md'), '# Other Note\n\nNo bookmark.\n', 'utf8');
    server = await startServer({ vault });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    await cleanupVault(vault);
  });

  it('scenario-4-step-1: after prop set bookmark true, LIST WHERE bookmark includes note', async () => {
    // Set bookmark via CLI
    const setResult = await cli(['prop', 'set', 'bookmarkable.md', 'bookmark', 'true']);
    expect(setResult.code, `prop set failed: ${setResult.stderr}`).toBe(0);

    // Query
    const { status, body } = await postQuery(server.baseUrl, 'LIST WHERE bookmark');
    expect(status).toBe(200);
    const qr = queryResponseSchema.parse(body);
    expect(qr.type).toBe('list');
    if (qr.type !== 'list') return;
    const paths = qr.results.map((r) => r.path);
    expect(paths).toContain('bookmarkable.md');
    // other.md (no bookmark) should not be in results
    expect(paths).not.toContain('other.md');
  });

  it('scenario-4-step-2: after prop unset bookmark, LIST WHERE bookmark excludes note', async () => {
    // Unset via CLI
    const unsetResult = await cli(['prop', 'unset', 'bookmarkable.md', 'bookmark']);
    expect(unsetResult.code, `prop unset failed: ${unsetResult.stderr}`).toBe(0);

    const { status, body } = await postQuery(server.baseUrl, 'LIST WHERE bookmark');
    expect(status).toBe(200);
    const qr = queryResponseSchema.parse(body);
    expect(qr.type).toBe('list');
    if (qr.type !== 'list') return;
    const paths = qr.results.map((r) => r.path);
    expect(paths).not.toContain('bookmarkable.md');
  });

  it('e2e via API only: set bookmark via POST then verify in DQL', async () => {
    // Reset: create a fresh note
    await writeFile(
      path.join(vault, 'api-bookmark.md'),
      '# API Bookmark Test\n\nBody.\n',
      'utf8',
    );

    const { status } = await postProperties(server.baseUrl, 'api-bookmark.md', {
      set: { bookmark: true },
    });
    expect(status).toBe(200);

    const { body } = await postQuery(server.baseUrl, 'LIST WHERE bookmark');
    const qr = queryResponseSchema.parse(body);
    expect(qr.type).toBe('list');
    if (qr.type !== 'list') return;
    expect(qr.results.map((r) => r.path)).toContain('api-bookmark.md');
  });
});
