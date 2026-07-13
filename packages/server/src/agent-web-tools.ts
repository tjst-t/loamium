/**
 * Loamium エージェント用 Web ツール群 (S5e0206 / ADR-0017)。
 *
 * ADR-0017 契約:
 * - web は ADR-0015 の独立ケーパビリティで **既定 off**。effectiveCaps に `web` が
 *   含まれるときだけ web_fetch / web_search を生成する (含まれなければ空配列 =
 *   LLM に広告されない、AC-S5e0206-1-1)。
 * - すべての Web アクセスは監査ログに **URL / クエリを記録** する (op: agent.web_fetch /
 *   agent.web_search)。**取得内容 (レスポンス本文) は監査に記録しない** (AC-S5e0206-1-3)。
 * - web_fetch は http/https の公開 URL のみ取得する (SSRF 防止、AC-S5e0206-1-2)。
 *   スキーム制限・localhost・プライベート/ループバック/リンクローカル IP は web-guard で拒否。
 * - web と privacy (ADR-0018 機密領域) は独立軸。web ツールは vault を読まないため
 *   privacy deny には関与しない (機密領域は read 系ツールで従来どおり常に非開示)。
 *
 * 全ツール共通制約 (read/write ツールと同じ規約):
 * - execute() は throw せず、エラー時は content テキストで返す。
 * - Web アクセス後に writeAuditEntry(config, ...) を直接呼ぶ (HTTP を通らないため)。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AgentConfig, Capability } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import { writeAuditEntry } from './audit.js';
import { isPublicHttpUrl } from './web-guard.js';
import { builtinWebSearch } from './web-search-provider.js';

// ---- 型エイリアス --------------------------------------------------------------

type ToolDetails = { error?: boolean; url?: string; query?: string; bytes?: number };

type ToolResult = { content: { type: 'text'; text: string }[]; details: ToolDetails };

function textResult(text: string, details: ToolDetails = {}): ToolResult {
  return { content: [{ type: 'text' as const, text }], details };
}

// ---- 既定値 --------------------------------------------------------------------

/** web_fetch のレスポンス読み取り上限 (バイト)。既定 1MiB。 */
const DEFAULT_MAX_FETCH_BYTES = 1024 * 1024;
/** web_fetch / web_search のタイムアウト (ミリ秒)。 */
const FETCH_TIMEOUT_MS = 15_000;
/** web_search 結果の整形で拾う最大件数。 */
const MAX_SEARCH_RESULTS = 10;

export interface WebToolsOptions {
  /** テスト時に注入する fetch 実装。既定は global fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * true のときのみ web_fetch がプライベート/ループバック URL を許可する
   * (ローカル HTTP サーバを立てる実 fetch テスト用)。本番は必ず false。
   */
  allowPrivate?: boolean;
  /** web_fetch のサイズ上限 (バイト)。既定 1MiB。 */
  maxFetchBytes?: number;
}

// ---- 監査 ----------------------------------------------------------------------

/**
 * Web アクセスを監査ログへ 1 エントリ記録する。
 * path フィールドに URL / クエリ (アクセス対象) を入れる。**取得内容は入れない**。
 */
async function auditWeb(
  config: ServerConfig,
  op: 'agent.web_fetch' | 'agent.web_search',
  target: string,
  ok: boolean,
): Promise<void> {
  await writeAuditEntry(config, {
    ts: new Date().toISOString(),
    op,
    path: target,
    mode: config.mode,
    result: ok ? 'ok' : 'error',
    status: ok ? 200 : 0,
  });
}

// ---- HTML → テキスト簡易抽出 ---------------------------------------------------

/**
 * HTML から簡易にテキストを抽出する (タグ除去程度)。厳密な DOM 解析はしない。
 * - script / style ブロックを丸ごと除去。
 * - タグを空白へ置換し、HTML エンティティを最小限復元、空白を圧縮する。
 */
function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
  const decoded = withoutTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return decoded.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** Response body を上限バイトまで読む (超過分は打ち切り、超過フラグを返す)。 */
async function readTextCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    const buf = Buffer.from(text, 'utf8');
    if (buf.byteLength <= maxBytes) return { text, bytes: buf.byteLength, truncated: false };
    return { text: buf.subarray(0, maxBytes).toString('utf8'), bytes: maxBytes, truncated: true };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      const keep = value.byteLength - (total - maxBytes);
      chunks.push(value.subarray(0, keep));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: merged.toString('utf8'), bytes: merged.byteLength, truncated };
}

// ---- ツールファクトリ ----------------------------------------------------------

/**
 * Web ツール (web_fetch / web_search) を生成する (ADR-0017)。
 * caps に `web` が含まれないとき空配列を返す (広告されない、AC-S5e0206-1-1)。
 *
 * @param serverConfig ServerConfig (mode / vaultRoot)。監査に渡す。
 * @param config       AgentConfig。webSearch 設定を参照する。
 * @param caps         実効ケーパビリティ (ADR-0015)。
 * @param opts         fetch 注入 / allowPrivate / サイズ上限 (テスト用)。
 */
export function createVaultWebTools(
  serverConfig: ServerConfig,
  config: AgentConfig,
  caps: readonly Capability[],
  opts: WebToolsOptions = {},
): ReturnType<typeof defineTool>[] {
  if (!caps.includes('web')) return [];

  const fetchImpl = opts.fetchImpl ?? fetch;
  const allowPrivate = opts.allowPrivate ?? false;
  const maxFetchBytes = opts.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES;

  const tools: ReturnType<typeof defineTool>[] = [];

  // ---- web_fetch --------------------------------------------------------------

  tools.push(
    defineTool({
      name: 'web_fetch',
      label: 'Web 取得',
      description:
        '公開 Web ページ (http/https) を取得しテキストを返す。HTML は簡易にテキスト抽出する。' +
        'localhost / プライベート IP など内部アドレスは取得できない。取得できるのは公開 URL のみ。',
      parameters: Type.Object({
        url: Type.String({ description: '取得する http/https の公開 URL' }),
      }),
      async execute(_id, params): Promise<ToolResult> {
        const guard = isPublicHttpUrl(params.url);
        // allowPrivate=true (テストのみ) のときは http/https スキームだけ確認し、
        // プライベート/ループバック拒否を無効化する。本番既定 (false) では guard 通過必須。
        if (!guard.ok) {
          if (!(allowPrivate && isHttpScheme(params.url))) {
            // 取得を試みないケースでも「アクセスしようとした URL」を監査に残す。
            await auditWeb(serverConfig, 'agent.web_fetch', params.url, false);
            return textResult(`取得できません: ${guard.reason}`, { error: true, url: params.url });
          }
        }
        const targetUrl = guard.ok ? guard.url.toString() : params.url;

        let text: string;
        let bytes: number;
        let truncated: boolean;
        let ok = false;
        try {
          const res = await fetchImpl(targetUrl, {
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { accept: 'text/html,text/plain,*/*' },
          });
          if (!res.ok) {
            await auditWeb(serverConfig, 'agent.web_fetch', targetUrl, false);
            return textResult(`取得に失敗しました (HTTP ${String(res.status)}): ${targetUrl}`, {
              error: true,
              url: targetUrl,
            });
          }
          const capped = await readTextCapped(res, maxFetchBytes);
          bytes = capped.bytes;
          truncated = capped.truncated;
          const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
          text = contentType.includes('html') ? htmlToText(capped.text) : capped.text;
          ok = true;
        } catch (err) {
          await auditWeb(serverConfig, 'agent.web_fetch', targetUrl, false);
          return textResult(`取得エラー: ${String(err)}`, { error: true, url: targetUrl });
        }

        // 成否に関わらず URL を監査記録 (取得本文は記録しない)。
        await auditWeb(serverConfig, 'agent.web_fetch', targetUrl, ok);
        const note = truncated ? `\n\n(サイズ上限 ${String(maxFetchBytes)} バイトで打ち切り)` : '';
        return textResult(`${targetUrl}:\n\n${text}${note}`, {
          url: targetUrl,
          bytes,
        });
      },
    }),
  );

  // ---- web_search -------------------------------------------------------------

  tools.push(
    defineTool({
      name: 'web_search',
      label: 'Web 検索',
      description:
        'Web を検索し結果 (タイトル・URL・スニペット) を返す。検索プロバイダは agent.json の ' +
        'webSearch で設定できる。未設定の場合は組み込みの DuckDuckGo lite ' +
        '(失敗時は Wikipedia) を既定プロバイダとして使う。',
      parameters: Type.Object({
        query: Type.String({ description: '検索クエリ文字列' }),
      }),
      async execute(_id, params): Promise<ToolResult> {
        const webSearch = config.webSearch;

        // webSearch 未設定 → 組み込み既定プロバイダ (DuckDuckGo lite → Wikipedia)。
        // クエリは監査に記録するが、取得結果本文は記録しない (ADR-0017)。
        if (!webSearch) {
          let hits;
          try {
            hits = await builtinWebSearch(params.query, fetchImpl);
          } catch (err) {
            await auditWeb(serverConfig, 'agent.web_search', params.query, false);
            return textResult(`Web 検索エラー: ${String(err)}`, {
              error: true,
              query: params.query,
            });
          }
          await auditWeb(serverConfig, 'agent.web_search', params.query, true);
          const rendered = renderSearchResults({ results: hits });
          return textResult(`"${params.query}" の検索結果:\n\n${rendered}`, {
            query: params.query,
          });
        }

        let endpoint: URL;
        try {
          endpoint = new URL(webSearch.endpoint);
          endpoint.searchParams.set('q', params.query);
        } catch {
          await auditWeb(serverConfig, 'agent.web_search', params.query, false);
          return textResult(`Web 検索エンドポイントが不正です: ${webSearch.endpoint}`, {
            error: true,
            query: params.query,
          });
        }

        const headers: Record<string, string> = { accept: 'application/json' };
        if (webSearch.apiKey) headers.authorization = `Bearer ${webSearch.apiKey}`;

        let ok = false;
        let rendered: string;
        try {
          const res = await fetchImpl(endpoint.toString(), {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers,
          });
          if (!res.ok) {
            await auditWeb(serverConfig, 'agent.web_search', params.query, false);
            return textResult(`Web 検索に失敗しました (HTTP ${String(res.status)})`, {
              error: true,
              query: params.query,
            });
          }
          const json: unknown = await res.json();
          rendered = renderSearchResults(json);
          ok = true;
        } catch (err) {
          await auditWeb(serverConfig, 'agent.web_search', params.query, false);
          return textResult(`Web 検索エラー: ${String(err)}`, { error: true, query: params.query });
        }

        // クエリを監査記録 (取得結果は記録しない)。
        await auditWeb(serverConfig, 'agent.web_search', params.query, ok);
        return textResult(`"${params.query}" の検索結果:\n\n${rendered}`, { query: params.query });
      },
    }),
  );

  return tools;
}

/** allowPrivate バイパス用: 生 URL が http/https スキームか (プライベート判定は無視)。 */
function isHttpScheme(rawUrl: string): boolean {
  try {
    const p = new URL(rawUrl).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/**
 * 検索プロバイダの JSON レスポンスを人間可読な行へ整形する。
 * 一般的な形状 `{ results: [{ title, url, snippet }] }` を最優先で拾い、
 * それ以外は JSON をそのまま文字列化して返す (プロバイダ差異に頑健)。
 */
function renderSearchResults(json: unknown): string {
  if (typeof json === 'object' && json !== null && 'results' in json) {
    const results = (json as { results: unknown }).results;
    if (Array.isArray(results)) {
      if (results.length === 0) return '(該当なし)';
      const lines = results.slice(0, MAX_SEARCH_RESULTS).map((r, i) => {
        const item = typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : {};
        const title = typeof item.title === 'string' ? item.title : '(no title)';
        const url = typeof item.url === 'string' ? item.url : '';
        const snippet = typeof item.snippet === 'string' ? item.snippet : '';
        const head = url ? `${title} — ${url}` : title;
        return snippet ? `${String(i + 1)}. ${head}\n   ${snippet}` : `${String(i + 1)}. ${head}`;
      });
      return lines.join('\n');
    }
  }
  return JSON.stringify(json);
}

/** Web ツール名の固定セット (ADR-0015 deriveToolNames の web マッピングと一致)。sorted。 */
export const VAULT_WEB_TOOL_NAMES = ['web_fetch', 'web_search'] as const;
