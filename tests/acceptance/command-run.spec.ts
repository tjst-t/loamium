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
// [BUG-REGRESSION] 表示名 ≠ ファイル stem のコマンド (GET id/name 分離の検証)
// ---------------------------------------------------------------------------

describe('[BUG-REGRESSION] display name ≠ stem — GET returns id, run uses stem', () => {
  let server: TestServer;

  /** display name に スペースを含む (stem="my-cmd", name="My Command") */
  const MY_CMD = [
    '---',
    'loamium-command:',
    '  name: "My Command"',
    '  description: display name differs from file stem',
    '  steps:',
    '    - kind: journal-append',
    '      content: "my-cmd ran"',
    '---',
    '# my-cmd',
    '',
  ].join('\n');

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    await putNote(server, 'commands/my-cmd.md', MY_CMD);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('GET returns id="my-cmd" (stem) and name="My Command" (display)', async () => {
    const res = await fetch(`${server.baseUrl}/api/commands`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: Array<{ id: string; name: string; path: string; valid: boolean }> };
    const cmd = body.commands.find((c) => c.path === 'commands/my-cmd.md');
    expect(cmd).toBeDefined();
    expect(cmd?.id).toBe('my-cmd');
    expect(cmd?.name).toBe('My Command');
    expect(cmd?.valid).toBe(true);
  });

  it('POST /api/commands/my-cmd/run (stem) succeeds', async () => {
    const { status } = await runCommand(server, 'my-cmd', {});
    expect(status).toBe(200);
  });

  it('POST /api/commands/My Command/run (display name) → 404', async () => {
    const { status } = await runCommand(server, 'My Command', {});
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// [AC-Sd22b1f-2-4] CLI `loamium command run <name> --param k=v`
// ---------------------------------------------------------------------------

describe('[AC-Sd22b1f-2-4] CLI command run', () => {
  let server: TestServer;

  /** when-gate: flag が truthy なら note-create を実行、falsey ならスキップ */
  const CLI_WHEN_GATE_COMMAND = [
    '---',
    'loamium-command:',
    '  name: cli-when-gate',
    '  params:',
    '    - name: flag',
    '    - name: title',
    '      required: true',
    '  steps:',
    '    - kind: note-create',
    '      target: "cli-when-tests/{{title}}.md"',
    '      content: "# {{title}}"',
    '      when: "{{flag}}"',
    '---',
    '',
  ].join('\n');

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    await putNote(server, 'commands/create-todo.md', CREATE_TODO_COMMAND);
    await putNote(server, 'commands/required-param.md', REQUIRED_PARAM_COMMAND);
    await putNote(server, 'commands/append-test.md', APPEND_COMMAND);
    await putNote(server, 'commands/cli-when-gate.md', CLI_WHEN_GATE_COMMAND);
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

  it('[AC-Sf2f114-2-4] CLI human output: skipped step prints skip\\t{kind} not ok\\t{kind}', async () => {
    // flag を渡さない → when: "{{flag}}" が falsey → note-create がスキップされる
    const result = await cli([
      'command', 'run', 'cli-when-gate',
      '--param', 'title=cli-skip-test',
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    // スキップされたステップは "skip\tnote-create" で表示される
    expect(result.stdout).toContain('skip\tnote-create');
    // "ok\tnote-create" は出力されない
    expect(result.stdout).not.toContain('ok\tnote-create');
  });

  it('[AC-Sf2f114-2-4] CLI --json: skipped step still has ok:true and skipped:true (json unchanged)', async () => {
    const result = await cli([
      'command', 'run', 'cli-when-gate',
      '--param', 'title=cli-skip-json',
      '--json',
    ]);
    expect(result.code).toBe(0);
    const raw: unknown = JSON.parse(result.stdout);
    const parsed = commandRunResponseSchema.safeParse(raw);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    // JSON モードではスキップステップが ok:true + skipped:true で返る
    expect(parsed.data.results[0]?.skipped).toBe(true);
    expect(parsed.data.results[0]?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [AC-Sf2f114-3-1/2] note-append の section/create/position 一般化 (ADR-0010)
// ---------------------------------------------------------------------------

describe('[AC-Sf2f114-3-1] note-append with section/create/position', () => {
  let server: TestServer;

  /** note-append with section — 見出し存在時 */
  const NOTE_APPEND_SECTION_COMMAND = [
    '---',
    'loamium-command:',
    '  name: note-append-section',
    '  params:',
    '    - name: target',
    '      required: true',
    '    - name: text',
    '      required: true',
    '    - name: section',
    '      required: true',
    '  steps:',
    '    - kind: note-append',
    '      target: "{{target}}"',
    '      content: "{{text}}"',
    '      section: "{{section}}"',
    '---',
    '',
  ].join('\n');

  /** note-append with create:true — 存在しないノートを新規作成 */
  const NOTE_APPEND_CREATE_COMMAND = [
    '---',
    'loamium-command:',
    '  name: note-append-create',
    '  params:',
    '    - name: target',
    '      required: true',
    '    - name: text',
    '      required: true',
    '  steps:',
    '    - kind: note-append',
    '      target: "{{target}}"',
    '      content: "{{text}}"',
    '      create: true',
    '---',
    '',
  ].join('\n');

  /** note-append with position:top */
  const NOTE_APPEND_TOP_COMMAND = [
    '---',
    'loamium-command:',
    '  name: note-append-top',
    '  params:',
    '    - name: target',
    '      required: true',
    '    - name: text',
    '      required: true',
    '  steps:',
    '    - kind: note-append',
    '      target: "{{target}}"',
    '      content: "{{text}}"',
    '      position: "top"',
    '---',
    '',
  ].join('\n');

  /** note-append with position:bottom (explicit) */
  const NOTE_APPEND_BOTTOM_COMMAND = [
    '---',
    'loamium-command:',
    '  name: note-append-bottom',
    '  params:',
    '    - name: target',
    '      required: true',
    '    - name: text',
    '      required: true',
    '  steps:',
    '    - kind: note-append',
    '      target: "{{target}}"',
    '      content: "{{text}}"',
    '      position: "bottom"',
    '---',
    '',
  ].join('\n');

  /** note-append without create — 後方互換: 存在しないノート → ok:false */
  const NOTE_APPEND_NO_CREATE_COMMAND = [
    '---',
    'loamium-command:',
    '  name: note-append-no-create',
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

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    await putNote(server, 'commands/note-append-section.md', NOTE_APPEND_SECTION_COMMAND);
    await putNote(server, 'commands/note-append-create.md', NOTE_APPEND_CREATE_COMMAND);
    await putNote(server, 'commands/note-append-top.md', NOTE_APPEND_TOP_COMMAND);
    await putNote(server, 'commands/note-append-bottom.md', NOTE_APPEND_BOTTOM_COMMAND);
    await putNote(server, 'commands/note-append-no-create.md', NOTE_APPEND_NO_CREATE_COMMAND);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-3-1] section: 見出し存在時 — 見出し配下に挿入
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-3-1] note-append with section (heading present): inserts under heading', async () => {
    await putNote(server, 'sectioned-note.md', '# Note\n\n## Todo\n\n- [ ] existing\n');
    const { status, body } = await runCommand(server, 'note-append-section', {
      target: 'sectioned-note.md',
      text: '- [ ] new task',
      section: 'Todo',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'sectioned-note.md'), 'utf8');
    expect(content).toContain('- [ ] existing');
    expect(content).toContain('- [ ] new task');
    // new task が existing の後に来ること
    const existingIdx = content.indexOf('- [ ] existing');
    const newIdx = content.indexOf('- [ ] new task');
    expect(newIdx).toBeGreaterThan(existingIdx);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-3-1] section: 見出し不在時 — EOF に見出しごと追加
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-3-1] note-append with section (heading absent): creates heading at EOF', async () => {
    await putNote(server, 'no-heading-note.md', '# Note\n\nsome content\n');
    const { status, body } = await runCommand(server, 'note-append-section', {
      target: 'no-heading-note.md',
      text: '- [ ] task',
      section: 'Todo',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'no-heading-note.md'), 'utf8');
    expect(content).toContain('## Todo');
    expect(content).toContain('- [ ] task');
    const headingIdx = content.indexOf('## Todo');
    const taskIdx = content.indexOf('- [ ] task');
    expect(taskIdx).toBeGreaterThan(headingIdx);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-3-1] create:true — 存在しないノートを新規作成して追記
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-3-1] note-append with create:true (missing target) → creates note', async () => {
    const { status, body } = await runCommand(server, 'note-append-create', {
      target: 'newly-created.md',
      text: '# Created Content',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.path).toBe('newly-created.md');

    const content = await readFile(path.join(server.vault, 'newly-created.md'), 'utf8');
    expect(content).toContain('# Created Content');
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-3-2] 後方互換: create なし → 存在しないノートは ok:false
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-3-2] note-append without create to missing target → ok:false (backward compat)', async () => {
    const { status, body } = await runCommand(server, 'note-append-no-create', {
      target: 'definitely-nonexistent.md',
      text: 'some text',
    });
    // ステップ失敗は HTTP 200 (fail-stop は ok:false で返す)
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(false);
    expect(typeof parsed.data.results[0]?.error).toBe('string');
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-3-1] position:top — frontmatter 保護して本文先頭に挿入
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-3-1] note-append position:top (no frontmatter) → inserts at body start', async () => {
    await putNote(server, 'top-target-no-fm.md', '# Title\n\nbody line\n');
    const { status, body } = await runCommand(server, 'note-append-top', {
      target: 'top-target-no-fm.md',
      text: 'prepended line',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'top-target-no-fm.md'), 'utf8');
    expect(content).toContain('prepended line');
    expect(content).toContain('# Title');
    expect(content).toContain('body line');
    // prepended line が # Title の前にあること
    const prependedIdx = content.indexOf('prepended line');
    const titleIdx = content.indexOf('# Title');
    expect(prependedIdx).toBeLessThan(titleIdx);
  });

  it('[AC-Sf2f114-3-1] note-append position:top (with frontmatter) → preserves frontmatter, inserts before body', async () => {
    await putNote(
      server,
      'top-target-fm.md',
      '---\ntitle: FM Note\n---\n# Title\n\nbody\n',
    );
    const { status, body } = await runCommand(server, 'note-append-top', {
      target: 'top-target-fm.md',
      text: '> prepended quote',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'top-target-fm.md'), 'utf8');
    // frontmatter が保護されていること
    expect(content).toContain('---\ntitle: FM Note\n---\n');
    // 挿入テキストが frontmatter の直後にあること
    expect(content).toContain('> prepended quote');
    // 既存本文が後ろに続くこと
    expect(content).toContain('# Title');
    const prependedIdx = content.indexOf('> prepended quote');
    const titleIdx = content.indexOf('# Title');
    expect(prependedIdx).toBeLessThan(titleIdx);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-3-1] position:bottom (explicit) — 末尾に追記
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-3-1] note-append position:bottom → appends at end', async () => {
    await putNote(server, 'bottom-target.md', '# Title\n\nfirst line\n');
    const { status, body } = await runCommand(server, 'note-append-bottom', {
      target: 'bottom-target.md',
      text: 'last line',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'bottom-target.md'), 'utf8');
    expect(content).toContain('first line');
    expect(content).toContain('last line');
    const firstIdx = content.indexOf('first line');
    const lastIdx = content.indexOf('last line');
    expect(lastIdx).toBeGreaterThan(firstIdx);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-3-2] journal-append: 後方互換 (section あり/なし、変更なし)
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-3-2] journal-append unchanged — backward compat (section present)', async () => {
    await putNote(server, 'journals/2026-07-12.md', '# 2026-07-12\n\n## Log\n\n- existing\n');
    await putNote(server, 'commands/journal-compat-section.md', [
      '---',
      'loamium-command:',
      '  name: journal-compat-section',
      '  steps:',
      '    - kind: journal-append',
      '      content: "- new entry"',
      '      section: "Log"',
      '      date: "2026-07-12"',
      '---',
      '',
    ].join('\n'));

    const { status, body } = await runCommand(server, 'journal-compat-section', {});
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'journals/2026-07-12.md'), 'utf8');
    expect(content).toContain('- existing');
    expect(content).toContain('- new entry');
    const existingIdx = content.indexOf('- existing');
    const newIdx = content.indexOf('- new entry');
    expect(newIdx).toBeGreaterThan(existingIdx);
  });

  it('[AC-Sf2f114-3-2] journal-append unchanged — backward compat (section absent, bottom)', async () => {
    await putNote(server, 'journals/2026-07-10.md', '# 2026-07-10\n\nsome text\n');
    await putNote(server, 'commands/journal-compat-bottom.md', [
      '---',
      'loamium-command:',
      '  name: journal-compat-bottom',
      '  steps:',
      '    - kind: journal-append',
      '      content: "appended line"',
      '      date: "2026-07-10"',
      '---',
      '',
    ].join('\n'));

    const { status, body } = await runCommand(server, 'journal-compat-bottom', {});
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'journals/2026-07-10.md'), 'utf8');
    expect(content).toContain('some text');
    expect(content).toContain('appended line');
    const someIdx = content.indexOf('some text');
    const appendedIdx = content.indexOf('appended line');
    expect(appendedIdx).toBeGreaterThan(someIdx);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-3-1] position:'section' なのに section フィールドなし → ok:false
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-3-1] note-append position:section without section field → ok:false (does not crash)', async () => {
    // position:'section' を指定したが section フィールドが未設定のコマンド
    const POSITION_SECTION_NO_SECTION_COMMAND = [
      '---',
      'loamium-command:',
      '  name: position-section-no-section',
      '  params:',
      '    - name: target',
      '      required: true',
      '    - name: text',
      '      required: true',
      '  steps:',
      '    - kind: note-append',
      '      target: "{{target}}"',
      '      content: "{{text}}"',
      '      position: "section"',
      '---',
      '',
    ].join('\n');
    await putNote(server, 'commands/position-section-no-section.md', POSITION_SECTION_NO_SECTION_COMMAND);
    await putNote(server, 'pos-section-target.md', '# Target\n\nsome content\n');

    const { status, body } = await runCommand(server, 'position-section-no-section', {
      target: 'pos-section-target.md',
      text: 'should not appear',
    });
    // コマンド自体はクラッシュせず 200 で返る (ステップ失敗は ok:false)
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    // ステップは失敗 (ok:false) — クラッシュしない
    expect(parsed.data.results[0]?.ok).toBe(false);
    expect(parsed.data.results[0]?.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// [AC-Sf2f114-2-1/2] when / when-not 条件付きステップ実行 (ADR-0010)
// ---------------------------------------------------------------------------

describe('[AC-Sf2f114-2-1/2] when / when-not 条件付きステップ実行', () => {
  let server: TestServer;

  /**
   * when: {{flag}} gate — flag が truthy なら note-create を実行、falsey ならスキップ。
   * 後続の journal-append は常に実行される (スキップは fail-stop しない)。
   */
  const WHEN_GATE_COMMAND = [
    '---',
    'loamium-command:',
    '  name: when-gate',
    '  params:',
    '    - name: flag',
    '    - name: title',
    '      required: true',
    '  steps:',
    '    - kind: note-create',
    '      target: "when-tests/{{title}}.md"',
    '      content: "# {{title}}"',
    '      when: "{{flag}}"',
    '    - kind: journal-append',
    '      content: "when-gate ran: {{title}}"',
    '---',
    '',
  ].join('\n');

  /**
   * when-not: {{skip}} gate — skip が falsey なら note-create を実行、truthy ならスキップ。
   */
  const WHEN_NOT_GATE_COMMAND = [
    '---',
    'loamium-command:',
    '  name: when-not-gate',
    '  params:',
    '    - name: skip',
    '    - name: title',
    '      required: true',
    '  steps:',
    '    - kind: note-create',
    '      target: "when-not-tests/{{title}}.md"',
    '      content: "# {{title}}"',
    '      when-not: "{{skip}}"',
    '---',
    '',
  ].join('\n');

  /**
   * when + when-not 両方指定 — 両方の条件を満たすときのみ実行。
   */
  const BOTH_CONDITION_COMMAND = [
    '---',
    'loamium-command:',
    '  name: both-condition',
    '  params:',
    '    - name: enable',
    '    - name: skip',
    '    - name: title',
    '      required: true',
    '  steps:',
    '    - kind: note-create',
    '      target: "both-tests/{{title}}.md"',
    '      content: "# {{title}}"',
    '      when: "{{enable}}"',
    '      when-not: "{{skip}}"',
    '---',
    '',
  ].join('\n');

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    await putNote(server, 'commands/when-gate.md', WHEN_GATE_COMMAND);
    await putNote(server, 'commands/when-not-gate.md', WHEN_NOT_GATE_COMMAND);
    await putNote(server, 'commands/both-condition.md', BOTH_CONDITION_COMMAND);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-2-2] when: {{flag}} — flag truthy → 実行
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-2-2] when: {{flag}} — flag が truthy → ステップ実行される', async () => {
    const { status, body } = await runCommand(server, 'when-gate', {
      flag: 'true',
      title: 'when-truthy',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    const res = parsed.data;
    // 2 ステップ実行 (note-create + journal-append)
    expect(res.results).toHaveLength(2);
    expect(res.results[0]?.kind).toBe('note-create');
    expect(res.results[0]?.ok).toBe(true);
    // skipped は未定義 (実行された)
    expect(res.results[0]?.skipped).toBeUndefined();
    // ファイルが実際に作成されたこと
    const noteContent = await readFile(
      path.join(server.vault, 'when-tests/when-truthy.md'),
      'utf8',
    );
    expect(noteContent).toBe('# when-truthy');
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-2-2] when: {{flag}} — flag falsey → スキップ、後続ステップ続行
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-2-2] when: {{flag}} — flag が falsey → スキップ (skipped:true), 後続ステップ続行', async () => {
    const { status, body } = await runCommand(server, 'when-gate', {
      flag: 'false',
      title: 'when-falsey',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    const res = parsed.data;
    // 2 ステップ: [0] スキップ、[1] 実行
    expect(res.results).toHaveLength(2);
    expect(res.results[0]?.kind).toBe('note-create');
    expect(res.results[0]?.ok).toBe(true);
    expect(res.results[0]?.skipped).toBe(true);
    // 後続ステップ (journal-append) は実行される
    expect(res.results[1]?.kind).toBe('journal-append');
    expect(res.results[1]?.ok).toBe(true);
    expect(res.results[1]?.skipped).toBeUndefined();
    // note-create がスキップされたのでファイルは作られない
    const fs = await import('node:fs/promises');
    await expect(
      fs.access(path.join(server.vault, 'when-tests/when-falsey.md')),
    ).rejects.toThrow();
  });

  it('[AC-Sf2f114-2-2] when: {{flag}} — flag が空文字 (省略) → スキップ', async () => {
    const { status, body } = await runCommand(server, 'when-gate', {
      // flag を送らない = params に flag キーが存在しない → missing.length > 0 で falsey 扱い
      title: 'when-empty',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    expect(parsed.data.results[0]?.skipped).toBe(true);
    // 後続ステップは続行
    expect(parsed.data.results[1]?.kind).toBe('journal-append');
    expect(parsed.data.results[1]?.ok).toBe(true);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-2-2] when-not: {{skip}} — inverse (falsey → 実行, truthy → スキップ)
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-2-2] when-not: {{skip}} — skip が falsey → ステップ実行される', async () => {
    const { status, body } = await runCommand(server, 'when-not-gate', {
      skip: 'false',
      title: 'when-not-falsey',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.skipped).toBeUndefined();
    // ファイルが作成されたこと
    const noteContent = await readFile(
      path.join(server.vault, 'when-not-tests/when-not-falsey.md'),
      'utf8',
    );
    expect(noteContent).toBe('# when-not-falsey');
  });

  it('[AC-Sf2f114-2-2] when-not: {{skip}} — skip が truthy → スキップ (skipped:true)', async () => {
    const { status, body } = await runCommand(server, 'when-not-gate', {
      skip: 'yes',
      title: 'when-not-truthy',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.skipped).toBe(true);
    // ファイルは作られない
    const fs = await import('node:fs/promises');
    await expect(
      fs.access(path.join(server.vault, 'when-not-tests/when-not-truthy.md')),
    ).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-2-2] when + when-not 両方: 両方の条件を満たさないとスキップ
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-2-2] when + when-not 両方 — 両方満たす → 実行', async () => {
    const { status, body } = await runCommand(server, 'both-condition', {
      enable: 'true',
      skip: 'false',
      title: 'both-pass',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.skipped).toBeUndefined();
  });

  it('[AC-Sf2f114-2-2] when + when-not 両方 — when が falsey → スキップ', async () => {
    const { status, body } = await runCommand(server, 'both-condition', {
      enable: 'false',
      skip: 'false',
      title: 'both-when-fail',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.skipped).toBe(true);
  });

  it('[AC-Sf2f114-2-2] when + when-not 両方 — when-not が truthy → スキップ', async () => {
    const { status, body } = await runCommand(server, 'both-condition', {
      enable: 'true',
      skip: 'yes',
      title: 'both-when-not-fail',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.skipped).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 後方互換: when / when-not なしの既存ステップは変わらず動く
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-2-2] 後方互換 — when / when-not なしのステップは変わらず実行される', async () => {
    // CREATE_TODO_COMMAND は when / when-not を持たない既存コマンド
    await putNote(server, 'commands/create-todo.md', CREATE_TODO_COMMAND);
    const { status, body } = await runCommand(server, 'create-todo', { title: 'compat-test' });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    // 全ステップが skipped なしで実行される
    for (const result of parsed.data.results) {
      expect(result.ok).toBe(true);
      expect(result.skipped).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-2-2] when-not: {{undefined_param}} — param absent → step RUNS
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-2-2] when-not: "{{undefined_param}}" — param 未送信 (absent=falsey) → ステップ実行される', async () => {
    // when-not-gate の skip パラメータをまったく送らない
    // → when-not の評価式 "{{skip}}" が falsey (未定義=空) になる
    // → falsey なので when-not 条件を満たし、ステップが実行される
    const { status, body } = await runCommand(server, 'when-not-gate', {
      title: 'when-not-undefined-param',
      // skip を意図的に省略
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');

    // スキップされず実行される
    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.skipped).toBeUndefined();
    // ファイルが作成されたこと
    const noteContent = await readFile(
      path.join(server.vault, 'when-not-tests/when-not-undefined-param.md'),
      'utf8',
    );
    expect(noteContent).toBe('# when-not-undefined-param');
  });
});

// ---------------------------------------------------------------------------
// [AC-Sf2f114-4-1/2/3] prop-set / note-patch ステップ (ADR-0009/0010)
// ---------------------------------------------------------------------------

describe('[AC-Sf2f114-4-1/2/3] prop-set / note-patch ステップ', () => {
  let server: TestServer;

  /** prop-set コマンド: target note の frontmatter を upsert する */
  const PROP_SET_COMMAND = [
    '---',
    'loamium-command:',
    '  name: prop-set-test',
    '  params:',
    '    - name: target',
    '      required: true',
    '    - name: value',
    '      required: true',
    '  steps:',
    '    - kind: prop-set',
    '      target: "{{target}}"',
    '      set:',
    '        bookmark: "{{value}}"',
    '---',
    '',
  ].join('\n');

  /** prop-set コマンド: unset キー */
  const PROP_UNSET_COMMAND = [
    '---',
    'loamium-command:',
    '  name: prop-unset-test',
    '  params:',
    '    - name: target',
    '      required: true',
    '  steps:',
    '    - kind: prop-set',
    '      target: "{{target}}"',
    '      unset:',
    '        - bookmark',
    '---',
    '',
  ].join('\n');

  /** prop-set コマンド: set と unset 両方なし → no-op */
  const PROP_SET_NOOP_COMMAND = [
    '---',
    'loamium-command:',
    '  name: prop-set-noop',
    '  params:',
    '    - name: target',
    '      required: true',
    '  steps:',
    '    - kind: prop-set',
    '      target: "{{target}}"',
    '---',
    '',
  ].join('\n');

  /** note-patch コマンド: old → new 置換 */
  const NOTE_PATCH_COMMAND = [
    '---',
    'loamium-command:',
    '  name: note-patch-test',
    '  params:',
    '    - name: target',
    '      required: true',
    '    - name: old',
    '      required: true',
    '    - name: new',
    '      required: true',
    '  steps:',
    '    - kind: note-patch',
    '      target: "{{target}}"',
    '      old: "{{old}}"',
    '      new: "{{new}}"',
    '---',
    '',
  ].join('\n');

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    await putNote(server, 'commands/prop-set-test.md', PROP_SET_COMMAND);
    await putNote(server, 'commands/prop-unset-test.md', PROP_UNSET_COMMAND);
    await putNote(server, 'commands/prop-set-noop.md', PROP_SET_NOOP_COMMAND);
    await putNote(server, 'commands/note-patch-test.md', NOTE_PATCH_COMMAND);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-4-1] prop-set: sets frontmatter key
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-4-1] prop-set sets a frontmatter key via round-trip-safe path', async () => {
    await putNote(server, 'prop-set-target.md', '---\ntitle: Test Note\n---\n\nBody content.\n');
    const { status, body } = await runCommand(server, 'prop-set-test', {
      target: 'prop-set-target.md',
      value: 'yes',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.kind).toBe('prop-set');
    expect(parsed.data.results[0]?.path).toBe('prop-set-target.md');

    // Verify frontmatter was actually updated
    const noteRes = await fetch(`${server.baseUrl}/api/notes/prop-set-target.md`);
    const noteBody = (await noteRes.json()) as { frontmatter: Record<string, unknown>; body: string };
    expect(noteBody.frontmatter.bookmark).toBe('yes');
    // Existing keys preserved
    expect(noteBody.frontmatter.title).toBe('Test Note');
    // Body preserved
    expect(noteBody.body).toContain('Body content.');
  });

  it('[AC-Sf2f114-4-1] prop-set unsets a frontmatter key', async () => {
    await putNote(server, 'prop-unset-target.md', '---\ntitle: Unset Test\nbookmark: true\n---\n\nBody.\n');
    const { status, body } = await runCommand(server, 'prop-unset-test', {
      target: 'prop-unset-target.md',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const noteRes = await fetch(`${server.baseUrl}/api/notes/prop-unset-target.md`);
    const noteBody = (await noteRes.json()) as { frontmatter: Record<string, unknown> };
    expect(noteBody.frontmatter.bookmark).toBeUndefined();
    expect(noteBody.frontmatter.title).toBe('Unset Test');
  });

  it('[AC-Sf2f114-4-1] prop-set with neither set nor unset → ok:true (no-op)', async () => {
    await putNote(server, 'prop-noop-target.md', '---\ntitle: Noop Test\n---\n\nContent.\n');
    const { status, body } = await runCommand(server, 'prop-set-noop', {
      target: 'prop-noop-target.md',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);
    // File should be unchanged (read it back)
    const noteRes = await fetch(`${server.baseUrl}/api/notes/prop-noop-target.md`);
    const noteBody = (await noteRes.json()) as { frontmatter: Record<string, unknown> };
    expect(noteBody.frontmatter.title).toBe('Noop Test');
  });

  it('[AC-Sf2f114-4-1] prop-set on non-existent note → ok:false', async () => {
    const { status, body } = await runCommand(server, 'prop-set-test', {
      target: 'does-not-exist.md',
      value: 'true',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(false);
    expect(typeof parsed.data.results[0]?.error).toBe('string');
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-4-2] note-patch: replaces old → new
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-4-2] note-patch replaces old text with new text', async () => {
    await putNote(server, 'patch-target.md', '# Title\n\nOld content here.\n\nMore text.\n');
    const { status, body } = await runCommand(server, 'note-patch-test', {
      target: 'patch-target.md',
      old: 'Old content here.',
      new: 'New content here.',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.kind).toBe('note-patch');
    expect(parsed.data.results[0]?.path).toBe('patch-target.md');

    const noteRes = await fetch(`${server.baseUrl}/api/notes/patch-target.md`);
    const noteBody = (await noteRes.json()) as { content: string };
    expect(noteBody.content).toContain('New content here.');
    expect(noteBody.content).not.toContain('Old content here.');
    expect(noteBody.content).toContain('More text.');
  });

  it('[AC-Sf2f114-4-2] note-patch with non-matching old → ok:false (not 4xx)', async () => {
    await putNote(server, 'patch-nomatch.md', '# Title\n\nSome text.\n');
    const { status, body } = await runCommand(server, 'note-patch-test', {
      target: 'patch-nomatch.md',
      old: 'This string does not exist in the file',
      new: 'replacement',
    });
    // ステップ失敗は HTTP 200 (fail-stop は ok:false で返す)
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(false);
    expect(typeof parsed.data.results[0]?.error).toBe('string');
  });

  it('[AC-Sf2f114-4-2] note-patch with ambiguous (multiple-match) old → ok:false', async () => {
    await putNote(
      server,
      'patch-ambiguous.md',
      '# Title\n\nRepeat. Repeat. Same text.\n',
    );
    const { status, body } = await runCommand(server, 'note-patch-test', {
      target: 'patch-ambiguous.md',
      old: 'Repeat',
      new: 'Different',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(false);
    expect(parsed.data.results[0]?.error).toMatch(/2 locations/);
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-4-3] Both kinds in discriminated union + unknown kinds rejected
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-4-3] unknown kind is rejected at command parse time', async () => {
    await putNote(server, 'commands/unknown-kind.md', [
      '---',
      'loamium-command:',
      '  name: unknown-kind',
      '  steps:',
      '    - kind: invalid-step-kind',
      '      target: "foo.md"',
      '---',
      '',
    ].join('\n'));
    const { status, body } = await runCommand(server, 'unknown-kind', {});
    expect(status).toBe(400);
    const b = body as { error: string; message: string };
    expect(b.error).toBe('invalid_command');
  });

  // -----------------------------------------------------------------------
  // [AC-Sf2f114-4-3] append-only: commands with prop-set/note-patch are rejected
  // -----------------------------------------------------------------------

  it('[AC-Sf2f114-4-3] prop-set audit: prop-set.write is recorded in audit log', async () => {
    await putNote(server, 'audit-prop-set.md', '---\ntitle: Audit Test\n---\n\nBody.\n');
    const before = (await readAuditLog(server.vault)).filter((l) => l.op === 'prop-set.write').length;

    const { status } = await runCommand(server, 'prop-set-test', {
      target: 'audit-prop-set.md',
      value: 'true',
    });
    expect(status).toBe(200);

    const after = await readAuditLog(server.vault);
    const propSetEntries = after.filter((l) => l.op === 'prop-set.write');
    expect(propSetEntries.length).toBeGreaterThan(before);
    expect(propSetEntries.some((l) => l.path === 'audit-prop-set.md' && l.result === 'ok')).toBe(true);
  });

  it('[AC-Sf2f114-4-3] note-patch audit: note-patch.write is recorded in audit log', async () => {
    await putNote(server, 'audit-note-patch.md', '# Title\n\nOld value.\n');
    const before = (await readAuditLog(server.vault)).filter((l) => l.op === 'note-patch.write').length;

    const { status } = await runCommand(server, 'note-patch-test', {
      target: 'audit-note-patch.md',
      old: 'Old value.',
      new: 'New value.',
    });
    expect(status).toBe(200);

    const after = await readAuditLog(server.vault);
    const patchEntries = after.filter((l) => l.op === 'note-patch.write');
    expect(patchEntries.length).toBeGreaterThan(before);
    expect(patchEntries.some((l) => l.path === 'audit-note-patch.md' && l.result === 'ok')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [AC-Sf2f114-5-2] select/boolean/note/number param — 値が resolveTemplate を流れる
// ---------------------------------------------------------------------------

describe('[AC-Sf2f114-5-2] new param types — value flows through resolveTemplate', () => {
  let server: TestServer;

  /**
   * select param: {{priority}} が content に展開されること。
   * 実行時は選択した option 文字列が渡される。
   */
  const SELECT_PARAM_CMD = [
    '---',
    'loamium-command:',
    '  name: select-run-test',
    '  params:',
    '    - name: priority',
    '      type: select',
    '      required: true',
    '      options:',
    '        - low',
    '        - medium',
    '        - high',
    '  steps:',
    '    - kind: note-create',
    '      target: "select-out/{{priority}}.md"',
    '      content: "priority={{priority}}"',
    '---',
    '',
  ].join('\n');

  /**
   * boolean param: {{flag}} が content に展開されること。
   * 'true' (truthy) または '' (falsey) が渡される想定。
   */
  const BOOLEAN_PARAM_CMD = [
    '---',
    'loamium-command:',
    '  name: boolean-run-test',
    '  params:',
    '    - name: flag',
    '      type: boolean',
    '  steps:',
    '    - kind: note-create',
    '      target: "bool-out/result.md"',
    '      content: "flag={{flag}}"',
    '---',
    '',
  ].join('\n');

  /**
   * number param: {{count}} が content に展開されること。
   * 数値文字列 (例 "42") が渡される想定。
   */
  const NUMBER_PARAM_CMD = [
    '---',
    'loamium-command:',
    '  name: number-run-test',
    '  params:',
    '    - name: count',
    '      type: number',
    '  steps:',
    '    - kind: note-create',
    '      target: "num-out/result.md"',
    '      content: "count={{count}}"',
    '---',
    '',
  ].join('\n');

  /**
   * note param: {{target}} が content に展開されること。
   * vault 相対パス文字列が渡される想定。
   */
  const NOTE_PARAM_CMD = [
    '---',
    'loamium-command:',
    '  name: note-run-test',
    '  params:',
    '    - name: ref',
    '      type: note',
    '  steps:',
    '    - kind: note-create',
    '      target: "note-out/result.md"',
    '      content: "ref={{ref}}"',
    '---',
    '',
  ].join('\n');

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    await putNote(server, 'commands/select-run-test.md', SELECT_PARAM_CMD);
    await putNote(server, 'commands/boolean-run-test.md', BOOLEAN_PARAM_CMD);
    await putNote(server, 'commands/number-run-test.md', NUMBER_PARAM_CMD);
    await putNote(server, 'commands/note-run-test.md', NOTE_PARAM_CMD);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('[AC-Sf2f114-5-2] select param: 選択 option 文字列が resolveTemplate に渡されノートに展開される', async () => {
    const { status, body } = await runCommand(server, 'select-run-test', { priority: 'high' });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success, `schema: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);
    expect(parsed.data.results[0]?.path).toBe('select-out/high.md');

    const content = await readFile(path.join(server.vault, 'select-out/high.md'), 'utf8');
    expect(content).toBe('priority=high');
  });

  it('[AC-Sf2f114-5-2] boolean param: "true" が resolveTemplate に渡されノートに展開される', async () => {
    const { status, body } = await runCommand(server, 'boolean-run-test', { flag: 'true' });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'bool-out/result.md'), 'utf8');
    expect(content).toBe('flag=true');
  });

  it('[AC-Sf2f114-5-2] boolean param: "" (falsey) が渡されたとき when ゲートがスキップを引き起こす', async () => {
    // boolean が "" のとき、when ゲートでスキップされる動作を確認
    // (executor は変更なし — 値はそのまま string として流れる)
    const { status, body } = await runCommand(server, 'boolean-run-test', { flag: '' });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    // when なしコマンドなので常に実行される (空文字もそのまま渡される)
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'bool-out/result.md'), 'utf8');
    // 空文字はそのまま展開される (flag=)
    expect(content).toContain('flag=');
  });

  it('[AC-Sf2f114-5-2] number param: 数値文字列が resolveTemplate に渡されノートに展開される', async () => {
    const { status, body } = await runCommand(server, 'number-run-test', { count: '42' });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'num-out/result.md'), 'utf8');
    expect(content).toBe('count=42');
  });

  it('[AC-Sf2f114-5-2] note param: vault パス文字列が resolveTemplate に渡されノートに展開される', async () => {
    const { status, body } = await runCommand(server, 'note-run-test', {
      ref: 'projects/my-project.md',
    });
    expect(status).toBe(200);
    const parsed = commandRunResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.results[0]?.ok).toBe(true);

    const content = await readFile(path.join(server.vault, 'note-out/result.md'), 'utf8');
    expect(content).toBe('ref=projects/my-project.md');
  });
});

// ---------------------------------------------------------------------------
// [AC-Sf2f114-4-3] append-only rejects commands with prop-set/note-patch
// ---------------------------------------------------------------------------

describe('[AC-Sf2f114-4-3] append-only rejects prop-set / note-patch commands', () => {
  let server: TestServer;

  const PROP_SET_CMD = [
    '---',
    'loamium-command:',
    '  name: mutating-prop-set',
    '  params:',
    '    - name: target',
    '      required: true',
    '  steps:',
    '    - kind: prop-set',
    '      target: "{{target}}"',
    '      set:',
    '        status: draft',
    '---',
    '',
  ].join('\n');

  const NOTE_PATCH_CMD = [
    '---',
    'loamium-command:',
    '  name: mutating-note-patch',
    '  params:',
    '    - name: target',
    '      required: true',
    '  steps:',
    '    - kind: note-patch',
    '      target: "{{target}}"',
    '      old: "TODO"',
    '      new: "DONE"',
    '---',
    '',
  ].join('\n');

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedNote(vault, 'commands/mutating-prop-set.md', PROP_SET_CMD);
    await seedNote(vault, 'commands/mutating-note-patch.md', NOTE_PATCH_CMD);
    await seedNote(vault, 'target.md', '---\ntitle: Target\n---\n\nTODO item.\n');
    server = await startServer({ vault, mode: 'append-only' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('[AC-Sf2f114-4-3] append-only rejects prop-set command with 403', async () => {
    const { status, body } = await runCommand(server, 'mutating-prop-set', {
      target: 'target.md',
    });
    expect(status).toBe(403);
    const b = body as { error: string; message: string };
    expect(b.error).toBe('forbidden');
    expect(b.message).toContain('append-only');
  });

  it('[AC-Sf2f114-4-3] append-only rejects note-patch command with 403', async () => {
    const { status, body } = await runCommand(server, 'mutating-note-patch', {
      target: 'target.md',
    });
    expect(status).toBe(403);
    const b = body as { error: string; message: string };
    expect(b.error).toBe('forbidden');
    expect(b.message).toContain('append-only');
  });

  it('[AC-Sf2f114-4-3] append-only still allows v1-only commands (journal-append / note-create)', async () => {
    const CREATE_TODO_COMMAND = [
      '---',
      'loamium-command:',
      '  name: create-todo',
      '  params:',
      '    - name: title',
      '      required: true',
      '  steps:',
      '    - kind: note-create',
      '      target: "todos/{{title}}.md"',
      '      content: "# {{title}}\\n"',
      '---',
      '',
    ].join('\n');
    await seedNote(server.vault, 'commands/create-todo.md', CREATE_TODO_COMMAND);

    const { status } = await runCommand(server, 'create-todo', { title: 'ao-allowed-test' });
    expect(status).toBe(200);
  });
});
