import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const STATE_FILE = '.loamium/agent-job-state.json';

interface JobStateEntry {
  lastRunAt: string;
}

interface StateFile {
  jobs: Record<string, JobStateEntry>;
}

function statePath(vaultRoot: string): string {
  return path.join(vaultRoot, STATE_FILE);
}

async function readState(vaultRoot: string): Promise<StateFile> {
  const filePath = statePath(vaultRoot);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'jobs' in parsed) {
      return parsed as StateFile;
    }
    return { jobs: {} };
  } catch {
    return { jobs: {} };
  }
}

export async function getJobState(
  vaultRoot: string,
  jobName: string,
): Promise<{ lastRunAt: string | null }> {
  const state = await readState(vaultRoot);
  const entry = state.jobs[jobName];
  if (entry && typeof entry.lastRunAt === 'string') {
    return { lastRunAt: entry.lastRunAt };
  }
  return { lastRunAt: null };
}

export async function setJobLastRunAt(
  vaultRoot: string,
  jobName: string,
  runAt: string,
): Promise<void> {
  const state = await readState(vaultRoot);
  state.jobs[jobName] = { lastRunAt: runAt };
  const filePath = statePath(vaultRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}
