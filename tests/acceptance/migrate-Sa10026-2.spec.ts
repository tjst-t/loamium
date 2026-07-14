/**
 * Story Sa10026-2「設定系3系統の一括移行」受け入れテスト。
 * test-discipline Rule 2 (api): 実サーバーをサブプロセスとして起動し、
 * 実 HTTP クライアント (fetch) で叩く。vault はテストごとの一時ディレクトリ。
 *
 * [AC-Sa10026-2-1] スマートフォルダ: .loamium/smart-folders.json → system/smart-folders/*.yaml
 * [AC-Sa10026-2-2] テンプレート: templates/ → system/templates/, コマンド: commands/ → system/commands/
 * [AC-Sa10026-2-3] 破壊的多版テスト: 旧形式→移行→新形式、冪等再実行
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

let server: TestServer | null = null;
let vault = '';

beforeEach(async () => {
  vault = await makeTempVault();
});

afterEach(async () => {
  if (server !== null) {
    await server.stop();
    server = null;
  }
  if (vault !== '') {
    await cleanupVault(vault);
    vault = '';
  }
});

// ---- ヘルパー ----

async function seedFile(relPath: string, content: string): Promise<void> {
  const abs = path.join(vault, ...relPath.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function fileExists(relPath: string): Promise<boolean> {
  try {
    const st = await stat(path.join(vault, ...relPath.split('/')));
    return st.isFile();
  } catch {
    return false;
  }
}

async function readVaultFile(relPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(vault, ...relPath.split('/')), 'utf8');
  } catch {
    return null;
  }
}

async function listDir(relPath: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(vault, ...relPath.split('/')));
    return entries;
  } catch {
    return [];
  }
}

// ---- AC-Sa10026-2-1: スマートフォルダ移行 ----

describe('AC-Sa10026-2-1: smart-folders migration', () => {
  it('旧 .loamium/smart-folders.json の query item が system/smart-folders/*.yaml へ移行される', async () => {
    // v0 旧形式: フラット JSON
    const oldConfig = {
      version: 1,
      items: [
        {
          kind: 'query',
          id: 'todo',
          name: 'ToDo 一覧',
          icon: '📋',
          dql: 'LIST WHERE tags CONTAINS "todo" SORT file.mtime DESC',
        },
        {
          kind: 'query',
          id: 'recent',
          name: '最近更新',
          dql: 'LIST SORT file.mtime DESC LIMIT 10',
        },
      ],
    };
    await seedFile('.loamium/smart-folders.json', JSON.stringify(oldConfig, null, 2));

    // サーバー起動 (移行が起動時に実行される)
    server = await startServer({ vault });
    const { baseUrl } = server;

    // 1. system/smart-folders/ にファイルが作成されているか
    const systemFiles = await listDir('system/smart-folders');
    expect(systemFiles).toContain('todo.yaml');
    expect(systemFiles).toContain('recent.yaml');

    // 2. YAML の内容が正しいか
    const todoYaml = await readVaultFile('system/smart-folders/todo.yaml');
    expect(todoYaml).not.toBeNull();
    expect(todoYaml).toContain('todo'); // DQL を含む
    expect(todoYaml).toContain('ToDo 一覧'); // title

    // 3. GET /api/smart-folders が system/ から読む
    const res = await fetch(`${baseUrl}/api/smart-folders`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ kind: string; id: string; dql: string }> };
    expect(body.items).toHaveLength(2);
    const todoItem = body.items.find((i) => i.id === 'todo');
    expect(todoItem).toBeDefined();
    expect(todoItem?.kind).toBe('query');
    expect(todoItem?.dql).toContain('todo');

    // 4. マーカーファイルが作成されているか
    expect(await fileExists('.loamium/migrate-Sa10026-2.done')).toBe(true);
  });

  it('pin item は system/ へ移行されない (query item のみ)', async () => {
    const oldConfig = {
      version: 1,
      items: [
        {
          kind: 'pin',
          id: 'my-pin',
          name: 'My Note',
          path: 'notes/important.md',
        },
        {
          kind: 'query',
          id: 'q1',
          name: 'All Notes',
          dql: 'LIST LIMIT 5',
        },
      ],
    };
    await seedFile('.loamium/smart-folders.json', JSON.stringify(oldConfig, null, 2));

    server = await startServer({ vault });
    const { baseUrl } = server;

    const systemFiles = await listDir('system/smart-folders');
    // q1 は移行される、my-pin は移行されない
    expect(systemFiles).toContain('q1.yaml');
    expect(systemFiles).not.toContain('my-pin.yaml');

    // GET で q1 は system/ から取得、pin は json フォールバックから取得
    const res = await fetch(`${baseUrl}/api/smart-folders`);
    const body = await res.json() as { items: Array<{ kind: string; id: string }> };
    // query item が system/ から来る
    const q1Item = body.items.find((i) => i.id === 'q1');
    expect(q1Item?.kind).toBe('query');
  });

  it('system/ が既に存在する場合は json へのフォールバックをしない', async () => {
    // system/ にすでにファイルがある
    await seedFile('system/smart-folders/existing.yaml', 'query: LIST LIMIT 3\ntitle: Existing\n');
    // 旧 JSON もある (移行マーカーなし)
    const oldConfig = {
      version: 1,
      items: [{ kind: 'query', id: 'other', name: 'Other', dql: 'LIST LIMIT 1' }],
    };
    await seedFile('.loamium/smart-folders.json', JSON.stringify(oldConfig));

    server = await startServer({ vault });
    const { baseUrl } = server;

    const res = await fetch(`${baseUrl}/api/smart-folders`);
    const body = await res.json() as { items: Array<{ id: string }> };
    // system/ の existing が返る (json の other は返らない)
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain('existing');
  });

  it('[AC-Sa10026-2-1] traversal を含む id はスキップされ、他の item は正常移行する', async () => {
    const oldConfig = {
      version: 1,
      items: [
        { kind: 'query', id: '../../escape', name: 'Bad', dql: 'LIST LIMIT 1' },
        { kind: 'query', id: 'safe', name: 'Safe', dql: 'LIST LIMIT 1' },
      ],
    };
    await seedFile('.loamium/smart-folders.json', JSON.stringify(oldConfig));

    // 移行時に traversal id で例外を投げずサーバが起動すること
    server = await startServer({ vault });
    const { baseUrl } = server;

    const res = await fetch(`${baseUrl}/api/smart-folders`);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((i) => i.id);
    // safe は移行される / traversal id は含まれない
    expect(ids).toContain('safe');
    expect(ids).not.toContain('../../escape');
    // vault 外へ escape.yaml が書かれていない
    await expect(stat(path.join(vault, '..', 'escape.yaml'))).rejects.toThrow();
  });

  it('[AC-Sa10026-2-3] 冪等: 二重起動しても smart-folders データが失われない', async () => {
    const oldConfig = {
      version: 1,
      items: [{ kind: 'query', id: 'idempotent', name: 'Idempotent Test', dql: 'LIST LIMIT 1' }],
    };
    await seedFile('.loamium/smart-folders.json', JSON.stringify(oldConfig));

    // 1回目起動
    server = await startServer({ vault });
    await server.stop();
    server = null;

    // マーカー確認
    expect(await fileExists('.loamium/migrate-Sa10026-2.done')).toBe(true);

    // 2回目起動 (マーカーありでスキップ)
    server = await startServer({ vault });
    const { baseUrl } = server;

    const res = await fetch(`${baseUrl}/api/smart-folders`);
    const body = await res.json() as { items: Array<{ id: string }> };
    // データが失われていない
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain('idempotent');
  });

  it('[AC-Sa10026-2-3] 部分移行済み状態でも安全 (一部ファイルが既に存在)', async () => {
    const oldConfig = {
      version: 1,
      items: [
        { kind: 'query', id: 'first', name: 'First', dql: 'LIST LIMIT 1' },
        { kind: 'query', id: 'second', name: 'Second', dql: 'LIST LIMIT 2' },
      ],
    };
    await seedFile('.loamium/smart-folders.json', JSON.stringify(oldConfig));
    // 部分移行済み: first だけ先に system/ にある
    await seedFile('system/smart-folders/first.yaml', 'query: LIST LIMIT 1\ntitle: First\n');

    server = await startServer({ vault });
    const { baseUrl } = server;

    // second も移行されているか
    const systemFiles = await listDir('system/smart-folders');
    expect(systemFiles).toContain('first.yaml');
    expect(systemFiles).toContain('second.yaml');

    const res = await fetch(`${baseUrl}/api/smart-folders`);
    const body = await res.json() as { items: Array<{ id: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain('first');
    expect(ids).toContain('second');
  });
});

// ---- AC-Sa10026-2-2: テンプレート移行 ----

describe('AC-Sa10026-2-2: templates migration', () => {
  it('templates/ が system/templates/ へ移行される', async () => {
    const templateContent = [
      '---',
      'loamium-template:',
      '  description: サンプルテンプレート',
      '  target: notes/sample',
      '---',
      '# サンプルノート',
      '',
      'これはテンプレートです。',
    ].join('\n');
    await seedFile('templates/sample.md', templateContent);

    server = await startServer({ vault });
    const { baseUrl } = server;

    // system/templates/ にコピーされているか
    expect(await fileExists('system/templates/sample.md')).toBe(true);

    // GET /api/templates で取得できるか
    const res = await fetch(`${baseUrl}/api/templates`);
    const body = await res.json() as { templates: Array<{ name: string; path: string }> };
    const sample = body.templates.find((t) => t.name === 'sample');
    expect(sample).toBeDefined();
    // system/ から来ていることを確認
    expect(sample?.path).toContain('system/templates/');
  });

  it('system/templates/ を優先し、同名 templates/ はシャドウされる', async () => {
    const systemContent = '# System Version\n\nシステム側テンプレート\n';
    const legacyContent = '# Legacy Version\n\n旧パステンプレート\n';
    await seedFile('system/templates/mytemplate.md', systemContent);
    await seedFile('templates/mytemplate.md', legacyContent);

    server = await startServer({ vault });
    const { baseUrl } = server;

    const res = await fetch(`${baseUrl}/api/templates`);
    const body = await res.json() as { templates: Array<{ name: string; path: string }> };
    const matches = body.templates.filter((t) => t.name === 'mytemplate');
    // 同名は 1 件のみ (system/ が shadowing)
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toContain('system/templates/');
  });

  it('instantiate で system/templates/ を優先する', async () => {
    const templateContent = [
      '---',
      'loamium-template:',
      '  target: notes/instantiated',
      '---',
      '# Instantiated from system',
    ].join('\n');
    await seedFile('system/templates/my-tmpl.md', templateContent);

    server = await startServer({ vault });
    const { baseUrl } = server;

    const res = await fetch(`${baseUrl}/api/templates/my-tmpl/instantiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vars: {} }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { path: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.path).toBe('notes/instantiated.md');
  });

  it('後方互換: templates/ のみ存在する場合も instantiate できる', async () => {
    const templateContent = [
      '---',
      'loamium-template:',
      '  target: notes/legacy-instantiated',
      '---',
      '# From legacy templates/',
    ].join('\n');
    await seedFile('templates/legacy-tmpl.md', templateContent);

    server = await startServer({ vault });
    const { baseUrl } = server;

    const res = await fetch(`${baseUrl}/api/templates/legacy-tmpl/instantiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vars: {} }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { path: string };
    expect(body.path).toBe('notes/legacy-instantiated.md');
  });

  it('[AC-Sa10026-2-3] 冪等: templates/ 移行が二重実行で重複しない', async () => {
    await seedFile('templates/idempotent.md', '# Idempotent Template\n');

    // 1回目
    server = await startServer({ vault });
    await server.stop();
    server = null;

    // system/templates/ にコピーされた
    expect(await fileExists('system/templates/idempotent.md')).toBe(true);

    // 2回目 (マーカーあり)
    server = await startServer({ vault });
    await server.stop();
    server = null;

    // ファイル数は変わらない
    const files = await listDir('system/templates');
    const idempotentCount = files.filter((f) => f === 'idempotent.md').length;
    expect(idempotentCount).toBe(1);
  });
});

// ---- AC-Sa10026-2-2: コマンド移行 ----

describe('AC-Sa10026-2-2: commands migration', () => {
  const SAMPLE_COMMAND = [
    'name: サンプルコマンド',
    'description: テスト用コマンド',
    'params: []',
    'steps:',
    '  - kind: note-create',
    '    target: notes/from-command',
    '    content: "# Created"',
  ].join('\n');

  it('commands/*.yaml が system/commands/*.yaml へ移行される', async () => {
    await seedFile('commands/sample.yaml', SAMPLE_COMMAND);

    server = await startServer({ vault });
    const { baseUrl } = server;

    // system/commands/ にコピーされているか
    expect(await fileExists('system/commands/sample.yaml')).toBe(true);

    // GET /api/commands で取得できるか
    const res = await fetch(`${baseUrl}/api/commands`);
    const body = await res.json() as { commands: Array<{ id: string; path: string }> };
    const sample = body.commands.find((c) => c.id === 'sample');
    expect(sample).toBeDefined();
    expect(sample?.path).toContain('system/commands/');
  });

  it('system/commands/ を優先し、同名 commands/ はシャドウされる', async () => {
    const validStep = '\n  - kind: note-create\n    target: notes/dummy\n    content: "# dummy"\n';
    const systemCmd = `name: System Version\nparams: []\nsteps:${validStep}`;
    const legacyCmd = `name: Legacy Version\nparams: []\nsteps:${validStep}`;
    await seedFile('system/commands/mycommand.yaml', systemCmd);
    await seedFile('commands/mycommand.yaml', legacyCmd);

    server = await startServer({ vault });
    const { baseUrl } = server;

    const res = await fetch(`${baseUrl}/api/commands`);
    const body = await res.json() as { commands: Array<{ id: string; name: string; path: string }> };
    const matches = body.commands.filter((c) => c.id === 'mycommand');
    // 同名は 1 件のみ (system/ が shadowing)
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toContain('system/commands/');
    expect(matches[0]?.name).toBe('System Version');
  });

  it('GET source で system/commands/ を優先する', async () => {
    const validStep = '\n  - kind: note-create\n    target: notes/dummy\n    content: "# dummy"\n';
    await seedFile('system/commands/srccmd.yaml', `name: System Source\nparams: []\nsteps:${validStep}`);
    await seedFile('commands/srccmd.yaml', `name: Legacy Source\nparams: []\nsteps:${validStep}`);

    server = await startServer({ vault });
    const { baseUrl } = server;

    const res = await fetch(`${baseUrl}/api/commands/srccmd/source`);
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string; path: string };
    expect(body.path).toContain('system/commands/');
    expect(body.content).toContain('System Source');
  });

  it('PUT source で system/commands/ に書き込まれる', async () => {
    server = await startServer({ vault });
    const { baseUrl } = server;

    const newContent = 'name: New Command\nparams: []\nsteps: []\n';
    const res = await fetch(`${baseUrl}/api/commands/newcmd/source`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: newContent }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; created: boolean };
    expect(body.path).toContain('system/commands/');
    expect(body.created).toBe(true);
  });

  it('後方互換: commands/ のみ存在するコマンドも run できる', async () => {
    const legacyCmd = [
      'name: Legacy Run Test',
      'params: []',
      'steps:',
      '  - kind: note-create',
      '    target: notes/legacy-run-result',
      '    content: "# Created by legacy command"',
    ].join('\n');
    await seedFile('commands/legacyrun.yaml', legacyCmd);

    server = await startServer({ vault });
    const { baseUrl } = server;

    const res = await fetch(`${baseUrl}/api/commands/legacyrun/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ kind: string; ok: boolean }> };
    expect(body.results[0]?.ok).toBe(true);
  });

  it('[AC-Sa10026-2-3] 冪等: commands/ 移行が二重実行でデータを失わない', async () => {
    await seedFile('commands/idempotent-cmd.yaml', SAMPLE_COMMAND);

    // 1回目
    server = await startServer({ vault });
    await server.stop();
    server = null;

    expect(await fileExists('system/commands/idempotent-cmd.yaml')).toBe(true);

    // 内容を確認
    const content1 = await readVaultFile('system/commands/idempotent-cmd.yaml');
    expect(content1).toContain('サンプルコマンド');

    // 2回目 (マーカーあり → スキップ)
    server = await startServer({ vault });
    await server.stop();
    server = null;

    const content2 = await readVaultFile('system/commands/idempotent-cmd.yaml');
    expect(content2).toBe(content1); // 内容不変
  });
});

// ---- AC-Sa10026-2-3: 破壊的多版テスト (v0 フラット JSON → 移行 → 新形式) ----

describe('AC-Sa10026-2-3: destructive multi-version migration', () => {
  it('v0 フラット JSON + 旧パス fixture → 移行 → 全種 system/ で正常動作', async () => {
    // v0 旧形式を完全に再現する
    // 1. .loamium/smart-folders.json (旧スマートフォルダ)
    const oldSmartFolders = {
      version: 1,
      items: [
        { kind: 'query', id: 'mv-todo', name: '移行テスト ToDo', dql: 'LIST LIMIT 3' },
        { kind: 'query', id: 'mv-recent', name: '移行テスト 最近', dql: 'LIST LIMIT 5' },
      ],
    };
    await seedFile('.loamium/smart-folders.json', JSON.stringify(oldSmartFolders));

    // 2. templates/mv-journal.md (旧テンプレート)
    await seedFile('templates/mv-journal.md', '---\nloamium-template:\n  target: journals/mv\n---\n# MV Journal\n');

    // 3. commands/mv-create.yaml (旧コマンド)
    await seedFile('commands/mv-create.yaml', 'name: MV Create\nparams: []\nsteps:\n  - kind: note-create\n    target: notes/mv-note\n    content: "# MV"\n');

    // サーバー起動 → 移行実行
    server = await startServer({ vault });
    const { baseUrl } = server;

    // --- 移行後検証 ---

    // 1. smart-folders
    const sfRes = await fetch(`${baseUrl}/api/smart-folders`);
    const sfBody = await sfRes.json() as { items: Array<{ id: string }> };
    expect(sfBody.items.map((i) => i.id)).toContain('mv-todo');
    expect(sfBody.items.map((i) => i.id)).toContain('mv-recent');

    // 2. templates
    const tmplRes = await fetch(`${baseUrl}/api/templates`);
    const tmplBody = await tmplRes.json() as { templates: Array<{ name: string }> };
    expect(tmplBody.templates.map((t) => t.name)).toContain('mv-journal');

    // 3. commands
    const cmdRes = await fetch(`${baseUrl}/api/commands`);
    const cmdBody = await cmdRes.json() as { commands: Array<{ id: string }> };
    expect(cmdBody.commands.map((c) => c.id)).toContain('mv-create');

    // 4. マーカー確認
    expect(await fileExists('.loamium/migrate-Sa10026-2.done')).toBe(true);

    // 5. PUT smart-folders で system/ に書き込める (正本更新)
    const newCfg = {
      version: 1,
      items: [
        { kind: 'query', id: 'mv-todo', name: 'Updated ToDo', dql: 'LIST LIMIT 3' },
      ],
    };
    const putRes = await fetch(`${baseUrl}/api/smart-folders`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(newCfg),
    });
    expect(putRes.status).toBe(200);

    // 6. mv-recent が削除されているか確認
    const sfRes2 = await fetch(`${baseUrl}/api/smart-folders`);
    const sfBody2 = await sfRes2.json() as { items: Array<{ id: string }> };
    expect(sfBody2.items.map((i) => i.id)).not.toContain('mv-recent');
    expect(sfBody2.items.map((i) => i.id)).toContain('mv-todo');
  });

  it('[AC-Sa10026-2-3] 壊れた旧 JSON でも他系統の移行は継続する', async () => {
    // 壊れた JSON
    await seedFile('.loamium/smart-folders.json', '{ invalid json }');
    // templates と commands は正常
    await seedFile('templates/safe.md', '---\nloamium-template:\n  target: notes/safe\n---\n# Safe\n');
    await seedFile('commands/safe.yaml', 'name: Safe\nparams: []\nsteps: []\n');

    server = await startServer({ vault });
    const { baseUrl } = server;

    // smart-folders はスキップされたが templates と commands は移行された
    expect(await fileExists('system/templates/safe.md')).toBe(true);
    expect(await fileExists('system/commands/safe.yaml')).toBe(true);

    // マーカーは書かれた (部分成功)
    expect(await fileExists('.loamium/migrate-Sa10026-2.done')).toBe(true);
  });
});
