/**
 * Story S67ea41-1「journal 遅延生成へのテンプレート適用」受け入れテスト。
 * 実サーバー (サブプロセス) + 実 HTTP クライアント (fetch) + 実ファイル (test-discipline Rule 2)。
 *
 * 検証の要点:
 * - [AC-S67ea41-1-1] 既定 journal テンプレートを適用した本文でファイル作成 / テンプレ無しは空ファイル (後方互換)
 * - [AC-S67ea41-1-2] {{date:...}} が対象日 (未来日/過去日含む) 基準で展開 / read-only は書かず仮想返却
 * - [AC-S67ea41-1-3] 既存ジャーナルは上書きしない (冪等)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { journalPath } from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

/** 既定 journal テンプレート: 対象日基準の見出し + 作者の他フロントマターを含む。 */
const JOURNAL_TEMPLATE = [
  '---',
  'loamium-template:',
  '  description: デイリージャーナル',
  'tags: [journal]',
  '---',
  '# {{date:YYYY-MM-DD}} ({{date:MM}}/{{date:DD}})',
  '',
  '## やること',
  '',
].join('\n');

/** vault ディスクへ直接ファイルを書く (read-only サーバーでも事前に seed するため)。 */
async function seedFile(vault: string, rel: string, content: string): Promise<void> {
  const abs = path.join(vault, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function fileExists(vault: string, rel: string): Promise<boolean> {
  try {
    return (await stat(path.join(vault, ...rel.split('/')))).isFile();
  } catch {
    return false;
  }
}

interface JournalBody {
  date: string;
  path: string;
  content: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
  created: boolean;
  mtime: number | null;
}

describe('[AC-S67ea41-1-1] 既定テンプレートを適用した本文で遅延生成する', () => {
  let server: TestServer;
  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedFile(vault, 'templates/journal.md', JOURNAL_TEMPLATE);
    server = await startServer({ vault });
  });
  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('テンプレートを対象日基準で解決した本文でファイルを作成する', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal?date=2026-07-06`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as JournalBody;
    expect(body.created).toBe(true);
    expect(body.path).toBe(journalPath('2026-07-06'));
    // 対象日基準で {{date:...}} が展開されている
    expect(body.content).toContain('# 2026-07-06 (07/06)');
    // 作者の他フロントマターは保持され、loamium-template は結果に残らない
    expect(body.frontmatter).toEqual({ tags: ['journal'] });
    expect(body.content).not.toContain('loamium-template');
    // 解決済みピュア Markdown (テンプレ記法 非残存)
    expect(body.content).not.toContain('{{');

    // 実ファイルにテンプレ適用済み本文が書かれている (ファイルが正)
    const raw = await readFile(
      path.join(server.vault, journalPath('2026-07-06')),
      'utf8',
    );
    expect(raw).toContain('# 2026-07-06 (07/06)');
    expect(raw).not.toContain('{{');
  });
});

describe('[AC-S67ea41-1-1] テンプレート無しは従来どおり空ファイル (後方互換)', () => {
  let server: TestServer;
  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
  });
  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('templates/journal.md が無ければ空ファイルで作成する', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal?date=2026-05-20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as JournalBody;
    expect(body.created).toBe(true);
    expect(body.content).toBe('');
    expect(body.frontmatter).toBeNull();

    const raw = await readFile(
      path.join(server.vault, journalPath('2026-05-20')),
      'utf8',
    );
    expect(raw).toBe('');
  });
});

describe('[AC-S67ea41-1-2] 対象日 (未来日/過去日) 基準で展開する', () => {
  let server: TestServer;
  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedFile(vault, 'templates/journal.md', JOURNAL_TEMPLATE);
    server = await startServer({ vault });
  });
  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('未来日ジャーナルは対象日で展開される (now ではない)', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal?date=2030-12-31`);
    const body = (await res.json()) as JournalBody;
    expect(body.content).toContain('# 2030-12-31 (12/31)');
    expect(body.content).not.toContain('{{');
  });

  it('過去日ジャーナルは対象日で展開される', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal?date=2019-01-02`);
    const body = (await res.json()) as JournalBody;
    expect(body.content).toContain('# 2019-01-02 (01/02)');
    expect(body.content).not.toContain('{{');
  });
});

describe('[AC-S67ea41-1-2] read-only は書き込まずテンプレ適用済み仮想ジャーナルを返す', () => {
  let server: TestServer;
  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedFile(vault, 'templates/journal.md', JOURNAL_TEMPLATE);
    server = await startServer({ vault, mode: 'read-only' });
  });
  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('テンプレ適用済み本文を返すが、ディスクには書かない (created=false / mtime=null)', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal?date=2026-08-15`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as JournalBody;
    // 仮想ジャーナル: 生成扱いにしない
    expect(body.created).toBe(false);
    expect(body.mtime).toBeNull();
    // だがテンプレは対象日基準で適用済み
    expect(body.content).toContain('# 2026-08-15 (08/15)');
    expect(body.content).not.toContain('{{');

    // ファイルは書かれていない (read-only はファイルを守る)
    expect(await fileExists(server.vault, journalPath('2026-08-15'))).toBe(false);
  });
});

describe('[AC-S67ea41-1-3] 既存ジャーナルは上書きしない (冪等)', () => {
  let server: TestServer;
  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedFile(vault, 'templates/journal.md', JOURNAL_TEMPLATE);
    // ユーザーが既に書いたジャーナルを seed
    await seedFile(vault, journalPath('2026-06-01'), '# 手書きの見出し\n\n既存の内容\n');
    server = await startServer({ vault });
  });
  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('既存ファイルはテンプレで上書きされず、そのまま返る', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal?date=2026-06-01`);
    const body = (await res.json()) as JournalBody;
    expect(body.created).toBe(false);
    expect(body.content).toBe('# 手書きの見出し\n\n既存の内容\n');

    const raw = await readFile(
      path.join(server.vault, journalPath('2026-06-01')),
      'utf8',
    );
    expect(raw).toBe('# 手書きの見出し\n\n既存の内容\n');
  });

  it('新規生成後の 2 回目アクセスは created=false で内容が変わらない', async () => {
    const first = await fetch(`${server.baseUrl}/api/journal?date=2026-06-02`);
    const firstBody = (await first.json()) as JournalBody;
    expect(firstBody.created).toBe(true);
    const firstContent = firstBody.content;

    const second = await fetch(`${server.baseUrl}/api/journal?date=2026-06-02`);
    const secondBody = (await second.json()) as JournalBody;
    expect(secondBody.created).toBe(false);
    expect(secondBody.content).toBe(firstContent);
  });
});
