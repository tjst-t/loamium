/**
 * 内蔵オフライン LLM の REST ルート (S8a3f2e-2 / S8a3f2e-3 / ADR-0025)。
 *
 * ## OpenAI 互換 shim (S8a3f2e-2)
 *   POST /api/llm/v1/chat/completions  — pi SDK (openai-completions) が叩く chat 完了
 *   GET  /api/llm/v1/models            — pi SDK / UI が叩く内蔵モデル一覧 (OpenAI models 形)
 *
 * baseUrl 導出の一致 (AC-S8a3f2e-2-1):
 *   agent-service が backend='local' 時に登録する baseUrl は `<origin>/api/llm/v1`。
 *   pi の openai クライアントは baseUrl に `/chat/completions` / `/models` を付けて
 *   叩くため、shim のパスは `/api/llm/v1/chat/completions` と `/api/llm/v1/models` に
 *   なる (localLlmBaseUrl() が唯一の導出点)。
 *
 * ## モデル管理 (S8a3f2e-3)
 *   GET    /api/llm/models                        — .loamium/models/llm/*.gguf 一覧
 *   POST   /api/llm/models/download               — GGUF ダウンロード (ジョブ受理)
 *   GET    /api/llm/models/download/:id/status    — 進捗ポーリング
 *   DELETE /api/llm/models/:filename              — 削除 (ロード中はアンロード後削除)
 *
 * セキュリティ / 境界:
 *   - 保存先は必ず .loamium/models/llm/ 内に封じ込める (resolveModelFilePath)。
 *   - filename は英数・._- のみ・パス区切り不可。不正名は FS に触れる前に 400。
 *   - 書き込み系 (download/delete) は監査ログに記録する (auditMiddleware + setAudit)。
 */
import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import {
  llmChatRequestSchema,
  localModelDownloadRequestSchema,
  type LocalModelListResponse,
  type LocalModelInfo,
  type LocalModelDownloadAcceptedResponse,
  type LocalModelDownloadStatusResponse,
  type LocalModelDeleteResponse,
} from '@loamium/shared';
import { promises as fs } from 'node:fs';
import type { ServerConfig } from '../config.js';
import { parseBody, setAudit, errorJson, type AppEnv } from '../http.js';
import {
  listModelFiles,
  resolveModelFilePath,
  modelVaultRelPath,
  isValidModelFileName,
  InvalidModelFilenameError,
} from '../model-paths.js';
import { ModelDownloadManager, type FetchFn } from '../model-download.js';
import {
  sharedLocalLlmEngine,
  messagesToPrompt,
  completionOptionsFromRequest,
  buildChatCompletion,
  buildChatChunk,
  buildFinalChunk,
  buildErrorBody,
  newCompletionId,
} from '../local-llm-shim.js';
import { LocalLlmUnavailableError, type LocalLlmEngine } from '../local-llm-engine.js';

/** LLM GGUF の拡張子。 */
const GGUF_EXT = '.gguf';

/**
 * ローカル shim の baseUrl 導出点 (agent-service と routes が共有する唯一の真実)。
 * pi は baseUrl + '/chat/completions' / '/models' を叩くため、末尾は `/api/llm/v1`。
 * origin は PORT / LOAMIUM_HOST から組み立てる (in-process 同一オリジン)。
 */
export function localLlmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = env.PORT ?? '3000';
  // バインド先が 0.0.0.0 でも、自プロセスへは 127.0.0.1 で到達できる。
  const host = env.LOAMIUM_HOST === undefined || env.LOAMIUM_HOST === '0.0.0.0'
    ? '127.0.0.1'
    : env.LOAMIUM_HOST;
  return `http://${host}:${port}/api/llm/v1`;
}

/**
 * routes を組み立てる。engine / downloadManager は注入可能 (テストがスタブする)。
 * 既定はプロセス内シングルトンの sharedLocalLlmEngine と実 fetch。
 */
export function llmRoutes(
  config: ServerConfig,
  options?: {
    engine?: LocalLlmEngine;
    fetchFn?: FetchFn;
    downloadManager?: ModelDownloadManager;
  },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const engine = options?.engine ?? sharedLocalLlmEngine;
  const downloadManager =
    options?.downloadManager ?? new ModelDownloadManager(config.vaultRoot, options?.fetchFn);

  // ==========================================================================
  // OpenAI 互換 shim (S8a3f2e-2)
  // ==========================================================================

  // GET /api/llm/v1/models — 内蔵モデル一覧を OpenAI models 形で返す (AC-S8a3f2e-2-3)。
  app.get('/api/llm/v1/models', async (c) => {
    const files = await listModelFiles(config.vaultRoot, 'llm');
    const data = files
      .filter((f) => f.toLowerCase().endsWith(GGUF_EXT))
      .map((f) => ({ id: f, object: 'model' as const, owned_by: 'loamium-local' }));
    return c.json({ object: 'list', data });
  });

  // POST /api/llm/v1/chat/completions — OpenAI chat.completions 互換 (AC-S8a3f2e-2-1/2/3)。
  app.post('/api/llm/v1/chat/completions', async (c) => {
    const bodyResult = await parseBody(c, llmChatRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const req = bodyResult.data;

    const prompt = messagesToPrompt(req.messages);
    const opts = completionOptionsFromRequest(req);

    // 非ストリーム: 完了を待って OpenAI chat.completion を返す。
    if (req.stream !== true) {
      let content: string;
      try {
        content = await engine.complete(prompt, opts);
      } catch (err) {
        return respondEngineError(c, err);
      }
      return c.json(buildChatCompletion(req.model, prompt, content));
    }

    // ストリーム: text/event-stream で delta を送出し末尾に [DONE]。
    // エンジンは完了文字列を返す面 (トークンストリーム非公開) のため、完了を
    // 1 delta として送出する。未ロード等は SSE 開始前に検知してエラー JSON を返す。
    let content: string;
    try {
      content = await engine.complete(prompt, opts);
    } catch (err) {
      return respondEngineError(c, err);
    }

    const id = newCompletionId();
    return stream(c, async (s) => {
      c.res.headers.set('Content-Type', 'text/event-stream');
      c.res.headers.set('Cache-Control', 'no-cache');
      c.res.headers.set('Connection', 'keep-alive');
      await s.write(`data: ${JSON.stringify(buildChatChunk(id, req.model, content))}\n\n`);
      await s.write(`data: ${JSON.stringify(buildFinalChunk(id, req.model))}\n\n`);
      await s.write('data: [DONE]\n\n');
    });
  });

  // ==========================================================================
  // モデル管理 REST (S8a3f2e-3)
  // ==========================================================================

  // GET /api/llm/models — .loamium/models/llm/*.gguf を走査 (AC-S8a3f2e-3-1)。
  app.get('/api/llm/models', async (c) => {
    const files = await listModelFiles(config.vaultRoot, 'llm');
    const models: LocalModelInfo[] = [];
    for (const filename of files) {
      if (!filename.toLowerCase().endsWith(GGUF_EXT)) continue;
      // 検証を通したファイル名のみ扱う (列挙結果は基本安全だが二重に守る)。
      if (!isValidModelFileName(filename)) continue;
      const abs = resolveModelFilePath(config.vaultRoot, 'llm', filename);
      let sizeBytes = 0;
      try {
        const st = await fs.stat(abs);
        sizeBytes = st.size;
      } catch {
        continue; // 列挙後に消えた等はスキップ
      }
      models.push({
        id: filename,
        filename,
        sizeBytes,
        path: modelVaultRelPath('llm', filename),
      });
    }
    const res: LocalModelListResponse = { models };
    return c.json(res);
  });

  // POST /api/llm/models/download — GGUF ダウンロード開始 (AC-S8a3f2e-3-2)。
  app.post('/api/llm/models/download', async (c) => {
    setAudit(c, 'llm.model.download', '.loamium/models/llm');
    const bodyResult = await parseBody(c, localModelDownloadRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const { url, filename } = bodyResult.data;

    let job;
    try {
      // start() が封じ込め検証 (英数・._-・パス区切り不可) を FS 前に実施する。
      job = downloadManager.start(url, filename);
    } catch (err) {
      if (err instanceof InvalidModelFilenameError) {
        return errorJson(c, 400, 'invalid_filename', err.message);
      }
      throw err;
    }

    const res: LocalModelDownloadAcceptedResponse = {
      id: job.id,
      filename: job.filename,
      status: job.status,
    };
    return c.json(res, 202);
  });

  // GET /api/llm/models/download/:id/status — 進捗ポーリング (AC-S8a3f2e-3-2)。
  app.get('/api/llm/models/download/:id/status', (c) => {
    const id = c.req.param('id');
    const job = downloadManager.getJob(id);
    if (!job) {
      return errorJson(c, 404, 'not_found', `download job not found: ${id}`);
    }
    const res: LocalModelDownloadStatusResponse = {
      id: job.id,
      filename: job.filename,
      status: job.status,
      receivedBytes: job.receivedBytes,
      totalBytes: job.totalBytes,
      ...(job.error !== undefined ? { error: job.error } : {}),
    };
    return c.json(res);
  });

  // DELETE /api/llm/models/:filename — 削除 (AC-S8a3f2e-3-3)。
  app.delete('/api/llm/models/:filename', async (c) => {
    const filename = c.req.param('filename');
    // 監査パスは検証前でも設定してよい (実 FS 操作は検証後のみ)。
    setAudit(c, 'llm.model.delete', modelVaultRelPath('llm', filename));

    // 検証 → FS に触れる前に不正名を弾く (AC-S8a3f2e-3-3)。
    if (!isValidModelFileName(filename)) {
      return errorJson(c, 400, 'invalid_filename', `invalid model filename: ${filename}`);
    }
    let abs: string;
    try {
      abs = resolveModelFilePath(config.vaultRoot, 'llm', filename);
    } catch (err) {
      if (err instanceof InvalidModelFilenameError) {
        return errorJson(c, 400, 'invalid_filename', err.message);
      }
      throw err;
    }

    // 存在確認。無ければ 404 (FS には触れるが封じ込め済みパスのみ)。
    try {
      await fs.stat(abs);
    } catch {
      return errorJson(c, 404, 'not_found', `model not found: ${filename}`);
    }

    // ロード中モデルなら先にアンロードしてから削除する (AC-S8a3f2e-3-3)。
    if (engine.loadedModelPath() === abs) {
      await engine.unloadEngine();
    }

    try {
      await fs.unlink(abs);
    } catch (err) {
      return errorJson(c, 500, 'delete_failed', String(err));
    }

    const res: LocalModelDeleteResponse = { ok: true, filename };
    return c.json(res);
  });

  return app;
}

/**
 * エンジンエラーを OpenAI 互換エラー + 適切な HTTP に変換する (AC-S8a3f2e-2-3)。
 * 未ロード / 未存在 (LocalLlmUnavailableError) は 503 で「フォールバック不能」を示す。
 */
function respondEngineError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof LocalLlmUnavailableError) {
    return c.json(
      buildErrorBody(err.message, 'local_llm_unavailable'),
      503,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json(buildErrorBody(message, 'local_llm_error'), 500);
}
