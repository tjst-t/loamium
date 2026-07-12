/**
 * Story Sd22b1f-1「スマートコマンド定義スキーマ + 一覧」受け入れテスト。
 * 実サーバー (サブプロセス) + 実 HTTP クライアント (fetch) + CLI サブプロセス。
 *
 * テストハーネスは templates.spec.ts / cli.spec.ts と同じパターンを踏襲する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { runCli } from './helpers/cli.js';
import { commandsResponseSchema } from '@loamium/shared';

let server: TestServer;

/** このテストファイル内の全 CLI 呼び出しはテストサーバーを指す。 */
function cli(args: string[]): ReturnType<typeof runCli> {
  return runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
}

/** ノートを vault に置くヘルパー (REST API 経由)。 */
async function putNote(rel: string, content: string): Promise<void> {
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
// フィクスチャコマンド定義
// ---------------------------------------------------------------------------

/** 正常なコマンド定義 — Todo 作成 + ジャーナル追記の 2 ステップ。 */
const VALID_COMMAND = [
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
  'Todo ノートを作成し、今日のジャーナルに追記します。',
  '',
].join('\n');

/** 壊れた frontmatter (loamium-command が文字列) — valid:false になるはず。 */
const BROKEN_COMMAND = [
  '---',
  'loamium-command: "これは壊れた定義"',
  '---',
  '# broken',
  '',
].join('\n');

/** steps が空配列 — valid:false になるはず (steps は 1 個以上必須)。 */
const EMPTY_STEPS_COMMAND = [
  '---',
  'loamium-command:',
  '  name: empty-steps',
  '  steps: []',
  '---',
  '# empty-steps',
  '',
].join('\n');

beforeAll(async () => {
  const vault = await makeTempVault();
  server = await startServer({ vault });
  // commands/ フォルダにフィクスチャを配置する
  await putNote('commands/create-todo.md', VALID_COMMAND);
  await putNote('commands/broken.md', BROKEN_COMMAND);
  await putNote('commands/empty-steps.md', EMPTY_STEPS_COMMAND);
  // commands/ 外のノートは一覧に出ない
  await putNote('notes/普通のノート.md', '# 普通\n');
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

// ---------------------------------------------------------------------------
// [AC-Sd22b1f-1-2] GET /api/commands
// ---------------------------------------------------------------------------

async function listCommands(): Promise<ReturnType<typeof commandsResponseSchema.parse>['commands']> {
  const res = await fetch(`${server.baseUrl}/api/commands`);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  const parsed = commandsResponseSchema.safeParse(body);
  expect(parsed.success, `commandsResponseSchema validation failed: ${!parsed.success ? JSON.stringify(parsed.error.issues) : ''}`).toBe(true);
  if (!parsed.success) throw new Error('unreachable');
  return parsed.data.commands;
}

describe('[AC-Sd22b1f-1-2] GET /api/commands', () => {
  it('commands/ 配下の *.md をすべて一覧し 200 を返す', async () => {
    const commands = await listCommands();
    const names = commands.map((c) => c.name).sort();
    // create-todo (valid), broken (invalid), empty-steps (invalid) の 3 件
    expect(names).toContain('create-todo');
    expect(names).toContain('broken');
    expect(names).toContain('empty-steps');
    // commands/ 外のノートは含まない
    expect(commands.some((c) => c.path === 'notes/普通のノート.md')).toBe(false);
    // id はすべてのエントリ (valid/invalid) に存在し、ファイル stem に一致する
    for (const cmd of commands) {
      expect(typeof cmd.id).toBe('string');
      expect(cmd.id.length).toBeGreaterThan(0);
      // id は path から導出した stem と一致する (commands/{id}.md)
      expect(cmd.path).toBe(`commands/${cmd.id}.md`);
    }
  });

  it('正常なコマンドは valid:true で id / name / description / params / path を返す', async () => {
    const commands = await listCommands();
    const todo = commands.find((c) => c.path === 'commands/create-todo.md');
    expect(todo).toBeDefined();
    expect(todo?.valid).toBe(true);
    // id は常にファイル stem (拡張子なし) である
    expect(todo?.id).toBe('create-todo');
    // name は frontmatter の loamium-command.name (省略時は stem と同値)
    expect(todo?.name).toBe('create-todo');
    expect(todo?.path).toBe('commands/create-todo.md');
    // Narrow the discriminated union before accessing valid:true-only fields
    if (todo?.valid === true) {
      expect(todo.description).toBe('Todo を作成してジャーナルに追記する');
      expect(Array.isArray(todo.params)).toBe(true);
      expect(todo.params).toHaveLength(1);
    } else {
      throw new Error('expected todo command to be valid:true');
    }
  });

  it('壊れた frontmatter のコマンドは valid:false + error + id で一覧に含まれる (200 維持)', async () => {
    const commands = await listCommands();
    const broken = commands.find((c) => c.path === 'commands/broken.md');
    expect(broken).toBeDefined();
    expect(broken?.valid).toBe(false);
    // id はファイル stem から導出される (valid:false でも id を持つ)
    expect(broken?.id).toBe('broken');
    // Narrow the discriminated union before accessing valid:false-only fields
    if (broken?.valid === false) {
      expect(typeof broken.error).toBe('string');
      expect(broken.error.length).toBeGreaterThan(0);
    } else {
      throw new Error('expected broken command to be valid:false');
    }
  });

  it('steps が空のコマンドは valid:false になる', async () => {
    const commands = await listCommands();
    const emptySteps = commands.find((c) => c.path === 'commands/empty-steps.md');
    expect(emptySteps).toBeDefined();
    expect(emptySteps?.valid).toBe(false);
  });

  it('壊れた定義があっても 200 を維持する (アプリを落とさない)', async () => {
    const res = await fetch(`${server.baseUrl}/api/commands`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: unknown[] };
    expect(Array.isArray(body.commands)).toBe(true);
  });

  it('commands/ が空の vault では { commands: [] } を 200 で返す', async () => {
    // 別途空 vault でサーバーを起動して確認する
    const emptyVault = await makeTempVault();
    const emptyServer = await startServer({ vault: emptyVault });
    try {
      const res = await fetch(`${emptyServer.baseUrl}/api/commands`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { commands: unknown[] };
      expect(body.commands).toEqual([]);
    } finally {
      await emptyServer.stop();
      await cleanupVault(emptyVault);
    }
  });

  // [AC-Sd22b1f-1-2] 非UTF-8バイナリファイルがあっても 200 を維持する (寛容 read)
  it('[AC-Sd22b1f-1-2] 非UTF-8バイナリファイルがあっても GET /api/commands は 200 を返す', async () => {
    // PUT API は UTF-8 を強制するため、直接 fs.writeFile でバイナリを書き込む
    const binaryVault = await makeTempVault();
    const binaryServer = await startServer({ vault: binaryVault });
    try {
      // commands/ ディレクトリを作成してバイナリファイルを直接置く
      const commandsDir = path.join(binaryVault, 'commands');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(commandsDir, { recursive: true });
      await writeFile(
        path.join(commandsDir, 'binary.md'),
        Buffer.from([0xff, 0xfe, 0x00, 0x01, 0xd8, 0x00, 0xdc, 0x00]),
      );
      const res = await fetch(`${binaryServer.baseUrl}/api/commands`);
      // サーバーがクラッシュせず 200 を返すことが核心
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      const parsed = commandsResponseSchema.safeParse(body);
      expect(parsed.success, `commandsResponseSchema validation failed: ${!parsed.success ? JSON.stringify(parsed.error.issues) : ''}`).toBe(true);
      if (!parsed.success) throw new Error('unreachable');
      // binary.md がエントリとして含まれること (valid:true/false は問わない)
      const hasEntry = parsed.data.commands.some((c) => c.path === 'commands/binary.md');
      expect(hasEntry).toBe(true);
    } finally {
      await binaryServer.stop();
      await cleanupVault(binaryVault);
    }
  });
});

// ---------------------------------------------------------------------------
// [AC-Sf2f114-5-2] GET /api/commands — select/boolean/note/number param 型の passthrough
// ---------------------------------------------------------------------------

describe('[AC-Sf2f114-5-2] GET /api/commands — new param types passthrough', () => {
  /** select param を持つ valid コマンド */
  const SELECT_PARAM_COMMAND = [
    '---',
    'loamium-command:',
    '  name: select-param-test',
    '  description: select param command',
    '  params:',
    '    - name: priority',
    '      type: select',
    '      options:',
    '        - low',
    '        - medium',
    '        - high',
    '    - name: flag',
    '      type: boolean',
    '    - name: count',
    '      type: number',
    '    - name: target',
    '      type: note',
    '  steps:',
    '    - kind: note-create',
    '      target: "out/{{priority}}.md"',
    '      content: "priority={{priority}}"',
    '---',
    '# select-param-test',
    '',
  ].join('\n');

  /** select param だが options が空 → valid:false */
  const SELECT_NO_OPTIONS_COMMAND = [
    '---',
    'loamium-command:',
    '  name: select-no-options',
    '  params:',
    '    - name: priority',
    '      type: select',
    '  steps:',
    '    - kind: journal-append',
    '      content: "hello"',
    '---',
    '# select-no-options',
    '',
  ].join('\n');

  let srv: TestServer;

  async function putNoteSrv(rel: string, content: string): Promise<void> {
    const encoded = rel
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const res = await fetch(`${srv.baseUrl}/api/notes/${encoded}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error(`seed putNote failed for ${rel}: ${res.status}`);
  }

  beforeAll(async () => {
    const vault = await makeTempVault();
    srv = await startServer({ vault });
    await putNoteSrv('commands/select-param-test.md', SELECT_PARAM_COMMAND);
    await putNoteSrv('commands/select-no-options.md', SELECT_NO_OPTIONS_COMMAND);
  });

  afterAll(async () => {
    await srv.stop();
    await cleanupVault(srv.vault);
  });

  async function listCmds() {
    const res = await fetch(`${srv.baseUrl}/api/commands`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = commandsResponseSchema.safeParse(body);
    expect(
      parsed.success,
      `commandsResponseSchema validation failed: ${!parsed.success ? JSON.stringify(parsed.error.issues) : ''}`,
    ).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    return parsed.data.commands;
  }

  it('[AC-Sf2f114-5-2] select param command は valid:true で options が passthrough される', async () => {
    const commands = await listCmds();
    const cmd = commands.find((c) => c.path === 'commands/select-param-test.md');
    expect(cmd).toBeDefined();
    expect(cmd?.valid).toBe(true);
    if (cmd?.valid !== true) throw new Error('expected valid:true');

    // select param が options 付きで返ること
    const priorityParam = cmd.params.find((p) => p.name === 'priority');
    expect(priorityParam).toBeDefined();
    expect(priorityParam?.type).toBe('select');
    expect(priorityParam?.options).toEqual(['low', 'medium', 'high']);

    // boolean / number / note param も返ること
    expect(cmd.params.find((p) => p.name === 'flag')?.type).toBe('boolean');
    expect(cmd.params.find((p) => p.name === 'count')?.type).toBe('number');
    expect(cmd.params.find((p) => p.name === 'target')?.type).toBe('note');
  });

  it('[AC-Sf2f114-5-2] select-without-options command は valid:false で一覧に含まれる', async () => {
    const commands = await listCmds();
    const cmd = commands.find((c) => c.path === 'commands/select-no-options.md');
    expect(cmd).toBeDefined();
    expect(cmd?.valid).toBe(false);
    if (cmd?.valid !== false) throw new Error('expected valid:false');
    expect(typeof cmd.error).toBe('string');
    expect(cmd.error.length).toBeGreaterThan(0);
    // エラーメッセージに options への言及があること
    expect(cmd.error).toContain('options');
  });
});

// ---------------------------------------------------------------------------
// [AC-Sd22b1f-1-3] CLI `loamium commands`
// ---------------------------------------------------------------------------

describe('[AC-Sd22b1f-1-3] CLI loamium commands', () => {
  it('exit 0 で全コマンドを stdout に出力する', async () => {
    const result = await cli(['commands']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    // 正常なコマンドは name\tpath が含まれる
    expect(result.stdout).toContain('create-todo');
    expect(result.stdout).toContain('commands/create-todo.md');
  });

  it('有効なコマンドは description も出力する', async () => {
    const result = await cli(['commands']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Todo を作成してジャーナルに追記する');
  });

  it('無効なコマンドは [INVALID] マーク付きで出力する', async () => {
    const result = await cli(['commands']);
    expect(result.code).toBe(0);
    const lines = result.stdout.split('\n');
    expect(lines.some((l) => l.includes('commands/broken.md') && l.includes('[INVALID]'))).toBe(true);
  });

  it('--json フラグで API レスポンスの生 JSON をそのまま出力する', async () => {
    const result = await cli(['commands', '--json']);
    expect(result.code).toBe(0);
    const raw: unknown = JSON.parse(result.stdout);
    const parsed = commandsResponseSchema.safeParse(raw);
    expect(parsed.success, `commandsResponseSchema validation failed: ${!parsed.success ? JSON.stringify(parsed.error.issues) : ''}`).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    const todo = parsed.data.commands.find((c) => c.name === 'create-todo');
    expect(todo?.valid).toBe(true);
  });

  it('サーバー未起動の場合は exit 1 + server_unreachable エラー', async () => {
    const res = await runCli(['commands'], { env: { LOAMIUM_URL: 'http://127.0.0.1:9' } });
    expect(res.code).toBe(1);
    const err = JSON.parse(res.stderr) as { error: string };
    expect(err.error).toBe('server_unreachable');
  });
});
