/**
 * 意味型スキーマ配信 (GET /api/property-types — S87f4b7-2)。
 *
 * `.loamium/property-types.json`(キー → 型定義)の生 JSON をそのまま返す
 * (無ければ {})。読み取り専用 (permissions で GET = read 分類 — 全モードで許可)。
 *
 * ユーザーの JSON を検証・拒否しない: 壊れた JSON でもサーバーは 200 で {} を返し、
 * UI 側 (parsePropertyTypesJson) が zod で検証してヒューリスティックへフォールバック
 * する (AC-S87f4b7-2-3)。.loamium は使い捨て資源であり正本ではない (priority 6)。
 */
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PropertyTypesResponse } from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import type { AppEnv } from '../http.js';

export function propertyTypesRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/property-types', async (c) => {
    const file = path.join(config.vaultRoot, '.loamium', 'property-types.json');
    let types: unknown = {};
    try {
      const text = await readFile(file, 'utf8');
      types = JSON.parse(text);
    } catch {
      // 未作成 (ENOENT) / 壊れた JSON はどちらも「型定義なし」として {} を返す
      types = {};
    }
    const res: PropertyTypesResponse = { types };
    return c.json(res);
  });

  return app;
}
