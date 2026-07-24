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
 *
 * [AC-S1bd397-2-agent] command_run 経由の select+optionsQuery 厳格検証:
 *   - index を渡した場合: 候補外 → invalid_select_value 相当で拒否 / 候補内 → 成功。
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

/** deny なし (テスト既定)。個別テストで deny 対象を差し替える。 */
const denyNone = (): boolean => false;

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
  created?: boolean;
} {
  const d = result.details;
  if (typeof d === 'object' && d !== null) {
    return d as { error?: boolean; count?: number; id?: string; ran?: number; created?: boolean };
  }
  return {};
}

const ALL_CAPS: Capability[] = ['read', 'command_run', 'command_write'];

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

  function tool(
    name: string,
    caps: Capability[] = ALL_CAPS,
    mode: ServerConfig['mode'] = 'full',
    isDenied: (relPath: string) => boolean = denyNone,
  ) {
    const tools = createCommandTools(makeConfig(vaultRoot, mode), index, isDenied, caps);
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not generated: ${name}`);
    return t;
  }

  // ---- ケーパビリティゲート ------------------------------------------------

  it('read 無効時は commands_list を広告しない', () => {
    const tools = createCommandTools(makeConfig(vaultRoot), index, denyNone, ['command_run']);
    expect(tools.map((t) => t.name).sort()).toEqual(['command_run']);
  });

  it('command_run 無効時は command_run を広告しない', () => {
    const tools = createCommandTools(makeConfig(vaultRoot), index, denyNone, ['read']);
    expect(tools.map((t) => t.name).sort()).toEqual(['commands_list']);
  });

  it('caps 空なら 1 つも広告しない', () => {
    expect(createCommandTools(makeConfig(vaultRoot), index, denyNone, [])).toHaveLength(0);
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

  // ---- command_run: ADR-0018 deny 強制 (agent 経路のみ) ---------------------

  it('command_run は deny 対象への note-create 書込を拒否しファイルを作らない (fail-stop)', async () => {
    // secret/ 配下を機密領域とみなす deny 判定。
    const isDenied = (rel: string): boolean => rel.startsWith('secret/');
    await writeCommandFixture(
      vaultRoot,
      'mk-secret',
      'steps:\n  - kind: note-create\n    target: "secret/leak.md"\n    content: "# leak\\n"\n',
    );
    const result = await tool('command_run', ALL_CAPS, 'full', isDenied).execute(
      'c',
      { id: 'mk-secret' },
      undefined,
      undefined,
      fakeCtx,
    );
    // 書込ステップが deny で失敗 → fail-stop。
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('失敗');
    expect(textOf(result)).toContain('denied');
    // ファイルは作られない。
    await expect(readVaultNote(vaultRoot, 'secret/leak.md')).rejects.toThrow();
    // 書込監査 (note-create.write) は残らない。
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'note-create.write')).toBe(false);
  });

  it('command_run は deny 対象への journal-append 書込を拒否する', async () => {
    const isDenied = (rel: string): boolean => rel.startsWith('journals/');
    await writeCommandFixture(
      vaultRoot,
      'jrnl',
      'steps:\n  - kind: journal-append\n    date: "2026-07-16"\n    content: "secret entry\\n"\n',
    );
    const result = await tool('command_run', ALL_CAPS, 'full', isDenied).execute(
      'c',
      { id: 'jrnl' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('denied');
    await expect(
      readVaultNote(vaultRoot, 'journals/2026/07/2026-07-16.md'),
    ).rejects.toThrow();
  });

  it('command_run は deny 判定なし (isDenied=false) なら従来どおり書き込む', async () => {
    // agent 経路でも deny リストが空なら書ける (REST と挙動一致)。
    await writeCommandFixture(
      vaultRoot,
      'ok',
      'steps:\n  - kind: note-create\n    target: "notes/ok.md"\n    content: "# ok\\n"\n',
    );
    const result = await tool('command_run', ALL_CAPS, 'full', denyNone).execute(
      'c',
      { id: 'ok' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBeUndefined();
    expect(await readVaultNote(vaultRoot, 'notes/ok.md')).toContain('# ok');
  });

  // ---- ケーパビリティゲート: command_write ---------------------------------

  it('command_write 無効時は command_write / command_delete を広告しない', () => {
    const tools = createCommandTools(makeConfig(vaultRoot), index, denyNone, ['read', 'command_run']);
    expect(tools.map((t) => t.name).sort()).toEqual(['command_run', 'commands_list']);
  });

  it('command_write 有効時は command_write / command_delete を広告する', () => {
    const tools = createCommandTools(makeConfig(vaultRoot), index, denyNone, ['command_write']);
    expect(tools.map((t) => t.name).sort()).toEqual(['command_delete', 'command_write']);
  });

  // ---- command_write: 正常保存 + 監査 --------------------------------------

  it('command_write は system/commands に純 YAML を保存し agent.command_write を監査する', async () => {
    const source =
      'name: 会議メモ\ndescription: 会議ノートを作る\nparams:\n  - name: topic\n    required: true\nsteps:\n  - kind: note-create\n    target: "meetings/{{topic}}"\n    content: "# {{topic}}\\n"\n';
    const result = await tool('command_write').execute(
      'c',
      { name: 'new-meeting', source },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBeUndefined();
    expect(detailsOf(result).created).toBe(true);
    expect(textOf(result)).toContain('作成');
    // ファイルが書かれ、内容が保存した source と一致する (独自フォーマットを混ぜない)。
    const saved = await readVaultNote(vaultRoot, 'system/commands/new-meeting.yaml');
    expect(saved).toBe(source);

    const audit = await readAudit(vaultRoot);
    expect(
      audit.some(
        (e) => e.op === 'agent.command_write' && e.path === 'system/commands/new-meeting.yaml',
      ),
    ).toBe(true);
  });

  it('command_write は既存 name を更新扱い (created:false) にする', async () => {
    await writeCommandFixture(
      vaultRoot,
      'exists',
      'steps:\n  - kind: note-create\n    target: "a.md"\n    content: "x"\n',
    );
    const result = await tool('command_write').execute(
      'c',
      {
        name: 'exists',
        source: 'steps:\n  - kind: note-create\n    target: "b.md"\n    content: "y"\n',
      },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).created).toBe(false);
    expect(textOf(result)).toContain('更新');
  });

  // ---- command_write: 不正 YAML は保存前に拒否 -----------------------------

  it('command_write は不正 YAML を保存前に拒否しファイルを作らない', async () => {
    const result = await tool('command_write').execute(
      'c',
      { name: 'bad', source: 'steps: [not-a-valid-step\n' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('不正');
    await expect(readVaultNote(vaultRoot, 'system/commands/bad.yaml')).rejects.toThrow();
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.command_write')).toBe(false);
  });

  it('command_write は steps 欠落 (未知 kind) 定義を拒否する', async () => {
    const result = await tool('command_write').execute(
      'c',
      { name: 'nokind', source: 'name: x\nsteps:\n  - kind: bogus-step\n' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    await expect(readVaultNote(vaultRoot, 'system/commands/nokind.yaml')).rejects.toThrow();
  });

  // ---- command_write: パス脱出 / deny 拒否 ---------------------------------

  it('command_write は name のパス脱出 (../隠しセグメント) を拒否する', async () => {
    const result = await tool('command_write').execute(
      'c',
      {
        name: '../escape',
        source: 'steps:\n  - kind: note-create\n    target: "a.md"\n    content: "x"\n',
      },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('パスエラー');
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.command_write')).toBe(false);
  });

  it('command_write は deny 対象への書き込みを拒否しファイルを作らない (ADR-0018)', async () => {
    const isDenied = (rel: string): boolean => rel === 'system/commands/secret.yaml';
    const result = await tool('command_write', ALL_CAPS, 'full', isDenied).execute(
      'c',
      {
        name: 'secret',
        source: 'steps:\n  - kind: note-create\n    target: "a.md"\n    content: "x"\n',
      },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('拒否');
    await expect(readVaultNote(vaultRoot, 'system/commands/secret.yaml')).rejects.toThrow();
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.command_write')).toBe(false);
  });

  // ---- command_delete ------------------------------------------------------

  it('command_delete は既存定義を削除し agent.command_delete を監査する', async () => {
    await writeCommandFixture(
      vaultRoot,
      'gone',
      'steps:\n  - kind: note-create\n    target: "a.md"\n    content: "x"\n',
    );
    const result = await tool('command_delete').execute(
      'c',
      { name: 'gone' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBeUndefined();
    expect(textOf(result)).toContain('削除しました');
    await expect(readVaultNote(vaultRoot, 'system/commands/gone.yaml')).rejects.toThrow();
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.command_delete')).toBe(true);
  });

  it('command_delete は存在しない name を『削除対象なし』・エラーにしない', async () => {
    const result = await tool('command_delete').execute(
      'c',
      { name: 'ghost' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBeUndefined();
    expect(textOf(result)).toContain('削除対象なし');
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.command_delete')).toBe(false);
  });

  it('command_delete は deny 対象を拒否し削除しない (ADR-0018)', async () => {
    await writeCommandFixture(
      vaultRoot,
      'keep',
      'steps:\n  - kind: note-create\n    target: "a.md"\n    content: "x"\n',
    );
    const isDenied = (rel: string): boolean => rel === 'system/commands/keep.yaml';
    const result = await tool('command_delete', ALL_CAPS, 'full', isDenied).execute(
      'c',
      { name: 'keep' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('拒否');
    // ファイルは残る。
    expect(await readVaultNote(vaultRoot, 'system/commands/keep.yaml')).toContain('note-create');
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.command_delete')).toBe(false);
  });

  // ---- [AC-S1bd397-2-agent] command_run 経由の select+optionsQuery 厳格検証 ----

  describe('[AC-S1bd397-2-agent] select+optionsQuery 厳格検証 — agent 経路 (command_run)', () => {
    let vaultRootQ: string;
    let indexQ: VaultIndex;

    beforeEach(async () => {
      vaultRootQ = await mkdtemp(path.join(tmpdir(), 'loamium-agent-cmd-optionsquery-'));
      indexQ = new VaultIndex(vaultRootQ);

      // #project ノートを 2 件シード
      await mkdir(path.join(vaultRootQ, 'projects'), { recursive: true });
      await writeFile(
        path.join(vaultRootQ, 'projects', 'loamium.md'),
        '---\ntags: [project]\n---\n# loamium\n',
        'utf8',
      );
      await writeFile(
        path.join(vaultRootQ, 'projects', 'webapp.md'),
        '---\ntags: [project]\n---\n# webapp\n',
        'utf8',
      );
      await indexQ.build();

      // select+optionsQuery param を持つコマンド
      await mkdir(path.join(vaultRootQ, 'system', 'commands'), { recursive: true });
      await writeFile(
        path.join(vaultRootQ, 'system', 'commands', 'add-to-project.yaml'),
        [
          'name: プロジェクト追記',
          'description: 指定プロジェクトノートへ追記するコマンド',
          'params:',
          '  - name: プロジェクト名',
          '    type: select',
          '    required: true',
          '    optionsQuery: "LIST FROM #project"',
          '  - name: メモ',
          '    type: text',
          '    required: true',
          'steps:',
          '  - kind: note-append',
          '    target: "projects/{{プロジェクト名}}.md"',
          '    content: "{{メモ}}"',
          '    create: true',
        ].join('\n'),
        'utf8',
      );

      // text+optionsQuery param を持つコマンド (自由入力)
      await writeFile(
        path.join(vaultRootQ, 'system', 'commands', 'text-optionsquery.yaml'),
        [
          'name: テキスト自由入力テスト',
          'params:',
          '  - name: キーワード',
          '    type: text',
          '    required: true',
          '    optionsQuery: "LIST FROM #project"',
          'steps:',
          '  - kind: journal-append',
          '    content: "{{キーワード}}"',
        ].join('\n'),
        'utf8',
      );
    });

    function toolQ(
      name: string,
      caps: Capability[] = ALL_CAPS,
      isDenied: (relPath: string) => boolean = denyNone,
    ) {
      const config = makeConfig(vaultRootQ);
      const tools = createCommandTools(config, indexQ, isDenied, caps);
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`tool not generated: ${name}`);
      return t;
    }

    it('[AC-S1bd397-2-agent-5] select+optionsQuery の候補外の値 → 候補外エラーテキストで拒否', async () => {
      const result = await toolQ('command_run').execute(
        'c',
        { id: 'add-to-project', params: { プロジェクト名: '存在しないプロジェクト', メモ: 'テスト' } },
        undefined,
        undefined,
        fakeCtx,
      );
      expect(detailsOf(result).error).toBe(true);
      // invalid_select_value ケース: 候補外エラーテキストを確認
      expect(textOf(result)).toContain('候補外');
      expect(textOf(result)).toContain('プロジェクト名');
      // コマンドは実行されないので監査 command.run は残らない
      const audit = await readAudit(vaultRootQ);
      expect(audit.some((e) => e.op === 'command.run')).toBe(false);
    });

    it('[AC-S1bd397-2-agent-6] select+optionsQuery の候補内の値 → 成功 (コマンド実行)', async () => {
      const result = await toolQ('command_run').execute(
        'c',
        { id: 'add-to-project', params: { プロジェクト名: 'loamium', メモ: 'テストメモ' } },
        undefined,
        undefined,
        fakeCtx,
      );
      expect(detailsOf(result).error).toBeUndefined();
      expect(textOf(result)).toContain('OK');
      const audit = await readAudit(vaultRootQ);
      expect(audit.some((e) => e.op === 'command.run')).toBe(true);
    });

    it('[AC-S1bd397-2-agent-7] text+optionsQuery の param は候補外でも自由入力として受理', async () => {
      // キーワードは type:text なので optionsQuery があっても候補外 OK
      const result = await toolQ('command_run').execute(
        'c',
        { id: 'text-optionsquery', params: { キーワード: '候補にない完全自由なテキスト' } },
        undefined,
        undefined,
        fakeCtx,
      );
      expect(detailsOf(result).error).toBeUndefined();
    });
  });
});
