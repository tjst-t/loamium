/**
 * Story S89a350-2「テンプレート定義の読み込みとインスタンス化」受け入れテスト。
 * 実サーバー (サブプロセス) + 実 HTTP クライアント (fetch) + 実ファイル (test-discipline Rule 2)。
 *
 * 検証の要点:
 * - GET /api/templates が target / vars を返し、frontmatter 無しファイルも純粋雛形として扱う
 * - 壊れた loamium-template がクラッシュせずフォールバックする
 * - POST instantiate が target/本文を解決して実ファイルを作成する
 * - 生成ノートが解決済みピュア Markdown (テンプレ記法 {{...}} / loamium-template が非残存)
 * - パス衝突時に連番 (_2) を付与する
 * - 不足変数は 4xx で不足名を返す
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

let server: TestServer;

function todayLocal(): { y: string; m: string; d: string; iso: string } {
  const now = new Date();
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return { y, m, d, iso: `${y}-${m}-${d}` };
}

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

const MEETING_TEMPLATE = [
  '---',
  'loamium-template:',
  '  description: 会議の議事録',
  '  target: "議事録/{{date:YYYY}}/{{date:MM}}/{{date:DD}}_{{会議名}}"',
  '  vars:',
  '    - name: 会議名',
  '      type: text',
  '      required: true',
  '    - name: 日付',
  '      type: date',
  '      default: "{{date:YYYY-MM-DD}}"',
  '    - name: カテゴリ',
  '      type: select',
  '      options: [定例, 臨時, その他]',
  '      default: 定例',
  '    - name: 参加者',
  '      type: tags',
  'カテゴリ: "{{カテゴリ}}"',
  '---',
  '# {{会議名}}',
  '',
  '日付: {{日付}}',
  '参加者: {{参加者}}',
  '',
].join('\n');

const DAILY_TEMPLATE = [
  '---',
  'loamium-template:',
  '  target: "journals/{{date:YYYY}}/{{date:MM}}/{{date:YYYY-MM-DD}}"',
  '---',
  '# {{date:YYYY-MM-DD}}',
  '',
].join('\n');

// frontmatter 無し = 純粋雛形 (target なし)
const PLAIN_TEMPLATE = '# 雛形\n\nプレーンな雛形。\n';

// 壊れた loamium-template (オブジェクトでない) → フォールバック
const BROKEN_TEMPLATE = ['---', 'loamium-template: "これは壊れた定義"', '---', '# broken', ''].join(
  '\n',
);

beforeAll(async () => {
  const vault = await makeTempVault();
  server = await startServer({ vault });
  await putNote('templates/議事録.md', MEETING_TEMPLATE);
  await putNote('templates/デイリー.md', DAILY_TEMPLATE);
  await putNote('templates/雛形.md', PLAIN_TEMPLATE);
  await putNote('templates/broken.md', BROKEN_TEMPLATE);
  // templates/ 外のノートは一覧に出ない
  await putNote('notes/普通のノート.md', '# 普通\n');
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

interface TemplateSummary {
  name: string;
  path: string;
  target: string | null;
  description?: string;
  vars: { name: string; type: string; required: boolean; options?: string[]; default?: string }[];
}

async function listTemplates(): Promise<TemplateSummary[]> {
  const res = await fetch(`${server.baseUrl}/api/templates`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { templates: TemplateSummary[] };
  return body.templates;
}

describe('[AC-S89a350-2-1] GET /api/templates', () => {
  it('templates/ 配下の *.md を target / vars 付きで一覧する', async () => {
    const templates = await listTemplates();
    const names = templates.map((t) => t.name).sort();
    expect(names).toEqual(['broken', 'デイリー', '議事録', '雛形']);

    const meeting = templates.find((t) => t.name === '議事録');
    expect(meeting).toBeDefined();
    expect(meeting?.path).toBe('templates/議事録.md');
    expect(meeting?.target).toBe('議事録/{{date:YYYY}}/{{date:MM}}/{{date:DD}}_{{会議名}}');
    expect(meeting?.description).toBe('会議の議事録');
    // vars が正規化されて返る
    const kaigi = meeting?.vars.find((v) => v.name === '会議名');
    expect(kaigi).toMatchObject({ name: '会議名', type: 'text', required: true });
    const cat = meeting?.vars.find((v) => v.name === 'カテゴリ');
    expect(cat).toMatchObject({ type: 'select' });
    expect(cat?.options).toEqual(['定例', '臨時', 'その他']);
    expect(meeting?.vars.find((v) => v.name === '参加者')?.type).toBe('tags');
  });

  it('frontmatter 無しファイルも純粋雛形 (target=null, vars=[]) として扱う', async () => {
    const templates = await listTemplates();
    const plain = templates.find((t) => t.name === '雛形');
    expect(plain).toBeDefined();
    expect(plain?.target).toBeNull();
    expect(plain?.vars).toEqual([]);
  });

  it('壊れた loamium-template はクラッシュせずフォールバック (target=null) して一覧に残る', async () => {
    const templates = await listTemplates();
    const broken = templates.find((t) => t.name === 'broken');
    expect(broken).toBeDefined();
    expect(broken?.target).toBeNull();
    expect(broken?.vars).toEqual([]);
  });

  it('templates/ 外のノートは一覧に含まれない', async () => {
    const templates = await listTemplates();
    expect(templates.some((t) => t.path === 'notes/普通のノート.md')).toBe(false);
  });
});

async function instantiate(
  name: string,
  body: { vars?: Record<string, string>; date?: string },
): Promise<Response> {
  return fetch(`${server.baseUrl}/api/templates/${encodeURIComponent(name)}/instantiate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('[AC-S89a350-2-2] POST /api/templates/{name}/instantiate', () => {
  it('target/本文を解決して新規ノートを作成し、解決パスと created を返す', async () => {
    const t = todayLocal();
    const res = await instantiate('議事録', {
      vars: { 会議名: '定例会議', カテゴリ: '定例', 参加者: '田中, 佐藤' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.path).toBe(`議事録/${t.y}/${t.m}/${t.d}_定例会議.md`);

    // 実ファイルが作成されている
    const raw = await readFile(path.join(server.vault, body.path), 'utf8');
    // 解決済みピュア Markdown: テンプレート記法が一切残らない
    expect(raw).not.toContain('{{');
    expect(raw).not.toContain('loamium-template');
    expect(raw).toContain('# 定例会議');
    expect(raw).toContain('カテゴリ: "定例"');
    expect(raw).toContain('日付: ' + t.iso); // date 型変数の default が解決されている
    expect(raw).toContain('参加者: 田中, 佐藤');
  });

  it('パス衝突時は連番 (_2) を付与する', async () => {
    const t = todayLocal();
    const res = await instantiate('議事録', { vars: { 会議名: '定例会議' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    // 直前のテストで _  無しは作成済み → _2
    expect(body.path).toBe(`議事録/${t.y}/${t.m}/${t.d}_定例会議_2.md`);
    const raw = await readFile(path.join(server.vault, body.path), 'utf8');
    expect(raw).toContain('# 定例会議');
  });

  it('date 指定で {{date:...}} の基準日を上書きできる', async () => {
    const res = await instantiate('デイリー', { date: '2020-01-02' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe('journals/2020/01/2020-01-02.md');
    const raw = await readFile(path.join(server.vault, body.path), 'utf8');
    expect(raw).toBe('# 2020-01-02\n');
    expect(raw).not.toContain('{{');
  });

  it('不足変数があれば 4xx で不足変数名を返す (ノートは作成しない)', async () => {
    const res = await instantiate('議事録', { vars: {} }); // 会議名 (required) 未指定
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string; missing: string[] };
    expect(body.error).toBe('missing_vars');
    expect(body.missing).toContain('会議名');
  });

  it('存在しないテンプレートは 404', async () => {
    const res = await instantiate('存在しない', { vars: {} });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('template_not_found');
  });

  it('target が無い純粋雛形はテンプレート名をパスにフォールバックして作成する', async () => {
    const res = await instantiate('雛形', {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe('雛形.md');
    const raw = await readFile(path.join(server.vault, body.path), 'utf8');
    expect(raw).toBe('# 雛形\n\nプレーンな雛形。\n');
  });
});

describe('[AC-S89a350-2-3] 書き込みは監査ログに記録される', () => {
  it('instantiate が .loamium/audit.log に template.instantiate を残す', async () => {
    const res = await instantiate('デイリー', { date: '2021-05-05' });
    expect(res.status).toBe(201);
    const log = await readFile(path.join(server.vault, '.loamium', 'audit.log'), 'utf8');
    const lines = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { op: string; path: string; result: string });
    const entry = lines.find(
      (e) => e.op === 'template.instantiate' && e.path === 'journals/2021/05/2021-05-05.md',
    );
    expect(entry).toBeDefined();
    expect(entry?.result).toBe('ok');
  });

  it('read-only モードでは instantiate が 403 で拒否される (mutate 分類)', async () => {
    const vault = await makeTempVault();
    const ro = await startServer({ vault, mode: 'read-only' });
    try {
      await fetch(`${ro.baseUrl}/api/notes/${encodeURIComponent('templates/x.md')}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: DAILY_TEMPLATE }),
      });
      // read-only なので上の PUT も 403。テンプレ作成は full 別サーバーで行う必要があるが
      // ここでは「instantiate が mutate として 403」を確認するのが目的。
      const res = await fetch(
        `${ro.baseUrl}/api/templates/${encodeURIComponent('デイリー')}/instantiate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vars: {} }),
        },
      );
      expect(res.status).toBe(403);
    } finally {
      await ro.stop();
      await cleanupVault(vault);
    }
  });
});
