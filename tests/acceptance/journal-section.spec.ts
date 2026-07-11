/**
 * Story Sd22b1f-3「journal-append section 対応」受け入れテスト。
 * 実サーバー (サブプロセス) + 実 HTTP クライアント (fetch) + CLI サブプロセス。
 *
 * [AC-Sd22b1f-3-1] POST /api/journal/append の section 対応
 *   - section あり → 見出し配下の末尾に挿入
 *   - section あり、見出しなし → ファイル末尾に見出しごと追記
 *   - section なし → 従来どおり appendText (回帰)
 * [AC-Sd22b1f-3-2] CLI journal-append --section が 1:1 で動く
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { journalAppendResponseSchema } from '@loamium/shared';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';
import { runCli } from './helpers/cli.js';

// ---------------------------------------------------------------------------
// テストユーティリティ
// ---------------------------------------------------------------------------

function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** REST API で journal/append を呼ぶ。 */
async function journalAppend(
  server: TestServer,
  body: { content: string; date?: string; section?: string },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.baseUrl}/api/journal/append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody: unknown = await res.json();
  return { status: res.status, body: responseBody };
}

/** 指定日のジャーナルをファイルから読む。 */
async function readJournal(vault: string, date: string): Promise<string> {
  return readFile(path.join(vault, 'journals', `${date}.md`), 'utf8');
}

/** PUT /api/notes/{path} でノートをシードする。 */
async function putNote(server: TestServer, rel: string, content: string): Promise<void> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(`${server.baseUrl}/api/notes/${encoded}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`seed putNote failed for ${rel}: ${res.status}`);
}

// ---------------------------------------------------------------------------
// [AC-Sd22b1f-3-1] POST /api/journal/append section 対応
// ---------------------------------------------------------------------------

describe('[AC-Sd22b1f-3-1] POST /api/journal/append with section', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('[AC-Sd22b1f-3-1] section present: inserts under that heading', async () => {
    const date = '2026-04-01';
    // 既存ジャーナルに見出しを仕込む
    await putNote(server, `journals/${date}.md`, '# 日記\n\n## Todo\n\n- [ ] 既存\n\n## Done\n\n- [x] 済み\n');

    const { status, body } = await journalAppend(server, {
      content: '- [ ] 新規タスク',
      date,
      section: 'Todo',
    });
    expect(status).toBe(200);
    const parsed = journalAppendResponseSchema.safeParse(body);
    expect(parsed.success, `schema validation failed: ${JSON.stringify(parsed)}`).toBe(true);

    const raw = await readJournal(server.vault, date);
    expect(raw).toContain('- [ ] 既存');
    expect(raw).toContain('- [ ] 新規タスク');
    // 新規が既存の後、Done セクションの前にあること
    const existingIdx = raw.indexOf('- [ ] 既存');
    const newIdx = raw.indexOf('- [ ] 新規タスク');
    const doneIdx = raw.indexOf('## Done');
    expect(newIdx).toBeGreaterThan(existingIdx);
    expect(newIdx).toBeLessThan(doneIdx);
  });

  it('[AC-Sd22b1f-3-1] section present, heading absent: appends heading + text at EOF', async () => {
    const date = '2026-04-02';
    // 見出しのないジャーナル
    await putNote(server, `journals/${date}.md`, '# 日記\n\n本文のみ\n');

    const { status } = await journalAppend(server, {
      content: '- [ ] 新規',
      date,
      section: 'Todo',
    });
    expect(status).toBe(200);

    const raw = await readJournal(server.vault, date);
    // 末尾に見出しと追記内容が付与されること
    expect(raw).toContain('## Todo');
    expect(raw).toContain('- [ ] 新規');
    // 見出しが末尾に追記されていること (元の本文より後)
    const bodyIdx = raw.indexOf('本文のみ');
    const headingIdx = raw.indexOf('## Todo');
    expect(headingIdx).toBeGreaterThan(bodyIdx);
  });

  it('[AC-Sd22b1f-3-1] section absent: legacy appendText behavior is unchanged (regression)', async () => {
    const date = '2026-04-03';
    // 既存ジャーナル
    await putNote(server, `journals/${date}.md`, '# 日記\n\n- 既存行\n');

    const { status } = await journalAppend(server, {
      content: '- 追記行',
      date,
      // section なし
    });
    expect(status).toBe(200);

    const raw = await readJournal(server.vault, date);
    // ファイル末尾に追記されていること
    expect(raw).toContain('- 既存行');
    expect(raw).toContain('- 追記行');
    const existingIdx = raw.indexOf('- 既存行');
    const newIdx = raw.indexOf('- 追記行');
    expect(newIdx).toBeGreaterThan(existingIdx);
    // 余計な見出しが追加されていないこと
    expect(raw).not.toContain('##');
  });

  it('[AC-Sd22b1f-3-1] section present, file does not exist: creates file with heading + text (201)', async () => {
    const date = '2026-04-04';
    // ファイルが存在しない状態から section 付き append

    const { status, body } = await journalAppend(server, {
      content: '- [ ] 初回',
      date,
      section: 'Todo',
    });
    expect(status).toBe(201);
    const parsed = journalAppendResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.created).toBe(true);

    const raw = await readJournal(server.vault, date);
    // 空コンテンツに見出しが追記される (insertUnderHeading の empty content ケース)
    expect(raw).toContain('## Todo');
    expect(raw).toContain('- [ ] 初回');
  });
});

// ---------------------------------------------------------------------------
// [AC-Sd22b1f-3-2] CLI journal-append --section
// ---------------------------------------------------------------------------

describe('[AC-Sd22b1f-3-2] CLI journal-append --section', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  const today = localToday();

  it('[AC-Sd22b1f-3-2] --section inserts under heading via CLI', async () => {
    // 既存ジャーナルに ## Todo 見出しを仕込む
    await putNote(server, `journals/${today}.md`, '# 日記\n\n## Todo\n\n既存CLIタスク\n');

    // Note: CLI content that starts with '-' would be misinterpreted by Commander
    // as an option flag. Use content that does not start with '-' in CLI tests.
    // REST API handles '- [ ] ...' content directly (no Commander parsing involved).
    const result = await runCli(
      ['journal-append', 'CLIから追記したタスク', '--section', 'Todo'],
      { env: { LOAMIUM_URL: server.baseUrl } },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    // 成功メッセージにジャーナルパスが含まれる
    expect(result.stdout).toContain('journals/');

    const raw = await readJournal(server.vault, today);
    expect(raw).toContain('既存CLIタスク');
    expect(raw).toContain('CLIから追記したタスク');
    // CLI追記が既存の後に来ること
    const existingIdx = raw.indexOf('既存CLIタスク');
    const cliIdx = raw.indexOf('CLIから追記したタスク');
    expect(cliIdx).toBeGreaterThan(existingIdx);
  });

  it('[AC-Sd22b1f-3-2] --section with absent heading: appends heading + text via CLI', async () => {
    const date = '2026-05-01';
    // 見出しのないジャーナル
    await putNote(server, `journals/${date}.md`, '# 日記\n\n本文\n');

    const result = await runCli(
      ['journal-append', '新しいCLIタスク', date, '--section', 'Tasks'],
      { env: { LOAMIUM_URL: server.baseUrl } },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');

    const raw = await readJournal(server.vault, date);
    expect(raw).toContain('## Tasks');
    expect(raw).toContain('新しいCLIタスク');
  });

  it('[AC-Sd22b1f-3-2] --json output works with --section', async () => {
    const date = '2026-05-02';
    await putNote(server, `journals/${date}.md`, '## Todo\n\n- item\n');

    const result = await runCli(
      ['journal-append', 'json-test-item', date, '--section', 'Todo', '--json'],
      { env: { LOAMIUM_URL: server.baseUrl } },
    );
    expect(result.code).toBe(0);
    const raw: unknown = JSON.parse(result.stdout);
    const parsed = journalAppendResponseSchema.safeParse(raw);
    expect(parsed.success, `schema validation failed: ${JSON.stringify(parsed)}`).toBe(true);
  });
});
