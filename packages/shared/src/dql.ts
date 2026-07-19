/**
 * DQL (dataview query language) 簡易サブセット — パーサーと評価器 (Sb1593c-1)。
 *
 * Obsidian dataview 互換の構文に寄せる (priority 4 — 独自の別構文を発明しない):
 *
 *   LIST                [FROM ...] [WHERE ...] [SORT ...]
 *   TABLE f1, f2, ...   [FROM ...] [WHERE ...] [SORT ...]
 *   TASK                [FROM ...] [WHERE ...] [SORT ...]
 *
 *   FROM  #tag | "folder"
 *   WHERE cond [AND cond ...]     cond := field op value | field | !field
 *   op    := = | != | > | < | >= | <= | contains
 *   SORT  field [ASC|DESC]
 *
 * キーワードは大文字小文字両対応。対応外の構文 (OR / 関数 / 複数 SORT キー等) は
 * 位置情報付きの DqlParseError で明確に拒否する (「対応外は明確なエラー」)。
 * パーサー・評価器とも純関数 — サーバーがインデックスから QueryableNote[] を
 * 供給して executeQuery を呼ぶ (ユニットテスト必須 — coding_conventions)。
 */
import type { NoteTask } from './extract.js';
import type {
  QueryResponse,
  TableCellValue,
  TableQueryRow,
  TaskQueryRow,
} from './schemas.js';

// ---- AST ----------------------------------------------------------------------

export type DqlComparisonOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains';

export type DqlCondition =
  | { kind: 'compare'; field: string; op: DqlComparisonOp; value: string | number | boolean }
  | { kind: 'truthy'; field: string; negated: boolean };

export type DqlSource =
  | { kind: 'tag'; tag: string }
  | { kind: 'folder'; folder: string };

export interface DqlQuery {
  type: 'list' | 'table' | 'task';
  /** TABLE の列フィールド (LIST / TASK は空配列) */
  fields: string[];
  from: DqlSource | null;
  /** AND 結合の条件列 (空 = 全件) */
  where: DqlCondition[];
  sort: { field: string; direction: 'asc' | 'desc' } | null;
  /** SORT 適用後に先頭 n 件に絞る (null = 制限なし、0 = 0 件)。Obsidian dataview 互換の LIMIT 節。 */
  limit: number | null;
}

/** 構文エラー (1 始まりの行・列 + 該当トークン長)。message は位置情報込み。 */
export class DqlParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
    readonly length: number,
  ) {
    super(`${String(line)} 行 ${String(column)} 列: ${message}`);
    this.name = 'DqlParseError';
  }
}

// ---- トークナイザ ---------------------------------------------------------------

interface Token {
  kind: 'word' | 'string' | 'number' | 'tag' | 'op' | 'comma' | 'bang';
  /** 元テキスト (エラー表示用) */
  text: string;
  /** string は引用符を外した値、number は数値 */
  value: string | number;
  line: number;
  column: number;
}

const WORD_RE = /^[\p{L}\p{M}\p{N}_.\-/]+/u;

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  const lines = query.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const lineText = lines[li] ?? '';
    let col = 0;
    while (col < lineText.length) {
      const rest = lineText.slice(col);
      const ws = /^\s+/.exec(rest);
      if (ws) {
        col += ws[0].length;
        continue;
      }
      const pos = { line: li + 1, column: col + 1 };
      const two = rest.slice(0, 2);
      if (two === '!=' || two === '>=' || two === '<=') {
        tokens.push({ kind: 'op', text: two, value: two, ...pos });
        col += 2;
        continue;
      }
      const one = rest[0] ?? '';
      if (one === '=' || one === '>' || one === '<') {
        tokens.push({ kind: 'op', text: one, value: one, ...pos });
        col += 1;
        continue;
      }
      if (one === ',') {
        tokens.push({ kind: 'comma', text: ',', value: ',', ...pos });
        col += 1;
        continue;
      }
      if (one === '!') {
        tokens.push({ kind: 'bang', text: '!', value: '!', ...pos });
        col += 1;
        continue;
      }
      if (one === '"') {
        const close = rest.indexOf('"', 1);
        if (close === -1) {
          throw new DqlParseError('閉じられていない文字列リテラル', pos.line, pos.column, rest.length);
        }
        const text = rest.slice(0, close + 1);
        tokens.push({ kind: 'string', text, value: rest.slice(1, close), ...pos });
        col += close + 1;
        continue;
      }
      if (one === '#') {
        const m = /^#([\p{L}\p{M}\p{N}_/-]+)/u.exec(rest);
        if (!m || m[1] === undefined) {
          throw new DqlParseError("'#' の後にタグ名が必要です", pos.line, pos.column, 1);
        }
        tokens.push({ kind: 'tag', text: m[0], value: m[1], ...pos });
        col += m[0].length;
        continue;
      }
      const num = /^-?\d+(?:\.\d+)?(?![\p{L}\p{M}_.\-/])/u.exec(rest);
      if (num) {
        tokens.push({ kind: 'number', text: num[0], value: Number(num[0]), ...pos });
        col += num[0].length;
        continue;
      }
      const word = WORD_RE.exec(rest);
      if (word) {
        tokens.push({ kind: 'word', text: word[0], value: word[0], ...pos });
        col += word[0].length;
        continue;
      }
      throw new DqlParseError(`解釈できない文字 '${one}'`, pos.line, pos.column, 1);
    }
  }
  return tokens;
}

// ---- パーサー -------------------------------------------------------------------

function keywordOf(tok: Token): string | null {
  return tok.kind === 'word' ? tok.text.toLowerCase() : null;
}

const CLAUSE_KEYWORDS = new Set(['from', 'where', 'sort', 'limit']);

function unexpected(tok: Token | undefined, expected: string, fallbackLine = 1, fallbackCol = 1): never {
  if (tok === undefined) {
    throw new DqlParseError(`クエリが途中で終わっています — ${expected}`, fallbackLine, fallbackCol, 1);
  }
  throw new DqlParseError(
    `予期しないトークン '${tok.text}' — ${expected}`,
    tok.line,
    tok.column,
    tok.text.length,
  );
}

/** DQL クエリ文字列を AST にパースする。失敗は DqlParseError (位置情報付き)。 */
export function parseQuery(query: string): DqlQuery {
  const tokens = tokenize(query);
  let i = 0;
  const peek = (): Token | undefined => tokens[i];
  const next = (): Token | undefined => tokens[i++];

  const head = next();
  const headKw = head === undefined ? null : keywordOf(head);
  if (headKw !== 'list' && headKw !== 'table' && headKw !== 'task') {
    unexpected(head, "'LIST' / 'TABLE' / 'TASK' のいずれかで始めてください");
  }
  const type = headKw === 'list' ? 'list' : headKw === 'table' ? 'table' : 'task';

  // TABLE の列リスト: TABLE f1, f2, ... (FROM/WHERE/SORT の手前まで)
  const fields: string[] = [];
  if (type === 'table') {
    for (;;) {
      const tok = peek();
      if (tok === undefined) break;
      const kw = keywordOf(tok);
      if (kw !== null && CLAUSE_KEYWORDS.has(kw) && fields.length > 0) break;
      if (tok.kind !== 'word') {
        unexpected(tok, 'TABLE の列フィールド名を想定');
      }
      if (kw !== null && CLAUSE_KEYWORDS.has(kw)) {
        // TABLE from ... のように列なしは不可 (dataview は TABLE 単独可だが
        // 「TABLE fields」のサブセットとして列必須にする — 対応外は明確なエラー)
        unexpected(tok, "TABLE には列フィールドが必要です (例: TABLE status, updated)");
      }
      fields.push(tok.text);
      i += 1;
      const sep = peek();
      if (sep?.kind === 'comma') {
        i += 1;
        continue;
      }
      break;
    }
    if (fields.length === 0) {
      unexpected(peek(), 'TABLE には列フィールドが必要です (例: TABLE status, updated)');
    }
  }

  let from: DqlSource | null = null;
  const where: DqlCondition[] = [];
  let sort: DqlQuery['sort'] = null;
  let limit: number | null = null;

  const parseValue = (): string | number | boolean => {
    const tok = next();
    if (tok === undefined) unexpected(tok, '比較する値 (文字列 "..." / 数値 / true / false) を想定');
    if (tok.kind === 'string') return String(tok.value);
    if (tok.kind === 'number') return Number(tok.value);
    const kw = keywordOf(tok);
    if (kw === 'true') return true;
    if (kw === 'false') return false;
    unexpected(tok, '比較する値 (文字列 "..." / 数値 / true / false) を想定');
  };

  const parseCondition = (): DqlCondition => {
    const tok = next();
    if (tok === undefined) unexpected(tok, 'WHERE の条件 (フィールド名) を想定');
    if (tok.kind === 'bang') {
      const field = next();
      if (field === undefined || field.kind !== 'word') {
        unexpected(field ?? tok, "'!' の後にフィールド名を想定");
      }
      return { kind: 'truthy', field: field.text, negated: true };
    }
    if (tok.kind !== 'word') {
      unexpected(tok, 'WHERE の条件 (フィールド名) を想定');
    }
    const field = tok.text;
    const opTok = peek();
    if (opTok === undefined) return { kind: 'truthy', field, negated: false };
    if (opTok.kind === 'op') {
      i += 1;
      return { kind: 'compare', field, op: opTok.text as DqlComparisonOp, value: parseValue() };
    }
    const opKw = keywordOf(opTok);
    if (opKw === 'contains') {
      i += 1;
      return { kind: 'compare', field, op: 'contains', value: parseValue() };
    }
    // 次が and / 節キーワード / 終端なら bare truthy 条件
    if (opKw === 'and' || (opKw !== null && CLAUSE_KEYWORDS.has(opKw))) {
      return { kind: 'truthy', field, negated: false };
    }
    unexpected(opTok, "演算子 (= != > < >= <= contains) / 'and' / 節キーワードを想定");
  };

  for (;;) {
    const tok = next();
    if (tok === undefined) break;
    const kw = keywordOf(tok);
    if (kw === 'from') {
      if (from !== null) unexpected(tok, "FROM 節は 1 つだけ指定できます");
      const src = next();
      if (src?.kind === 'tag') {
        from = { kind: 'tag', tag: String(src.value).normalize('NFC') };
      } else if (src?.kind === 'string') {
        from = {
          kind: 'folder',
          folder: String(src.value).normalize('NFC').replace(/^\/+|\/+$/g, ''),
        };
      } else {
        unexpected(src ?? tok, "FROM には #タグ か \"フォルダ\" を指定してください");
      }
    } else if (kw === 'where') {
      if (where.length > 0) unexpected(tok, 'WHERE 節は 1 つだけ指定できます');
      where.push(parseCondition());
      for (;;) {
        const nextTok = peek();
        if (nextTok === undefined || keywordOf(nextTok) !== 'and') break;
        i += 1;
        where.push(parseCondition());
      }
    } else if (kw === 'sort') {
      if (sort !== null) unexpected(tok, 'SORT 節は 1 つだけ指定できます');
      const field = next();
      if (field === undefined || field.kind !== 'word') {
        unexpected(field ?? tok, 'SORT にはフィールド名を指定してください');
      }
      let direction: 'asc' | 'desc' = 'asc';
      const dir = peek();
      const dirKw = dir === undefined ? null : keywordOf(dir);
      if (dirKw === 'asc' || dirKw === 'desc') {
        direction = dirKw;
        i += 1;
      }
      sort = { field: field.text, direction };
    } else if (kw === 'limit') {
      if (limit !== null) unexpected(tok, 'LIMIT 節は 1 つだけ指定できます');
      const numTok = next();
      if (numTok === undefined) {
        throw new DqlParseError(
          'LIMIT には 0 以上の整数を指定してください',
          tok.line,
          tok.column + tok.text.length + 1,
          1,
        );
      }
      if (numTok.kind !== 'number') {
        throw new DqlParseError(
          `LIMIT には 0 以上の整数を指定してください — '${numTok.text}' は整数ではありません`,
          numTok.line,
          numTok.column,
          numTok.text.length,
        );
      }
      const n = numTok.value as number;
      if (!Number.isInteger(n) || n < 0) {
        throw new DqlParseError(
          `LIMIT には 0 以上の整数を指定してください — ${numTok.text} は無効です (負値または小数は不可)`,
          numTok.line,
          numTok.column,
          numTok.text.length,
        );
      }
      limit = n;
    } else {
      unexpected(tok, "'from' / 'where' / 'sort' / 'limit' のいずれかを想定");
    }
  }

  return { type, fields, from, where, sort, limit };
}

// ---- 評価器 ---------------------------------------------------------------------

/** クエリ対象のノート 1 件 (server の VaultIndex が供給する読み取り専用ビュー)。 */
export interface QueryableNote {
  /** vault 相対パス (NFC) */
  path: string;
  title: string;
  /** 親フォルダ ("" = ルート直下) */
  folder: string;
  /** ファイル mtime (ms epoch) */
  mtime: number;
  /** インライン #tag + frontmatter tags (NFC、# なし) */
  tags: string[];
  frontmatter: Record<string, unknown> | null;
  tasks: NoteTask[];
}

type FieldValue = string | number | boolean | string[] | null;

/** フィールド値の解決。組み込み (file.*) + frontmatter 任意キー + tags。 */
function noteField(note: QueryableNote, field: string): FieldValue {
  const key = field.toLowerCase();
  if (key === 'file.name') return note.title;
  if (key === 'file.folder') return note.folder;
  if (key === 'file.path') return note.path;
  if (key === 'file.mtime') return note.mtime;
  if (key === 'tags' || key === 'file.tags') return note.tags;
  if (key === 'file.tasks') return note.tasks.length;
  if (key === 'file.open_tasks') return note.tasks.filter((t) => !t.checked).length;
  const raw = note.frontmatter?.[field] ?? note.frontmatter?.[key];
  return toFieldValue(raw);
}

/** frontmatter の unknown 値をクエリで扱える形に落とす。 */
function toFieldValue(raw: unknown): FieldValue {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (raw instanceof Date) return raw.getTime();
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }
  return null;
}

/** タスク行のコンテキストではタスク組み込みフィールドを先に解決する。 */
function taskField(note: QueryableNote, task: NoteTask, field: string): FieldValue {
  const key = field.toLowerCase();
  if (key === 'completed' || key === 'checked') return task.checked;
  if (key === 'text') return task.text;
  if (key === 'line') return task.line;
  // Se3b7a2-3: Dataview インラインフィールド (status / priority / due) を解決する。
  // null フィールドは欠損扱い — compare/truthy の欠損ルール (null-false) に従う。
  if (key === 'status') return task.status;
  if (key === 'priority') return task.priority;
  if (key === 'due') return task.due;
  return noteField(note, field);
}

/**
 * mtime のような ms epoch フィールドを日付文字列 ("2026-07-01") と比較できるよう、
 * 片方が数値・片方が日付文字列なら文字列側を epoch に変換する。
 */
function alignForCompare(a: FieldValue, b: string | number | boolean): [FieldValue, string | number | boolean] {
  if (typeof a === 'number' && typeof b === 'string') {
    const t = /^\d{4}-\d{2}-\d{2}/.test(b) ? Date.parse(b) : Number.NaN;
    if (!Number.isNaN(t)) return [a, t];
  }
  return [a, b];
}

function compare(op: DqlComparisonOp, rawField: FieldValue, rawValue: string | number | boolean): boolean {
  if (op === 'contains') {
    if (Array.isArray(rawField)) {
      const needle = String(rawValue).normalize('NFC').toLowerCase();
      return rawField.some((v) => v.normalize('NFC').toLowerCase() === needle);
    }
    if (typeof rawField === 'string') {
      return rawField.normalize('NFC').includes(String(rawValue).normalize('NFC'));
    }
    return false;
  }
  const [field, value] = alignForCompare(rawField, rawValue);
  if (field === null || Array.isArray(field)) {
    // 欠損フィールドは != のみ true (dataview 同様「値が異なる」扱い)、他は false
    return op === '!=' ? true : false;
  }
  if (op === '=' || op === '!=') {
    const eq =
      typeof field === 'string' && typeof value === 'string'
        ? field.normalize('NFC') === value.normalize('NFC')
        : field === value;
    return op === '=' ? eq : !eq;
  }
  // 順序比較: 両方数値なら数値、そうでなければ文字列 (ISO 日付は文字列比較で正しい)
  if (typeof field === 'number' && typeof value === 'number') {
    if (op === '>') return field > value;
    if (op === '<') return field < value;
    if (op === '>=') return field >= value;
    return field <= value;
  }
  const fs = String(field).normalize('NFC');
  const vs = String(value).normalize('NFC');
  if (op === '>') return fs > vs;
  if (op === '<') return fs < vs;
  if (op === '>=') return fs >= vs;
  return fs <= vs;
}

function truthy(v: FieldValue): boolean {
  if (v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return v !== 0;
  return v;
}

function matchesCondition(cond: DqlCondition, resolve: (field: string) => FieldValue): boolean {
  if (cond.kind === 'truthy') {
    const v = truthy(resolve(cond.field));
    return cond.negated ? !v : v;
  }
  return compare(cond.op, resolve(cond.field), cond.value);
}

function matchesFrom(note: QueryableNote, from: DqlSource | null): boolean {
  if (from === null) return true;
  if (from.kind === 'tag') {
    const key = from.tag.toLowerCase();
    // ネストタグ: #dev は dev/api にもマッチ (listNotes と同じ Obsidian 互換規則)
    return note.tags.some((t) => {
      const k = t.normalize('NFC').toLowerCase();
      return k === key || k.startsWith(`${key}/`);
    });
  }
  const folder = from.folder;
  return note.folder === folder || note.folder.startsWith(`${folder}/`);
}

/** ソート比較 (欠損値は常に末尾)。 */
function sortCompare(a: FieldValue, b: FieldValue, direction: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // 欠損は方向に関わらず末尾
  if (b === null) return -1;
  const av = Array.isArray(a) ? a.join(',') : a;
  const bv = Array.isArray(b) ? b.join(',') : b;
  let cmp: number;
  if (typeof av === 'number' && typeof bv === 'number') {
    cmp = av - bv;
  } else {
    const as = String(av).normalize('NFC');
    const bs = String(bv).normalize('NFC');
    cmp = as < bs ? -1 : as > bs ? 1 : 0;
  }
  return direction === 'desc' ? -cmp : cmp;
}

/** TABLE セル値のシリアライズ (string[] はタグ等の配列表示用にそのまま渡す)。 */
function toCellValue(v: FieldValue): TableCellValue {
  return v;
}

/**
 * パース済みクエリをノート集合に対して実行する (純関数)。
 * 返り値はそのまま POST /api/query のレスポンスになる。
 */
export function executeQuery(ast: DqlQuery, notes: readonly QueryableNote[]): QueryResponse {
  const candidates = notes.filter((n) => matchesFrom(n, ast.from));

  if (ast.type === 'task') {
    const hits: { note: QueryableNote; task: NoteTask }[] = [];
    for (const note of candidates) {
      for (const task of note.tasks) {
        const ok = ast.where.every((cond) =>
          matchesCondition(cond, (f) => taskField(note, task, f)),
        );
        if (ok) hits.push({ note, task });
      }
    }
    hits.sort((a, b) => {
      if (ast.sort !== null) {
        const cmp = sortCompare(
          taskField(a.note, a.task, ast.sort.field),
          taskField(b.note, b.task, ast.sort.field),
          ast.sort.direction,
        );
        if (cmp !== 0) return cmp;
      }
      // 既定 / 同値: パス昇順 → 行番号昇順 (安定した表示のため)
      if (a.note.path !== b.note.path) return a.note.path < b.note.path ? -1 : 1;
      return a.task.line - b.task.line;
    });
    const limitedHits = ast.limit !== null ? hits.slice(0, ast.limit) : hits;
    const rows: TaskQueryRow[] = limitedHits.map(({ note, task }) => ({
      path: note.path,
      title: note.title,
      line: task.line,
      text: task.text,
      checked: task.checked,
      indent: task.indent,
      // Se3b7a2-3: Dataview インラインフィールド (ADR-0029)
      status: task.status,
      priority: task.priority,
      due: task.due,
    }));
    return { type: 'task', results: rows };
  }

  const matched = candidates.filter((n) =>
    ast.where.every((cond) => matchesCondition(cond, (f) => noteField(n, f))),
  );
  matched.sort((a, b) => {
    if (ast.sort !== null) {
      const cmp = sortCompare(
        noteField(a, ast.sort.field),
        noteField(b, ast.sort.field),
        ast.sort.direction,
      );
      if (cmp !== 0) return cmp;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const limited = ast.limit !== null ? matched.slice(0, ast.limit) : matched;

  if (ast.type === 'list') {
    return {
      type: 'list',
      results: limited.map((n) => ({ path: n.path, title: n.title, folder: n.folder })),
    };
  }

  const rows: TableQueryRow[] = limited.map((n) => ({
    path: n.path,
    title: n.title,
    folder: n.folder,
    values: ast.fields.map((f) => toCellValue(noteField(n, f))),
  }));
  return { type: 'table', fields: ast.fields, results: rows };
}

/** パース + 実行のショートカット (構文エラーは DqlParseError を送出)。 */
export function runQuery(query: string, notes: readonly QueryableNote[]): QueryResponse {
  return executeQuery(parseQuery(query), notes);
}
