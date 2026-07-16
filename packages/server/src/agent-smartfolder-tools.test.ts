/**
 * エージェントスマートフォルダツールのユニットテスト (Sc4b9d1-1 / ADR-0016)。
 *
 * [AC-Sc4b9d1-1-2] smartfolders_list は readConfig 経路 (system/ YAML + pin JSON マージ) を通す。
 * [AC-Sc4b9d1-1-3] smartfolder_notes は query→executeQuery / pin 解決を通し、
 *   privacy deny を除外、id 不明は not-found テキスト (throw しない)。
 * [AC-Sc4b9d1-1-4] smartfolder_write は writeSystemSmartFolder 経由・PUT と同一 YAML 直列化、
 *   normalizeSystemPath でパス脱出を拒否、成功時に agent.smartfolder_write を監査。
 * [AC-Sc4b9d1-1-5] smartfolder_delete は無い id を『削除対象なし』・成功時に監査。
 * [AC-Sc4b9d1-1-1] 無効ケーパビリティ (read/smartfolder_write) のツールは生成 (広告) されない。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { VaultIndex } from './noteIndex.js';
import { createSmartFolderTools } from './agent-smartfolder-tools.js';
import type { ServerConfig } from './config.js';
import type { Capability } from '@loamium/shared';

// ---- ヘルパー ------------------------------------------------------------------

const fakeCtx = {} as Parameters<
  ReturnType<typeof createSmartFolderTools>[number]['execute']
>[4];

type ExecResult = Awaited<
  ReturnType<ReturnType<typeof createSmartFolderTools>[number]['execute']>
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
  created?: boolean;
} {
  const d = result.details;
  if (typeof d === 'object' && d !== null) {
    return d as { error?: boolean; count?: number; id?: string; created?: boolean };
  }
  return {};
}

const ALL_CAPS: Capability[] = ['read', 'smartfolder_write'];

function makeConfig(vaultRoot: string): ServerConfig {
  return { vaultRoot, mode: 'full', maxUploadBytes: 1024 };
}

async function readAudit(
  vaultRoot: string,
): Promise<{ op: string; path: string; result: string }[]> {
  try {
    const raw = await readFile(path.join(vaultRoot, '.loamium', 'audit.log'), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { op: string; path: string; result: string });
  } catch {
    return [];
  }
}

/** system/smart-folders/{id}.yaml を書く (テスト用フィクスチャ)。 */
async function writeSmartFolderFixture(
  vaultRoot: string,
  id: string,
  obj: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(vaultRoot, 'system', 'smart-folders');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.yaml`), stringifyYaml(obj), 'utf8');
}

/** vault にノートを書き、index を再構築する。 */
async function writeNote(vaultRoot: string, rel: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

// ---- テスト --------------------------------------------------------------------

describe('createSmartFolderTools', () => {
  let vaultRoot: string;
  let index: VaultIndex;
  let config: ServerConfig;
  const noDeny = (_rel: string): boolean => false;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agent-sf-test-'));
    index = new VaultIndex(vaultRoot);
    config = makeConfig(vaultRoot);
  });

  function tool(name: string, caps: Capability[] = ALL_CAPS, isDenied = noDeny) {
    const tools = createSmartFolderTools(config, index, isDenied, caps);
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not generated: ${name}`);
    return t;
  }

  // ---- ケーパビリティゲート [AC-Sc4b9d1-1-1] --------------------------------

  it('read 無効時は smartfolders_list / smartfolder_notes を広告しない', () => {
    const tools = createSmartFolderTools(config, index, noDeny, ['smartfolder_write']);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['smartfolder_delete', 'smartfolder_write']);
  });

  it('smartfolder_write 無効時は write / delete を広告しない', () => {
    const tools = createSmartFolderTools(config, index, noDeny, ['read']);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['smartfolder_notes', 'smartfolders_list']);
  });

  it('caps 空なら 1 つも広告しない', () => {
    expect(createSmartFolderTools(config, index, noDeny, [])).toHaveLength(0);
  });

  // ---- smartfolders_list [AC-Sc4b9d1-1-2] ----------------------------------

  it('smartfolders_list は system/ の query 定義を readConfig 経路で返す', async () => {
    await writeSmartFolderFixture(vaultRoot, 'projects', {
      query: 'LIST FROM #project',
      title: 'プロジェクト',
    });
    const result = await tool('smartfolders_list').execute('c', {}, undefined, undefined, fakeCtx);
    expect(detailsOf(result).count).toBe(1);
    expect(textOf(result)).toContain('projects');
    expect(textOf(result)).toContain('プロジェクト');
    expect(textOf(result)).toContain('LIST FROM #project');
  });

  it('smartfolders_list は定義なしなら 0 件テキスト', async () => {
    const result = await tool('smartfolders_list').execute('c', {}, undefined, undefined, fakeCtx);
    expect(detailsOf(result).count).toBe(0);
    expect(textOf(result)).toContain('定義されていません');
  });

  // ---- smartfolder_notes [AC-Sc4b9d1-1-3] ----------------------------------

  it('smartfolder_notes は query を実行して該当ノートを返す', async () => {
    await writeNote(vaultRoot, 'a.md', '# A\n\n#project\n');
    await writeNote(vaultRoot, 'b.md', '# B\n\nno tag\n');
    await index.build();
    await writeSmartFolderFixture(vaultRoot, 'projects', { query: 'LIST FROM #project' });

    const result = await tool('smartfolder_notes').execute(
      'c',
      { id: 'projects' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(textOf(result)).toContain('[[a]]');
    expect(textOf(result)).not.toContain('[[b]]');
    expect(detailsOf(result).count).toBe(1);
  });

  it('[AC-Sc4b9d1-1-3] smartfolder_notes は privacy deny のノートを除外する', async () => {
    await writeNote(vaultRoot, 'secret.md', '# S\n\n#project\n');
    await writeNote(vaultRoot, 'ok.md', '# OK\n\n#project\n');
    await index.build();
    await writeSmartFolderFixture(vaultRoot, 'projects', { query: 'LIST FROM #project' });

    const isDenied = (rel: string): boolean => rel === 'secret.md';
    const result = await tool('smartfolder_notes', ALL_CAPS, isDenied).execute(
      'c',
      { id: 'projects' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(textOf(result)).toContain('[[ok]]');
    expect(textOf(result)).not.toContain('secret');
    expect(detailsOf(result).count).toBe(1);
  });

  it('[AC-Sc4b9d1-1-3] smartfolder_notes は id 不明で throw せず not-found テキストを返す', async () => {
    const result = await tool('smartfolder_notes').execute(
      'c',
      { id: 'nope' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('見つかりません');
  });

  // ---- smartfolder_write [AC-Sc4b9d1-1-4] ----------------------------------

  it('smartfolder_write は system/ YAML を書き込み agent.smartfolder_write を監査する', async () => {
    const result = await tool('smartfolder_write').execute(
      'c',
      { id: 'todo', name: 'ToDo', dql: 'TASK FROM #todo' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).created).toBe(true);
    const yaml = await readFile(
      path.join(vaultRoot, 'system', 'smart-folders', 'todo.yaml'),
      'utf8',
    );
    // yaml ライブラリは '#' を含む値をクォートする (PUT と同一直列化)。
    expect(yaml).toContain('query: "TASK FROM #todo"');
    expect(yaml).toContain('title: ToDo');

    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.smartfolder_write' && e.path.includes('todo'))).toBe(
      true,
    );
  });

  it('smartfolder_write は既存 id を更新扱い (created:false) にする', async () => {
    await writeSmartFolderFixture(vaultRoot, 'todo', { query: 'TASK FROM #old' });
    const result = await tool('smartfolder_write').execute(
      'c',
      { id: 'todo', name: 'ToDo', dql: 'TASK FROM #todo' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).created).toBe(false);
    expect(textOf(result)).toContain('更新');
  });

  it('[AC-Sc4b9d1-1-4] smartfolder_write は不正 DQL を保存前に拒否する', async () => {
    const result = await tool('smartfolder_write').execute(
      'c',
      { id: 'bad', name: 'x', dql: 'NOT A QUERY' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('DQL');
    // ファイルは書かれない
    await expect(
      readFile(path.join(vaultRoot, 'system', 'smart-folders', 'bad.yaml'), 'utf8'),
    ).rejects.toThrow();
  });

  it('[AC-Sc4b9d1-1-4] smartfolder_write は id のパス脱出 (../隠しセグメント) を拒否する', async () => {
    const result = await tool('smartfolder_write').execute(
      'c',
      { id: '../escape', name: 'x', dql: 'LIST' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('パスエラー');
    // 監査は記録されない
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.smartfolder_write')).toBe(false);
  });

  // ---- smartfolder_delete [AC-Sc4b9d1-1-5] ---------------------------------

  it('smartfolder_delete は既存を削除し agent.smartfolder_delete を監査する', async () => {
    await writeSmartFolderFixture(vaultRoot, 'todo', { query: 'TASK FROM #todo' });
    const result = await tool('smartfolder_delete').execute(
      'c',
      { id: 'todo' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBeUndefined();
    expect(textOf(result)).toContain('削除しました');
    await expect(
      readFile(path.join(vaultRoot, 'system', 'smart-folders', 'todo.yaml'), 'utf8'),
    ).rejects.toThrow();
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.smartfolder_delete')).toBe(true);
  });

  it('[AC-Sc4b9d1-1-5] smartfolder_delete は存在しない id を『削除対象なし』・エラーにしない', async () => {
    const result = await tool('smartfolder_delete').execute(
      'c',
      { id: 'ghost' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBeUndefined();
    expect(textOf(result)).toContain('削除対象なし');
    // 監査は記録されない (実削除がないため)
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.smartfolder_delete')).toBe(false);
  });
});
