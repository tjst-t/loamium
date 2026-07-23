/**
 * 動的選択肢解決エンドポイント (ADR-0031 / S1bd397)。
 *
 * POST /api/options-query
 *   req: { dql: string, resolvedVars?: Record<string,string>, topN?: number }
 *   res: { candidates: [{value,label}], truncated: boolean }
 *
 * エラー:
 *   400 { error: 'query_syntax', message } — DQL 構文エラー
 *   400 { error: 'list_only', message }    — LIST 以外の DQL (TABLE/TASK は v1 非対応)
 *
 * 権限: read-only でも利用可 (queryNotes はインデックス読み取りのみ)。
 * POST /api/query と同じ DQL エンジン (parseQuery/executeQuery) を再利用する (ADR-0001)。
 */
import { Hono } from 'hono';
import {
  parseQuery,
  DqlParseError,
  optionsQueryRequestSchema,
  type OptionsQueryResponse,
} from '@loamium/shared';
import { errorJson, parseBody, type AppEnv } from '../http.js';
import type { VaultIndex } from '../noteIndex.js';
import { resolveDynamicOptions } from '../options-query-resolver.js';

export function optionsQueryRoutes(index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/api/options-query', async (c) => {
    const body = await parseBody(c, optionsQueryRequestSchema);
    if (!body.ok) return body.response;

    const { dql, resolvedVars, topN } = body.data;

    // LIST のみ v1 対応。DQL type を先に確認して list_only を返す。
    let dqlType: string;
    try {
      const ast = parseQuery(dql);
      dqlType = ast.type;
    } catch (err) {
      if (err instanceof DqlParseError) {
        return errorJson(c, 400, 'query_syntax', err.message);
      }
      throw err;
    }

    if (dqlType !== 'list') {
      return errorJson(
        c,
        400,
        'list_only',
        `v1 は LIST クエリのみサポートしています (指定されたクエリは '${dqlType}' 型です)`,
      );
    }

    const opts: { topN?: number; resolvedVars?: Record<string, string> } = {};
    if (topN !== undefined) opts.topN = topN;
    if (resolvedVars !== undefined) opts.resolvedVars = resolvedVars;
    const outcome = resolveDynamicOptions(dql, index, opts);

    if (!outcome.ok) {
      if (outcome.errorCode === 'query_syntax') {
        return errorJson(c, 400, 'query_syntax', outcome.message);
      }
      if (outcome.errorCode === 'list_only') {
        return errorJson(c, 400, 'list_only', outcome.message);
      }
      // exhaustiveness
      throw new Error('unexpected errorCode');
    }

    const res: OptionsQueryResponse = {
      candidates: outcome.result.candidates,
      truncated: outcome.result.truncated,
    };
    return c.json(res);
  });

  return app;
}
