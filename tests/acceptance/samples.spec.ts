/**
 * Story Sa629e2-2「機能サンプルノート集」受け入れテスト。
 * scenario-Sa629e2-2.json (mixed: cli + api) を機械的に実行する。
 *
 * test-discipline Rule 2:
 * - cli: `make samples` をサブプロセスとして実行する (ユーザーの実入口)
 * - api: 実サーバー + 実 HTTP クライアント (fetch) で POST /api/query を叩く
 * vault はテストごとの一時ディレクトリ (dev-vault は使わない)。
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryResponseSchema } from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');

let vault: string;
let server: TestServer | null = null;

/** `make samples` をサブプロセスで実行する (LOAMIUM_VAULT=一時 vault)。 */
function runMakeSamples(dest: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('make', ['samples'], {
      cwd: repoRoot,
      env: { ...process.env, LOAMIUM_VAULT: dest },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.stderr.on('data', (c: Buffer) => (out += c.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`make samples did not exit within 30s:\n${out}`));
    }, 30_000);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** vault/samples/ 配下の .md を全部読み、連結テキストとファイル一覧を返す。 */
async function readAllSamples(dest: string): Promise<{ files: string[]; text: string }> {
  const root = path.join(dest, 'samples');
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else files.push(path.relative(root, p));
    }
  }
  await walk(root);
  let text = '';
  for (const f of files.filter((f) => f.endsWith('.md'))) {
    text += `\n<<<${f}>>>\n${await readFile(path.join(root, f), 'utf8')}`;
  }
  return { files: files.sort(), text };
}

/** サンプルノートから ```dataview フェンスの中身を全て抽出する。 */
function extractDataviewQueries(text: string): string[] {
  const out: string[] = [];
  const re = /```dataview\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const q = (m[1] ?? '').trim();
    if (q.length > 0) out.push(q);
  }
  return out;
}

beforeAll(async () => {
  vault = await makeTempVault();
});

afterAll(async () => {
  if (server !== null) await server.stop();
  await cleanupVault(vault);
});

describe('[AC-Sa629e2-2-1] make samples で全機能トピックのサンプル vault が投入される', () => {
  it('make samples が成功し、index + 機能別ノート + 実データ + 画像が vault に入る', async () => {
    const res = await runMakeSamples(vault);
    expect(res.code, res.out).toBe(0);

    const { files, text } = await readAllSamples(vault);
    // index とサンプル画像 (PNG マジックバイト)
    expect(files).toContain('index.md');
    const png = files.find((f) => f.startsWith('assets/') && f.endsWith('.png'));
    expect(png, 'assets/ に PNG サンプル画像があること').toBeDefined();
    const head = (await readFile(path.join(vault, 'samples', png ?? ''))).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // dataview の使い方 (筆頭): LIST/TABLE/TASK・FROM #tag・"folder"・WHERE・SORT の実例
    expect(text).toContain('```dataview');
    expect(text).toMatch(/LIST FROM #/);
    expect(text).toMatch(/TABLE .*FROM #/);
    expect(text).toMatch(/TASK FROM #/);
    expect(text).toMatch(/FROM "samples\//);
    expect(text).toMatch(/WHERE /);
    expect(text).toMatch(/SORT /);
    // クエリ → 何が出るかの説明が併記されている
    expect(text).toContain('下の例は');

    // 機能トピックの網羅 (実際の記法が含まれること)
    expect(text).toMatch(/\| --- \|/); // テーブル
    expect(text).toContain('![['); // embed / transclusion / 画像
    expect(text).toContain('> [!note]'); // callout
    expect(text).toContain('=='); // highlight
    expect(text).toContain('$$'); // KaTeX ブロック数式
    expect(text).toContain('```mermaid'); // mermaid
    expect(text).toContain('```ts'); // コードフェンス
    expect(text).toContain('- [ ]'); // タスク
    expect(text).toContain('[['); // wikilink
    expect(text).toContain('スラッシュメニュー'); // / メニューの使い方
    expect(text).toContain('アップロード'); // 添付/アップロードの使い方

    // 全て日本語のガイド + データノートが揃っている
    for (const f of [
      'index.md',
      '機能ガイド/dataview の使い方.md',
      '機能ガイド/テーブル.md',
      '機能ガイド/embed と transclusion.md',
      '機能ガイド/callout と highlight.md',
      '機能ガイド/数式 KaTeX.md',
      '機能ガイド/mermaid 図.md',
      '機能ガイド/コードフェンス.md',
      '機能ガイド/タスク.md',
      '機能ガイド/wikilink とバックリンク.md',
      '機能ガイド/スラッシュメニュー.md',
      '機能ガイド/添付とアップロード.md',
      'データ/プロジェクト Hydra.md',
      'データ/プロジェクト Loamium.md',
      'データ/読書メモ 失敗の科学.md',
      'データ/読書メモ SF短編集.md',
    ]) {
      expect(files, `${f} が投入されていること`).toContain(f);
    }
  });

  it('既存ファイルは上書きしない (no-clobber)', async () => {
    const indexPath = path.join(vault, 'samples', 'index.md');
    const sentinel = '# ユーザーが編集した index\n\nこの内容は守られるべき。\n';
    await writeFile(indexPath, sentinel, 'utf8');

    const res = await runMakeSamples(vault);
    expect(res.code, res.out).toBe(0);
    expect(await readFile(indexPath, 'utf8')).toBe(sentinel);

    // 次のテストのために元の index を復元しておく (再実行では上書きされないため手動で)
    // サンプル正本は packages/server/src/samples/ に移動済み (S7e2d5c-2)
    const original = await readFile(path.join(repoRoot, 'packages/server/src/samples', 'index.md'), 'utf8');
    await writeFile(indexPath, original, 'utf8');
  });
});

describe('[AC-Sa629e2-2-2] 投入したサンプルの dataview クエリが /api/query で実際に動く', () => {
  beforeAll(async () => {
    server = await startServer({ vault });
  });

  it('サンプル内の全 dataview クエリが構文エラーなく実行でき、LIST/TABLE/TASK とも結果が返る', async () => {
    const { text } = await readAllSamples(vault);
    const queries = extractDataviewQueries(text);
    expect(queries.length).toBeGreaterThanOrEqual(6);

    const seen = { list: 0, table: 0, task: 0 };
    for (const query of queries) {
      const res = await fetch(`${server?.baseUrl ?? ''}/api/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const body: unknown = await res.json();
      expect(res.status, `クエリが成功すること: ${query}\n-> ${JSON.stringify(body)}`).toBe(200);
      const parsed = queryResponseSchema.parse(body);
      // サンプル自身が実データとして機能する: 各クエリが 1 件以上ヒットする
      expect(parsed.results.length, `結果が空でないこと: ${query}`).toBeGreaterThan(0);
      seen[parsed.type] += 1;
    }
    // LIST / TABLE / TASK の全タイプが実例として含まれる
    expect(seen.list).toBeGreaterThan(0);
    expect(seen.table).toBeGreaterThan(0);
    expect(seen.task).toBeGreaterThan(0);
  });
});
