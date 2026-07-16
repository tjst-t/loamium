/**
 * エージェントスマートコマンドツールのユニットテスト (Sc4b9d1-2 / ADR-0016)。
 *
 * [AC-Sc4b9d1-2] commands_list は listAllCommandFiles + summaryFor 経路 (GET /api/commands 同一)。
 *   command_run は runCommand (POST /api/commands/{name}/run 同一エンジン) へ委譲する:
 *     - 実行成功 → results をテキスト化・command.run + 各書き込みステップを監査。
 *     - 必須 param 不足 → missing 一覧テキスト (throw しない)。
 *     - 未検出 → not-found テキスト。
 *     - append-only で prop-set/note-patch/agent-run 含むコマンド → 拒否テキスト。
 *     - target パス脱出 → 拒否テキスト。
 *   ケーパビリティゲート: commands_list は read、command_run は command_run cap のみ広告。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { VaultIndex } from './noteIndex.js';
import { createCommandTools } from './agent-command-tools.js';
import type { ServerConfig } from './config.js';
import type { Capability } from '@loamium/shared';

const fakeCtx = {} as Parameters<
  ReturnType<typeof createCommandTools>[number]['execute']
>[4];

type ExecResult = Awaited<
  ReturnType<ReturnType<typeof createCommandTools>[number]['execute']>
>;

function textOf(result: ExecResult): string {
  const first = result.content[0];
  if (first && first.type === 'text') return first.text;
  return '';
}

function detailsOf(result: ExecResult): {
  error?: boolean;
  count?: number;
  id?: string;
  ran?: number;
} {
  const d = result.details;
  if (typeof d === 'object' && d !== null) {
    return d as { error?: boolean; count?: number; id?: string; ran?: number };
  }
  return {};
}

const ALL_CAPS: Capability[] = ['read', 'command_run'];

function makeConfig(vaultRoot: string, mode: ServerConfig['mode'] = 'full'): ServerConfig {
  return { vaultRoot, mode, maxUploadBytes: 1024 };
}

async function readAudit(vaultRoot: string): Promise<{ op: string; path: string }[]> {
  try {
    const raw = await readFile(path.join(vaultRoot, '.loamium', 'audit.log'), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { op: string; path: string });
  } catch {
    return [];
  }
}

/** system/commands/{name}.yaml を書く。 */
async function writeCommandFixture(vaultRoot: string, name: string, yaml: string): Promise<void> {
  const dir = path.join(vaultRoot, 'system', 'commands');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.yaml`), yaml, 'utf8');
}

async function writeNote(vaultRoot: string, rel: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function readVaultNote(vaultRoot: string, rel: string): Promise<string> {
  return readFile(path.join(vaultRoot, rel), 'utf8');
}

describe('createCommandTools', () => {
  let vaultRoot: string;
  let index: VaultIndex;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agent-cmd-test-'));
    index = new VaultIndex(vaultRoot);
  });

  function tool(name: string, caps: Capability[] = ALL_CAPS, mode: ServerConfig['mode'] = 'full') {
    const tools = createCommandTools(makeConfig(vaultRoot, mode), index, caps);
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not generated: ${name}`);
    return t;
  }

  // ---- ケーパビリティゲート ------------------------------------------------

  it('read 無効時は commands_list を広告しない', () => {
    const tools = createCommandTools(makeConfig(vaultRoot), index, ['command_run']);
    expect(tools.map((t) => t.name).sort()).toEqual(['command_run']);
  });

  it('command_run 無効時は command_run を広告しない', () => {
    const tools = createCommandTools(makeConfig(vaultRoot), index, ['read']);
    expect(tools.map((t) => t.name).sort()).toEqual(['commands_list']);
  });

  it('caps 空なら 1 つも広告しない', () => {
    expect(createCommandTools(makeConfig(vaultRoot), index, [])).toHaveLength(0);
  });

  // ---- commands_list -------------------------------------------------------

  it('commands_list は system/commands を列挙する (壊れた定義も含む)', async () => {
    await writeCommandFixture(
      vaultRoot,
      'create-todo',
      'description: ToDo を作る\nparams:\n  - name: title\n    required: true\nsteps:\n  - kind: note-create\n    target: "todos/{{title}}"\n    content: "# {{title}}"\n',
    );
    await writeCommandFixture(vaultRoot, 'broken', 'steps: [not-a-valid-step\n');
    const result = await tool('commands_list').execute('c', {}, undefined, undefined, fakeCtx);
    expect(detailsOf(result).count).toBe(2);
    expect(textOf(result)).toContain('create-todo');
    expect(textOf(result)).toContain('必須 param: title');
    expect(textOf(result)).toContain('無効');
  });

  it('commands_list は定義なしなら 0 件テキスト', async () => {
    const result = await tool('commands_list').execute('c', {}, undefined, undefined, fakeCtx);
    expect(detailsOf(result).count).toBe(0);
    expect(textOf(result)).toContain('定義されていません');
  });

  // ---- command_run: 実行成功 + 監査 ----------------------------------------

  it('command_run はステップを実行し command.run + 書き込みを監査する', async () => {
    await writeCommandFixture(
      vaultRoot,
      'mk',
      'params:\n  - name: title\n    required: true\nsteps:\n  - kind: note-create\n    target: "todos/{{title}}"\n    content: "# {{title}}\\n"\n',
    );
    const result = await tool('command_run').execute(
      'c',
      { id: 'mk', params: { title: 'hello' } },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBeUndefined();
    expect(detailsOf(result).ran).toBe(1);
    expect(textOf(result)).toContain('OK');
    // ピュア Markdown が書かれる
    expect(await readVaultNote(vaultRoot, 'todos/hello.md')).toContain('# hello');

    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'command.run' && e.path.includes('mk'))).toBe(true);
    expect(audit.some((e) => e.op === 'note-create.write' && e.path === 'todos/hello.md')).toBe(true);
  });

  // ---- command_run: 必須 param 不足 ----------------------------------------

  it('command_run は必須 param 不足を missing テキストで返す (throw しない)', async () => {
    await writeCommandFixture(
      vaultRoot,
      'mk',
      'params:\n  - name: title\n    required: true\nsteps:\n  - kind: note-create\n    target: "todos/{{title}}"\n    content: "x"\n',
    );
    const result = await tool('command_run').execute(
      'c',
      { id: 'mk', params: {} },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('必須パラメータ');
    expect(textOf(result)).toContain('title');
    // 実行されないので監査 command.run は残らない
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'command.run')).toBe(false);
  });

  // ---- command_run: 未検出 -------------------------------------------------

  it('command_run は未検出コマンドを not-found テキストで返す', async () => {
    const result = await tool('command_run').execute(
      'c',
      { id: 'ghost' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('見つかりません');
  });

  // ---- command_run: append-only 拒否 (mode 制約) ---------------------------

  it('command_run は append-only で prop-set を含むコマンドを拒否する', async () => {
    await writeCommandFixture(
      vaultRoot,
      'setprop',
      'steps:\n  - kind: prop-set\n    target: "n.md"\n    set:\n      done: true\n',
    );
    const result = await tool('command_run', ALL_CAPS, 'append-only').execute(
      'c',
      { id: 'setprop' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('このモードでは実行できません');
  });

  // ---- command_run: fail-stop (最初の失敗で停止) ---------------------------

  it('command_run は最初の失敗ステップで停止する (fail-stop, ロールバックなし)', async () => {
    await writeNote(vaultRoot, 'exists.md', '# exists\n');
    await writeCommandFixture(
      vaultRoot,
      'two',
      'steps:\n  - kind: note-create\n    target: "made.md"\n    content: "# made\\n"\n  - kind: note-append\n    target: "missing.md"\n    content: "x"\n',
    );
    const result = await tool('command_run').execute(
      'c',
      { id: 'two' },
      undefined,
      undefined,
      fakeCtx,
    );
    // 1 件目 OK, 2 件目 失敗 → 停止 (計 2 ステップ結果)
    expect(detailsOf(result).ran).toBe(2);
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('失敗');
    // 1 件目のノートは書かれている (ロールバックなし)
    expect(await readVaultNote(vaultRoot, 'made.md')).toContain('# made');
  });
});
