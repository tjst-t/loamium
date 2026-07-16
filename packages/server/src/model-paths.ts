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
