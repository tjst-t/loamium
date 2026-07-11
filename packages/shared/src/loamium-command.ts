/**
 * スマートコマンド定義 (ADR-0008 / ADR-0009) の zod スキーマとパース関数。
 *
 * コマンド定義は vault 内 commands/*.md の YAML frontmatter キー `loamium-command` に格納する。
 * params は templates の TemplateVar と同型 (name / label / required / default /
 * type: 'string'|'text'|'date')。steps は kind による判別可能ユニオン (4 種)。
 *
 * parseLoamiumCommand(frontmatter) は parseTemplateConfig と同じスタイル:
 *   - Record<string, unknown> frontmatter を受け取る
 *   - 壊れた定義はクラッシュせず null を返す (一覧の寛容 read 側が valid:false に変換)
 *   - 正常ならば LoamiumCommand を返す
 */
import { z } from 'zod';

// ---- CommandParam (templates の TemplateVarDef と同型 + type 加算) ----

/**
 * コマンドパラメータの入力型。templates の TemplateVar と互換。
 * type: 'string' (デフォルト、1 行テキスト) | 'text' (複数行) | 'date'。
 */
export const commandParamTypeSchema = z.enum(['string', 'text', 'date']);
export type CommandParamType = z.infer<typeof commandParamTypeSchema>;

export const commandParamSchema = z.object({
  /** パラメータ名 (= {{name}} の name)。 */
  name: z.string().min(1, 'param name must not be empty'),
  /** 表示ラベル (省略時は name)。 */
  label: z.string().optional(),
  /** 必須か (未入力なら run は 4xx)。 */
  required: z.boolean().optional(),
  /** 既定値 (date は {{date:YYYY-MM-DD}} 等も可)。 */
  default: z.string().optional(),
  /** 入力ウィジェット種別。 */
  type: commandParamTypeSchema.optional(),
});
export type CommandParam = z.infer<typeof commandParamSchema>;

// ---- CommandStep — 判別可能ユニオン (ADR-0009, v1 = 4 種) ----

/** journal-append: ジャーナルへ追記 (section 指定で見出し配下末尾挿入)。 */
export const journalAppendStepSchema = z.object({
  kind: z.literal('journal-append'),
  content: z.string(),
  date: z.string().optional(),
  /** 空文字列は拒否 (journalAppendRequestSchema の section と整合)。 */
  section: z.string().min(1).optional(),
  open: z.boolean().optional(),
});
export type JournalAppendStep = z.infer<typeof journalAppendStepSchema>;

/** note-append: 既存ノート末尾へ追記。 */
export const noteAppendStepSchema = z.object({
  kind: z.literal('note-append'),
  target: z.string(),
  content: z.string(),
  open: z.boolean().optional(),
});
export type NoteAppendStep = z.infer<typeof noteAppendStepSchema>;

/** note-create: 新規ノート作成 (衝突時は連番サフィックス)。 */
export const noteCreateStepSchema = z.object({
  kind: z.literal('note-create'),
  target: z.string(),
  content: z.string(),
  open: z.boolean().optional(),
});
export type NoteCreateStep = z.infer<typeof noteCreateStepSchema>;

/** template-instantiate: 既存テンプレート機構でノート生成。 */
export const templateInstantiateStepSchema = z.object({
  kind: z.literal('template-instantiate'),
  template: z.string(),
  vars: z.record(z.string(), z.string()).optional(),
  open: z.boolean().optional(),
});
export type TemplateInstantiateStep = z.infer<typeof templateInstantiateStepSchema>;

/** CommandStep — kind による閉じた判別可能ユニオン (ADR-0009 v1 の 4 種)。 */
export const commandStepSchema = z.discriminatedUnion('kind', [
  journalAppendStepSchema,
  noteAppendStepSchema,
  noteCreateStepSchema,
  templateInstantiateStepSchema,
]);
export type CommandStep = z.infer<typeof commandStepSchema>;

// ---- LoamiumCommand (frontmatter loamium-command の値) ----

export const loamiumCommandSchema = z.object({
  /** パレット表示名。省略時はファイル名 (拡張子なし)。 */
  name: z.string().optional(),
  /** パレットのサブテキスト。 */
  description: z.string().optional(),
  /** 実行前フォームの入力定義。 */
  params: z.array(commandParamSchema).optional().default([]),
  /** 順次実行されるステップ列。1 個以上必須 (lax: 実行時検証、一覧時はスキーマ通りに受け入れる)。 */
  steps: z.array(commandStepSchema).min(1, 'steps must have at least one step'),
});
export type LoamiumCommand = z.infer<typeof loamiumCommandSchema>;

// ---- parseLoamiumCommand ----

/**
 * frontmatter から loamium-command 設定を厳格に取り出す。
 * 壊れていれば null を返す (一覧の寛容 read 側が valid:false + error に変換する)。
 * parseTemplateConfig と同スタイル: Record<string, unknown> frontmatter を受け取る。
 */
export function parseLoamiumCommand(
  frontmatter: Record<string, unknown> | null,
): LoamiumCommand | null {
  if (frontmatter === null) return null;
  const raw = frontmatter['loamium-command'];
  if (raw === undefined) return null;
  // zod で厳格パース (ADR-0008: 未知 kind は検証エラー)
  const result = loamiumCommandSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

/**
 * parseLoamiumCommand と同様だが、エラーメッセージを返すバージョン。
 * GET /api/commands の valid:false + error フィールドに使う。
 */
export function parseLoamiumCommandWithError(
  frontmatter: Record<string, unknown> | null,
): { ok: true; command: LoamiumCommand } | { ok: false; error: string } {
  if (frontmatter === null) {
    return { ok: false, error: 'no frontmatter found' };
  }
  const raw = frontmatter['loamium-command'];
  if (raw === undefined) {
    return { ok: false, error: 'loamium-command key not found in frontmatter' };
  }
  const result = loamiumCommandSchema.safeParse(raw);
  if (!result.success) {
    // zod エラーを人間可読な文字列にまとめる
    const msg = result.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    return { ok: false, error: msg };
  }
  return { ok: true, command: result.data };
}
