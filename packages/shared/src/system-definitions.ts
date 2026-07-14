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
import { parse as parseYaml } from 'yaml';
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
