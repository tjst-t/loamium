/**
 * 組み込み既定 Web 検索プロバイダ (S5e0206 / ADR-0017)。
 *
 * agent.json の `webSearch` が未設定のとき、web_search ツールが既定で使うプロバイダ。
 * API キー不要の keyless バックエンド (DuckDuckGo lite の HTML スクレイピング → 失敗時
 * Wikipedia 全文検索) を叩き、`SearchHit[]` に整形して返す。
 *
 * ADR-0017 契約: 検索プロバイダの実体は sprint ローカル判断。web ケーパビリティの
 * opt-in 性 (既定 off) と監査 (クエリ記録・本文非記録) は呼び出し側 (agent-web-tools.ts)
 * が維持する。この層は純粋な取得・パースのみを担う。
 *
 * 注意: プロバイダのスクレイピングは壊れやすい。実運用では正式な検索 API + apiKey を
 * webSearch に設定して上書きするのが望ましい。
 */

/** 検索結果 1 件。renderSearchResults の `{ results: [...] }` 要素と互換。 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** 検索プロバイダのタイムアウト (ミリ秒)。 */
const FETCH_TIMEOUT_MS = 15_000;
/** 拾う最大件数。 */
const MAX_SEARCH_RESULTS = 10;
/** スクレイピング用 User-Agent。 */
const UA = 'Mozilla/5.0 (compatible; LoamiumWebSearch/1.0)';

// ---- HTML 簡易処理 -------------------------------------------------------------

/** HTML エンティティを最小限デコードする。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** HTML タグを除去し、エンティティ復元・空白圧縮した素のテキストにする。 */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- DuckDuckGo lite パース ----------------------------------------------------

/**
 * DuckDuckGo lite の HTML から結果を抽出する (純関数)。
 *
 * - `class="result-link"` アンカーの開始タグ全体を取り、属性順に依存せず href を抽出する。
 * - href が `//duckduckgo.com/l/?uddg=<encoded>&rut=...` のリダイレクト形式なら、
 *   uddg パラメータをデコードして実 URL を得る。`//` 始まりは https: を補う。
 * - `class="result-snippet"` セルを出現順に集め、アンカーと同じ添字でペアリングする。
 * - HTML タグ除去・エンティティ復元を通す。最大 MAX_SEARCH_RESULTS 件。
 */
export function parseDuckDuckGoLite(html: string): SearchHit[] {
  const links: { title: string; url: string }[] = [];
  // 属性順に依存しないよう、開始タグ全体 (group1) と内側テキスト (group2) を取り、
  // href は開始タグから別途抽出する。
  const linkRe = /<a\b([^>]*\bclass=["']result-link["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const startTag = m[1] ?? '';
    const inner = m[2] ?? '';
    const hrefMatch = /\bhref=["']([^"']+)["']/.exec(startTag);
    const rawHref = hrefMatch?.[1];
    if (rawHref === undefined) continue;
    let href = decodeEntities(rawHref);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    const encoded = uddg?.[1];
    if (encoded !== undefined) {
      try {
        href = decodeURIComponent(encoded);
      } catch {
        /* デコード失敗時はリダイレクト URL のまま残す */
      }
    } else if (href.startsWith('//')) {
      href = `https:${href}`;
    }
    links.push({ title: stripTags(inner), url: href });
  }

  const snippets: string[] = [];
  const snipRe = /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = snipRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1] ?? ''));
  }

  return links.slice(0, MAX_SEARCH_RESULTS).map((l, i) => ({
    title: l.title || '(no title)',
    url: l.url,
    snippet: snippets[i] ?? '',
  }));
}

// ---- Wikipedia パース ----------------------------------------------------------

/** unknown が Record<string, unknown> か判定する。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Wikipedia 全文検索 API の JSON から結果を抽出する (純関数)。
 *
 * 期待形状: `{ query: { search: [{ title, snippet, ... }] } }`。
 * - url は `https://en.wikipedia.org/wiki/<title を _ 置換・encodeURIComponent>`。
 * - snippet は HTML タグ除去 (API は `<span class="searchmatch">` を含む)。
 * - 壊れ形状 (query / search 欠落・非配列) は空配列を返す。最大 MAX_SEARCH_RESULTS 件。
 */
export function parseWikipedia(json: unknown): SearchHit[] {
  if (!isRecord(json)) return [];
  const query = json.query;
  if (!isRecord(query)) return [];
  const search = query.search;
  if (!Array.isArray(search)) return [];

  const hits: SearchHit[] = [];
  for (const entry of search) {
    if (!isRecord(entry)) continue;
    const title = typeof entry.title === 'string' ? entry.title : '';
    if (title === '') continue;
    const rawSnippet = typeof entry.snippet === 'string' ? entry.snippet : '';
    hits.push({
      title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      snippet: stripTags(rawSnippet),
    });
    if (hits.length >= MAX_SEARCH_RESULTS) break;
  }
  return hits;
}

// ---- 取得 (DDG → Wikipedia フォールバック) ------------------------------------

/** DuckDuckGo lite を叩いてパースする。失敗 (非 2xx / 例外) は空配列。 */
async function fetchDuckDuckGo(query: string, fetchImpl: typeof fetch): Promise<SearchHit[]> {
  try {
    const res = await fetchImpl(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      {
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) return [];
    const html = await res.text();
    return parseDuckDuckGoLite(html);
  } catch {
    return [];
  }
}

/** Wikipedia 全文検索を叩いてパースする。失敗は空配列。 */
async function fetchWikipedia(query: string, fetchImpl: typeof fetch): Promise<SearchHit[]> {
  try {
    const api =
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json` +
      `&srsearch=${encodeURIComponent(query)}&srlimit=${String(MAX_SEARCH_RESULTS)}`;
    const res = await fetchImpl(api, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const json: unknown = await res.json();
    return parseWikipedia(json);
  } catch {
    return [];
  }
}

/**
 * 組み込み既定プロバイダで Web 検索する。
 *
 * DuckDuckGo lite を優先し、0 件 or 失敗なら Wikipedia にフォールバックする。
 * 両方失敗 (0 件) なら空配列を返す (呼び出し側で「該当なし」メッセージ化する)。
 *
 * @param query     検索クエリ
 * @param fetchImpl 注入する fetch 実装 (テスト用。本番は global fetch)
 */
export async function builtinWebSearch(
  query: string,
  fetchImpl: typeof fetch,
): Promise<SearchHit[]> {
  const ddg = await fetchDuckDuckGo(query, fetchImpl);
  if (ddg.length > 0) return ddg;
  return fetchWikipedia(query, fetchImpl);
}
