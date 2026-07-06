/**
 * 意味型スキーマ配信・永続化 (GET/PUT /api/property-types — S87f4b7-2 / Sd13ab1-2)。
 *
 * GET: `.loamium/property-types.json`(キー → 型定義)の生 JSON をそのまま返す
 *   (無ければ {})。読み取り専用 (permissions で GET = read 分類 — 全モードで許可)。
 *   ユーザーの JSON を検証・拒否しない: 壊れた JSON でもサーバーは 200 で {} を返し、
 *   UI 側 (parsePropertyTypesJson) が zod で検証してヒューリスティックへフォールバック
 *   する (AC-S87f4b7-2-3)。.loamium は使い捨て資源であり正本ではない (priority 6)。
 *
 * PUT: 新規プロパティ作成時に選んだ汎用型を 1 キー分だけマージ書き込みする
 *   (D方式の横断固定 — 以後そのキーは全ファイルで同じ型に解決)。書き込み系なので
 *   permissions で mutate 分類 (read-only / append-only は 403)・監査ログに記録。
 *   型情報は .loamium/ にのみ書き、ノート本文 (.md) には一切書かない (ピュア Markdown)。
 */
import { Hono } from 'hono';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  propertyTypeWriteRequestSchema,
  type PropertyTypesResponse,
  type PropertyTypeWriteResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { parseBody, setAudit, type AppEnv } from '../http.js';

/** 既存 property-types.json を読む (壊れ/未作成はオブジェクトへフォールバック)。 */
async function readTypes(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 未作成 (ENOENT) / 壊れた JSON はどちらも「型定義なし」として扱う
  }
  return {};
}

export function propertyTypesRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const file = path.join(config.vaultRoot, '.loamium', 'property-types.json');

  app.get('/api/property-types', async (c) => {
    const res: PropertyTypesResponse = { types: await readTypes(file) };
    return c.json(res);
  });

  app.put('/api/property-types', async (c) => {
    setAudit(c, 'property-types.write', '.loamium/property-types.json');
    const body = await parseBody(c, propertyTypeWriteRequestSchema);
    if (!body.ok) return body.response;

    // 既存を読み、1 キー分だけマージ (他キーの型定義は保持する)。
    const types = await readTypes(file);
    const def: { type: string; options?: unknown } = { type: body.data.def.type };
    if (body.data.def.options !== undefined) def.options = body.data.def.options;
    types[body.data.key] = def;

    // .loamium は使い捨て資源 (priority 6)。整形して人が読める JSON にする。
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(types, null, 2)}\n`, 'utf8');

    const res: PropertyTypeWriteResponse = { key: body.data.key, types };
    return c.json(res);
  });

  return app;
}
