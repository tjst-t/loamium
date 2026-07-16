import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { agentJobDefinitionSchema, type AgentJobDefinition } from '@loamium/shared';

const JOBS_FILE = '.loamium/agent-jobs.json';

export async function loadAgentJobs(vaultRoot: string): Promise<AgentJobDefinition[]> {
  const filePath = path.join(vaultRoot, JOBS_FILE);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[loamium] agent-jobs.json: invalid JSON, skipping all entries`);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[loamium] agent-jobs.json: expected array, skipping`);
    return [];
  }

  const valid: AgentJobDefinition[] = [];
  for (const entry of parsed) {
    const result = agentJobDefinitionSchema.safeParse(entry);
    if (result.success) {
      valid.push(result.data);
    } else {
      const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      console.warn(`[loamium] agent-jobs.json: invalid entry skipped — ${issues}`);
    }
  }
  return valid;
}

export function computeNextRunAt(schedule: string): string | null {
  try {
    const interval = CronExpressionParser.parse(schedule, { tz: 'UTC' });
    return interval.next().toISOString();
  } catch {
    return null;
  }
}
