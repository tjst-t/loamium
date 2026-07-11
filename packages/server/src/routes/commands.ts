/**
 * スマートコマンド定義一覧エンドポイント (Sd22b1f-1)。
 *
 * - GET /api/commands   vault 内 commands/*.md を寛容 read で列挙する
 *
 * 正常な定義は { name, path, description?, params, valid:true } で返す。
 * frontmatter が壊れたファイルも { name, path, valid:false, error } で一覧に含め、
 * アプリを落とさない (ADR-0008: 寛容 read、priority 2)。
 * レスポンスは常に 200 (一覧取得自体は失敗しない)。
 *
 * GET /api/templates と同じパターン (packages/server/src/routes/templates.ts 参照)。
 */
import { Hono } from 'hono';
import {
  parseLoamiumCommandWithError,
  parseNote,
  type CommandSummary,
  type CommandsResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { listNoteFiles, readNote } from '../vault.js';
import type { AppEnv } from '../http.js';

const COMMANDS_DIR = 'commands';
const COMMANDS_PREFIX = `${COMMANDS_DIR}/`;

/** vault 相対パスからファイル名 (拡張子なし) を取り出す。 */
function stemFrom(rel: string): string {
  const basename = rel.slice(COMMANDS_PREFIX.length);
  return basename.replace(/\.md$/i, '');
}

/** 1 ファイルの内容から CommandSummary を組み立てる (寛容: 壊れは valid:false)。 */
function summaryFor(rel: string, content: string): CommandSummary {
  const stem = stemFrom(rel);
  const { frontmatter } = parseNote(content);
  const parsed = parseLoamiumCommandWithError(frontmatter);

  if (!parsed.ok) {
    return { name: stem, path: rel, valid: false, error: parsed.error };
  }

  const cmd = parsed.command;
  const summary: CommandSummary = {
    name: cmd.name ?? stem,
    path: rel,
    params: cmd.params,
    valid: true,
  };
  if (cmd.description !== undefined) {
    summary.description = cmd.description;
  }
  return summary;
}

export function commandsRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/commands', async (c) => {
    const all = await listNoteFiles(config.vaultRoot);
    const commands: CommandSummary[] = [];

    for (const rel of all) {
      if (!rel.startsWith(COMMANDS_PREFIX)) continue;
      const content = await readNote(config.vaultRoot, rel);
      if (content === null) continue; // 走査後に消えたファイル
      try {
        commands.push(summaryFor(rel, content));
      } catch (err) {
        // 予期せぬ例外でも一覧全体を落とさない (priority 2)
        console.error(`[loamium] unexpected error reading command ${rel}:`, err);
        const stem = stemFrom(rel);
        commands.push({
          name: stem,
          path: rel,
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const res: CommandsResponse = { commands };
    return c.json(res);
  });

  return app;
}
