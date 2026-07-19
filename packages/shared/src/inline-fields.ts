/**
 * Dataview インラインフィールドパーサー (Se3b7a2-1 / ADR-0029)。
 *
 * Obsidian Dataview 互換の `[key:: value]` 構文を行末から抽出・操作する。
 * 対象フィールドは status / priority / due の 3 種のみ。
 *
 * 原則:
 * - 正本 (Markdown 文字列) を変更しない読み取り専用ビュー (extractInlineFields)。
 * - setInlineField は old→new テキストを返すだけで書き込みはしない。
 *   書き込みは ADR-0016 の patchNote 経由 (POST /api/notes/{path}/patch)。
 * - チェックボックス `- [ ]` / `- [x]` は完了/未完了のみを示す (ADR-0029 decision 1)。
 *   status/priority/due は独立した Dataview インラインフィールドとして保存する。
 * - インラインコード (`...`) 内のフィールドは無視する (blankInlineCode で空白化)。
 * - due 日付は YYYY-MM-DD 形式のみ認め、それ以外は null を返す。
 * - status/priority の値は NFC 正規化後に小文字化して返す (大文字入力を許容)。
 */

// ---- インラインコード空白化 (extract.ts と同一ロジック) -------------------------

/**
 * 1 行からインラインコード (`...`) スパンを同じ長さの空白に置き換える。
 * 行番号・桁位置を保ったままフィールド検出だけを無効化する。
 */
function blankInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

// ---- フィールド抽出 正規表現 ----------------------------------------------------

/**
 * `[key:: value]` をマッチする正規表現 (グローバル)。
 * key は英小文字のみ (Obsidian Dataview の慣習)。
 * value は `]` を含まない任意の文字列。
 */
const INLINE_FIELD_RE = /\[([a-zA-Z][a-zA-Z0-9_-]*)::[ \t]*([^\]]*)\]/g;

/**
 * YYYY-MM-DD 日付形式の厳格な検証正規表現。
 * 文字列全体がこの形式であることを確認する (前後に余分な文字があれば null を返す)。
 */
const DUE_DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

// ---- 公開型 -------------------------------------------------------------------

/**
 * 1 行から抽出したインラインフィールドの 3 種。
 * フィールドが存在しない場合は null。
 */
export interface InlineFields {
  /** `[status:: ...]` の値 (NFC 正規化後 toLowerCase)。なければ null。 */
  status: string | null;
  /** `[priority:: ...]` の値 (NFC 正規化後 toLowerCase)。なければ null。 */
  priority: string | null;
  /** `[due:: YYYY-MM-DD]` の値。形式不正 / なければ null。 */
  due: string | null;
}

// ---- extractInlineFields -------------------------------------------------------

/**
 * 1 行から status / priority / due の Dataview インラインフィールドを抽出する。
 *
 * - インラインコード (`...`) 内のフィールドは無視する。
 * - 同じキーが複数あれば最初のものを採用する。
 * - status/priority の値は NFC 正規化後 toLowerCase して返す。
 * - due は YYYY-MM-DD 形式のみ認め、それ以外は null を返す。
 *
 * [AC-Se3b7a2-1-1]
 */
export function extractInlineFields(line: string): InlineFields {
  const scan = blankInlineCode(line);

  let status: string | null = null;
  let priority: string | null = null;
  let due: string | null = null;

  INLINE_FIELD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_FIELD_RE.exec(scan)) !== null) {
    const key = (m[1] ?? '').toLowerCase();
    const rawValue = (m[2] ?? '').trim();

    if (key === 'status' && status === null) {
      if (rawValue.length > 0) {
        status = rawValue.normalize('NFC').toLowerCase();
      }
    } else if (key === 'priority' && priority === null) {
      if (rawValue.length > 0) {
        priority = rawValue.normalize('NFC').toLowerCase();
      }
    } else if (key === 'due' && due === null) {
      // due は YYYY-MM-DD 形式のみ
      const normalized = rawValue.normalize('NFC');
      if (DUE_DATE_RE.test(normalized)) {
        due = normalized;
      }
      // 形式不正は null のまま
    }
  }

  return { status, priority, due };
}

// ---- setInlineField -----------------------------------------------------------

/**
 * 行テキスト内の指定インラインフィールドを set/replace/remove する。
 *
 * - `value` が null または undefined → 該当フィールドを行から削除する。
 * - 既存フィールドがあれば置換する。
 * - 既存フィールドがなく value が非 null → 行末に追記する。
 * - 他のフィールドや行テキストは変更しない (ピュア Markdown 保持)。
 *
 * 返り値は新しい行テキスト。書き込みは呼び出し側が行う (ADR-0016 patchNote 経由)。
 *
 * [AC-Se3b7a2-1-1 / Se3b7a2-2-1]
 */
export function setInlineField(line: string, key: string, value: string | null | undefined): string {
  const normalizedKey = key.toLowerCase();
  // インラインフィールドのマッチ正規表現 (単一キー, 大文字小文字両対応)
  const fieldRe = new RegExp(
    `\\[${escapeRegExp(normalizedKey)}::[ \\t]*([^\\]]*?)\\]`,
    'gi',
  );

  const existing = fieldRe.exec(line);
  const hasExisting = existing !== null;

  if (value === null || value === undefined) {
    // フィールドを削除 (存在しなければ変更なし)
    if (!hasExisting) return line;
    fieldRe.lastIndex = 0;
    // 前後のスペースも含めてきれいに除去する
    return line
      .replace(
        new RegExp(`[ \\t]*\\[${escapeRegExp(normalizedKey)}::[ \\t]*[^\\]]*?\\]`, 'gi'),
        '',
      )
      .trimEnd();
  }

  if (hasExisting) {
    // 既存フィールドを置換
    fieldRe.lastIndex = 0;
    return line.replace(
      new RegExp(`\\[${escapeRegExp(normalizedKey)}::[ \\t]*[^\\]]*?\\]`, 'gi'),
      `[${normalizedKey}:: ${value}]`,
    );
  }

  // 行末に追記 (末尾スペースは trim してから追加)
  return `${line.trimEnd()} [${normalizedKey}:: ${value}]`;
}

// ---- 内部ヘルパー ---------------------------------------------------------------

/** RegExp の特殊文字をエスケープする。 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
