/**
 * 添付ファイル (task #16)。
 *
 * `![[画像.png]]` のような埋め込みは、**Markdown としては WikiLink のまま**。
 * ここにあるのは「その target が添付か、どう見せるか」の判定だけで、
 * ファイルには何も書き足さない。
 */

export type AttachmentKind = 'image' | 'pdf' | 'audio' | 'video' | 'csv' | 'text' | 'code' | 'other'

const KINDS: [AttachmentKind, string[]][] = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp']],
  ['pdf', ['pdf']],
  ['audio', ['mp3', 'wav', 'ogg', 'm4a', 'flac']],
  ['video', ['mp4', 'webm', 'mov']],
  ['csv', ['csv', 'tsv']],
  ['code', ['ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml', 'py', 'go', 'rs', 'sh', 'sql', 'css', 'html', 'toml']],
  ['text', ['txt', 'log']],
]

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', log: 'text/plain',
  json: 'application/json',
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * その埋め込み先が添付か。**拡張子が無いもの・`.md` はノート**なので false
 * (`![[ノート]]` の埋め込みは embed 機能の担当。二重に描かないための境目)。
 */
export function isAttachment(target: string): boolean {
  const ext = extensionOf(target.split('#')[0] ?? '')
  return ext !== '' && ext !== 'md'
}

export function attachmentKind(path: string): AttachmentKind {
  const ext = extensionOf(path)
  for (const [kind, list] of KINDS) if (list.includes(ext)) return kind
  return 'other'
}

/** そのまま配るときの Content-Type。分からないものは octet-stream (勝手に解釈させない) */
export function contentTypeOf(path: string): string {
  return MIME[extensionOf(path)] ?? 'application/octet-stream'
}

/** テキストとして中身を見せてよいか (プレビュー用) */
export function isTextual(path: string): boolean {
  const kind = attachmentKind(path)
  return kind === 'text' || kind === 'code' || kind === 'csv'
}

/**
 * 添付として保存する名前。
 * 危険な文字を落とし、同じ名前があれば `-2`, `-3` と足す (黙って上書きしない)。
 */
export function attachmentName(original: string, taken: readonly string[]): string {
  const cleaned = original
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .trim()
  const safe = cleaned === '' ? 'file' : cleaned
  if (!taken.includes(safe)) return safe
  const dot = safe.lastIndexOf('.')
  const stem = dot <= 0 ? safe : safe.slice(0, dot)
  const ext = dot <= 0 ? '' : safe.slice(dot)
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}-${String(i)}${ext}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${stem}-${String(taken.length)}${ext}`
}

/** CSV / TSV を表として読む (プレビュー用。引用符つきセルまで面倒を見る) */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1 } else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === delimiter) { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (ch !== '\r') cell += ch
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}
