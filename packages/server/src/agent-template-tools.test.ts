/**
 * エージェントテンプレートツールのユニットテスト (Sc4b9d1-3 / ADR-0016)。
 *
 * [AC-Sc4b9d1-3] templates_list は listTemplates 経路 (GET /api/templates 同一・壊れはスキップ)。
 *   template_instantiate は instantiateTemplate (POST /api/templates/{name}/instantiate 同一
 *   解決エンジン) へ委譲する:
 *     - 生成成功 → ピュア Markdown ノート・op:agent.template_instantiate を監査。
 *     - 必須変数不足 → missing 一覧テキスト (throw しない)。
 *     - 未検出 → not-found テキスト。
 *     - 衝突 → firstFreePath で連番回避。
 *   ケーパビリティ帰属: templates_list は read、template_instantiate は template_write 再利用。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTemplateTools } from './agent-template-tools.js';
import type { ServerConfig } from './config.js';
import type { Capability } from '@loamium/shared';

const fakeCtx = {} as Parameters<
  ReturnType<typeof createTemplateTools>[number]['execute']
>[4];

type ExecResult = Awaited<
  ReturnType<ReturnType<typeof createTemplateTools>[number]['execute']>
>;

function textOf(result: ExecResult): string {
  const first = result.content[0];
  if (first && first.type === 'text') return first.text;
  return '';
}

function detailsOf(result: ExecResult): {
  error?: boolean;
  count?: number;
  path?: string;
  created?: boolean;
} {
  const d = result.details;
  if (typeof d === 'object' && d !== null) {
    return d as { error?: boolean; count?: number; path?: string; created?: boolean };
  }
  return {};
}

const ALL_CAPS: Capability[] = ['read', 'template_write'];

function makeConfig(vaultRoot: string): ServerConfig {
  return { vaultRoot, mode: 'full', maxUploadBytes: 1024 };
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

/** system/templates/{name}.md を書く。 */
async function writeTemplateFixture(vaultRoot: string, name: string, content: string): Promise<void> {
  const dir = path.join(vaultRoot, 'system', 'templates');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.md`), content, 'utf8');
}

async function readVaultNote(vaultRoot: string, rel: string): Promise<string> {
  return readFile(path.join(vaultRoot, rel), 'utf8');
}

describe('createTemplateTools', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agent-tpl-test-'));
  });

  function tool(name: string, caps: Capability[] = ALL_CAPS) {
    const tools = createTemplateTools(makeConfig(vaultRoot), caps);
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not generated: ${name}`);
    return t;
  }

  // ---- ケーパビリティゲート ------------------------------------------------

  it('read 無効時は templates_list を広告しない', () => {
    const tools = createTemplateTools(makeConfig(vaultRoot), ['template_write']);
    expect(tools.map((t) => t.name).sort()).toEqual(['template_instantiate']);
  });

  it('template_write 無効時は template_instantiate を広告しない', () => {
    const tools = createTemplateTools(makeConfig(vaultRoot), ['read']);
    expect(tools.map((t) => t.name).sort()).toEqual(['templates_list']);
  });

  it('caps 空なら 1 つも広告しない', () => {
    expect(createTemplateTools(makeConfig(vaultRoot), [])).toHaveLength(0);
  });

  // ---- templates_list ------------------------------------------------------

  it('templates_list は system/templates を列挙する (壊れはスキップ)', async () => {
    await writeTemplateFixture(
      vaultRoot,
      'meeting',
      '---\nloamium-template:\n  description: 会議メモ\n  target: "meetings/{{title}}"\n  vars:\n    - name: title\n      required: true\n---\n# {{title}}\n',
    );
    const result = await tool('templates_list').execute('c', {}, undefined, undefined, fakeCtx);
    expect(detailsOf(result).count).toBe(1);
    expect(textOf(result)).toContain('meeting');
    expect(textOf(result)).toContain('会議メモ');
    expect(textOf(result)).toContain('必須変数: title');
  });

  it('templates_list は定義なしなら 0 件テキスト', async () => {
    const result = await tool('templates_list').execute('c', {}, undefined, undefined, fakeCtx);
    expect(detailsOf(result).count).toBe(0);
    expect(textOf(result)).toContain('定義されていません');
  });

  // ---- template_instantiate: 生成成功 + ピュア Markdown + 監査 --------------

  it('template_instantiate はピュア Markdown ノートを生成し agent.template_instantiate を監査する', async () => {
    await writeTemplateFixture(
      vaultRoot,
      'meeting',
      '---\nloamium-template:\n  target: "meetings/{{title}}"\n  vars:\n    - name: title\n      required: true\ntags: [meeting]\n---\n# {{title}}\n\n議題:\n',
    );
    const result = await tool('template_instantiate').execute(
      'c',
      { name: 'meeting', vars: { title: '定例' } },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).created).toBe(true);
    expect(detailsOf(result).path).toBe('meetings/定例.md');

    const note = await readVaultNote(vaultRoot, 'meetings/定例.md');
    // 結果ノートはピュア Markdown: loamium-template 記法が残らない (DESIGN_PRINCIPLES priority 1)
    expect(note).not.toContain('loamium-template');
    expect(note).toContain('# 定例');
    // 変数展開済み
    expect(note).not.toContain('{{title}}');

    const audit = await readAudit(vaultRoot);
    expect(
      audit.some((e) => e.op === 'agent.template_instantiate' && e.path === 'meetings/定例.md'),
    ).toBe(true);
  });

  // ---- template_instantiate: 必須変数不足 ----------------------------------

  it('template_instantiate は必須変数不足を missing テキストで返す (throw しない)', async () => {
    await writeTemplateFixture(
      vaultRoot,
      'meeting',
      '---\nloamium-template:\n  target: "meetings/{{title}}"\n  vars:\n    - name: title\n      required: true\n---\n# {{title}}\n',
    );
    const result = await tool('template_instantiate').execute(
      'c',
      { name: 'meeting', vars: {} },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('必須変数');
    expect(textOf(result)).toContain('title');
    const audit = await readAudit(vaultRoot);
    expect(audit.some((e) => e.op === 'agent.template_instantiate')).toBe(false);
  });

  // ---- template_instantiate: 未検出 ----------------------------------------

  it('template_instantiate は未検出を not-found テキストで返す', async () => {
    const result = await tool('template_instantiate').execute(
      'c',
      { name: 'ghost' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(result).error).toBe(true);
    expect(textOf(result)).toContain('見つかりません');
  });

  // ---- template_instantiate: 衝突は firstFreePath で回避 --------------------

  it('template_instantiate は保存先衝突を連番で回避する', async () => {
    await writeTemplateFixture(
      vaultRoot,
      'note',
      '---\nloamium-template:\n  target: "n/fixed"\n---\n# body\n',
    );
    const first = await tool('template_instantiate').execute(
      'c',
      { name: 'note' },
      undefined,
      undefined,
      fakeCtx,
    );
    const second = await tool('template_instantiate').execute(
      'c',
      { name: 'note' },
      undefined,
      undefined,
      fakeCtx,
    );
    expect(detailsOf(first).path).toBe('n/fixed.md');
    // 2 回目は連番で別パス
    expect(detailsOf(second).path).not.toBe('n/fixed.md');
    expect(detailsOf(second).created).toBe(true);
  });
});
