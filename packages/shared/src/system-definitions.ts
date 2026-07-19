/**
 * system/ フォルダの per-item 定義スキーマとパースユーティリティ (Sa10026-1-1)。
 *
 * ADR-0010 (2026-07-14 amendment) に従い、種別ごとに格納形式を分ける:
 *   - スマートフォルダ: system/smart-folders/*.yaml (純 YAML)
 *   - スマートコマンド: system/commands/*.yaml      (純 YAML)
 *   - テンプレート    : system/templates/*.md        (.md + YAML frontmatter)
 *
 * フィールド:
 *   title  — 表示名 (任意。省略時はファイル stem)
 *   order  — 安定ソート用整数 (任意。欠落は末尾)
 *   icon   — 任意アイコン文字列
 *   query  — DQL 文字列 (smart-folder のみ)
 *
 * [AC-Sa10026-1-1] zod 検証、不正時は既定/空フォールバック。
 * [AC-Sa10026-1-2] order → ファイル名の安定ソート。
 * [AC-Sa10026-1-3] system/ 配下のパスも normalizeVaultFilePath 経由で vault 外脱出を防ぐ。
 */
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseNote } from './markdown.js';
import { normalizeVaultFilePath, VaultPathError } from './path.js';

// ---- システム定義フォルダ名 ----

export const SYSTEM_DIR = 'system';
export const SYSTEM_SMART_FOLDERS_DIR = `${SYSTEM_DIR}/smart-folders`;
export const SYSTEM_COMMANDS_DIR = `${SYSTEM_DIR}/commands`;
export const SYSTEM_TEMPLATES_DIR = `${SYSTEM_DIR}/templates`;

// ---- 純 YAML 定義 (smart-folder / command) の zod スキーマ ----

/**
 * system/smart-folders/*.yaml の 1 ファイルのスキーマ。
 * DQL クエリを query: フィールドに文字列で保持する (ADR-0010 amendment)。
 * [AC-Sa10026-1-1]
 */
export const systemSmartFolderYamlSchema = z.object({
  /** 表示名。省略時はファイル stem。 */
  title: z.string().optional(),
  /** 並び順 (整数)。欠落は末尾扱い。 */
  order: z.number().int().optional(),
  /** アイコン文字列 (任意)。 */
  icon: z.string().optional(),
  /** DQL クエリ文字列 (必須)。 */
  query: z.string().min(1, 'query must not be empty'),
});
export type SystemSmartFolderYaml = z.infer<typeof systemSmartFolderYamlSchema>;

/**
 * system/commands/*.yaml の 1 ファイルのスキーマ。
 * コマンド本体は steps を含む LoamiumCommand 構造だが、
 * このスキーマは system/ 層が管理するメタフィールドのみを扱う。
 * 実行ロジックは既存の loamium-command.ts の parseLoamiumCommandFileWithError が担う。
 * [AC-Sa10026-1-1]
 */
export const systemCommandYamlSchema = z.object({
  /** 表示名 (パレット表示用)。省略時はファイル stem。 */
  title: z.string().optional(),
  /** 並び順 (整数)。欠落は末尾扱い。 */
  order: z.number().int().optional(),
  /** アイコン文字列 (任意)。 */
  icon: z.string().optional(),
});
export type SystemCommandYaml = z.infer<typeof systemCommandYamlSchema>;

/**
 * system/templates/*.md の frontmatter に含まれるメタフィールドのスキーマ。
 * テンプレート本体 (loamium-template: ...) は template-note.ts の parseTemplateConfig が担う。
 * [AC-Sa10026-1-1]
 */
export const systemTemplateFrontmatterSchema = z.object({
  /** 表示名 (任意)。省略時はファイル stem。 */
  title: z.string().optional(),
  /** 並び順 (整数)。欠落は末尾扱い。 */
  order: z.number().int().optional(),
  /** アイコン文字列 (任意)。 */
  icon: z.string().optional(),
});
export type SystemTemplateFrontmatter = z.infer<typeof systemTemplateFrontmatterSchema>;

// ---- 解析結果型 ----

/** system/smart-folders/*.yaml の 1 ファイルを解析した結果。 */
export interface SystemSmartFolderDef {
  /** ファイル stem (拡張子なし)。安定識別子として使う。 */
  id: string;
  /** vault 相対パス。例: "system/smart-folders/todo.yaml" */
  path: string;
  /** 表示名 (title フィールド、省略時は id)。 */
  title: string;
  /** 並び順 (欠落は undefined → ソート時は末尾)。 */
  order: number | undefined;
  /** アイコン文字列 (任意)。 */
  icon: string | undefined;
  /** DQL クエリ文字列。 */
  query: string;
}

/** system/commands/*.yaml の 1 ファイルを解析したメタ情報。 */
export interface SystemCommandDef {
  /** ファイル stem (拡張子なし)。安定識別子として使う。 */
  id: string;
  /** vault 相対パス。例: "system/commands/create-todo.yaml" */
  path: string;
  /** 表示名 (title フィールド、省略時は id)。 */
  title: string;
  /** 並び順 (欠落は undefined → ソート時は末尾)。 */
  order: number | undefined;
  /** アイコン文字列 (任意)。 */
  icon: string | undefined;
}

/** system/templates/*.md の 1 ファイルを解析したメタ情報。 */
export interface SystemTemplateDef {
  /** ファイル stem (拡張子なし)。 */
  id: string;
  /** vault 相対パス。例: "system/templates/weekly.md" */
  path: string;
  /** 表示名 (title フィールド、省略時は id)。 */
  title: string;
  /** 並び順 (欠落は undefined → ソート時は末尾)。 */
  order: number | undefined;
  /** アイコン文字列 (任意)。 */
  icon: string | undefined;
}

// ---- 純 YAML パース (smart-folder / command) ----

/**
 * 純 YAML テキストをパースして SystemSmartFolderYaml を返す (寛容 read)。
 * zod 検証失敗 / YAML パースエラー → null (呼び出し側がフォールバック判断)。
 * [AC-Sa10026-1-1]
 */
export function parseSystemSmartFolderYaml(
  yamlText: string,
): SystemSmartFolderYaml | null {
  if (yamlText.trim() === '') return null;
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const result = systemSmartFolderYamlSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

/**
 * 純 YAML テキストをパースして SystemCommandYaml を返す (寛容 read)。
 * zod 検証失敗 / YAML パースエラー → null。
 * [AC-Sa10026-1-1]
 */
export function parseSystemCommandYaml(
  yamlText: string,
): SystemCommandYaml | null {
  if (yamlText.trim() === '') return null;
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const result = systemCommandYamlSchema.safeParse(raw);
  // systemCommandYamlSchema は全フィールドが optional なので、
  // 任意の object ならほぼ成功するが、念のため null チェックを保持する
  if (!result.success) return null;
  return result.data;
}

// ---- .md + YAML frontmatter パース (template) ----

/**
 * .md テキストの frontmatter から SystemTemplateFrontmatter を抽出する (寛容 read)。
 * frontmatter なし / zod 検証失敗 → 空オブジェクト (既定フォールバック)。
 * [AC-Sa10026-1-1]
 */
export function parseSystemTemplateFrontmatter(
  mdText: string,
): SystemTemplateFrontmatter {
  const parsed = parseNote(mdText);
  if (parsed.frontmatter === null) return {};
  const result = systemTemplateFrontmatterSchema.safeParse(parsed.frontmatter);
  if (!result.success) return {};
  return result.data;
}

// ---- ファイル stem (拡張子なし) を取り出す ----

/** vault 相対パスからファイル stem を返す (例: "system/smart-folders/todo.yaml" → "todo")。 */
export function stemFromSystemPath(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  return base.replace(/\.[^.]*$/, '');
}

// ---- 安定ソート (order → ファイル名) [AC-Sa10026-1-2] ----

/**
 * order と識別子 (id) を持つアイテムを安定ソートする。
 * order が未定義のアイテムは末尾に置く。同じ order の場合はファイル名 (id) 昇順。
 * gap / tie を許容し、順序の一貫性を保証する。
 * [AC-Sa10026-1-2]
 */
export function sortSystemDefs<T extends { id: string; order: number | undefined }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const ao = a.order;
    const bo = b.order;
    // order 欠落は末尾
    if (ao === undefined && bo === undefined) {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    if (ao === undefined) return 1;
    if (bo === undefined) return -1;
    if (ao !== bo) return ao - bo;
    // 同一 order はファイル名昇順 (安定)
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---- パス検証 (AC-Sa10026-1-3) ----

/**
 * system/ 配下のパスを検証・正規化する。
 * normalizeVaultFilePath を通すことで NFC 正規化・traversal 拒否・隠しセグメント拒否を保証する。
 * 不正なパスは VaultPathError を投げる。
 * [AC-Sa10026-1-3]
 */
export function normalizeSystemPath(relPath: string): string {
  return normalizeVaultFilePath(relPath);
}

/**
 * 文字列が system/smart-folders/ 配下の .yaml ファイルかを判定する (パス検証後)。
 */
export function isSystemSmartFolderPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    relPath.startsWith(`${SYSTEM_SMART_FOLDERS_DIR}/`) &&
    (lower.endsWith('.yaml') || lower.endsWith('.yml'))
  );
}

/**
 * 文字列が system/commands/ 配下の .yaml ファイルかを判定する (パス検証後)。
 */
export function isSystemCommandPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    relPath.startsWith(`${SYSTEM_COMMANDS_DIR}/`) &&
    (lower.endsWith('.yaml') || lower.endsWith('.yml'))
  );
}

/**
 * 文字列が system/templates/ 配下の .md ファイルかを判定する (パス検証後)。
 */
export function isSystemTemplatePath(relPath: string): boolean {
  return (
    relPath.startsWith(`${SYSTEM_TEMPLATES_DIR}/`) &&
    relPath.toLowerCase().endsWith('.md')
  );
}

// ---- 変換ヘルパー (vault 相対パス + テキストから SystemDef へ) ----

/**
 * system/smart-folders/{stem}.yaml の内容を SystemSmartFolderDef へ変換する (寛容 read)。
 * YAML パース / スキーマ不合格 → null。
 * [AC-Sa10026-1-1]
 */
export function buildSystemSmartFolderDef(
  relPath: string,
  yamlText: string,
): SystemSmartFolderDef | null {
  const parsed = parseSystemSmartFolderYaml(yamlText);
  if (parsed === null) return null;
  const id = stemFromSystemPath(relPath);
  return {
    id,
    path: relPath,
    title: parsed.title ?? id,
    order: parsed.order,
    icon: parsed.icon,
    query: parsed.query,
  };
}

/**
 * system/commands/{stem}.yaml の内容を SystemCommandDef のメタ情報へ変換する (寛容 read)。
 * YAML パース失敗でも空スキーマにフォールバックし必ずメタ情報を返す。
 * コマンドの実行定義 (steps 等) は loamium-command.ts が担うため、
 * ここでは order/title/icon の抽出のみ行う。
 * [AC-Sa10026-1-1]
 */
export function buildSystemCommandDef(
  relPath: string,
  yamlText: string,
): SystemCommandDef {
  const parsed = parseSystemCommandYaml(yamlText) ?? {};
  const id = stemFromSystemPath(relPath);
  return {
    id,
    path: relPath,
    title: parsed.title ?? id,
    order: parsed.order,
    icon: parsed.icon,
  };
}

/**
 * system/templates/{stem}.md の内容を SystemTemplateDef へ変換する (寛容 read)。
 * frontmatter なし / 検証失敗でも空フォールバックで必ずメタ情報を返す。
 * [AC-Sa10026-1-1]
 */
export function buildSystemTemplateDef(
  relPath: string,
  mdText: string,
): SystemTemplateDef {
  const fm = parseSystemTemplateFrontmatter(mdText);
  const id = stemFromSystemPath(relPath);
  return {
    id,
    path: relPath,
    title: fm.title ?? id,
    order: fm.order,
    icon: fm.icon,
  };
}

// VaultPathError を再エクスポート (呼び出し側が catch できるようにする)
export { VaultPathError };

// ---- アプリ全体設定 (system/settings.yaml — ADR-0010, Sa10026-3) ----

/**
 * `system/settings.yaml` の vault 相対パス定数。
 */
export const SYSTEM_SETTINGS_PATH = `${SYSTEM_DIR}/settings.yaml`;

// ---- タスク語彙スキーマ (Se3b7a2-8 / ADR-0029) — appSettingsSchema より前に定義 ----
// (appSettingsSchema が tasks フィールドで参照するため先に宣言する)

/**
 * status の 1 エントリ (ADR-0029)。
 * key: DQL フィルタ・インラインフィールドの値として使われる識別子 (小文字英数字/ハイフン)。
 * label: UI 表示名。
 * color: オプションのカラーヒント (UI が色つきピルを描画するために使う)。
 * done: true の場合、この status はタスク完了を意味し、チェックボックスを [x] に同期する。
 */
export const taskStatusEntrySchema = z.object({
  key: z.string().min(1, 'status key must not be empty'),
  label: z.string().min(1, 'status label must not be empty'),
  color: z.string().optional(),
  done: z.boolean().optional(),
});
export type TaskStatusEntry = z.infer<typeof taskStatusEntrySchema>;

/**
 * priority の 1 エントリ (ADR-0029)。
 * key: DQL フィルタ・インラインフィールドの値として使われる識別子 (小文字英数字/ハイフン)。
 * label: UI 表示名。
 * color: オプションのカラーヒント。
 */
export const taskPriorityEntrySchema = z.object({
  key: z.string().min(1, 'priority key must not be empty'),
  label: z.string().min(1, 'priority label must not be empty'),
  color: z.string().optional(),
});
export type TaskPriorityEntry = z.infer<typeof taskPriorityEntrySchema>;

/**
 * タスク語彙のスキーマ (system/settings.yaml `tasks:` セクション — ADR-0029 / Se3b7a2-8)。
 *
 * statuses: ワークフロー status の語彙一覧。done:true フラグを持つものが「完了」を意味する。
 * priorities: 重要度 priority の語彙一覧。
 *
 * UI はこの語彙からピル/選択肢を描画する (コードに enum をハードコードしない)。
 * 語彙未設定 (null / undefined) 時は DEFAULT_TASK_VOCAB がフォールバックとして使われる。
 */
export const taskVocabSchema = z.object({
  statuses: z.array(taskStatusEntrySchema).optional(),
  priorities: z.array(taskPriorityEntrySchema).optional(),
});
export type TaskVocab = z.infer<typeof taskVocabSchema>;

/**
 * アプリ全体設定の zod スキーマ (ADR-0010: system/settings.yaml)。
 *
 * 設計原則 (ADR-0010 境界原則):
 * - ここに含めるのは「versioning + 移植 + 人/agent 編集したい」設定のみ。
 * - 端末固有・再構築可能な状態 (インデックスキャッシュ / ペイン幅 / 最後に開いたノート等)
 *   は `.loamium/` に残す。[AC-Sa10026-3-2]
 *
 * 前方互換: z.object の各フィールドは既定値付きかつ optional とし、
 * 未知キーは passthrough() で無視する (将来フィールド追加に対して backward-compatible)。
 *
 * [AC-Sa10026-3-1]
 */
export const appSettingsSchema = z.object({
  /**
   * UI テーマ。
   * - 'light'  : 常にライトテーマ
   * - 'dark'   : 常にダークテーマ
   * - 'system' : OS 設定に追従 (既定)
   */
  theme: z.enum(['light', 'dark', 'system']).default('system'),
  /**
   * 新規ノート作成モーダルの保存先デフォルトフォルダ (vault 相対、"" = ルート)。
   * 別 Story Sa10026-8 が消費する。
   */
  defaultFolder: z.string().default(''),
  /**
   * ジャーナルテンプレートの vault 相対パス。
   */
  journalTemplate: z.string().default('system/templates/journal.md'),
  /**
   * ツリービューで system/ フォルダを表示するか。
   * false が既定 (system/ はアプリ管理領域で通常は隠す)。
   * 別 Story Sa10026-4 が消費する。
   */
  showSystemFolder: z.boolean().default(false),
  /**
   * タスク語彙 (Se3b7a2-8 / ADR-0029)。
   * status/priority の選択肢と色。コードに enum をハードコードしない。
   * 未設定 (undefined) は DEFAULT_TASK_VOCAB がフォールバックとして使われる。
   */
  tasks: taskVocabSchema.optional(),
}).passthrough();

export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * `AppSettings` の既定値。`system/settings.yaml` が存在しないときに使う。
 * スキーマの既定値と同値を定数として提供する (型チェック + 参照用)。
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  defaultFolder: '',
  journalTemplate: 'system/templates/journal.md',
  showSystemFolder: false,
};

/**
 * `system/settings.yaml` の生テキストをパースして `AppSettings` を返す (寛容 read)。
 *
 * - 空テキスト / null テキスト → 既定値を返す
 * - YAML パースエラー → 既定値を返す + console.error ログ
 * - zod 検証失敗 → フィールドごとに既定値へフォールバック (schema の `.default()` が担う)
 *
 * この関数は決して例外を投げない (priority 6: アプリを止めない)。
 * [AC-Sa10026-3-1]
 */
export function parseAppSettings(yamlText: string | null | undefined): AppSettings {
  if (yamlText === null || yamlText === undefined || yamlText.trim() === '') {
    return { ...DEFAULT_APP_SETTINGS };
  }
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    console.error(`[loamium] failed to parse system/settings.yaml: ${String(err)}`);
    return { ...DEFAULT_APP_SETTINGS };
  }
  // YAML の空ドキュメント ("---\n" 等) は null を返すことがある
  if (raw === null || raw === undefined) {
    return { ...DEFAULT_APP_SETTINGS };
  }
  // 配列や非オブジェクトは不正な設定とみなし既定へ
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.error('[loamium] system/settings.yaml is not a YAML object, using defaults');
    return { ...DEFAULT_APP_SETTINGS };
  }
  const result = appSettingsSchema.safeParse(raw);
  if (result.success) {
    return result.data as AppSettings;
  }
  // 個別フィールドが壊れている場合: スキーマの .default() が機能するため
  // ここに到達するのはスキーマ構造上の parse 失敗 (通常は到達しない)。
  // 念のため既定値に落とす。
  console.error(
    `[loamium] system/settings.yaml validation error, using defaults: ${result.error.message}`,
  );
  return { ...DEFAULT_APP_SETTINGS };
}

/**
 * `AppSettings` オブジェクトを YAML テキストに変換する。
 * スキーマの未知キー (passthrough) も保持した上でシリアライズする。
 * 使用する yaml ライブラリ (packages/shared 依存済み) で stringify する。
 */
export function serializeAppSettings(settings: AppSettings): string {
  return stringifyYaml(settings);
}

// ---- タスク語彙 フォールバック + パース/シリアライズ (Se3b7a2-8 / ADR-0029) ----

/**
 * フォールバック既定語彙 (ADR-0029 decision 3 / Se3b7a2-8)。
 * statuses:   todo / progress / blocked / done (done:true)
 * priorities: highest / high / medium / low
 *
 * system/settings.yaml の `tasks:` が未設定のときに使う。
 * UI は語彙未取得中もこの既定値でピル/選択肢を描画できる。
 */
/** DEFAULT_TASK_VOCAB の具体型 (statuses/priorities が必須)。 */
export type TaskVocabRequired = {
  statuses: TaskStatusEntry[];
  priorities: TaskPriorityEntry[];
};

export const DEFAULT_TASK_VOCAB: TaskVocabRequired = {
  statuses: [
    { key: 'todo',     label: 'Todo',     color: 'gray' },
    { key: 'progress', label: 'Progress', color: 'blue' },
    { key: 'blocked',  label: 'Blocked',  color: 'red' },
    { key: 'done',     label: 'Done',     color: 'green', done: true },
  ],
  priorities: [
    { key: 'highest', label: 'Highest', color: 'red' },
    { key: 'high',    label: 'High',    color: 'amber' },
    { key: 'medium',  label: 'Medium',  color: 'blue' },
    { key: 'low',     label: 'Low',     color: 'gray' },
  ],
};

/**
 * `system/settings.yaml` の生テキストから `tasks:` セクションをパースして TaskVocab を返す。
 *
 * - 空テキスト / YAML 無し → DEFAULT_TASK_VOCAB を返す (語彙未設定)。
 * - tasks: セクションなし / 不正 → DEFAULT_TASK_VOCAB を返す (寛容 read)。
 * - tasks: セクションあり → パースして返す。statuses/priorities が欠落フィールドは既定で補う。
 *
 * この関数は決して例外を投げない (priority 6: アプリを止めない)。
 * [AC-Se3b7a2-8]
 */
export function parseTaskVocab(yamlText: string | null | undefined): TaskVocabRequired {
  const fallback = (): TaskVocabRequired => ({
    statuses: [...DEFAULT_TASK_VOCAB.statuses],
    priorities: [...DEFAULT_TASK_VOCAB.priorities],
  });
  if (yamlText === null || yamlText === undefined || yamlText.trim() === '') {
    return fallback();
  }
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch {
    return fallback();
  }
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return fallback();
  }
  const tasks = (raw as Record<string, unknown>).tasks;
  if (tasks === undefined || tasks === null) {
    return fallback();
  }
  const result = taskVocabSchema.safeParse(tasks);
  if (!result.success) {
    console.error(`[loamium] tasks vocab validation error, using defaults: ${result.error.message}`);
    return fallback();
  }
  return {
    statuses: result.data.statuses ?? DEFAULT_TASK_VOCAB.statuses,
    priorities: result.data.priorities ?? DEFAULT_TASK_VOCAB.priorities,
  };
}

/**
 * TaskVocab オブジェクトを YAML テキストに変換する (テスト用・シリアライズ確認用)。
 * `tasks:` キーを含む YAML テキストを返す。
 */
export function serializeTaskVocab(vocab: TaskVocab): string {
  return stringifyYaml({ tasks: vocab });
}
