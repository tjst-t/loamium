/**
 * エージェント API ルート (S53409d-2)。
 *
 * POST   /api/agent/sessions             新規セッション作成 → { id }
 * GET    /api/agent/sessions             セッション一覧 → { sessions }
 * GET    /api/agent/sessions/{id}        セッション詳細 (メッセージ履歴) → { id, messages }
 * POST   /api/agent/sessions/{id}/messages  SSE テキスト配信
 * POST   /api/agent/sessions/{id}/abort     中断 → { ok }
 *
 * SSE イベント (data: <json>\n\n):
 *   { type:'text_delta', text }
 *   { type:'tool_start', toolCallId, name, argsSummary }
 *   { type:'tool_end',   toolCallId, name }
 *   { type:'error',      message }
 *   { type:'done' }
 */
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { ServerConfig } from '../config.js';
import {
  loadAgentConfig,
  createPiSession,
  listSessions,
  getSessionFromDisk,
  extractSessionMessages,
  getActiveSession,
  updateSessionTitle,
  validateSessionId,
  deleteSession,
  getEffectiveCapabilities,
  evictActiveSession,
} from '../agent-service.js';
import { parseBody, errorJson, setAudit, type AppEnv } from '../http.js';
import {
  agentSendMessageRequestSchema,
  agentCreateSessionRequestSchema,
  resolvePermissions,
} from '@loamium/shared';
import { loadSessionPerms, saveSessionPerms } from '../agent-session-perms.js';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { VaultIndex } from '../noteIndex.js';

/**
 * ツール引数から短い要約文字列を生成する (SSE tool_start の argsSummary フィールド)。
 *
 * - search  → クエリ文字列 (ダブルクォート付き)
 * - read / backlinks → パス文字列
 * - query   → DQL 文字列 (先頭 60 文字)
 * - tags    → '' (引数なし)
 * - unknown → JSON フォールバック
 */
function buildArgsSummary(toolName: string, args: unknown): string {
  const a = (typeof args === 'object' && args !== null) ? (args as Record<string, unknown>) : {};
  switch (toolName) {
    case 'search': {
      const q = typeof a['query'] === 'string' ? a['query'] : '';
      return JSON.stringify(q);
    }
    case 'read_note':
    case 'backlinks': {
      const p = typeof a['path'] === 'string' ? a['path'] : '';
      return p.slice(0, 120);
    }
    case 'query': {
      const d = typeof a['dql'] === 'string' ? a['dql'] : '';
      return d.slice(0, 60);
    }
    case 'help': {
      const t = typeof a['topic'] === 'string' ? a['topic'] : '';
      return t.slice(0, 40);
    }
    case 'tags':
      return '';
    default:
      return JSON.stringify(a).slice(0, 80);
  }
}

/**
 * POST 本文を任意扱いで読む (body 無し / 空 / 非 JSON は {} として扱う)。
 * POST /api/agent/sessions は permissions が optional で body 無しも許容するため。
 * JSON として parse できたがオブジェクトでない (配列/プリミティブ) 場合はそのまま返し、
 * 後段の zod 検証に委ねる (不正な permissions は 400 になる)。
 */
async function readOptionalJsonBody(c: { req: { text: () => Promise<string> } }): Promise<unknown> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return {};
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function agentRoutes(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- GET /api/agent/sessions -----------------------------------------------

  app.get('/api/agent/sessions', async (c) => {
    const sessions = await listSessions(config);
    return c.json({ sessions });
  });

  // ---- POST /api/agent/sessions -----------------------------------------------

  app.post('/api/agent/sessions', async (c) => {
    const configResult = await loadAgentConfig(config.vaultRoot);
    if (!configResult.ok) {
      return errorJson(c, 400, configResult.reason, configResult.message);
    }

    // permissions は optional。body 無し / 空オブジェクトも許容する。
    // permissions 未指定なら agent.json 既定 (未指定なら read-only) を使う。
    const rawBody = await readOptionalJsonBody(c);
    const parsed = agentCreateSessionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return errorJson(c, 400, 'invalid_permissions', msg);
    }

    // セッション権限 = リクエストの permissions or agent.json 既定 → LOAMIUM_MODE でクランプ。
    const requested =
      parsed.data.permissions !== undefined
        ? resolvePermissions(parsed.data.permissions)
        : resolvePermissions(configResult.config.permissions);
    const effectiveCaps = getEffectiveCapabilities(
      configResult.config,
      requested,
      config.mode,
    );

    let session;
    try {
      // createPiSession は成功後に caps をセッション権限ストアへ永続化する。
      session = await createPiSession(
        config,
        configResult.config,
        index,
        effectiveCaps,
      );
    } catch (err) {
      return errorJson(c, 500, 'session_create_failed', String(err));
    }

    setAudit(c, 'agent.session.create', session.sessionId);

    return c.json({ id: session.sessionId });
  });

  // ---- GET /api/agent/sessions/{id} ------------------------------------------

  app.get('/api/agent/sessions/:id', async (c) => {
    const sessionId = c.req.param('id');

    // セキュリティ: ファイルシステムへアクセスする前にセッション ID を検証する
    try {
      validateSessionId(sessionId);
    } catch {
      return errorJson(c, 400, 'invalid_session_id', 'session id contains invalid characters');
    }

    // 実効ケーパビリティ (ADR-0011) を導出する。
    // セッション権限ストア (無ければ agent.json 既定) → LOAMIUM_MODE でクランプ。
    // agent.json 未設定でも effectivePermissions は返す (config 既定 = read-only 相当)。
    const configResult = await loadAgentConfig(config.vaultRoot);
    const sessionPerms = await loadSessionPerms(config.vaultRoot, sessionId);
    const effectivePermissions = configResult.ok
      ? getEffectiveCapabilities(configResult.config, sessionPerms, config.mode)
      : getEffectiveCapabilities(
          // agent.json 無しでもクランプ導出できるよう permissions 無しの最小 config を渡す
          { api: 'openai', baseUrl: 'x', model: 'x', apiKey: 'x' },
          sessionPerms,
          config.mode,
        );

    // fast-path: active session in memory
    const active = getActiveSession(sessionId);
    if (active) {
      const messages = extractSessionMessages(active);
      return c.json({ id: sessionId, messages, effectivePermissions });
    }

    // slow-path: load from JSONL on disk (サーバー再起動後のリストア)
    if (!configResult.ok) {
      return c.json({ id: sessionId, messages: [], effectivePermissions });
    }
    try {
      const session = await getSessionFromDisk(
        sessionId,
        config,
        configResult.config,
        index,
      );
      const messages = extractSessionMessages(session);
      return c.json({ id: sessionId, messages, effectivePermissions });
    } catch {
      return c.json({ id: sessionId, messages: [], effectivePermissions });
    }
  });

  // ---- PUT /api/agent/sessions/{id}/permissions ------------------------------
  //
  // セッション中の権限変更 (ADR-0011)。要求 permissions を LOAMIUM_MODE でクランプし、
  // 実効ケーパビリティをセッション権限ストアへ保存する (create と同じく effectiveCaps を保存)。
  // その後 active キャッシュから退避し、次メッセージ送信時に新ツール集合で再オープンさせる。
  //
  // 注: permissionMiddleware が /api/* の PUT を mutate 分類するため、read-only/append-only
  // モードでは 403 になる (既存挙動)。full 前提。
  app.put('/api/agent/sessions/:id/permissions', async (c) => {
    const sessionId = c.req.param('id');

    // セキュリティ: ファイルシステムへアクセスする前にセッション ID を検証する
    try {
      validateSessionId(sessionId);
    } catch {
      return errorJson(c, 400, 'invalid_session_id', 'session id contains invalid characters');
    }

    const configResult = await loadAgentConfig(config.vaultRoot);
    if (!configResult.ok) {
      return errorJson(c, 400, configResult.reason, configResult.message);
    }

    // permissions は create と同じスキーマ (プリセット名 or ケーパビリティ配列)。
    const rawBody = await readOptionalJsonBody(c);
    const parsed = agentCreateSessionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return errorJson(c, 400, 'invalid_permissions', msg);
    }

    // 要求 permissions (未指定なら agent.json 既定) → LOAMIUM_MODE でクランプ。
    const requested =
      parsed.data.permissions !== undefined
        ? resolvePermissions(parsed.data.permissions)
        : resolvePermissions(configResult.config.permissions);
    const effectiveCaps = getEffectiveCapabilities(
      configResult.config,
      requested,
      config.mode,
    );

    // create と整合: 実効ケーパビリティを保存する (再オープン時に同じ集合を導出)。
    await saveSessionPerms(config.vaultRoot, sessionId, effectiveCaps);
    // active キャッシュから退避 → 次送信で新ツール集合で再オープンされる。
    evictActiveSession(sessionId);

    setAudit(c, 'agent.session.permissions', sessionId);

    return c.json({ effectivePermissions: effectiveCaps });
  });

  // ---- DELETE /api/agent/sessions/{id} --------------------------------------

  app.delete('/api/agent/sessions/:id', async (c) => {
    const sessionId = c.req.param('id');

    // セキュリティ: ファイルシステムへアクセスする前にセッション ID を検証する
    try {
      validateSessionId(sessionId);
    } catch {
      return errorJson(c, 400, 'invalid_session_id', 'session id contains invalid characters');
    }

    // 権限チェック: セッション削除は mutate 操作。read-only/append-only では 403。
    // permissionMiddleware は DELETE を mutate に分類するが、agentRoutes は権限チェックを
    // 自前で行う慣習 (comment in app.ts) のため、ここでも明示的に確認する。
    // (permissionMiddleware 自体はすでに app.use('/api/*') で動いているため二重判定)
    // 既にミドルウェアが弾くが、フォールスルーとして応答を用意しておく。
    // ミドルウェアが弾く前に DELETE が到達したケースに備え mode チェックはしない
    // (ミドルウェアが先に 403 を返すため、ここは通らない)。

    try {
      await deleteSession(sessionId, config.vaultRoot);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('session not found')) {
        return errorJson(c, 404, 'session_not_found', `session not found: ${sessionId}`);
      }
      return errorJson(c, 500, 'delete_failed', msg);
    }

    setAudit(c, 'agent.session.delete', sessionId);
    return c.json({ ok: true });
  });

  // ---- POST /api/agent/sessions/{id}/abort -----------------------------------

  app.post('/api/agent/sessions/:id/abort', async (c) => {
    const sessionId = c.req.param('id');

    // セキュリティ: セッション ID を検証する (abort は in-memory Map 参照だが一貫性のため)
    try {
      validateSessionId(sessionId);
    } catch {
      return errorJson(c, 400, 'invalid_session_id', 'session id contains invalid characters');
    }

    const session = getActiveSession(sessionId);
    if (session) {
      try {
        await session.abort();
      } catch {
        // abort は best-effort
      }
    }
    return c.json({ ok: true });
  });

  // ---- POST /api/agent/sessions/{id}/messages (SSE) --------------------------

  app.post('/api/agent/sessions/:id/messages', async (c) => {
    const sessionId = c.req.param('id');

    // セキュリティ: ファイルシステムへアクセスする前にセッション ID を検証する
    try {
      validateSessionId(sessionId);
    } catch {
      return errorJson(c, 400, 'invalid_session_id', 'session id contains invalid characters');
    }

    const bodyResult = await parseBody(c, agentSendMessageRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const { content } = bodyResult.data;

    // fast-path: メモリ内アクティブセッション。
    // slow-path: サーバー再起動後などアクティブに無い場合は JSONL からリハイドレートして
    // 継続送信できるようにする (GET 詳細と同じ復元経路。これが無いと復元セッションへの送信が 404)。
    let session = getActiveSession(sessionId);
    if (!session) {
      const configResult = await loadAgentConfig(config.vaultRoot);
      if (!configResult.ok) {
        return errorJson(c, 400, 'agent_not_configured', 'agent is not configured');
      }
      try {
        session = await getSessionFromDisk(
          sessionId,
          config,
          configResult.config,
          index,
        );
      } catch {
        return errorJson(c, 404, 'session_not_found', `session not found: ${sessionId}`);
      }
    }

    // 監査ログ — auditMiddleware に任せる (直接 writeAuditEntry は呼ばない)
    setAudit(c, 'agent.message', sessionId);

    // SSE ストリーム
    return stream(c, async (s) => {
      // SSE ヘッダ — Hono の stream() は Content-Type を自動でセットしないため明示する
      c.res.headers.set('Content-Type', 'text/event-stream');
      c.res.headers.set('Cache-Control', 'no-cache');
      c.res.headers.set('Connection', 'keep-alive');

      let settled = false;
      let errorMessage: string | null = null;

      const sendEvent = async (data: Record<string, unknown>): Promise<void> => {
        if (s.aborted) return;
        await s.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // auto-retry は SSE ブリッジでは不要 (クライアント側が再試行を判断する)。
      // デフォルト3回 × 指数バックオフ (合計~14秒) を防ぐために無効化する。
      session.setAutoRetryEnabled(false);

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (settled) return;

        if (event.type === 'agent_settled') {
          // settled を同期的に true にセットする — waitForIdle() との競合を防ぐ
          // (非同期 IIFE の外で先にセットしないと fallback が二重送信する)
          settled = true;
        }

        void (async () => {
          if (event.type === 'message_update') {
            const ae = event.assistantMessageEvent;
            if (ae.type === 'text_delta') {
              await sendEvent({ type: 'text_delta', text: ae.delta });
            }
          } else if (event.type === 'tool_execution_start') {
            const argsSummary = buildArgsSummary(event.toolName, event.args);
            await sendEvent({
              type: 'tool_start',
              toolCallId: event.toolCallId,
              name: event.toolName,
              argsSummary,
            });
          } else if (event.type === 'tool_execution_end') {
            await sendEvent({
              type: 'tool_end',
              toolCallId: event.toolCallId,
              name: event.toolName,
            });
          } else if (event.type === 'agent_end') {
            // agent_end はエラー (含む非リトライエラー) のとき stopReason === 'error' になる。
            // willRetry === true ならリトライが続くので何もしない (auto_retry_end で確定)。
            if (!event.willRetry) {
              // 全メッセージの最後の assistant メッセージを調べてエラーを検出する
              for (let i = event.messages.length - 1; i >= 0; i--) {
                const msg = event.messages[i] as Record<string, unknown> | undefined;
                if (
                  msg !== undefined &&
                  msg['role'] === 'assistant' &&
                  msg['stopReason'] === 'error' &&
                  typeof msg['errorMessage'] === 'string'
                ) {
                  errorMessage = msg['errorMessage'];
                  break;
                }
              }
            }
          } else if (event.type === 'auto_retry_end') {
            // auto-retry は無効化しているので基本来ないが、念のため
            if (!event.success && event.finalError) {
              errorMessage = event.finalError;
            }
          } else if (event.type === 'agent_settled') {
            // settled は subscriber コールバック先頭で同期的にセット済み
            if (errorMessage !== null) {
              await sendEvent({ type: 'error', message: errorMessage });
            } else {
              await sendEvent({ type: 'done' });
            }
          }
        })();
      });

      try {
        await session.prompt(content);
        // agent_settled が来るまで待つ (エラー時も必ず settled になる)
        await session.waitForIdle();
      } catch (err) {
        // prompt() 自体が throw した場合 (preflight失敗など)
        // settled が false のときのみ送信 (abort パスや settled 後の例外を除外)
        if (!settled) {
          settled = true;
          unsubscribe();
          await sendEvent({ type: 'error', message: String(err) });
          return;
        }
        unsubscribe();
        return;
      }

      unsubscribe();
      if (!settled) {
        // agent_settled が来ていない場合 (waitForIdle が先に解決するケース)
        settled = true;
        if (errorMessage !== null) {
          await sendEvent({ type: 'error', message: errorMessage });
        } else {
          await sendEvent({ type: 'done' });
        }
      }

      // セッションタイトルを初回ユーザーメッセージから設定する
      void updateSessionTitle(session, config.vaultRoot);
    });
  });

  return app;
}
