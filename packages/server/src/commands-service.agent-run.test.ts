/**
 * agent-run ステップの権限 least-privilege テスト (autopilot/agent-run-permissions)。
 *
 * 方針: agent-run は least-privilege。step.permissions 未指定なら job.permissions は
 * 明示的に 'read-only' になる (agent.json の権限を継承しない = footgun 解消)。
 * step.permissions を明示したときはそれがそのまま job へ渡る。
 *
 * runAgentJob をスタブして job 引数 (commands-service が組み立てる AgentJob) を検証する。
 * 実 LLM / agent.json は不要 (job 組み立てまでが検証対象)。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentJob, JobRunResult } from '@loamium/shared';

// runAgentJob をスタブし、渡された job を捕捉する。
const capturedJobs: AgentJob[] = [];
vi.mock('./agent-job-runner.js', () => ({
  runAgentJob: vi.fn(
    async (
      _config: unknown,
      _index: unknown,
      job: AgentJob,
    ): Promise<{ result: JobRunResult; error: string | null }> => {
      capturedJobs.push(job);
      return { result: 'ok', error: null };
    },
  ),
}));

import { runCommand } from './commands-service.js';
import { VaultIndex } from './noteIndex.js';
import type { ServerConfig } from './config.js';

function makeConfig(vaultRoot: string): ServerConfig {
  return { vaultRoot, mode: 'full', maxUploadBytes: 1024 };
}

async function writeCommandFixture(vaultRoot: string, name: string, yaml: string): Promise<void> {
  const dir = path.join(vaultRoot, 'system', 'commands');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.yaml`), yaml, 'utf8');
}

let vaultRoot: string;
let index: VaultIndex;

beforeEach(async () => {
  capturedJobs.length = 0;
  vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agentrun-'));
  index = new VaultIndex(vaultRoot);
});

describe('agent-run 権限 least-privilege (既定 read-only)', () => {
  it('permissions 未指定の agent-run ステップは job.permissions=read-only になる (継承しない)', async () => {
    await writeCommandFixture(
      vaultRoot,
      'no-perm',
      'name: no-perm\nsteps:\n  - kind: agent-run\n    prompt: "調べて"\n',
    );

    const result = await runCommand(makeConfig(vaultRoot), index, 'no-perm', {});
    expect(result.status).toBe('ok');
    expect(capturedJobs).toHaveLength(1);
    // 明示 read-only (agent.json 継承ではない)。
    expect(capturedJobs[0]?.permissions).toBe('read-only');
  });

  it('permissions 明示 (プリセット notes-rw) はそのまま job へ渡る', async () => {
    await writeCommandFixture(
      vaultRoot,
      'notes',
      'name: notes\nsteps:\n  - kind: agent-run\n    permissions: notes-rw\n    prompt: "要約して追記"\n',
    );

    const result = await runCommand(makeConfig(vaultRoot), index, 'notes', {});
    expect(result.status).toBe('ok');
    expect(capturedJobs[0]?.permissions).toBe('notes-rw');
  });

  it('permissions 明示 (ケーパビリティ配列) はそのまま job へ渡る', async () => {
    await writeCommandFixture(
      vaultRoot,
      'survey',
      'name: survey\nsteps:\n  - kind: agent-run\n    permissions: ["read", "web", "note_create"]\n    prompt: "調査して保存"\n',
    );

    const result = await runCommand(makeConfig(vaultRoot), index, 'survey', {});
    expect(result.status).toBe('ok');
    expect(capturedJobs[0]?.permissions).toEqual(['read', 'web', 'note_create']);
  });
});
