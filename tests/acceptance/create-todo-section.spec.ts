/**
 * Story Sd22b1f-3「create-todo コマンド定義実証」受け入れテスト。
 * [AC-Sd22b1f-3-3]
 *
 * create-todo コマンド定義フィクスチャを run すると、今日のジャーナルの
 * 指定セクション (## Todo) に `- [ ] {{summary}}` 形式の行が追記される。
 *
 * resolveTemplate の missing-optional-var 規約:
 *   vars に存在しないキーは `{{key}}` のまま verbatim に残る (missing[] に収集)。
 *   本テストでは `due` は content テンプレートに含めないことで、
 *   「due 省略時も行が well-formed」を保証する。
 *   具体的に: content = "- [ ] {{summary}}" のみ。
 *   `due` は定義上 optional param として存在するが、journal-append の content に
 *   は含まれないため、省略時も `- [ ] <summary>` という clean な行が生成される。
 *
 *   もし content に "{{due}}" を含める場合の挙動 (ドキュメントのみ):
 *     - due 省略時: `- [ ] <summary> {{due}}` (verbatim トークンが残る)
 *     - due 提供時: `- [ ] <summary> 2026-12-31` のように展開される
 *   本テストはこのフォールバック挙動を検証するテストも含む (WITH_DUE_COMMAND)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commandRunResponseSchema } from '@loamium/shared';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';

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

async function seedNote(vault: string, rel: string, content: string): Promise<void> {
  const abs = path.join(vault, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function runCommand(
  server: TestServer,
  name: string,
  params: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const encoded = name
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(`${server.baseUrl}/api/commands/${encoded}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  });
  const body: unknown = await res.json();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// フィクスチャコマンド定義
// ---------------------------------------------------------------------------

/**
 * create-todo フィクスチャ (AC-Sd22b1f-3-3):
 *
 * params:
 *   - summary (required, string): Todo テキスト
 *   - due     (optional, date):  期限 (content には含めない — 省略時も clean な行)
 *   - detail  (optional, text):  詳細メモ (content には含めない)
 *
 * steps:
 *   1. journal-append: section="Todo", content="- [ ] {{summary}}"
 *      → 今日のジャーナルの ## Todo セクション配下の末尾に追記
 *
 * convention: due/detail は optional param として定義されているが,
 * journal-append の content テンプレートには含まない。
 * resolveTemplate は content を "- [ ] {{summary}}" として受け取り,
 * {{summary}} のみを展開する → due が空でも行は well-formed になる。
 */
const CREATE_TODO_SECTION_COMMAND = [
  '---',
  'loamium-command:',
  '  name: create-todo-section',
  '  description: 今日のジャーナルの Todo セクションにタスクを追記する',
  '  params:',
  '    - name: summary',
  '      label: タスク内容',
  '      required: true',
  '      type: string',
  '    - name: due',
  '      label: 期限 (YYYY-MM-DD)',
  '      required: false',
  '      type: date',
  '    - name: detail',
  '      label: 詳細メモ',
  '      required: false',
  '      type: text',
  '  steps:',
  '    - kind: journal-append',
  '      section: "Todo"',
  '      content: "- [ ] {{summary}}"',
  '---',
  '# create-todo-section',
  '',
  'ジャーナルの ## Todo セクションにタスクを追記するコマンド。',
  '',
].join('\n');

/**
 * due を content に含むバリアント (resolveTemplate の missing-var 挙動検証用)。
 * due が省略されると content 内の {{due}} は verbatim で残る。
 * → 行は `- [ ] <summary> (due: {{due}})` という形式になる。
 */
const CREATE_TODO_WITH_DUE_COMMAND = [
  '---',
  'loamium-command:',
  '  name: create-todo-with-due',
  '  description: due を content に含む create-todo バリアント',
  '  params:',
  '    - name: summary',
  '      label: タスク内容',
  '      required: true',
  '      type: string',
  '    - name: due',
  '      label: 期限 (YYYY-MM-DD)',
  '      required: false',
  '      type: date',
  '  steps:',
  '    - kind: journal-append',
  '      section: "Todo"',
  '      content: "- [ ] {{summary}} (due: {{due}})"',
  '---',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

describe('[AC-Sd22b1f-3-3] create-todo section コマンド実証', () => {
  let server: TestServer;
  const today = localToday();

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    // フィクスチャをシード
    await seedNote(vault, 'commands/create-todo-section.md', CREATE_TODO_SECTION_COMMAND);
    await seedNote(vault, 'commands/create-todo-with-due.md', CREATE_TODO_WITH_DUE_COMMAND);
    // 今日のジャーナルを初期化 (## Todo セクションあり)
    await seedNote(
      vault,
      `journals/${today}.md`,
      `# ${today}\n\n## Todo\n\n## Done\n`,
    );
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  // -------------------------------------------------------------------------
  // [AC-Sd22b1f-3-3] summary のみ提供 (due 省略)
  // -------------------------------------------------------------------------

  it('[AC-Sd22b1f-3-3] summary のみで実行: - [ ] <summary> が ## Todo 配下に追記される', async () => {
    const { status, body } = await runCommand(server, 'create-todo-section', {
      summary: 'レポートを書く',
      // due は意図的に省略
    });
    expect(status).toBe(200);

    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema validation failed: ${JSON.stringify(body)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    // ステップが 1 件あって成功していること
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.results[0]?.kind).toBe('journal-append');
    expect(parsed.data.results[0]?.ok).toBe(true);

    // 今日のジャーナルに行が追記されていること
    const journal = await readFile(
      path.join(server.vault, 'journals', `${today}.md`),
      'utf8',
    );
    expect(journal).toContain('- [ ] レポートを書く');

    // ## Todo セクション配下にあること (## Done より前)
    const todoIdx = journal.indexOf('- [ ] レポートを書く');
    const doneIdx = journal.indexOf('## Done');
    expect(todoIdx).toBeGreaterThan(-1);
    expect(todoIdx).toBeLessThan(doneIdx);

    // 行が well-formed であること (verbatim トークンが残らない)
    const line = journal.split('\n').find((l) => l.includes('- [ ] レポートを書く'));
    expect(line).toBeDefined();
    // content テンプレートに {{due}} が含まれていないので verbatim トークンは残らない
    expect(line).not.toContain('{{');
    expect(line).not.toContain('}}');
  });

  it('[AC-Sd22b1f-3-3] due も提供: - [ ] <summary> が同じく追記される (due は content に影響しない)', async () => {
    const { status } = await runCommand(server, 'create-todo-section', {
      summary: '会議の準備',
      due: '2026-07-31',
    });
    expect(status).toBe(200);

    const journal = await readFile(
      path.join(server.vault, 'journals', `${today}.md`),
      'utf8',
    );
    // - [ ] 会議の準備 が追記されていること
    expect(journal).toContain('- [ ] 会議の準備');
    // due は content テンプレートにないので行に影響しない
    const line = journal.split('\n').find((l) => l.includes('- [ ] 会議の準備'));
    expect(line).toBe('- [ ] 会議の準備');
  });

  // -------------------------------------------------------------------------
  // [AC-Sd22b1f-3-3] missing required param の検証
  // -------------------------------------------------------------------------

  it('[AC-Sd22b1f-3-3] summary 省略時は 400 missing_params', async () => {
    const { status, body } = await runCommand(server, 'create-todo-section', {
      // summary は省略 (required)
      due: '2026-07-31',
    });
    expect(status).toBe(400);
    const b = body as { error: string; missing: string[] };
    expect(b.error).toBe('missing_params');
    expect(b.missing).toContain('summary');
  });

  // -------------------------------------------------------------------------
  // [AC-Sd22b1f-3-3] resolveTemplate missing-var 挙動の明示的ドキュメントテスト
  // -------------------------------------------------------------------------

  /**
   * due を content テンプレートに含む create-todo-with-due コマンドで、
   * due を省略した場合の挙動を検証する。
   *
   * resolveTemplate 規約: vars に存在しないキーは `{{key}}` のまま verbatim に残る。
   * → content = "- [ ] {{summary}} (due: {{due}})" + due 省略
   * → 展開結果: "- [ ] <summary> (due: {{due}})"
   * これは「クラッシュしない」「行は生成される」という意味で "well-formed" だが、
   * verbatim トークンが残る点を明示的にアサートする。
   *
   * 使用するコマンド: create-todo-with-due (別フィクスチャ)
   */
  it('[AC-Sd22b1f-3-3] resolveTemplate missing-var: due 省略時 {{due}} が verbatim に残る (documented behavior)', async () => {
    const date = '2026-08-01';
    // テスト用ジャーナルを直接書く
    await seedNote(
      server.vault,
      `journals/${date}.md`,
      `# ${date}\n\n## Todo\n\n`,
    );

    const { status, body } = await runCommand(server, 'create-todo-with-due', {
      summary: 'テスト',
      // due は省略
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    // コマンドは成功する (クラッシュしない)
    expect(parsed.data.results[0]?.ok).toBe(true);

    // today のジャーナルに追記される
    const todayJournal = await readFile(
      path.join(server.vault, 'journals', `${today}.md`),
      'utf8',
    );
    // create-todo-with-due は section="Todo" で today のジャーナルに書く
    // (date 指定なし → todayJournalDate を使う)
    const line = todayJournal.split('\n').find((l) => l.includes('- [ ] テスト'));
    expect(line).toBeDefined();
    // due が省略されているので {{due}} が verbatim に残ること
    expect(line).toContain('{{due}}');
    expect(line).toBe('- [ ] テスト (due: {{due}})');
  });
});
