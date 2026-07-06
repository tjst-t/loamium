/**
 * Story S89a350-2「CLI new コマンド」受け入れテスト (AC-S89a350-2-3)。
 *
 * test-discipline Rule 2 (cli): packages/cli/bin/loamium.js をサブプロセスとして
 * 起動し、stdout / stderr / exit code / vault 内ファイルを観測する。
 * CLI → HTTP → 実サーバー → 実ファイルの全経路を通し、REST instantiate と 1:1 で
 * あること、書き込みが監査ログに残ること、生成ノートがピュア Markdown であることを検証する。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { parseStderrJson, runCli } from './helpers/cli.js';

let server: TestServer;

function cli(args: string[]): ReturnType<typeof runCli> {
  return runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
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
  '  target: "議事録/{{date:YYYY-MM-DD}}_{{会議名}}"',
  '  vars:',
  '    - name: 会議名',
  '      type: text',
  '      required: true',
  '    - name: カテゴリ',
  '      type: select',
  '      default: 定例',
  '---',
  '# {{会議名}}',
  '',
  'カテゴリ: {{カテゴリ}}',
  '',
].join('\n');

function todayIso(): string {
  const now = new Date();
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

beforeAll(async () => {
  const vault = await makeTempVault();
  server = await startServer({ vault });
  await putNote('templates/議事録.md', MEETING_TEMPLATE);
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

describe('[AC-S89a350-2-3] loamium new --template --var は instantiate API と 1:1', () => {
  it('変数を渡してノートを作成し、解決パスを stdout に出す', async () => {
    const res = await cli(['new', '--template', '議事録', '--var', '会議名=定例会議']);
    expect(res.code).toBe(0);
    const iso = todayIso();
    expect(res.stdout.trim()).toBe(`created 議事録/${iso}_定例会議.md`);

    // 実ファイルが解決済みピュア Markdown で作成されている
    const raw = await readFile(path.join(server.vault, `議事録/${iso}_定例会議.md`), 'utf8');
    expect(raw).not.toContain('{{');
    expect(raw).toContain('# 定例会議');
    expect(raw).toContain('カテゴリ: 定例'); // default が解決されている
  });

  it('--json で instantiate API の生レスポンスをそのまま出す', async () => {
    const res = await cli(['new', '--template', '議事録', '--var', '会議名=設計会議', '--json']);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as { path: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.path).toContain('設計会議');
  });

  it('--date で {{date:...}} の基準日を上書きできる', async () => {
    const res = await cli([
      'new',
      '--template',
      '議事録',
      '--var',
      '会議名=過去会議',
      '--date',
      '2020-01-02',
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('created 議事録/2020-01-02_過去会議.md');
  });

  it('必須変数を欠くと 4xx を機械可読エラーとして stderr に出し非 0 終了', async () => {
    const res = await cli(['new', '--template', '議事録']);
    expect(res.code).not.toBe(0);
    const err = parseStderrJson(res.stderr);
    expect(err.error).toBe('missing_vars');
    expect(err.message).toContain('会議名');
  });

  it('--var の形式が不正なら usage エラー (exit 2)', async () => {
    const res = await cli(['new', '--template', '議事録', '--var', '会議名']);
    expect(res.code).toBe(2);
    const err = parseStderrJson(res.stderr);
    expect(err.error).toBe('usage');
  });

  it('存在しないテンプレートは template_not_found', async () => {
    const res = await cli(['new', '--template', '無い', '--var', 'x=y']);
    expect(res.code).not.toBe(0);
    const err = parseStderrJson(res.stderr);
    expect(err.error).toBe('template_not_found');
  });

  it('CLI 作成も監査ログ (.loamium/audit.log) に template.instantiate を残す', async () => {
    const res = await cli(['new', '--template', '議事録', '--var', '会議名=監査確認会']);
    expect(res.code).toBe(0);
    const log = await readFile(path.join(server.vault, '.loamium', 'audit.log'), 'utf8');
    const entries = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { op: string; path: string });
    expect(entries.some((e) => e.op === 'template.instantiate' && e.path.includes('監査確認会'))).toBe(
      true,
    );
  });
});
