/**
 * 汎用テンプレートエンドポイント (S89a350-2, Sa10026-2-2)。
 *
 * POST-Sa10026-2 正本: system/templates/*.md (ADR-0010 amendment)
 *
 * - GET  /api/templates                       vault 内可視テンプレート一覧
 *                                              (system/templates/ を優先、fallback: templates/)
 * - POST /api/templates/{name}/instantiate     target/本文を解決して新規ノート作成
 *
 * テンプレートの正本は system/templates/ 配下のピュア Markdown。設定はフロントマターの
 * 単一キー `loamium-template`(target: 保存先パターン / vars: 変数定義 / description)。
 * loamium-template 以外のフロントマター + 本文が結果ノートのテンプレート本体になり、
 * instantiate 時に loamium-template ブロックを除去してから変数解決する。
 * 結果ノートはピュア Markdown(テンプレート記法は一切残らない — DESIGN_PRINCIPLES priority 1)。
 *
 * 後方互換:
 *   - system/templates/ にないテンプレートは templates/ からフォールバック読み込み。
 *   - instantiate の name は system/templates/{name}.md → templates/{name}.md の順に探す。
 *
 * 壊れた loamium-template(型不一致)はクラッシュせず純粋雛形(target なし)へフォールバック。
 * 変数値のパスサニタイズ + normalizeVaultPath 通過は shared のエンジンが担う(priority 2)。
 */
import { Hono } from 'hono';
import {
  templateInstantiateRequestSchema,
  VaultPathError,
  type TemplateInstantiateResponse,
  type TemplateMissingVarsResponse,
  type TemplatesResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import type { VaultIndex } from '../noteIndex.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import {
  instantiateTemplate,
  listTemplates,
  resolveTemplatePath,
} from '../templates-service.js';

const INSTANTIATE_PREFIX = '/api/templates/';

/** URL パスから {name} を取り出す。 */
function nameFromInstantiatePath(rawPath: string): string {
  const rest = rawPath.slice(INSTANTIATE_PREFIX.length);
  const suffix = '/instantiate';
  if (!rest.endsWith(suffix)) {
    throw new VaultPathError('POST /api/templates/{name}/instantiate のみサポートしています');
  }
  const encodedName = rest.slice(0, rest.length - suffix.length);
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new VaultPathError('template name is not valid percent-encoding');
  }
  if (name === '') throw new VaultPathError('template name is missing');
  return name;
}

export function templatesRoutes(config: ServerConfig, index?: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/templates', async (c) => {
    // GET /api/templates と同一の列挙は templates-service.listTemplates に集約 (ADR-0016)。
    const templates = await listTemplates(config.vaultRoot);
    const res: TemplatesResponse = { templates };
    return c.json(res);
  });

  app.post('/api/templates/*', async (c) => {
    let name: string;
    try {
      name = nameFromInstantiatePath(c.req.path);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }

    // 元の REST 挙動順を保つため、テンプレート未検出 (404) を body parse より先に判定する。
    const found = await resolveTemplatePath(config.vaultRoot, name);
    if (found === null) {
      return errorJson(c, 404, 'template_not_found', `template not found: ${name}`);
    }

    const body = await parseBody(c, templateInstantiateRequestSchema);
    if (!body.ok) return body.response;

    // 解決エンジンは templates-service.instantiateTemplate に集約 (ADR-0016)。
    // agent ツールと REST が同一エンジンを共有し、各バリアントを従来と同一の
    // HTTP レスポンスへマップする (挙動不変)。
    // ADR-0031: VaultIndex を渡すことで select+optionsQuery の厳格 select 検証を有効化。
    const outcome = await instantiateTemplate(
      config,
      name,
      body.data.vars,
      body.data.date,
      undefined,
      index,
    );

    switch (outcome.status) {
      case 'invalid_date':
        return errorJson(c, 400, 'invalid_date', outcome.message);
      case 'not_found':
        return errorJson(c, 404, 'template_not_found', outcome.message);
      case 'missing_vars': {
        const res: TemplateMissingVarsResponse = {
          error: 'missing_vars',
          message: `missing required variables: ${outcome.missing.join(', ')}`,
          missing: outcome.missing,
        };
        return c.json(res, 400);
      }
      case 'invalid_target':
        return errorJson(c, 400, 'invalid_target', outcome.message);
      case 'denied':
        // ADR-0018 の deny は agent 経路のみ (isDenied を渡した場合) に発生する。
        // REST は isDenied を渡さないため到達不能。exhaustiveness のための防御分岐。
        return errorJson(c, 403, 'forbidden', outcome.message);
      case 'invalid_select_value':
        // ADR-0031: select+optionsQuery の候補外の値 (422 Unprocessable Entity)。
        return errorJson(c, 422, 'invalid_select_value', outcome.message);
      case 'ok': {
        setAudit(c, 'template.instantiate', outcome.path);
        const res: TemplateInstantiateResponse = { path: outcome.path, created: true };
        return c.json(res, 201);
      }
    }
  });

  return app;
}
