/**
 * デイリージャーナルエンドポイント。
 *
 * - GET  /api/journal[?date=YYYY-MM-DD]  取得。存在しなければ journals/YYYY-MM-DD.md を自動生成
 * - POST /api/journal/append             今日 (または body.date の日) のジャーナル末尾に追記
 *
 * タイムゾーンはサーバーローカル (shared/journal.ts)。
 * read-only モードでは自動生成せず、仮想的な空ジャーナルを返す (ファイルを書かない)。
 */
import { Hono } from 'hono';
import {
  appendText,
  isValidJournalDate,
  journalAppendRequestSchema,
  journalPath,
  parseNote,
  todayJournalDate,
  type JournalAppendResponse,
  type JournalResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { noteMtime, readNote, writeNote } from '../vault.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';

export function journalRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/journal', async (c) => {
    const date = c.req.query('date') ?? todayJournalDate();
    if (!isValidJournalDate(date)) {
      return errorJson(c, 400, 'invalid_date', `invalid date: "${date}" (expected YYYY-MM-DD)`);
    }
    const rel = journalPath(date);

    let content = await readNote(config.vaultRoot, rel);
    let created = false;
    let mtime: number | null = null;
    if (content === null) {
      content = '';
      if (config.mode !== 'read-only') {
        // 自動生成 (VISION success_criteria: デイリージャーナルの自動生成)。
        // これはディスクへの書き込みなので監査ログに残す。
        setAudit(c, 'journal.create', rel);
        const written = await writeNote(config.vaultRoot, rel, content);
        mtime = written.mtime;
        created = true;
      }
      // read-only の仮想ジャーナル (ファイル無し) は mtime: null のまま
    } else {
      mtime = await noteMtime(config.vaultRoot, rel);
    }

    const parsed = parseNote(content);
    const res: JournalResponse = {
      date,
      path: rel,
      content: parsed.content,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      created,
      mtime,
    };
    return c.json(res);
  });

  app.post('/api/journal/append', async (c) => {
    const body = await parseBody(c, journalAppendRequestSchema);
    if (!body.ok) return body.response;

    const date = body.data.date ?? todayJournalDate();
    if (!isValidJournalDate(date)) {
      return errorJson(c, 400, 'invalid_date', `invalid date: "${date}" (expected YYYY-MM-DD)`);
    }
    const rel = journalPath(date);
    setAudit(c, 'journal.append', rel);

    const existing = await readNote(config.vaultRoot, rel);
    const created = existing === null;
    await writeNote(config.vaultRoot, rel, appendText(existing ?? '', body.data.content));

    const res: JournalAppendResponse = { date, path: rel, created };
    return c.json(res, created ? 201 : 200);
  });

  return app;
}
