/**
 * スマートコマンド定義 (ADR-0024 supersedes ADR-0020 / ADR-0021 / ADR-0022) の zod スキーマとパース関数。
 *
 * ADR-0024: コマンド定義は vault 内 commands/*.yaml (または .yml) ファイルとし、
 * ファイル全体が LoamiumCommand オブジェクト (トップレベルに name?/description?/params[]/steps[])。
 * loamium-command: ラッパーキーも Markdown 本文も持たない。id = 拡張子を除いたファイル stem。
 *
 * params は templates の TemplateVar と同型 (name / label / required / default /
 * type: 'string'|'text'|'date')。steps は kind による判別可能ユニオン (6 種)。
 *
 * ADR-0022: 各ステップに任意の when / when-not フィールドを追加する (additive)。
 *   - when: 値が truthy なら実行、falsey ならスキップ。
 *   - when-not: 値が falsey なら実行、truthy ならスキップ。
 *   falsey 定義: 空文字列 ("") / "false" / "0" → falsey。それ以外 → truthy。
 *   両フィールドが指定された場合は両方が「実行条件を満たす」ときのみ実行する。
 *
 * parseLoamiumCommandFile(yamlText) — ADR-0024 用: ファイル全体の YAML テキストをパースする。
 * parseLoamiumCommand(frontmatter) — ADR-0020 互換 (旧 frontmatter ベース): 後方互換のため残す。
 *   editor UI (CommandEditor.tsx) が parseLoamiumCommandWithError を呼んでいるため,
 *   その関数も旧シグネチャで残す (エディタ側の変更は別タスク)。
 */
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { agentPermissionsSchema } from './agent-capabilities.js';

// ---- ADR-0022: 条件付きステップ実行の truthiness 評価 ----

/**
 * 条件フィールド (when / when-not) の文字列 truthy 評価。
 * falsey: 空文字列 ("") / "false" / "0"
 * truthy: それ以外の任意の非空文字列
 * [AC-Sf2f114-2-1]
 */
export function evaluateCondition(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  if (trimmed === 'false') return false;
  if (trimmed === '0') return false;
  return true;
}

// ---- 条件付きステップの共通フィールド (ADR-0022) ----

/**
 * 全ステップ種別が共有する任意フィールド (additive)。
 * when / when-not は resolveTemplate 展開後に evaluateCondition で評価する。
 * フィールド名 "when-not" はハイフンを含む — YAML では有効なキー。
 */
const stepConditionFields = {
  when: z.string().optional(),
  'when-not': z.string().optional(),
} as const;

// ---- CommandParam (templates の TemplateVarDef と同型 + type 加算) ----

/**
 * コマンドパラメータの入力型。templates の TemplateVar と互換。
 * type:
 *   'string'  — デフォルト、1 行テキスト
 *   'text'    — 複数行テキスト
 *   'date'    — 日付ピッカー
 *   'select'  — ドロップダウン (options 必須)
 *   'note'    — ノートパス文字列 (ノートピッカー。実行時は vault 相対パス文字列)
 *   'boolean' — チェックボックス (実行時は 'true' / '' の文字列)
 *   'number'  — 数値入力 (実行時は数値文字列 e.g. "42")
 *
 * ADR-0022 (Sf2f114-5): select/note/boolean/number を追加 (additive)。
 * すべての型の実行時値は string として resolveTemplate に渡す (executor は変更なし)。
 * 文字列変換規約:
 *   boolean → チェック済み = 'true'、未チェック = '' (falsey)
 *   number  → 数値を文字列化 (例: "42", "3.14")
 *   note    → vault 相対パス文字列 (例: "projects/foo.md")
 *   select  → 選択した option 文字列
 * [AC-Sf2f114-5-1]
 */
export const commandParamTypeSchema = z.enum([
  'string',
  'text',
  'date',
  'select',
  'note',
  'boolean',
  'number',
]);
export type CommandParamType = z.infer<typeof commandParamTypeSchema>;

export const commandParamSchema = z
  .object({
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
    /**
     * select 型の選択肢一覧。type='select' のときは非空配列が必須。
     * 他の型では存在を許容するが実行時は無視される (additive)。
     * [AC-Sf2f114-5-1]
     */
    options: z.array(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    // select 型には options が必要 (非空)
    if (data.type === 'select') {
      if (data.options === undefined || data.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: "param type 'select' requires non-empty options array",
        });
      }
    }
  });
export type CommandParam = z.infer<typeof commandParamSchema>;

// ---- CommandStep — 判別可能ユニオン (ADR-0021, v1 = 4 種) ----

/**
 * 挿入位置の種別 (ADR-0022 / Sf2f114-3)。
 * - bottom: ファイル末尾 (デフォルト)
 * - top:    frontmatter の直後 (本文先頭)
 * - section: section フィールドで指定した ATX 見出し配下末尾 (insertUnderHeading と同義)
 */
export const insertPositionSchema = z.enum(['bottom', 'top', 'section']);
export type InsertPositionField = z.infer<typeof insertPositionSchema>;

/** journal-append: ジャーナルへ追記 (section 指定で見出し配下末尾挿入)。 */
export const journalAppendStepSchema = z.object({
  kind: z.literal('journal-append'),
  content: z.string(),
  date: z.string().optional(),
  /** 空文字列は拒否 (journalAppendRequestSchema の section と整合)。 */
  section: z.string().min(1).optional(),
  /**
   * 挿入位置 (ADR-0022 / Sf2f114-3)。省略時は後方互換挙動:
   * section あり → 'section'、なし → 'bottom'。
   */
  position: insertPositionSchema.optional(),
  open: z.boolean().optional(),
  ...stepConditionFields,
});
export type JournalAppendStep = z.infer<typeof journalAppendStepSchema>;

/**
 * note-append: ノートへの追記 (Sf2f114-3 で section/create/position を追加)。
 * [AC-Sf2f114-3-1]
 */
export const noteAppendStepSchema = z.object({
  kind: z.literal('note-append'),
  target: z.string(),
  content: z.string(),
  /**
   * ATX 見出しテキスト (例: "Todo")。指定時、対象見出し配下の末尾に挿入する。
   * 見出しが存在しなければファイル末尾に見出しごと追記する (insertUnderHeading と同義)。
   * 空文字列は拒否 (section="" を省略扱いにするのではなく、スキーマ境界で弾く)。
   */
  section: z.string().min(1).optional(),
  /**
   * true の場合、対象ノートが存在しなければ新規作成する (空コンテンツに追記)。
   * false / 省略時は既存の後方互換動作 (存在しない → ok:false 失敗)。
   */
  create: z.boolean().optional(),
  /**
   * 挿入位置 (ADR-0022 / Sf2f114-3):
   * - 省略時: section あり → 'section' と同義、なし → 'bottom'
   * - 'bottom': ファイル末尾に追記 (デフォルト)
   * - 'top': frontmatter の直後 (本文先頭) に挿入
   * - 'section': section フィールドで指定した ATX 見出し配下末尾
   */
  position: insertPositionSchema.optional(),
  open: z.boolean().optional(),
  ...stepConditionFields,
});
export type NoteAppendStep = z.infer<typeof noteAppendStepSchema>;

/** note-create: 新規ノート作成 (衝突時は連番サフィックス)。 */
export const noteCreateStepSchema = z.object({
  kind: z.literal('note-create'),
  target: z.string(),
  content: z.string(),
  open: z.boolean().optional(),
  ...stepConditionFields,
});
export type NoteCreateStep = z.infer<typeof noteCreateStepSchema>;

/** template-instantiate: 既存テンプレート機構でノート生成。 */
export const templateInstantiateStepSchema = z.object({
  kind: z.literal('template-instantiate'),
  template: z.string(),
  vars: z.record(z.string(), z.string()).optional(),
  open: z.boolean().optional(),
  ...stepConditionFields,
});
export type TemplateInstantiateStep = z.infer<typeof templateInstantiateStepSchema>;

/**
 * prop-set: ノートの frontmatter プロパティを upsert/unset する (ADR-0021)。
 * 既存の POST /api/notes/{path}/properties と同じ round-trip-safe パスを経由する。
 * target と string 値は resolveTemplate 展開される。
 * set / unset のいずれも省略された場合は no-op (ok:true を返す)。
 * MUTATE 操作 → append-only モードでは実行不可。
 * [AC-Sf2f114-4-1]
 */
export const propSetStepSchema = z.object({
  kind: z.literal('prop-set'),
  target: z.string(),
  /** 追加・更新するキー→値マップ (string | number | boolean)。string 値は resolveTemplate 展開される。 */
  set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** 削除するキー名の配列 */
  unset: z.array(z.string()).optional(),
  ...stepConditionFields,
});
export type PropSetStep = z.infer<typeof propSetStepSchema>;

/**
 * note-patch: ノート内の old テキストを new テキストで置換する (ADR-0021)。
 * 既存の POST /api/notes/{path}/patch と同じロジックを再利用する。
 * - 非マッチ → ok:false (ステップ失敗)
 * - 複数マッチ → ok:false (曖昧 — 既存パッチ API と同挙動)
 * - 全フィールドは resolveTemplate 展開される。
 * MUTATE 操作 → append-only モードでは実行不可。
 * [AC-Sf2f114-4-2]
 */
export const notePatchStepSchema = z.object({
  kind: z.literal('note-patch'),
  target: z.string(),
  old: z.string(),
  new: z.string(),
  ...stepConditionFields,
});
export type NotePatchStep = z.infer<typeof notePatchStepSchema>;

/**
 * agent-run: 賢い処理を Pi エージェントへ委譲するステップ (ADR-0028 / S5a66e4)。
 *
 * 新規ジョブ実行基盤は作らず、S2fe109 の runAgentJob (agent-job-runner.ts) を
 * 再利用して Pi セッションを起動する。結果のファイル書き込みは agent-run 独自の
 * 書き込み経路を持たず、エージェント自身が ADR-0016 の監査済み書き込みツール
 * (journal_append / note_create / note_edit) をプロンプト指示に従って使う。
 * prompt が出力先を指定する (commands.ts は書き込み先を強制しない)。
 *
 * - prompt: 必須・非空。resolveTemplate 展開対象。
 * - permissions?: 実効ケーパビリティ (step 指定 → agent.json 既定 の順で解決, ADR-0015)。
 * - maxTurns?: 1..50。省略時は agentJobSchema の既定 20 に合わせる (実行側で補完)。
 * - timeoutSec?: 10..600。省略時は agentJobSchema の既定 120 に合わせる (実行側で補完)。
 * - open?: 共通フラグ (agent-run は書き込み先が可変のため実行側では未使用だが型を揃える)。
 * - when / when-not: 共通の条件付きスキップ (ADR-0022)。
 *
 * MUTATE 相当 → append-only モードでは agent-run を含むコマンドは 403 (ADR-0028)。
 * [AC-S5a66e4-2-1]
 */
export const agentRunStepSchema = z.object({
  kind: z.literal('agent-run'),
  /** エージェントへのプロンプト。非空必須。resolveTemplate 展開対象。 */
  prompt: z.string().min(1, 'agent-run prompt must not be empty'),
  /** 実効ケーパビリティ (省略時は agent.json 既定, ADR-0015)。 */
  permissions: agentPermissionsSchema.optional(),
  /** ターン数上限。省略時は agentJobSchema 既定 (20)。 */
  maxTurns: z.number().int().min(1).max(50).optional(),
  /** 全体タイムアウト秒。省略時は agentJobSchema 既定 (120)。 */
  timeoutSec: z.number().int().min(10).max(600).optional(),
  open: z.boolean().optional(),
  ...stepConditionFields,
});
export type AgentRunStep = z.infer<typeof agentRunStepSchema>;

/**
 * CommandStep — kind による閉じた判別可能ユニオン。
 * v1 (ADR-0021) の 4 種 + v2 (ADR-0021/0010 Sf2f114-4) の 2 種
 *   + v3 (ADR-0028 / S5a66e4) の agent-run 1 種 = 7 種。
 * [AC-Sf2f114-4-3] [AC-S5a66e4-2-2]
 */
export const commandStepSchema = z.discriminatedUnion('kind', [
  journalAppendStepSchema,
  noteAppendStepSchema,
  noteCreateStepSchema,
  templateInstantiateStepSchema,
  propSetStepSchema,
  notePatchStepSchema,
  agentRunStepSchema,
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
  // zod で厳格パース (ADR-0020: 未知 kind は検証エラー)
  const result = loamiumCommandSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

/**
 * parseLoamiumCommand と同様だが、エラーメッセージを返すバージョン。
 * GET /api/commands の valid:false + error フィールドに使う。
 * ADR-0020 互換 (旧 frontmatter ベース)。
 * editor UI (CommandEditor.tsx) が現在この関数を呼んでいるため、旧シグネチャで残す。
 * (エディタ側の YAML ファイル全体パースへの切り替えは別タスク)
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

// ---- ADR-0024: ファイル全体 YAML パース ----

/**
 * commands/*.yaml ファイルの全テキストをパースして LoamiumCommand を返す (ADR-0024)。
 * ファイル全体がトップレベルの LoamiumCommand オブジェクトであることを期待する。
 * loamium-command: ラッパーキーは不要 (持つと name/params/steps が欠けるため無効になる)。
 *
 * 壊れた YAML / スキーマ不合格 / 空ファイル → null (寛容 read 側が valid:false に変換)。
 */
export function parseLoamiumCommandFile(yamlText: string): LoamiumCommand | null {
  if (yamlText.trim() === '') return null;
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  const result = loamiumCommandSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

/**
 * parseLoamiumCommandFile と同様だが、エラーメッセージを返すバージョン。
 * GET /api/commands の valid:false + error フィールドに使う (ADR-0024)。
 */
export function parseLoamiumCommandFileWithError(
  yamlText: string,
): { ok: true; command: LoamiumCommand } | { ok: false; error: string } {
  if (yamlText.trim() === '') {
    return { ok: false, error: 'empty file' };
  }
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null || raw === undefined) {
    return { ok: false, error: 'YAML parsed to null or undefined' };
  }
  const result = loamiumCommandSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    return { ok: false, error: msg };
  }
  return { ok: true, command: result.data };
}
