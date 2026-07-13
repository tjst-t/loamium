/**
 * 組み込み既定 Web 検索プロバイダのユニットテスト (S5e0206 / ADR-0017)。
 *
 * [AC-S5e0206-1-2] webSearch 未設定時の既定プロバイダ:
 *   parseDuckDuckGoLite が DDG lite HTML (uddg リダイレクト付き・属性順違い) から
 *   title / 実 URL (デコード済み) / snippet を抽出する。parseWikipedia が全文検索
 *   JSON から title / URL / snippet を抽出し、壊れ形状は空配列。builtinWebSearch は
 *   DDG を優先し、0 件なら Wikipedia にフォールバックする。
 */
import { describe, expect, it } from 'vitest';
import {
  builtinWebSearch,
  parseDuckDuckGoLite,
  parseWikipedia,
} from './web-search-provider.js';

// ---- フィクスチャ --------------------------------------------------------------

/** DDG lite の実物風 HTML。result-link + result-snippet を複数、uddg リダイレクト付き。 */
const DDG_HTML = `
<html><body><table>
  <tr>
    <td>
      <a rel="nofollow" class="result-link"
         href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Title A &amp; Co</a>
    </td>
  </tr>
  <tr><td class="result-snippet">Snippet A about <b>things</b></td></tr>
  <tr>
    <td>
      <!-- 属性順違い: class が href より前 -->
      <a class="result-link" rel="nofollow"
         href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb&amp;rut=def">Title B</a>
    </td>
  </tr>
  <tr><td class="result-snippet">Snippet B</td></tr>
</table></body></html>
`;

/** Wikipedia 全文検索 API の JSON フィクスチャ。 */
const WIKI_JSON = {
  batchcomplete: '',
  query: {
    search: [
      { title: 'Markdown', snippet: 'a <span class="searchmatch">lightweight</span> markup language' },
      { title: 'Plain text', snippet: 'text without formatting' },
    ],
  },
};

/** 指定した status / body を返す fetch 応答を作る。 */
function makeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  } as unknown as Response;
}

// ---- parseDuckDuckGoLite -------------------------------------------------------

describe('[AC-S5e0206-1-2] parseDuckDuckGoLite', () => {
  it('title / デコード済み URL / snippet を出現順に抽出する', () => {
    const hits = parseDuckDuckGoLite(DDG_HTML);
    expect(hits).toEqual([
      { title: 'Title A & Co', url: 'https://example.com/a?x=1', snippet: 'Snippet A about things' },
      { title: 'Title B', url: 'https://example.org/b', snippet: 'Snippet B' },
    ]);
  });

  it('属性順 (class が href の前) に依存しない', () => {
    const html =
      '<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fz.example%2Fp">Z</a>';
    const hits = parseDuckDuckGoLite(html);
    expect(hits).toEqual([{ title: 'Z', url: 'https://z.example/p', snippet: '' }]);
  });

  it('uddg なしの // 始まり href は https: を補う', () => {
    const html = '<a class="result-link" href="//plain.example/q">Plain</a>';
    const hits = parseDuckDuckGoLite(html);
    expect(hits[0]?.url).toBe('https://plain.example/q');
  });

  it('result-link が無い HTML は空配列', () => {
    expect(parseDuckDuckGoLite('<html><body>no results</body></html>')).toEqual([]);
  });

  it('最大 10 件に制限する', () => {
    const one =
      '<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fe.example%2Fx">T</a>';
    const html = one.repeat(15);
    expect(parseDuckDuckGoLite(html)).toHaveLength(10);
  });
});

// ---- parseWikipedia ------------------------------------------------------------

describe('[AC-S5e0206-1-2] parseWikipedia', () => {
  it('title / wiki URL / タグ除去済み snippet を抽出する', () => {
    const hits = parseWikipedia(WIKI_JSON);
    expect(hits).toEqual([
      {
        title: 'Markdown',
        url: 'https://en.wikipedia.org/wiki/Markdown',
        snippet: 'a lightweight markup language',
      },
      {
        title: 'Plain text',
        url: 'https://en.wikipedia.org/wiki/Plain_text',
        snippet: 'text without formatting',
      },
    ]);
  });

  it('壊れ形状 (query/search 欠落・非配列・非オブジェクト) は空配列', () => {
    expect(parseWikipedia(null)).toEqual([]);
    expect(parseWikipedia({})).toEqual([]);
    expect(parseWikipedia({ query: {} })).toEqual([]);
    expect(parseWikipedia({ query: { search: 'nope' } })).toEqual([]);
    expect(parseWikipedia('string')).toEqual([]);
  });
});

// ---- builtinWebSearch ----------------------------------------------------------

describe('[AC-S5e0206-1-2] builtinWebSearch', () => {
  it('DDG が結果を返すとき DDG の結果を使う (Wikipedia は叩かない)', async () => {
    const calls: string[] = [];
    const fetchImpl = ((url: string): Promise<Response> => {
      calls.push(String(url));
      return Promise.resolve(makeResponse(DDG_HTML));
    }) as unknown as typeof fetch;

    const hits = await builtinWebSearch('markdown', fetchImpl);
    expect(hits[0]?.title).toBe('Title A & Co');
    expect(hits[0]?.url).toBe('https://example.com/a?x=1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('lite.duckduckgo.com');
  });

  it('DDG が空 → Wikipedia にフォールバックする', async () => {
    const calls: string[] = [];
    const fetchImpl = ((url: string): Promise<Response> => {
      const u = String(url);
      calls.push(u);
      if (u.includes('duckduckgo')) {
        return Promise.resolve(makeResponse('<html>no results</html>'));
      }
      return Promise.resolve(makeResponse(JSON.stringify(WIKI_JSON)));
    }) as unknown as typeof fetch;

    const hits = await builtinWebSearch('markdown', fetchImpl);
    expect(hits[0]?.title).toBe('Markdown');
    expect(hits[0]?.url).toBe('https://en.wikipedia.org/wiki/Markdown');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('en.wikipedia.org/w/api.php');
  });

  it('DDG が非 2xx で失敗 → Wikipedia にフォールバックする', async () => {
    const fetchImpl = ((url: string): Promise<Response> => {
      if (String(url).includes('duckduckgo')) {
        return Promise.resolve(makeResponse('err', false, 503));
      }
      return Promise.resolve(makeResponse(JSON.stringify(WIKI_JSON)));
    }) as unknown as typeof fetch;

    const hits = await builtinWebSearch('markdown', fetchImpl);
    expect(hits[0]?.title).toBe('Markdown');
  });

  it('両方失敗なら空配列を返す', async () => {
    const fetchImpl = (() =>
      Promise.resolve(makeResponse('err', false, 500))) as unknown as typeof fetch;
    const hits = await builtinWebSearch('markdown', fetchImpl);
    expect(hits).toEqual([]);
  });
});
