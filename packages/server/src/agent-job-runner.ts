/**
 * 単一エージェントジョブの無人実行エンジン (S2fe109)。
 *
 * - Pi セッションを生成し job.prompt を送信する。
 * - job.maxTurns: agent_end イベントを数え、上限に達したら abort する。
 * - job.timeoutSec: 全体タイムアウト。超過したら abort → 'timeout' を返す。
 */
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import type { AgentJob, JobRunResult } from '@loamium/shared';
import { loadAgentConfig, createPiSession, getEffectiveCapabilities } from './agent-service.js';
import { resolvePermissions } from '@loamium/shared';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

export async function runAgentJob(
  serverConfig: ServerConfig,
  index: VaultIndex,
  job: AgentJob,
): Promise<{ result: JobRunResult; error: string | null }> {
  const configResult = await loadAgentConfig(serverConfig.vaultRoot);
  if (!configResult.ok) {
    return { result: 'error', error: `agent 未設定: ${configResult.message}` };
  }

  // 権限: job 指定 → agent.json 既定 → read-only の順にフォールバック
  const requested =
    job.permissions !== undefined
      ? resolvePermissions(job.permissions)
      : resolvePermissions(configResult.config.permissions);
  const effectiveCaps = getEffectiveCapabilities(
    configResult.config,
    requested,
    serverConfig.mode,
  );

  const session = await createPiSession(serverConfig, configResult.config, index, effectiveCaps);

  let result: JobRunResult = 'ok';
  let errorMessage: string | null = null;
  let turnCount = 0;
  let settled = false;

  // ターン数カウント + エラー検出
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'agent_end') {
      if (!event.willRetry) {
        turnCount++;
        // エラー検出
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
        // ターン数上限チェック
        if (turnCount >= job.maxTurns && !settled) {
          void session.abort().catch(() => { /* best-effort */ });
        }
      }
    } else if (event.type === 'agent_settled') {
      settled = true;
    }
  });

  // タイムアウト
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    void session.abort().catch(() => { /* best-effort */ });
  }, job.timeoutSec * 1000);

  try {
    session.setAutoRetryEnabled(false);
    await session.prompt(job.prompt);
    await session.waitForIdle();
  } catch (err) {
    if (!timedOut) {
      result = 'error';
      errorMessage = String(err);
    }
  } finally {
    clearTimeout(timeoutTimer);
    unsubscribe();
  }

  if (timedOut) {
    result = 'timeout';
    errorMessage = `タイムアウト (${job.timeoutSec}s)`;
  } else if (turnCount >= job.maxTurns && result === 'ok') {
    result = 'aborted';
    errorMessage = `最大ターン数 (${job.maxTurns}) に達したため中断`;
  } else if (errorMessage !== null) {
    result = 'error';
  }

  return { result, error: errorMessage };
}
