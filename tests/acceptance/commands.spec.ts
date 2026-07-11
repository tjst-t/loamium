/**
 * Story Sd22b1f-1「スマートコマンド定義スキーマ + 一覧」受け入れテスト。
 * 実サーバー (サブプロセス) + 実 HTTP クライアント (fetch) + CLI サブプロセス。
 *
 * テストハーネスは templates.spec.ts / cli.spec.ts と同じパターンを踏襲する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { runCli } from './helpers/cli.js';

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

interface CommandSummaryRaw {
  name: string;
  path: string;
  description?: string;
  params?: unknown[];
  valid: boolean;
  error?: string;
}

async function listCommands(): Promise<CommandSummaryRaw[]> {
  const res = await fetch(`${server.baseUrl}/api/commands`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { commands: CommandSummaryRaw[] };
  return body.commands;
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
  });

  it('正常なコマンドは valid:true で name / description / params / path を返す', async () => {
    const commands = await listCommands();
    const todo = commands.find((c) => c.name === 'create-todo');
    expect(todo).toBeDefined();
    expect(todo?.valid).toBe(true);
    expect(todo?.path).toBe('commands/create-todo.md');
    expect(todo?.description).toBe('Todo を作成してジャーナルに追記する');
    expect(Array.isArray(todo?.params)).toBe(true);
    expect(todo?.params).toHaveLength(1);
  });

  it('壊れた frontmatter のコマンドは valid:false + error で一覧に含まれる (200 維持)', async () => {
    const commands = await listCommands();
    const broken = commands.find((c) => c.path === 'commands/broken.md');
    expect(broken).toBeDefined();
    expect(broken?.valid).toBe(false);
    expect(typeof broken?.error).toBe('string');
    expect((broken?.error ?? '').length).toBeGreaterThan(0);
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
    expect(result.stdout).toContain('[INVALID]');
    // broken ファイル名が含まれる
    expect(result.stdout).toContain('commands/broken.md');
  });

  it('--json フラグで API レスポンスの生 JSON をそのまま出力する', async () => {
    const result = await cli(['commands', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { commands: CommandSummaryRaw[] };
    expect(Array.isArray(parsed.commands)).toBe(true);
    const todo = parsed.commands.find((c) => c.name === 'create-todo');
    expect(todo?.valid).toBe(true);
  });

  it('サーバー未起動の場合は exit 1 + server_unreachable エラー', async () => {
    const res = await runCli(['commands'], { env: { LOAMIUM_URL: 'http://127.0.0.1:9' } });
    expect(res.code).toBe(1);
    const err = JSON.parse(res.stderr) as { error: string };
    expect(err.error).toBe('server_unreachable');
  });
});
