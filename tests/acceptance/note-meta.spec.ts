/**
 * Story S11493d-1「ノートメタ集約 API」受け入れテスト。
 *
 * test-discipline Rule 2 (api/cli): 実サーバー (tsx サブプロセス) を実 HTTP クライアントで
 * 叩き、かつ実 CLI バイナリ (loamium.js) を実行してエンドツーエンドを検証する。
 *
 * [AC-S11493d-1-1] GET /api/notes/{path}/meta のレスポンス形状と内容
 * [AC-S11493d-1-2] CLI `loamium note-meta <path>` が同内容を返す (REST/CLI 1:1)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noteMetaResponseSchema } from '@loamium/shared';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { runCli } from './helpers/cli.js';

let server: TestServer;

/** このテストファイル内の全 CLI 呼び出しは LOAMIUM_URL でテストサーバーを指す。 */
function cli(args: string[]): ReturnType<typeof runCli> {
  return runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
}

// テスト用ノートの内容
const NOTE_CONTENT = [
  '---',
  'tags: [dev, api]',
  'status: draft',
  '---',
  '',
  '# Main Heading',
  '',
  'ここは本文テキストです。 #inline-tag',
  '',
  'See [[alpha]] and [[beta#section|別名]] for details.',
  '',
  '## Sub Heading',
  '',
  '```typescript',
  '# Not a heading inside fence',
  '[[link-in-fence]] should be excluded',
  'const x = 1; // excluded from count',
  '```',
  '',
  '### Third level heading',
  '',
  '[[alpha]] appears again — deduplicated.',
  'CJK: 日本語のテキスト',
  '',
].join('\n');

// [[alpha]] が解決するノート、[[beta]] は存在しない (unresolved)
const ALPHA_CONTENT = '# Alpha Note\n\nThis is the alpha note.\n';

beforeAll(async () => {
  const vault = await makeTempVault();
  await mkdir(path.join(vault, 'notes'), { recursive: true });
  // メインのテストノート
  await writeFile(path.join(vault, 'notes/test-note.md'), NOTE_CONTENT, 'utf8');
  // [[alpha]] の解決先
  await writeFile(path.join(vault, 'notes/alpha.md'), ALPHA_CONTENT, 'utf8');
  // [[beta]] は作らない → resolvedPath = null になる
  server = await startServer({ vault });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await cleanupVault(server.vault);
});

// ---------------------------------------------------------------------------
// [AC-S11493d-1-1] GET /api/notes/{path}/meta
// ---------------------------------------------------------------------------

describe('[AC-S11493d-1-1] GET /api/notes/{path}/meta', () => {
  it('ノートメタを 1 リクエストで返す — zod スキーマで検証', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = noteMetaResponseSchema.safeParse(body);
    expect(parsed.success, `zod parse error: ${JSON.stringify(parsed)}`).toBe(true);
  });

  it('path フィールドが vault 相対パスとして正規化されている', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe('notes/test-note.md');
  });

  it('headings: フェンス外の ATX 見出しを抽出する', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as {
      headings: { level: number; text: string; line: number }[];
    };
    const texts = body.headings.map((h) => h.text);
    expect(texts).toContain('Main Heading');
    expect(texts).toContain('Sub Heading');
    expect(texts).toContain('Third level heading');
    // フェンス内の見出しは除外されている
    expect(texts).not.toContain('Not a heading inside fence');
  });

  it('headings: レベルが正しい', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as {
      headings: { level: number; text: string; line: number }[];
    };
    const main = body.headings.find((h) => h.text === 'Main Heading');
    expect(main?.level).toBe(1);
    const sub = body.headings.find((h) => h.text === 'Sub Heading');
    expect(sub?.level).toBe(2);
    const third = body.headings.find((h) => h.text === 'Third level heading');
    expect(third?.level).toBe(3);
  });

  it('outgoingLinks: 存在するリンクの resolvedPath が解決される', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as {
      outgoingLinks: { target: string; resolvedPath: string | null; raw: string }[];
    };
    const alpha = body.outgoingLinks.find((l) => l.target === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha?.resolvedPath).toBe('notes/alpha.md');
  });

  it('outgoingLinks: 存在しないリンクの resolvedPath が null', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as {
      outgoingLinks: { target: string; resolvedPath: string | null; raw: string }[];
    };
    const beta = body.outgoingLinks.find((l) => l.target === 'beta');
    expect(beta).toBeDefined();
    expect(beta?.resolvedPath).toBeNull();
  });

  it('outgoingLinks: [[alpha]] の重複は 1 件にまとめられる', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as {
      outgoingLinks: { target: string; resolvedPath: string | null; raw: string }[];
    };
    const alphaLinks = body.outgoingLinks.filter((l) => l.target === 'alpha');
    expect(alphaLinks).toHaveLength(1);
  });

  it('outgoingLinks: フェンス内のリンクが除外される', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as {
      outgoingLinks: { target: string; resolvedPath: string | null; raw: string }[];
    };
    const fenceLink = body.outgoingLinks.find((l) => l.target === 'link-in-fence');
    expect(fenceLink).toBeUndefined();
  });

  it('outgoingLinks: raw に元のリンクテキストが含まれる', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as {
      outgoingLinks: { target: string; resolvedPath: string | null; raw: string }[];
    };
    const beta = body.outgoingLinks.find((l) => l.target === 'beta');
    expect(beta?.raw).toBe('[[beta#section|別名]]');
  });

  it('tags: frontmatter tags + inline #tag の統合', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as { tags: string[] };
    // frontmatter tags: [dev, api]
    expect(body.tags).toContain('dev');
    expect(body.tags).toContain('api');
    // inline #inline-tag
    expect(body.tags).toContain('inline-tag');
  });

  it('frontmatter が返される', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as {
      frontmatter: Record<string, unknown> | null;
    };
    expect(body.frontmatter).not.toBeNull();
    expect(body.frontmatter?.['status']).toBe('draft');
  });

  it('mtime は正の整数', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as { mtime: number };
    expect(typeof body.mtime).toBe('number');
    expect(body.mtime).toBeGreaterThan(0);
    expect(Number.isInteger(body.mtime)).toBe(true);
  });

  it('wordCount / charCount が正の数値で返される', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`);
    const body = (await res.json()) as { wordCount: number; charCount: number };
    expect(body.wordCount).toBeGreaterThan(0);
    expect(body.charCount).toBeGreaterThan(0);
  });

  it('wordCount はフェンス内のコードを除外した値になる', async () => {
    // フェンス内のコードを含む版と含まない版で比較する
    const vault2 = await makeTempVault();
    const withFence = 'hello world\n```\nalpha beta gamma delta epsilon zeta\n```\nend';
    const noFence = 'hello world\nend';
    await writeFile(path.join(vault2, 'with-fence.md'), withFence, 'utf8');
    await writeFile(path.join(vault2, 'no-fence.md'), noFence, 'utf8');
    const server2 = await startServer({ vault: vault2 });
    try {
      const r1 = await fetch(`${server2.baseUrl}/api/notes/with-fence.md/meta`);
      const r2 = await fetch(`${server2.baseUrl}/api/notes/no-fence.md/meta`);
      const b1 = (await r1.json()) as { wordCount: number };
      const b2 = (await r2.json()) as { wordCount: number };
      // フェンス内のワードが除外されれば wordCount が等しくなる
      expect(b1.wordCount).toBe(b2.wordCount);
    } finally {
      await server2.stop();
      await cleanupVault(vault2);
    }
  });

  it('存在しないノートは 404 を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/nonexistent/path.md/meta`);
    expect(res.status).toBe(404);
  });

  it('パストラバーサルは 400 を返す', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/notes/${encodeURIComponent('../escape.md')}/meta`,
    );
    expect(res.status).toBe(400);
  });

  it('.md 拡張子なしのパスも正規化されて動く', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/test-note/meta`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe('notes/test-note.md');
  });
});

// ---------------------------------------------------------------------------
// [AC-S11493d-1-2] CLI `loamium note-meta <path>`
// ---------------------------------------------------------------------------

describe('[AC-S11493d-1-2] CLI loamium note-meta <path>', () => {
  it('成功時 exit 0 で stdout に情報が出力される', async () => {
    const result = await cli(['note-meta', 'notes/test-note.md']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('notes/test-note.md');
  });

  it('--json オプションで生 JSON が出力される', async () => {
    const result = await cli(['note-meta', '--json', 'notes/test-note.md']);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as unknown;
    const parsed = noteMetaResponseSchema.safeParse(body);
    expect(parsed.success, `zod parse error: ${JSON.stringify(parsed)}`).toBe(true);
  });

  it('--json の出力が REST API レスポンスと同一内容 (REST/CLI 1:1)', async () => {
    const [cliResult, httpRes] = await Promise.all([
      cli(['note-meta', '--json', 'notes/test-note.md']),
      fetch(`${server.baseUrl}/api/notes/notes/test-note.md/meta`),
    ]);
    expect(cliResult.code).toBe(0);
    expect(httpRes.status).toBe(200);

    const cliBody = JSON.parse(cliResult.stdout) as unknown;
    const httpBody = (await httpRes.json()) as unknown;

    const cliParsed = noteMetaResponseSchema.safeParse(cliBody);
    const httpParsed = noteMetaResponseSchema.safeParse(httpBody);
    expect(cliParsed.success).toBe(true);
    expect(httpParsed.success).toBe(true);

    // 主要フィールドが一致する (mtime は同一リクエストで差が出る可能性があるため除外)
    if (cliParsed.success && httpParsed.success) {
      expect(cliParsed.data.path).toBe(httpParsed.data.path);
      expect(cliParsed.data.headings).toEqual(httpParsed.data.headings);
      expect(cliParsed.data.tags.sort()).toEqual(httpParsed.data.tags.sort());
      expect(cliParsed.data.wordCount).toBe(httpParsed.data.wordCount);
      expect(cliParsed.data.charCount).toBe(httpParsed.data.charCount);
    }
  });

  it('human-readable 出力に見出し情報が含まれる', async () => {
    const result = await cli(['note-meta', 'notes/test-note.md']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('# Main Heading');
    expect(result.stdout).toContain('## Sub Heading');
  });

  it('human-readable 出力に tags が含まれる', async () => {
    const result = await cli(['note-meta', 'notes/test-note.md']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('dev');
    expect(result.stdout).toContain('api');
  });

  it('human-readable 出力にリンク情報が含まれる', async () => {
    const result = await cli(['note-meta', 'notes/test-note.md']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('alpha');
    expect(result.stdout).toContain('notes/alpha.md');
  });

  it('存在しないノートは exit 1 で stderr にエラー JSON が出る', async () => {
    const result = await cli(['note-meta', 'nonexistent.md']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBeTruthy();
    const err = JSON.parse(result.stderr.trim()) as { error: string; message: string };
    expect(err.error).toBe('not_found');
  });

  it('引数なしは exit 2 でエラー (使い方エラー)', async () => {
    const result = await cli(['note-meta']);
    expect(result.code).toBe(2);
  });
});
