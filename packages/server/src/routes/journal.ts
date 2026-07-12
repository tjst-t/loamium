/**
 * デイリージャーナルエンドポイント。
 *
 * - GET  /api/journal[?date=YYYY-MM-DD]  取得。存在しなければ journals/YYYY-MM-DD.md を自動生成
 * - POST /api/journal/append             今日 (または body.date の日) のジャーナル末尾に追記
 *
 * タイムゾーンはサーバーローカル (shared/journal.ts)。
 * 遅延生成 (S67ea41): 既定 journal テンプレート (templates/journal.md) があれば、対象日基準で
 * `{{date:...}}` 等を展開した本文でファイルを作成する。テンプレートが無ければ従来どおり空ファイル
 * (後方互換)。結果は解決済みピュア Markdown (テンプレ記法 {{...}} は残らない)。
 * read-only モードでは自動生成せず、テンプレート適用済みの仮想ジャーナルを返す (ファイルを書かない)。
 * 既存ジャーナルは上書きしない (冪等)。
 */
import { Hono } from 'hono';
import {
  applyJournalTemplate,
  isValidJournalDate,
  journalAppendRequestSchema,
  journalDateToLocalDate,
  journalPath,
  JOURNAL_TEMPLATE_PATH,
  parseNote,
  todayJournalDate,
  type JournalAppendResponse,
  type JournalResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { noteMtime, readNote, writeNote } from '../vault.js';
import { appendToJournal } from '../note-service.js';
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
      // 遅延生成の本文を既定 journal テンプレートから解決する (S67ea41-1)。
      // テンプレートが無ければ従来どおり空ファイル(後方互換 — AC1)。
      // {{date:...}} は対象日基準で展開する(明日/過去日ジャーナルも対象日 — AC2)。
      const template = await readNote(config.vaultRoot, JOURNAL_TEMPLATE_PATH);
      content =
        template !== null
          ? applyJournalTemplate(template, { date: journalDateToLocalDate(date), now: new Date() })
          : '';
      if (config.mode !== 'read-only') {
        // 自動生成 (VISION success_criteria: デイリージャーナルの自動生成)。
        // これはディスクへの書き込みなので監査ログに残す。
        setAudit(c, 'journal.create', rel);
        const written = await writeNote(config.vaultRoot, rel, content);
        mtime = written.mtime;
        created = true;
      }
      // read-only の仮想ジャーナル (ファイル無し) は mtime: null のまま。
      // テンプレート適用済みの本文をそのまま返す (書き込みはしない — AC2)。
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
    // audit パスは note-service に入る前に確定させる (振る舞い不変)。
    const rel = journalPath(date);
    setAudit(c, 'journal.append', rel);

    // ADR-0012: ジャーナル追記も note-service に集約 (REST/CLI/エージェント同一経路)。
    // date は検証済み。appendToJournal は追記結果 (created 判定込み) を返す。
    const { result } = await appendToJournal(config, date, body.data.content);
    // appendToJournal は追記 (常に成功 or I/O 例外を伝播)。判別型の created を使う。
    const created = result.ok ? result.created : false;

    const res: JournalAppendResponse = { date, path: rel, created };
    return c.json(res, created ? 201 : 200);
  });

  return app;
}
