/**
 * Story Sd22b1f-2「スマートコマンド実行エンジン」受け入れテスト。
 * 実サーバー (サブプロセス) + 実 HTTP クライアント (fetch) + CLI サブプロセス。
 *
 * カバー:
 * [AC-Sd22b1f-2-1] multi-step happy path (journal-append + note-create)
 * [AC-Sd22b1f-2-2] fail-stop、missing_params 400、path traversal 拒否
 * [AC-Sd22b1f-2-3] read-only 403、append-only 許可、監査ログ記録
 * [AC-Sd22b1f-2-4] note-create 連番サフィックス衝突回避、CLI `command run --param`
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commandRunResponseSchema } from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { runCli } from './helpers/cli.js';

// ---------------------------------------------------------------------------
// テストユーティリティ
// ---------------------------------------------------------------------------

/** CLI を特定サーバーに向けて実行する。 */
function cliFor(server: TestServer) {
  return (args: string[]) => runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
}

/** ノートを vault に置くヘルパー (REST API 経由)。 */
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

/** fs.writeFile で vault に直接ノートを置く (API を通さない)。 */
async function seedNote(vault: string, rel: string, content: string): Promise<void> {
  const abs = path.join(vault, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

/** 監査ログを読む。 */
interface AuditLine {
  ts: string;
  op: string;
  path: string;
  mode: string;
  result: string;
  status: number;
}
async function readAuditLog(vault: string): Promise<AuditLine[]> {
  const logPath = path.join(vault, '.loamium', 'audit.log');
  try {
    const raw = await readFile(logPath, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as AuditLine);
  } catch {
    return [];
  }
}

/** POST /api/commands/{name}/run を呼ぶ。 */
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

/** journal-append + note-create の 2 ステップ (open:true で openPath を確認) */
const CREATE_TODO_COMMAND = [
  '---',
  'loamium-command:',
  '  name: create-todo',
  '  description: Todo を作成してジャーナルに追記する',
  '  params:',
  '    - name: title',
  '      label: タイトル',
  '      required: true',
  '      type: string',
  '  steps:',
  '    - kind: note-create',
  '      target: "todos/{{title}}.md"',
  '      content: "# {{title}}\\n"',
  '      open: true',
  '    - kind: journal-append',
  '      content: "- [ ] [[{{title}}]]"',
  '---',
  '# create-todo',
  '',
].join('\n');

/** note-append ステップ: 既存ノートに追記 */
const APPEND_COMMAND = [
  '---',
  'loamium-command:',
  '  name: append-test',
  '  params:',
  '    - name: target',
  '      required: true',
  '    - name: text',
  '      required: true',
  '  steps:',
  '    - kind: note-append',
  '      target: "{{target}}"',
  '      content: "{{text}}"',
  '---',
  '',
].join('\n');

/** 必須 param なし (param 不足エラーを引き起こすためにあえて required を指定) */
const REQUIRED_PARAM_COMMAND = [
  '---',
  'loamium-command:',
  '  name: required-param',
  '  params:',
  '    - name: topic',
  '      required: true',
  '  steps:',
  '    - kind: note-create',
  '      target: "notes/{{topic}}.md"',
  '      content: "# {{topic}}"',
  '---',
  '',
].join('\n');

/** path traversal を含む target を持つコマンド */
const TRAVERSAL_COMMAND = [
  '---',
  'loamium-command:',
  '  name: traversal-test',
  '  steps:',
  '    - kind: note-create',
  '      target: "../evil"',
  '      content: "evil"',
  '---',
  '',
].join('\n');

/** fail-stop テスト: 1 ステップ目が note-append (存在しないノート) → 失敗後 2 ステップ目は実行されない */
const FAIL_STOP_COMMAND = [
  '---',
  'loamium-command:',
  '  name: fail-stop',
  '  steps:',
  '    - kind: note-append',
  '      target: "nonexistent-note.md"',
  '      content: "appended"',
  '    - kind: journal-append',
  '      content: "this should not run"',
  '---',
  '',
].join('\n');

/** journal-append の section 指定テスト */
const SECTION_COMMAND = [
  '---',
  'loamium-command:',
  '  name: section-test',
  '  params:',
  '    - name: task',
  '      required: true',
  '  steps:',
  '    - kind: journal-append',
  '      content: "- [ ] {{task}}"',
  '      section: "Todo"',
  '      date: "2026-07-11"',
  '---',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// メインテストスイート (full モード)
// ---------------------------------------------------------------------------

describe('[AC-Sd22b1f-2] command run — full mode', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    await putNote(server, 'commands/create-todo.md', CREATE_TODO_COMMAND);
    await putNote(server, 'commands/append-test.md', APPEND_COMMAND);
    await putNote(server, 'commands/required-param.md', REQUIRED_PARAM_COMMAND);
    await putNote(server, 'commands/traversal-test.md', TRAVERSAL_COMMAND);
    await putNote(server, 'commands/fail-stop.md', FAIL_STOP_COMMAND);
    await putNote(server, 'commands/section-test.md', SECTION_COMMAND);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  // -----------------------------------------------------------------------
  // [AC-Sd22b1f-2-1] multi-step happy path
  // -----------------------------------------------------------------------

  it('[AC-Sd22b1f-2-1] multi-step happy path: note-create + journal-append', async () => {
    const { status, body } = await runCommand(server, 'create-todo', { title: 'テストタスク' });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema validation failed: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    const res = parsed.data;
    expect(res.results).toHaveLength(2);
    // ステップ 1: note-create
    expect(res.results[0]?.kind).toBe('note-create');
    expect(res.results[0]?.ok).toBe(true);
    expect(res.results[0]?.path).toBe('todos/テストタスク.md');
    // ステップ 2: journal-append
    expect(res.results[1]?.kind).toBe('journal-append');
    expect(res.results[1]?.ok).toBe(true);
    // open:true はステップ 1 (note-create) なので openPath は todos/テストタスク.md
    expect(res.openPath).toBe('todos/テストタスク.md');

    // 実際にファイルが作られたこと
    const note = await readFile(path.join(server.vault, 'todos/テストタスク.md'), 'utf8');
    expect(note).toBe('# テストタスク\n');
  });

  it('[AC-Sd22b1f-2-1] note-append step appends to existing note', async () => {
    // 追記先ノートを作成
    await putNote(server, 'target-note.md', '# existing\n');
    const { status, body } = await runCommand(server, 'append-test', {
      target: 'target-note.md',
      text: 'new line',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'target-note.md'), 'utf8');
    expect(content).toContain('new line');
  });

  it('[AC-Sd22b1f-2-1] journal-append section inserts under heading', async () => {
    // 既存ジャーナルに ## Todo 見出しを仕込む
    await putNote(server, 'journals/2026-07-11.md', '# 2026-07-11\n\n## Todo\n\n- [ ] 既存\n');
    const { status, body } = await runCommand(server, 'section-test', { task: '新規タスク' });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const journal = await readFile(path.join(server.vault, 'journals/2026-07-11.md'), 'utf8');
    expect(journal).toContain('- [ ] 既存');
    expect(journal).toContain('- [ ] 新規タスク');
    // 新規タスクが既存の後に追加されていること
    const existingIdx = journal.indexOf('- [ ] 既存');
    const newIdx = journal.indexOf('- [ ] 新規タスク');
    expect(newIdx).toBeGreaterThan(existingIdx);
  });

  // -----------------------------------------------------------------------
  // [AC-Sd22b1f-2-2] エラーケース
  // -----------------------------------------------------------------------

  it('[AC-Sd22b1f-2-2] missing required param → 400 missing_params', async () => {
    const { status, body } = await runCommand(server, 'required-param', {});
    expect(status).toBe(400);
    const b = body as { error: string; missing: string[] };
    expect(b.error).toBe('missing_params');
    expect(b.missing).toContain('topic');
  });

  it('[AC-Sd22b1f-2-2] command not found → 404', async () => {
    const { status } = await runCommand(server, 'nonexistent', {});
    expect(status).toBe(404);
  });

  it('[AC-Sd22b1f-2-2] fail-stop: stops at first failure, returns completed steps so far', async () => {
    const { status, body } = await runCommand(server, 'fail-stop', {});
    // ステップ失敗は 200 で返す (AC-Sd22b1f-2-2 の仕様)
    // — "step runtime failure=200 with ok:false"
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    // ステップ 1 が失敗 → results は 1 件のみ (ステップ 2 は実行されない)
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.results[0]?.ok).toBe(false);
    expect(typeof parsed.data.results[0]?.error).toBe('string');
  });

  it('[AC-Sd22b1f-2-2] path traversal in expanded target → 400 invalid_target_path', async () => {
    // AC-Sd22b1f-2-2: 展開後の target が .. 脱出・隠しセグメントを含む場合は 400 で即拒否
    const { status, body } = await runCommand(server, 'traversal-test', {});
    expect(status).toBe(400);
    const b = body as { error: string; message: string };
    expect(b.error).toBe('invalid_target_path');
    expect(typeof b.message).toBe('string');
  });

  /** hidden/dot セグメントの traversal コマンドも追加で確認 */
  it('[AC-Sd22b1f-2-2] hidden segment in expanded target → 400 invalid_target_path', async () => {
    // .hidden セグメントを含む target も 400 で拒否
    await putNote(server, 'commands/hidden-seg-test.md', [
      '---',
      'loamium-command:',
      '  name: hidden-seg-test',
      '  steps:',
      '    - kind: note-create',
      '      target: ".hidden/secret.md"',
      '      content: "secret"',
      '---',
      '',
    ].join('\n'));
    const { status, body } = await runCommand(server, 'hidden-seg-test', {});
    expect(status).toBe(400);
    const b = body as { error: string; message: string };
    expect(b.error).toBe('invalid_target_path');
    expect(typeof b.message).toBe('string');
  });

  // -----------------------------------------------------------------------
  // [AC-Sd22b1f-2-4] note-create suffix collision
  // -----------------------------------------------------------------------

  it('[AC-Sd22b1f-2-4] note-create does not overwrite existing note — uses suffix', async () => {
    // 1 回目: todos/suffix-test.md が作られる
    const first = await runCommand(server, 'create-todo', { title: 'suffix-test' });
    expect(first.status).toBe(200);
    const firstParsed = commandRunResponseSchema.safeParse(first.body);
    expect(firstParsed.success).toBe(true);
    if (!firstParsed.success) throw new Error('unreachable');
    const firstPath = firstParsed.data.results[0]?.path;
    expect(firstPath).toBe('todos/suffix-test.md');

    // 2 回目: 衝突するので todos/suffix-test_2.md が作られる
    const second = await runCommand(server, 'create-todo', { title: 'suffix-test' });
    expect(second.status).toBe(200);
    const secondParsed = commandRunResponseSchema.safeParse(second.body);
    expect(secondParsed.success).toBe(true);
    if (!secondParsed.success) throw new Error('unreachable');
    const secondPath = secondParsed.data.results[0]?.path;
    expect(secondPath).toBe('todos/suffix-test_2.md');

    // 1 件目のファイルが上書きされていないこと
    const original = await readFile(path.join(server.vault, 'todos/suffix-test.md'), 'utf8');
    expect(original).toBe('# suffix-test\n');
  });

  // -----------------------------------------------------------------------
  // [AC-Sd22b1f-2-3] 監査ログ
  // -----------------------------------------------------------------------

  it('[AC-Sd22b1f-2-3] run records command.run in audit log', async () => {
    // このテスト自身でコマンドを実行し、監査ログに command.run が記録されることを確認する
    // (テスト順序に依存しない自己完結テスト)
    const before = await readAuditLog(server.vault);
    const beforeCount = before.filter((l) => l.op === 'command.run').length;

    const { status } = await runCommand(server, 'create-todo', { title: 'audit-self-contained' });
    expect(status).toBe(200);

    const after = await readAuditLog(server.vault);
    const commandRunEntries = after.filter((l) => l.op === 'command.run');
    // このテスト自身が実行した run が新たに記録されているはず
    expect(commandRunEntries.length).toBeGreaterThan(beforeCount);
    // 成功した run は result: ok, mode: full
    const successEntries = commandRunEntries.filter((l) => l.result === 'ok');
    expect(successEntries.length).toBeGreaterThan(0);
    for (const entry of successEntries) {
      expect(entry.mode).toBe('full');
    }
  });

  it('[AC-Sd22b1f-2-3] multi-step run records per-step write entries in audit log', async () => {
    // create-todo: note-create (todos/audit-step-test.md) + journal-append の 2 ステップ
    const { status } = await runCommand(server, 'create-todo', { title: 'audit-step-test' });
    expect(status).toBe(200);

    const lines = await readAuditLog(server.vault);
    // note-create.write エントリが存在し、パスが一致すること
    const noteCreateEntry = lines.find(
      (l) => l.op === 'note-create.write' && l.path === 'todos/audit-step-test.md',
    );
    expect(
      noteCreateEntry,
      'note-create.write entry for todos/audit-step-test.md not found in audit log',
    ).toBeDefined();
    expect(noteCreateEntry?.result).toBe('ok');

    // journal-append.write エントリが存在すること
    const journalWriteEntries = lines.filter((l) => l.op === 'journal-append.write');
    expect(
      journalWriteEntries.length,
      'journal-append.write entries not found in audit log',
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// [AC-Sd22b1f-2-3] 権限モードテスト
// ---------------------------------------------------------------------------

describe('[AC-Sd22b1f-2-3] read-only mode rejects command run', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedNote(vault, 'commands/create-todo.md', CREATE_TODO_COMMAND);
    server = await startServer({ vault, mode: 'read-only' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('[AC-Sd22b1f-2-3] read-only → 403 for POST run', async () => {
    const { status, body } = await runCommand(server, 'create-todo', { title: 'test' });
    expect(status).toBe(403);
    const b = body as { error: string };
    expect(b.error).toBe('forbidden');
  });

  it('[AC-Sd22b1f-2-3] denied run is recorded in audit log with result:denied and op:command.run', async () => {
    const lines = await readAuditLog(server.vault);
    const denied = lines.filter((l) => l.result === 'denied');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.some((l) => l.status === 403)).toBe(true);
    // F-3: deriveOp must return 'command.run' for read-only denial
    expect(denied.some((l) => l.op === 'command.run')).toBe(true);
  });
});

describe('[AC-Sd22b1f-2-3] append-only mode allows v1 commands', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedNote(vault, 'commands/create-todo.md', CREATE_TODO_COMMAND);
    server = await startServer({ vault, mode: 'append-only' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('[AC-Sd22b1f-2-3] append-only allows v1 commands (journal-append + note-create)', async () => {
    // v1 4 種のみで構成されたコマンドは append-only でも実行できる
    const { status, body } = await runCommand(server, 'create-todo', { title: 'ao-test' });
    // append-only でも v1 ステップのコマンドは許可される (ADR-0009)
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results.length).toBeGreaterThan(0);
    expect(parsed.data.results[0]?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [AC-Sd22b1f-2-4] CLI `loamium command run <name> --param k=v`
// ---------------------------------------------------------------------------

describe('[AC-Sd22b1f-2-4] CLI command run', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    await putNote(server, 'commands/create-todo.md', CREATE_TODO_COMMAND);
    await putNote(server, 'commands/required-param.md', REQUIRED_PARAM_COMMAND);
    await putNote(server, 'commands/append-test.md', APPEND_COMMAND);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  const cli = (args: string[]) => runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });

  it('[AC-Sd22b1f-2-4] CLI command run succeeds and prints step results', async () => {
    const result = await cli(['command', 'run', 'create-todo', '--param', 'title=CLIタスク']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    // ok\tnote-create\ttodos/CLIタスク.md
    expect(result.stdout).toContain('ok\tnote-create');
    expect(result.stdout).toContain('todos/CLIタスク.md');
    // open line
    expect(result.stdout).toContain('open\t');
  });

  it('[AC-Sd22b1f-2-4] CLI command run with --json outputs raw JSON', async () => {
    const result = await cli([
      'command', 'run', 'create-todo',
      '--param', 'title=JSON-テスト',
      '--json',
    ]);
    expect(result.code).toBe(0);
    const raw: unknown = JSON.parse(result.stdout);
    const parsed = commandRunResponseSchema.safeParse(raw);
    expect(parsed.success, `schema validation failed: ${JSON.stringify(parsed)}`).toBe(true);
  });

  it('[AC-Sd22b1f-2-4] CLI command run with missing param exits non-0 with machine-readable error', async () => {
    const result = await cli(['command', 'run', 'required-param']);
    expect(result.code).not.toBe(0);
    // サーバーが 400 を返し CLI が exit 1 する
    // stderr は 1 行 JSON
    const errBody = JSON.parse(result.stderr.trim()) as { error: string };
    expect(errBody.error).toBe('missing_params');
  });

  it('[AC-Sd22b1f-2-4] multiple --param flags are all sent', async () => {
    // append-test コマンドは target と text の 2 パラメータが必要
    // まず target ノートを作る
    await fetch(`${server.baseUrl}/api/notes/multi-param-target.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# multi-param\n' }),
    });
    const result = await cli([
      'command', 'run', 'append-test',
      '--param', 'target=multi-param-target.md',
      '--param', 'text=追記テキスト',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ok\tnote-append');
  });
});
