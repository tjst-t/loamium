/**
 * ローカル推論モデルの配置先パスを一元管理するヘルパー (ADR-0025 / S8a3f2e-1)。
 *
 * モデルは `.loamium/models/` 配下を「モデル種別」のサブフォルダに分けて置く
 * (ADR-0025 amendment 2026-07-16):
 *   - `.loamium/models/llm/` — LLM GGUF (node-llama-cpp が読む)
 *   - `.loamium/models/asr/` — 音声認識 (将来の Whisper 等)
 *
 * `.loamium/*` は .gitignore 済みで、models/ は再包含していない。つまり
 * インデックス / エージェントセッションと同格の「消しても vault は無傷」な
 * 使い捨て資産 (ADR-0010 / ADR-0011 と整合)。
 *
 * 実ファイル I/O は vaultRoot 起点。パス結合はここに集約し、他モジュールが
 * `.loamium/models/...` を直接組み立てないようにする (種別サブフォルダの
 * 一元化 = AC-S8a3f2e-1-4)。
 */
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

/** モデル種別。サブフォルダ名にそのまま使う。 */
export type ModelKind = 'llm' | 'asr';

/**
 * モデルファイル名の許可リスト正規表現 (S8a3f2e-3 / AC-S8a3f2e-3-3)。
 * 英数・ハイフン・アンダースコア・ドットのみ。パス区切り (/ \\)・`..`・
 * 先頭ドット (隠しファイル) を含む名前は許可しない。ファイルシステムに触れる
 * *前* にこの検証を通し、パストラバーサル / サブフォルダ脱出を封じる。
 */
const MODEL_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** モデルファイル名の検証エラー (呼び出し元が 400 を返す)。 */
export class InvalidModelFilenameError extends Error {
  constructor(fileName: string) {
    super(`invalid model filename: ${JSON.stringify(fileName)}`);
    this.name = 'InvalidModelFilenameError';
  }
}

/**
 * モデルファイル名が安全か検証する (I/O なし・純粋)。
 * - 許可文字のみ (英数 . _ -)、先頭は英数、パス区切り不可。
 * - `..` を含まない (念のため二重に禁止)。
 * 不正なら false。呼び出し元は false で 400 を返し、FS に触れないこと。
 */
export function isValidModelFileName(fileName: string): boolean {
  if (fileName.length === 0) return false;
  if (fileName.includes('..')) return false;
  return MODEL_FILENAME_RE.test(fileName);
}

/**
 * 検証済みのモデルファイル名から絶対パスを返す。不正名は
 * `InvalidModelFilenameError` を投げる (FS に触れる前のガード)。
 * さらに defense-in-depth として、結合後のパスが種別サブフォルダ内に
 * 収まることを確認する (サブフォルダ脱出の最終防波堤)。
 */
export function resolveModelFilePath(
  vaultRoot: string,
  kind: ModelKind,
  fileName: string,
): string {
  if (!isValidModelFileName(fileName)) {
    throw new InvalidModelFilenameError(fileName);
  }
  const dir = modelKindDir(vaultRoot, kind);
  const abs = path.resolve(dir, fileName);
  const resolvedDir = path.resolve(dir);
  if (abs !== path.join(resolvedDir, fileName) || !abs.startsWith(resolvedDir + path.sep)) {
    throw new InvalidModelFilenameError(fileName);
  }
  return abs;
}

/** vault 相対のモデルパス (.loamium/models/<kind>/<fileName>) を返す (表示用)。 */
export function modelVaultRelPath(kind: ModelKind, fileName: string): string {
  return path.posix.join('.loamium', 'models', kind, fileName);
}

/** `.loamium/models` のルート (種別サブフォルダの親)。 */
export function modelsRoot(vaultRoot: string): string {
  return path.join(vaultRoot, '.loamium', 'models');
}

/**
 * 種別サブフォルダの絶対パスを返す (I/O なし・純粋)。
 * 例: modelKindDir(root, 'llm') → `<root>/.loamium/models/llm`
 */
export function modelKindDir(vaultRoot: string, kind: ModelKind): string {
  return path.join(modelsRoot(vaultRoot), kind);
}

/**
 * 指定モデルファイルの絶対パスを返す (I/O なし・純粋)。
 * `fileName` はディレクトリを含まない単純なファイル名を前提とする
 * (呼び出し側で一覧から選んだ名前を渡す。パス traversal は含めない)。
 */
export function modelFilePath(vaultRoot: string, kind: ModelKind, fileName: string): string {
  return path.join(modelKindDir(vaultRoot, kind), fileName);
}

/**
 * 種別サブフォルダを初回アクセス時に作成し、その絶対パスを返す。
 * `fs.mkdir(..., { recursive: true })` は既存でもエラーにならない。
 */
export async function ensureModelKindDir(vaultRoot: string, kind: ModelKind): Promise<string> {
  const dir = modelKindDir(vaultRoot, kind);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 種別サブフォルダ内のファイル名を列挙する (ディレクトリ / ドット始まりは除外)。
 * ディレクトリ不在時は作成せず空配列を返す (一覧は副作用を持たない)。
 * 拡張子フィルタは呼び出し側 (LLM は .gguf 等) に委ねる。
 */
export async function listModelFiles(vaultRoot: string, kind: ModelKind): Promise<string[]> {
  const dir = modelKindDir(vaultRoot, kind);
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    // 不在 (ENOENT) 含め、読めなければ空扱い (呼び出し側で「モデル無し」)。
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}
