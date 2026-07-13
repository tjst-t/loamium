/**
 * websearch-adapter — API キー不要のローカル Web 検索アダプタ (ADR-0017 の webSearch 用)。
 *
 * Loamium の web_search ツールは `GET <endpoint>?q=<query>` を叩き、
 * `{ results: [{ title, url, snippet }] }` 形状の JSON を期待する
 * (packages/server/src/agent-web-tools.ts renderSearchResults)。
 * このアダプタは keyless の検索バックエンド (DuckDuckGo lite HTML → 失敗時 Wikipedia)
 * を叩き、その形状に整形して返す。web_search の endpoint は SSRF ガードを通らない
 * (信頼された設定値) ため 127.0.0.1 で問題ない。
 *
 * 使い方:
 *   node dev-tools/websearch-adapter.mjs          # PORT=8765 で起動
 *   PORT=9000 node dev-tools/websearch-adapter.mjs # ポート変更
 * agent.json の webSearch.endpoint に http://127.0.0.1:8765/search を設定する。
 *
 * 注意: これは開発・お試し用。プロバイダのスクレイピングは壊れやすく、
 * 過度なリクエストは避けること。実運用では正式な検索 API + apiKey を推奨。
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8765);
const MAX_RESULTS = 10;
const UA = 'Mozilla/5.0 (compatible; LoamiumWebSearchAdapter/1.0)';

/** HTML エンティティを最小限デコードする。 */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** HTML タグを除去して素のテキストにする。 */
function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * DuckDuckGo lite の HTML から結果を抽出する。
 * result-link アンカー (href=//duckduckgo.com/l/?uddg=<url>) と
 * result-snippet セルを出現順にペアリングする。
 */
async function searchDuckDuckGo(query) {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`ddg http ${res.status}`);
  const html = await res.text();

  const links = [];
  // 属性順に依存しないよう、result-link アンカーの開始タグ全体 (group1) と
  // 内側テキスト (group2) を取り、開始タグから href を別途抽出する。
  const linkRe = /<a\b([^>]*\bclass=["']result-link["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const hrefMatch = /\bhref=["']([^"']+)["']/.exec(m[1]);
    if (!hrefMatch) continue;
    let href = decodeEntities(hrefMatch[1]);
    // //duckduckgo.com/l/?uddg=<encoded>&rut=... から実 URL を取り出す
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        /* keep as-is */
      }
    } else if (href.startsWith('//')) {
      href = `https:${href}`;
    }
    links.push({ title: stripTags(m[2]), url: href });
  }

  const snippets = [];
  const snipRe = /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = snipRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]));
  }

  return links.slice(0, MAX_RESULTS).map((l, i) => ({
    title: l.title || '(no title)',
    url: l.url,
    snippet: snippets[i] ?? '',
  }));
}

/** Wikipedia 全文検索 (keyless、信頼性が高いフォールバック)。 */
async function searchWikipedia(query) {
  const api =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${String(MAX_RESULTS)}`;
  const res = await fetch(api, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`wikipedia http ${res.status}`);
  const json = await res.json();
  const hits = json?.query?.search ?? [];
  return hits.map((h) => ({
    title: h.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/ /g, '_'))}`,
    snippet: stripTags(String(h.snippet ?? '')),
  }));
}

async function doSearch(query) {
  try {
    const ddg = await searchDuckDuckGo(query);
    if (ddg.length > 0) return { source: 'duckduckgo', results: ddg };
  } catch (err) {
    console.error(`[websearch-adapter] duckduckgo failed: ${String(err)} — falling back to wikipedia`);
  }
  const wiki = await searchWikipedia(query);
  return { source: 'wikipedia', results: wiki };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(PORT)}`);
  if (url.pathname !== '/search') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', usage: 'GET /search?q=<query>' }));
    return;
  }
  const q = url.searchParams.get('q') ?? '';
  if (!q) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing q', results: [] }));
    return;
  }
  doSearch(q)
    .then(({ source, results }) => {
      console.error(`[websearch-adapter] q="${q}" source=${source} results=${String(results.length)}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results }));
    })
    .catch((err) => {
      console.error(`[websearch-adapter] error: ${String(err)}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err), results: [] }));
    });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[websearch-adapter] listening on http://127.0.0.1:${String(PORT)}/search (keyless: DuckDuckGo lite → Wikipedia)`);
});
