/**
 * エージェント定期実行ジョブのスキーマと型定義 (S2fe109)。
 *
 * ジョブ定義: .loamium/agent-jobs.json (Git 管理対象、ユーザーが編集)
 * ジョブ状態: .loamium/agent-jobs-state.json (使い捨て、Git 管理外)
 */
import { z } from 'zod';
import { agentPermissionsSchema } from './agent-capabilities.js';

// cron 式: "分 時 日 月 曜日" の 5 フィールド (* / n / n-m / n,m をサポート)
const cronExprSchema = z
  .string()
  .regex(/^\S+ \S+ \S+ \S+ \S+$/, 'cron は 5 フィールド (分 時 日 月 曜) でなければなりません');

export const agentJobSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, 'ジョブ名はアルファベット・数字・ハイフン・アンダースコアのみ'),
  schedule: cronExprSchema,
  prompt: z.string().min(1),
  permissions: agentPermissionsSchema.optional(),
  enabled: z.boolean().default(true),
  maxTurns: z.number().int().min(1).max(50).default(20),
  timeoutSec: z.number().int().min(10).max(600).default(120),
});

export type AgentJob = z.infer<typeof agentJobSchema>;

export const agentJobsSchema = z.array(agentJobSchema);
export type AgentJobs = z.infer<typeof agentJobsSchema>;

// ── API レスポンス ──────────────────────────────────────────────────────────

export const jobRunResultSchema = z.enum(['ok', 'error', 'timeout', 'aborted']);
export type JobRunResult = z.infer<typeof jobRunResultSchema>;

export const agentJobStateSchema = z.object({
  lastRunAt: z.string().nullable(),  // ISO 8601 or null (未実行)
  lastResult: jobRunResultSchema.nullable(),
  lastError: z.string().nullable(),
});
export type AgentJobState = z.infer<typeof agentJobStateSchema>;

export const agentJobWithStateSchema = agentJobSchema.extend({
  state: agentJobStateSchema,
});
export type AgentJobWithState = z.infer<typeof agentJobWithStateSchema>;

export const agentJobListResponseSchema = z.object({
  jobs: z.array(agentJobWithStateSchema),
});
export type AgentJobListResponse = z.infer<typeof agentJobListResponseSchema>;

export const agentJobRunResponseSchema = z.object({
  ok: z.boolean(),
  result: jobRunResultSchema,
  error: z.string().nullable(),
  durationMs: z.number(),
});
export type AgentJobRunResponse = z.infer<typeof agentJobRunResponseSchema>;

export const agentJobDetailResponseSchema = agentJobWithStateSchema.extend({
  nextRunAt: z.string().nullable(),
});
export type AgentJobDetailResponse = z.infer<typeof agentJobDetailResponseSchema>;
