/**
 * エージェント Web ツールのユニットテスト (S5e0206 / ADR-0013)。
 *
 * [AC-S5e0206-1-1] web ケーパビリティが有効なときだけ web_fetch / web_search が生成 (広告)
 *   される。無効 (caps に web 無し) なら空配列。
 * [AC-S5e0206-1-2] web_fetch は http/https の公開 URL のみ取得する。SSRF: localhost /
 *   プライベート IP / 非 http スキームは拒否。サイズ上限で打ち切る。web_search は
 *   webSearch 未設定なら明示メッセージ (エラーにしない)、設定時は結果を整形する。
 * [AC-S5e0206-1-3] Web アクセスは audit.log に URL / クエリを記録し、取得本文は記録しない。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createVaultWebTools, VAULT_WEB_TOOL_NAMES } from './agent-web-tools.js';
import { isPublicHttpUrl } from './web-guard.js';
import type { ServerConfig } from './config.js';
import type { AgentConfig, Capability } from '@loamium/shared';

// ---- ヘルパー ------------------------------------------------------------------

const noSignal = undefined;
const noUpdate = undefined;
const fakeCtx = {} as Parameters<
  ReturnType<typeof createVaultWebTools>[number]['execute']
>[4];

type ExecResult = Awaited<ReturnType<ReturnType<typeof createVaultWebTools>[number]['execute']>>;

function textOf(result: ExecResult): string {
  const first = result.content[0];
  if (first && first.type === 'text') return first.text;
  return '';
}

function detailsOf(result: ExecResult): { error?: boolean; url?: string; query?: string } {
  const d = result.details;
  if (typeof d === 'object' && d !== null) {
    return d as { error?: boolean; url?: string; query?: string };
  }
  return {};
}

const WEB_CAPS: Capability[] = ['read', 'web'];

function makeServerConfig(vaultRoot: string): ServerConfig {
  return { vaultRoot, mode: 'full', maxUploadBytes: 1024 };
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    api: 'anthropic',
    baseUrl: 'https://example.invalid',
    model: 'test-model',
    apiKey: 'sk-test',
    ...overrides,
  };
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

/** ローカル HTTP サーバを起動し base URL を返す。 */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(addr.port)}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

// ---- isPublicHttpUrl (SSRF ガード純関数) --------------------------------------

describe('[AC-S5e0206-1-2] isPublicHttpUrl', () => {
  it('公開 http/https URL を許可する', () => {
    expect(isPublicHttpUrl('https://example.com/path').ok).toBe(true);
    expect(isPublicHttpUrl('http://example.com').ok).toBe(true);
    expect(isPublicHttpUrl('https://example.com:8443/x').ok).toBe(true);
    expect(isPublicHttpUrl('https://8.8.8.8/').ok).toBe(true);
  });

  it('大文字スキームも URL 正規化で許可される', () => {
    expect(isPublicHttpUrl('HTTPS://example.com').ok).toBe(true);
  });

  it('非 http スキームを拒否する (file/ftp/data/gopher)', () => {
    expect(isPublicHttpUrl('file:///etc/passwd').ok).toBe(false);
    expect(isPublicHttpUrl('ftp://example.com/x').ok).toBe(false);
    expect(isPublicHttpUrl('data:text/plain,hi').ok).toBe(false);
    expect(isPublicHttpUrl('gopher://example.com').ok).toBe(false);
  });

  it('localhost を拒否する', () => {
    expect(isPublicHttpUrl('http://localhost/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://localhost:3000/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://api.localhost/x').ok).toBe(false);
  });

  it('IPv4 ループバック / プライベート / リンクローカル / 0.0.0.0 を拒否する', () => {
    expect(isPublicHttpUrl('http://127.0.0.1/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://127.1.2.3/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://10.0.0.1/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://172.16.5.4/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://172.31.255.255/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://192.168.1.1/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://169.254.169.254/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://0.0.0.0/x').ok).toBe(false);
  });

  it('公開範囲の 172.x は許可する (172.15 / 172.32 はプライベート外)', () => {
    expect(isPublicHttpUrl('http://172.15.0.1/x').ok).toBe(true);
    expect(isPublicHttpUrl('http://172.32.0.1/x').ok).toBe(true);
  });

  it('IPv6 ループバック / ULA / リンクローカルを拒否する', () => {
    expect(isPublicHttpUrl('http://[::1]/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://[fc00::1]/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://[fd12:3456::1]/x').ok).toBe(false);
    expect(isPublicHttpUrl('http://[fe80::1]/x').ok).toBe(false);
  });

  it('公開 IPv6 は許可する', () => {
    expect(isPublicHttpUrl('http://[2606:4700:4700::1111]/x').ok).toBe(true);
  });

  it('壊れた URL を拒否する', () => {
    expect(isPublicHttpUrl('not a url').ok).toBe(false);
    expect(isPublicHttpUrl('://missing-scheme').ok).toBe(false);
    expect(isPublicHttpUrl('').ok).toBe(false);
  });
});

// ---- createVaultWebTools -------------------------------------------------------

describe('createVaultWebTools', () => {
  let vaultRoot: string;
  let serverConfig: ServerConfig;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agent-web-test-'));
    serverConfig = makeServerConfig(vaultRoot);
  });

  function webTool(name: string, config: AgentConfig, caps: Capability[], opts = {}) {
    const tools = createVaultWebTools(serverConfig, config, caps, opts);
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not generated: ${name}`);
    return t;
  }

  // ---- AC-S5e0206-1-1: 広告制御 ------------------------------------------------

  it('[AC-S5e0206-1-1] web が有効なとき web_fetch / web_search が生成される', () => {
    const names = createVaultWebTools(serverConfig, makeAgentConfig(), ['web'])
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([...VAULT_WEB_TOOL_NAMES].sort());
  });

  it('[AC-S5e0206-1-1] caps に web が無いと空配列 (広告されない)', () => {
    expect(createVaultWebTools(serverConfig, makeAgentConfig(), ['read'])).toHaveLength(0);
    expect(createVaultWebTools(serverConfig, makeAgentConfig(), [])).toHaveLength(0);
    expect(
      createVaultWebTools(serverConfig, makeAgentConfig(), ['note_create', 'note_edit']),
    ).toHaveLength(0);
  });

  // ---- AC-S5e0206-1-2: web_fetch 取得 -----------------------------------------

  it('[AC-S5e0206-1-2] web_fetch がローカル URL のテキストを取得する (allowPrivate)', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('hello from server');
    });
    try {
      const t = webTool('web_fetch', makeAgentConfig(), WEB_CAPS, { allowPrivate: true });
      const res = await t.execute('t1', { url: `${srv.url}/page` }, noSignal, noUpdate, fakeCtx);
      expect(detailsOf(res).error).toBeUndefined();
      expect(textOf(res)).toContain('hello from server');
    } finally {
      await srv.close();
    }
  });

  it('[AC-S5e0206-1-2] web_fetch は HTML を簡易テキスト抽出する', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><style>.x{}</style><script>var a=1;</script></head>' +
          '<body><h1>Title</h1><p>Body &amp; more</p></body></html>',
      );
    });
    try {
      const t = webTool('web_fetch', makeAgentConfig(), WEB_CAPS, { allowPrivate: true });
      const res = await t.execute('t1', { url: srv.url }, noSignal, noUpdate, fakeCtx);
      const text = textOf(res);
      expect(text).toContain('Title');
      expect(text).toContain('Body & more');
      expect(text).not.toContain('var a=1');
      expect(text).not.toContain('<h1>');
    } finally {
      await srv.close();
    }
  });

  it('[AC-S5e0206-1-2] web_fetch はサイズ上限で打ち切る', async () => {
    const big = 'x'.repeat(5000);
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(big);
    });
    try {
      const t = webTool('web_fetch', makeAgentConfig(), WEB_CAPS, {
        allowPrivate: true,
        maxFetchBytes: 100,
      });
      const res = await t.execute('t1', { url: srv.url }, noSignal, noUpdate, fakeCtx);
      const text = textOf(res);
      expect(text).toContain('打ち切り');
      // 本文全体 (5000 バイト) は含まれない — 上限で切られている。
      expect(text).not.toContain(big);
    } finally {
      await srv.close();
    }
  });

  it('[AC-S5e0206-1-2] SSRF: allowPrivate=false (本番既定) は localhost を拒否する', async () => {
    const t = webTool('web_fetch', makeAgentConfig(), WEB_CAPS);
    const res = await t.execute(
      't1',
      { url: 'http://localhost:1/secret' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toContain('取得できません');
  });

  it('[AC-S5e0206-1-2] SSRF: プライベート IP を拒否する', async () => {
    const t = webTool('web_fetch', makeAgentConfig(), WEB_CAPS);
    const res = await t.execute(
      't1',
      { url: 'http://169.254.169.254/latest/meta-data/' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
  });

  it('[AC-S5e0206-1-2] 非 http スキームを拒否する', async () => {
    const t = webTool('web_fetch', makeAgentConfig(), WEB_CAPS, { allowPrivate: true });
    const res = await t.execute(
      't1',
      { url: 'file:///etc/passwd' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toContain('取得できません');
  });

  // ---- AC-S5e0206-1-3: 監査 (本文非記録) --------------------------------------

  it('[AC-S5e0206-1-3] web_fetch は URL を audit に記録し、取得本文は記録しない', async () => {
    const secret = 'TOP-SECRET-BODY-DO-NOT-LOG';
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(secret);
    });
    try {
      const t = webTool('web_fetch', makeAgentConfig(), WEB_CAPS, { allowPrivate: true });
      const url = `${srv.url}/doc`;
      await t.execute('t1', { url }, noSignal, noUpdate, fakeCtx);

      const entries = await readAudit(vaultRoot);
      const fetchEntries = entries.filter((e) => e.op === 'agent.web_fetch');
      expect(fetchEntries.length).toBeGreaterThanOrEqual(1);
      expect(fetchEntries.some((e) => e.path === url)).toBe(true);

      // 取得本文が audit.log に一切含まれないこと。
      const raw = await readFile(path.join(vaultRoot, '.loamium', 'audit.log'), 'utf8');
      expect(raw).not.toContain(secret);
    } finally {
      await srv.close();
    }
  });

  // ---- AC-S5e0206-1-2 / 1-3: web_search ---------------------------------------

  it('[AC-S5e0206-1-2] web_search は未設定なら組み込み既定プロバイダ (DuckDuckGo lite) で結果を返す', async () => {
    // 未設定 config + fetchImpl 注入 (DDG lite の HTML フィクスチャを返す)。
    const ddgHtml =
      '<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Floamium">Loamium Home</a>' +
      '<td class="result-snippet">note app snippet</td>';
    const fetchImpl = ((): Promise<Response> =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(ddgHtml),
        json: () => Promise.resolve({}),
      } as unknown as Response)) as unknown as typeof fetch;

    const t = webTool('web_search', makeAgentConfig(), WEB_CAPS, { fetchImpl });
    const res = await t.execute('t1', { query: 'loamium' }, noSignal, noUpdate, fakeCtx);
    const text = textOf(res);
    expect(detailsOf(res).error).toBeUndefined();
    expect(text).toContain('Loamium Home');
    expect(text).toContain('https://example.com/loamium');
    expect(text).toContain('note app snippet');

    // 未設定でもクエリは監査に記録される (取得本文は記録しない)。
    const entries = await readAudit(vaultRoot);
    expect(entries.some((e) => e.op === 'agent.web_search' && e.path === 'loamium')).toBe(true);
    const raw = await readFile(path.join(vaultRoot, '.loamium', 'audit.log'), 'utf8');
    expect(raw).not.toContain('note app snippet');
  });

  it('[AC-S5e0206-1-2/1-3] web_search は設定時に結果を整形し、クエリを監査記録する', async () => {
    const srv = await startServer((req, res) => {
      // ?q=<query> を受けて JSON 結果を返す fake 検索エンドポイント。
      const u = new URL(req.url ?? '', 'http://x');
      expect(u.searchParams.get('q')).toBe('markdown notes');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            { title: 'Loamium', url: 'https://example.com/loamium', snippet: 'note app' },
            { title: 'Markdown', url: 'https://example.com/md', snippet: 'plain text' },
          ],
        }),
      );
    });
    try {
      const config = makeAgentConfig({ webSearch: { endpoint: `${srv.url}/search` } });
      const t = webTool('web_search', config, WEB_CAPS);
      const res = await t.execute(
        't1',
        { query: 'markdown notes' },
        noSignal,
        noUpdate,
        fakeCtx,
      );
      const text = textOf(res);
      expect(text).toContain('Loamium');
      expect(text).toContain('https://example.com/loamium');
      expect(text).toContain('note app');

      const entries = await readAudit(vaultRoot);
      const searchEntries = entries.filter((e) => e.op === 'agent.web_search');
      expect(searchEntries.some((e) => e.path === 'markdown notes')).toBe(true);
      // 監査に検索結果本文 (URL/タイトル) は含まれない — path はクエリのみ。
      const raw = await readFile(path.join(vaultRoot, '.loamium', 'audit.log'), 'utf8');
      expect(raw).not.toContain('note app');
    } finally {
      await srv.close();
    }
  });
});
