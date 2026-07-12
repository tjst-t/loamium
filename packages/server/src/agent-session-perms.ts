/**
 * セッション権限ストア (ADR-0011)。
 *
 * チャット UI でセッション単位に上書きしたケーパビリティ集合を
 * `.loamium/agent-session-perms.json` (`{ [sessionId]: Capability[] }`) に永続化する。
 * これによりセッションを再オープン (サーバー再起動含む) しても同じツール集合を導出できる。
 *
 * マシンローカル (`.loamium/*` は .gitignore 済み)。壊れ / 不在は null を返し、
 * 呼び出し側で agent.json 既定へフォールバックする。
 *
 * セキュリティ: sessionId は呼び出し側で validateSessionId() を通したものを渡すこと。
 * このファイルは sessionId をパス結合しない (JSON オブジェクトのキーとしてのみ使う)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AGENT_CAPABILITIES, type Capability } from '@loamium/shared';

const capabilitySchema = z.enum(AGENT_CAPABILITIES);

/** ストアファイル全体のスキーマ: sessionId → Capability[]。 */
const sessionPermsFileSchema = z.record(z.string(), z.array(capabilitySchema));
type SessionPermsFile = z.infer<typeof sessionPermsFileSchema>;

function permsFilePath(vaultRoot: string): string {
  return path.join(vaultRoot, '.loamium', 'agent-session-perms.json');
}

/**
 * ストアファイルを読み込む。不在 / 壊れは空オブジェクト ({}) を返す。
 */
async function readPermsFile(vaultRoot: string): Promise<SessionPermsFile> {
  let raw: string;
  try {
    raw = await fs.readFile(permsFilePath(vaultRoot), 'utf8');
  } catch {
    // 不在 (ENOENT) 含め、読めなければ空扱い
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {};
  }
  const parsed = sessionPermsFileSchema.safeParse(json);
  if (!parsed.success) return {};
  return parsed.data;
}

/**
 * セッションのケーパビリティ集合を永続化する。
 * sessionId 確定後に呼び出す。既存エントリは上書きする。
 */
export async function saveSessionPerms(
  vaultRoot: string,
  sessionId: string,
  caps: Capability[],
): Promise<void> {
  const dir = path.join(vaultRoot, '.loamium');
  await fs.mkdir(dir, { recursive: true });
  const current = await readPermsFile(vaultRoot);
  current[sessionId] = caps;
  await fs.writeFile(permsFilePath(vaultRoot), `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

/**
 * セッションのケーパビリティ集合をロードする。
 * エントリが無い / ストアが壊れ / 不在なら null を返す (呼び出し側で agent.json 既定へフォールバック)。
 */
export async function loadSessionPerms(
  vaultRoot: string,
  sessionId: string,
): Promise<Capability[] | null> {
  const file = await readPermsFile(vaultRoot);
  const entry = file[sessionId];
  if (entry === undefined) return null;
  return entry;
}
