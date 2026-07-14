/**
 * 設定 API ルート (Sa10026-5)。
 *
 * GET  /api/settings/system                       アプリ全体設定取得 (system/settings.yaml)
 * PUT  /api/settings/system                       アプリ全体設定保存
 * GET  /api/settings/agent/connection             agent 接続設定取得 (.loamium/agent.json)
 * PUT  /api/settings/agent/connection             agent 接続設定保存
 * POST /api/settings/agent/connection/test        接続テスト (apiKey $ENV 解決、実値は返さない)
 * GET  /api/settings/agent/models                 モデル一覧取得 (失敗時 source:'fallback' で 200)
 * GET  /api/settings/agent/permissions            agent 権限・capability 取得
 * PUT  /api/settings/agent/permissions            agent 権限・capability 保存
 * GET  /api/settings/agent/privacy                privacy deny-list 取得
 * PUT  /api/settings/agent/privacy                privacy deny-list 保存
 *
 * セキュリティ:
 *   - 書き込み系 API はすべて監査ログに記録する (auditMiddleware が autonamous に動作)。
 *   - LOAMIUM_MODE read-only / append-only では書き込みを 403 で拒否する
 *     (classifyOp: settings PUT/POST は mutate 扱い → permissionMiddleware が止める)。
 *   - **agent ツールとしては公開しない** (通常の HTTP ルートのみ)。
 *     自己昇格防止の allowlist 除外は Sa10026-6 で完成。
 *   - apiKey の実値はどのレスポンスにも含めない (maskApiKey を使う)。
 *
 * [AC-Sa10026-5-1] 4 群 zod 検証付き read/write
 * [AC-Sa10026-5-2] 書き込み系 → 監査ログ + LOAMIUM_MODE クランプ
 * [AC-Sa10026-5-4] connection/test + models
 */
import { Hono } from 'hono';
import {
  appSettingsWriteRequestSchema,
  agentConnectionWriteRequestSchema,
  agentConnectionTestRequestSchema,
  agentPermissionsWriteRequestSchema,
  agentPrivacyWriteRequestSchema,
  agentPermissionsSchema,
  resolvePermissions,
  clampByMode,
  type AppSettingsResponse,
  type AgentConnectionResponse,
  type AgentPermissionsResponse,
  type AgentPrivacySettingsResponse,
  type AgentConnectionTestResponse,
  type AgentModelsResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { parseBody, setAudit, errorJson, type AppEnv } from '../http.js';
import {
  loadSettings,
  saveSettings,
  loadAgentJson,
  saveAgentConnection,
  saveAgentPermissions,
  loadAgentPrivacyDeny,
  saveAgentPrivacyDeny,
  resolveEnvRef,
  maskApiKey,
} from '../settings-store.js';

export function settingsRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ==========================================================================
  // Group 1: アプリ全体設定 (system/settings.yaml)
  // ==========================================================================

  // GET /api/settings/system
  app.get('/api/settings/system', async (c) => {
    try {
      const settings = await loadSettings(config.vaultRoot);
      const res: AppSettingsResponse = { settings };
      return c.json(res);
    } catch (err) {
      return errorJson(c, 500, 'settings_read_error', String(err));
    }
  });

  // PUT /api/settings/system
  // [AC-Sa10026-5-2] 書き込み系 → 監査ログ + mode クランプ (permissionMiddleware が mutate として止める)
  app.put('/api/settings/system', async (c) => {
    setAudit(c, 'settings.system.write', 'system/settings.yaml');
    const bodyResult = await parseBody(c, appSettingsWriteRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;

    try {
      await saveSettings(config.vaultRoot, bodyResult.data.settings);
      const res: AppSettingsResponse = { settings: bodyResult.data.settings };
      return c.json(res);
    } catch (err) {
      return errorJson(c, 500, 'settings_write_error', String(err));
    }
  });

  // ==========================================================================
  // Group 2: agent 接続設定 (.loamium/agent.json)
  // ==========================================================================

  // GET /api/settings/agent/connection
  app.get('/api/settings/agent/connection', async (c) => {
    const result = await loadAgentJson(config.vaultRoot);
    if (!result.ok) {
      if (result.reason === 'not_configured') {
        const res: AgentConnectionResponse = { connection: null };
        return c.json(res);
      }
      return errorJson(c, 500, 'agent_config_error', result.message);
    }
    const { config: cfg } = result;
    const webSearch =
      cfg.webSearch !== undefined
        ? ({
            endpoint: cfg.webSearch.endpoint,
            ...(cfg.webSearch.apiKey !== undefined
              ? { apiKeyRef: maskApiKey(cfg.webSearch.apiKey) }
              : {}),
          } as { endpoint: string; apiKeyRef?: string })
        : undefined;
    const res: AgentConnectionResponse = {
      connection: {
        api: cfg.api,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKeyRef: maskApiKey(cfg.apiKey),
        ...(webSearch !== undefined ? { webSearch } : {}),
      },
    };
    return c.json(res);
  });

  // PUT /api/settings/agent/connection
  // [AC-Sa10026-5-2] 書き込み系 → 監査ログ + mode クランプ
  app.put('/api/settings/agent/connection', async (c) => {
    setAudit(c, 'settings.agent.connection.write', '.loamium/agent.json');
    const bodyResult = await parseBody(c, agentConnectionWriteRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;

    const { api, baseUrl, model, apiKey, webSearch } = bodyResult.data;
    // exactOptionalPropertyTypes: webSearch.apiKey を条件付きで渡す
    const wsArg =
      webSearch !== undefined
        ? ({
            endpoint: webSearch.endpoint,
            ...(webSearch.apiKey !== undefined ? { apiKey: webSearch.apiKey } : {}),
          } as { endpoint: string; apiKey?: string })
        : undefined;
    try {
      await saveAgentConnection(config.vaultRoot, {
        api,
        baseUrl,
        model,
        apiKey,
        ...(wsArg !== undefined ? { webSearch: wsArg } : {}),
      });
      return c.json({ ok: true });
    } catch (err) {
      return errorJson(c, 500, 'agent_config_write_error', String(err));
    }
  });

  // ==========================================================================
  // 接続テスト: POST /api/settings/agent/connection/test
  // [AC-Sa10026-5-4]
  // ==========================================================================

  app.post('/api/settings/agent/connection/test', async (c) => {
    const bodyResult = await parseBody(c, agentConnectionTestRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;

    const req = bodyResult.data;

    // baseUrl / model / api は req から取るか、現在の agent.json から補う
    const agentResult = await loadAgentJson(config.vaultRoot);
    const baseFromConfig = agentResult.ok ? agentResult.config.baseUrl : undefined;
    const modelFromConfig = agentResult.ok ? agentResult.config.model : undefined;
    const apiFromConfig = agentResult.ok ? agentResult.config.api : undefined;
    const apiKeyRefFromConfig = agentResult.ok ? agentResult.config.apiKey : undefined;

    const baseUrl = req.baseUrl ?? baseFromConfig;
    const model = req.model ?? modelFromConfig;
    const api = req.api ?? apiFromConfig;
    const apiKeyRef = req.apiKeyRef ?? apiKeyRefFromConfig;

    if (baseUrl === undefined || model === undefined || api === undefined || apiKeyRef === undefined) {
      const res: AgentConnectionTestResponse = {
        ok: false,
        error: 'connection settings not configured; provide baseUrl, model, api, and apiKeyRef in the request or configure agent.json first',
      };
      return c.json(res);
    }

    // $ENV_VAR を解決する (実値はレスポンスに出さない)
    const resolvedApiKey = resolveEnvRef(apiKeyRef);
    if (resolvedApiKey === null) {
      const res: AgentConnectionTestResponse = {
        ok: false,
        error: `apiKey references an environment variable that is not set: ${apiKeyRef}`,
      };
      return c.json(res);
    }

    // 接続テスト: ミニマムなリクエスト (1 回だけ) を実 API へ送る
    const start = Date.now();
    try {
      const testResponse = await testApiConnection({ api, baseUrl, model, apiKey: resolvedApiKey });
      const latencyMs = Date.now() - start;
      const res: AgentConnectionTestResponse = {
        ok: true,
        model: testResponse.model ?? model,
        latencyMs,
      };
      return c.json(res);
    } catch (err) {
      const latencyMs = Date.now() - start;
      // apiKey 実値はエラーメッセージに含めない (安全側に倒す)
      const safeError = sanitizeErrorMessage(String(err), resolvedApiKey);
      const res: AgentConnectionTestResponse = {
        ok: false,
        latencyMs,
        error: safeError,
      };
      return c.json(res);
    }
  });

  // ==========================================================================
  // モデル一覧: GET /api/settings/agent/models
  // [AC-Sa10026-5-4] 取得失敗時は source:'fallback' で 200 を返す
  // ==========================================================================

  app.get('/api/settings/agent/models', async (c) => {
    const agentResult = await loadAgentJson(config.vaultRoot);
    if (!agentResult.ok) {
      // agent.json 未設定でも 200 (直接入力を妨げない)
      const res: AgentModelsResponse = {
        models: [],
        source: 'fallback',
        error: agentResult.message,
      };
      return c.json(res);
    }

    const { api, baseUrl, apiKey: apiKeyRef } = agentResult.config;
    const resolvedApiKey = resolveEnvRef(apiKeyRef);
    if (resolvedApiKey === null) {
      const res: AgentModelsResponse = {
        models: [],
        source: 'fallback',
        error: `apiKey references an environment variable that is not set: ${apiKeyRef}`,
      };
      return c.json(res);
    }

    try {
      const models = await fetchModelList({ api, baseUrl, apiKey: resolvedApiKey });
      const res: AgentModelsResponse = { models, source: 'api' };
      return c.json(res);
    } catch (err) {
      const safeError = sanitizeErrorMessage(String(err), resolvedApiKey);
      const res: AgentModelsResponse = {
        models: [],
        source: 'fallback',
        error: safeError,
      };
      return c.json(res);
    }
  });

  // ==========================================================================
  // Group 3: agent 権限 (.loamium/agent.json permissions)
  // ==========================================================================

  // GET /api/settings/agent/permissions
  app.get('/api/settings/agent/permissions', async (c) => {
    const agentResult = await loadAgentJson(config.vaultRoot);
    if (!agentResult.ok) {
      if (agentResult.reason === 'not_configured') {
        const res: AgentPermissionsResponse = { permissions: null };
        return c.json(res);
      }
      return errorJson(c, 500, 'agent_config_error', agentResult.message);
    }

    const { permissions } = agentResult.config;
    const resolved = resolvePermissions(permissions);
    const effective = clampByMode(resolved, config.mode);

    const res: AgentPermissionsResponse = {
      permissions: {
        value: permissions ?? null,
        effective,
      },
    };
    return c.json(res);
  });

  // PUT /api/settings/agent/permissions
  // [AC-Sa10026-5-2] 書き込み系 → 監査ログ + mode クランプ
  app.put('/api/settings/agent/permissions', async (c) => {
    setAudit(c, 'settings.agent.permissions.write', '.loamium/agent.json');
    const bodyResult = await parseBody(c, agentPermissionsWriteRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;

    // permissions フィールドを agentPermissionsSchema で検証する
    const parsed = agentPermissionsSchema.safeParse(bodyResult.data.permissions);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return errorJson(c, 400, 'invalid_permissions', msg);
    }

    try {
      await saveAgentPermissions(config.vaultRoot, parsed.data);
      return c.json({ ok: true });
    } catch (err) {
      return errorJson(c, 500, 'agent_permissions_write_error', String(err));
    }
  });

  // ==========================================================================
  // Group 4: privacy deny-list (.loamium/agent-privacy.json)
  // ==========================================================================

  // GET /api/settings/agent/privacy
  app.get('/api/settings/agent/privacy', async (c) => {
    try {
      const deny = await loadAgentPrivacyDeny(config.vaultRoot);
      const res: AgentPrivacySettingsResponse = { deny };
      return c.json(res);
    } catch (err) {
      return errorJson(c, 500, 'privacy_read_error', String(err));
    }
  });

  // PUT /api/settings/agent/privacy
  // [AC-Sa10026-5-2] 書き込み系 → 監査ログ + mode クランプ
  app.put('/api/settings/agent/privacy', async (c) => {
    setAudit(c, 'settings.agent.privacy.write', '.loamium/agent-privacy.json');
    const bodyResult = await parseBody(c, agentPrivacyWriteRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;

    try {
      await saveAgentPrivacyDeny(config.vaultRoot, bodyResult.data.deny);
      const res: AgentPrivacySettingsResponse = { deny: bodyResult.data.deny };
      return c.json(res);
    } catch (err) {
      return errorJson(c, 500, 'privacy_write_error', String(err));
    }
  });

  return app;
}

// ============================================================
// テスト可能な接続テスト実装
// ============================================================

interface ApiTestParams {
  api: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface ApiTestResult {
  model: string | undefined;
}

/**
 * 実 API へ最小リクエストを 1 回送り接続を確認する (AC-Sa10026-5-4)。
 * - OpenAI 互換: POST {baseUrl}/chat/completions に max_tokens:1 の最小リクエスト
 * - Anthropic: POST {baseUrl}/messages に max_tokens:1 の最小リクエスト
 *
 * 実キーはここだけで使い、レスポンスに含めない。
 * ネットワーク エラーや HTTP 非 2xx は Error を throw する。
 * テスト可能性: baseUrl に無効 URL を渡すと ok:false に、ローカル HTTP スタブを渡すと ok:true になる。
 */
export async function testApiConnection(params: ApiTestParams): Promise<ApiTestResult> {
  const { api, baseUrl, model, apiKey } = params;

  // baseUrl の末尾スラッシュを正規化
  const base = baseUrl.replace(/\/+$/, '');

  let url: string;
  let init: RequestInit;

  if (api === 'anthropic') {
    url = `${base}/messages`;
    init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      // 10 秒タイムアウト
      signal: AbortSignal.timeout(10_000),
    };
  } else {
    // openai 互換
    url = `${base}/chat/completions`;
    init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10_000),
    };
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`connection failed: ${String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  // レスポンスボディからモデル名を読む (optional)
  let returnedModel: string | undefined;
  try {
    const json = (await res.json()) as Record<string, unknown>;
    if (typeof json.model === 'string') {
      returnedModel = json.model;
    }
  } catch {
    // JSON パース失敗は無視 (モデル名なしで成功扱い)
  }

  return { model: returnedModel } satisfies ApiTestResult;
}

/**
 * API のモデル一覧エンドポイントを叩いてモデル名配列を返す。
 * - OpenAI 互換: GET {baseUrl}/models
 * - Anthropic: GET {baseUrl}/models (Anthropic も /models をサポート)
 *
 * テスト可能性: ローカル HTTP スタブで検証可能。
 */
export async function fetchModelList(params: {
  api: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
}): Promise<string[]> {
  const { api, baseUrl, apiKey } = params;
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/models`;

  const headers: Record<string, string> = {};
  if (api === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`models fetch failed: ${String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as unknown;

  // OpenAI 互換: { data: [ { id: string }, ... ] }
  if (
    json !== null &&
    typeof json === 'object' &&
    'data' in json &&
    Array.isArray((json as Record<string, unknown>).data)
  ) {
    const data = (json as { data: unknown[] }).data;
    return data
      .filter((m): m is { id: string } => m !== null && typeof m === 'object' && 'id' in m && typeof (m as { id: unknown }).id === 'string')
      .map((m) => m.id)
      .sort();
  }

  // Anthropic 互換: { models: [ { id: string }, ... ] } または { data: [...] } (同上)
  if (
    json !== null &&
    typeof json === 'object' &&
    'models' in json &&
    Array.isArray((json as Record<string, unknown>).models)
  ) {
    const models = (json as { models: unknown[] }).models;
    return models
      .filter((m): m is { id: string } => m !== null && typeof m === 'object' && 'id' in m && typeof (m as { id: unknown }).id === 'string')
      .map((m) => m.id)
      .sort();
  }

  return [];
}

/**
 * エラーメッセージから apiKey 実値を除去する。
 * apiKey が実値 (非 $ENV_VAR) の場合でも漏れを防ぐ。
 */
function sanitizeErrorMessage(msg: string, apiKey: string): string {
  if (apiKey.length > 0 && !apiKey.startsWith('$')) {
    // 実値が含まれていたら "(redacted)" に置換
    return msg.split(apiKey).join('(redacted)');
  }
  return msg;
}
