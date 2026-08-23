/**
 * タスク (task #19 / ADR-0029)。
 *
 * - チェックボックス `- [ ]` / `- [x]` は **GFM 標準の未完了/完了だけ**を表す。
 *   単純なタスクは追加フィールド無しのままにしておける。
 * - 状態・優先度・期限は Obsidian Dataview の**インラインフィールド** `[key:: value]` を
 *   行末に足して表す。ブロック ID も独自記法も使わない。
 *
 * ここは**行単位のテキスト操作**に徹する (mdast を通さない)。1 行しか触らないので、
 * 他の行のバイトが動かず round-trip が壊れない。
 */

export interface InlineField {
  key: string
  value: string
  /** 行の中での位置 (`[` から `]` の次まで) */
  start: number
  end: number
}

const FIELD = /\[([A-Za-z_][\w-]*)::\s*([^\]]*)\]/g

export function parseInlineFields(line: string): InlineField[] {
  const out: InlineField[] = []
  for (const m of line.matchAll(FIELD)) {
    const index = m.index
    if (index === undefined) continue
    out.push({ key: m[1] ?? '', value: (m[2] ?? '').trim(), start: index, end: index + m[0].length })
  }
  return out
}

export const formatInlineField = (key: string, value: string): string => `[${key}:: ${value}]`

export interface TaskLine {
  /** 0 始まりの行番号 */
  line: number
  checked: boolean
  /** チェックボックスとインラインフィールドを除いた本文 */
  text: string
  /** 行に付いているインラインフィールド */
  fields: Record<string, string>
  /** 行そのもの */
  raw: string
}

/** `- [ ] …` / `* [x] …` / `1. [ ] …` (インデントは何段でもよい) */
const TASK = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s?(.*)$/

/** コードフェンスの中は数えない (説明のために書いた `- [ ]` を拾わない) */
export function parseTasks(content: string): TaskLine[] {
  const out: TaskLine[] = []
  let inFence = false
  const lines = content.split('\n')
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = TASK.exec(line)
    if (!m) continue
    const body = m[4] ?? ''
    const fields: Record<string, string> = {}
    for (const field of parseInlineFields(body)) fields[field.key] = field.value
    out.push({
      line: index,
      checked: (m[3] ?? ' ').toLowerCase() === 'x',
      text: body.replace(FIELD, '').replace(/\s+/g, ' ').trim(),
      fields,
      raw: line,
    })
  }
  return out
}

function editLine(content: string, line: number, edit: (text: string) => string): string {
  const lines = content.split('\n')
  const target = lines[line]
  if (target === undefined) return content
  lines[line] = edit(target)
  return lines.join('\n')
}

/** チェックボックスの入り切り。**その行だけ**を書き換える */
export function setTaskChecked(content: string, line: number, checked: boolean): string {
  return editLine(content, line, (text) =>
    text.replace(TASK, (_all, indent: string, marker: string, _box: string, body: string) =>
      `${indent}${marker} [${checked ? 'x' : ' '}] ${body}`))
}

/**
 * インラインフィールドを足す・書き換える・消す (value が null なら消す)。
 * 足すときは**行末**に付ける (本文の途中に割り込ませない)。
 */
export function setTaskField(content: string, line: number, key: string, value: string | null): string {
  return editLine(content, line, (text) => {
    const found = parseInlineFields(text).find((f) => f.key === key)
    if (found !== undefined) {
      const next = value === null ? '' : formatInlineField(key, value)
      const before = text.slice(0, found.start)
      const after = text.slice(found.end)
      // 消したあとに空白が二重に残らないようにする
      return value === null
        ? `${before.replace(/\s+$/, '')}${after === '' ? '' : ` ${after.trimStart()}`}`.trimEnd()
        : `${before}${next}${after}`
    }
    if (value === null) return text
    return `${text.trimEnd()} ${formatInlineField(key, value)}`
  })
}
