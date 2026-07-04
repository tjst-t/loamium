/**
 * 添付ファイルの拡張子 → 種別分類 (Sf53ad6)。
 * ツリーのアイコン区別 (prototype/upload.html: 画像=緑 / PDF=赤 / データ=琥珀) と
 * ![[file]] プレビュー種別ディスパッチ (prototype/file-preview.html) が共有する。
 */

export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'bmp',
  'ico',
] as const;

/**
 * 読み取り専用テキストブロックでプレビューする拡張子 (AC-Sf53ad6-3-2)。
 * .txt / .log / .json / .csv + 主要なコード拡張子。
 */
export const TEXT_PREVIEW_EXTENSIONS = [
  'txt',
  'log',
  'json',
  'jsonc',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'xml',
  'sh',
  'bash',
  'zsh',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'go',
  'rs',
  'rb',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sql',
  'diff',
  'patch',
  'css',
  'scss',
  'html',
  'htm',
] as const;

/** パスの拡張子 (小文字、ドットなし)。無ければ null。 */
export function extensionOf(path: string): string | null {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return ext.length > 0 ? ext : null;
}

export type FileCategory = 'image' | 'pdf' | 'text' | 'other';

/** 添付ファイルの種別 (ツリーアイコン・プレビューディスパッチ共通)。 */
export function fileCategoryOf(path: string): FileCategory {
  const ext = extensionOf(path);
  if (ext === null) return 'other';
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if ((TEXT_PREVIEW_EXTENSIONS as readonly string[]).includes(ext)) return 'text';
  return 'other';
}

/** vault 相対パス → GET /api/files URL (セグメント単位 percent-encode)。 */
export function filesUrlOf(rel: string): string {
  return `/api/files/${rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`;
}

/**
 * ファイル種別の日本語ラベル (ファイル/フォルダブラウザの「種別」列 — Seac77a-1)。
 * prototype/files-page.html の "PNG 画像" / "PDF 文書" / "CSV データ" / "ログ" に一致。
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  png: 'PNG 画像',
  jpg: 'JPEG 画像',
  jpeg: 'JPEG 画像',
  gif: 'GIF 画像',
  svg: 'SVG 画像',
  webp: 'WebP 画像',
  avif: 'AVIF 画像',
  bmp: 'BMP 画像',
  ico: 'アイコン',
  pdf: 'PDF 文書',
  csv: 'CSV データ',
  tsv: 'TSV データ',
  json: 'JSON データ',
  log: 'ログ',
  txt: 'テキスト',
  md: 'Markdown ノート',
};

/** vault 相対パスと種別 (ノート/添付) から「種別」ラベルを返す。 */
export function kindLabelOf(path: string, kind: 'note' | 'attachment'): string {
  if (kind === 'note') return 'Markdown ノート';
  const ext = extensionOf(path);
  if (ext === null) return 'ファイル';
  return KIND_LABELS[ext] ?? `${ext.toUpperCase()} ファイル`;
}

/**
 * mtime (ms epoch) を "YYYY-MM-DD HH:mm" 表記へ (prototype の更新日時列に一致)。
 * mtime <= 0 は空文字 (mock の未設定値対策)。
 */
export function formatDateTime(mtime: number): string {
  if (mtime <= 0) return '';
  const d = new Date(mtime);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${String(y)}-${mo}-${da} ${h}:${mi}`;
}

/** バイト数の人間可読表記 (prototype の "1.2 MB" 相当)。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}
