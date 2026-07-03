/**
 * Markdown パース — frontmatter (YAML) 抽出。
 *
 * 正本は常に Markdown 文字列 1 本 (DESIGN_PRINCIPLES architecture: C 方式)。
 * parseNote は正本を変更せず、読み取り専用のビューを返す。
 */
import { parse as parseYaml } from 'yaml';

export interface ParsedNote {
  /** 正本そのもの (無加工) */
  content: string;
  /** パース済み frontmatter。無い / 壊れている場合は null */
  frontmatter: Record<string, unknown> | null;
  /** frontmatter ブロックを除いた本文 */
  body: string;
}

const FRONTMATTER_OPEN = /^---(?:\r?\n)/;

/**
 * ノート文字列から frontmatter を抽出する。
 *
 * - 先頭が `---` 行で始まり、次の `---` 行で閉じる場合のみ frontmatter とみなす (Obsidian 互換)
 * - YAML が壊れている場合は frontmatter: null とし、本文は正本全体のまま (ファイルを壊さない)
 * - YAML のトップレベルがオブジェクトでない場合 (例: スカラー) も frontmatter: null
 */
export function parseNote(content: string): ParsedNote {
  if (!FRONTMATTER_OPEN.test(content)) {
    return { content, frontmatter: null, body: content };
  }

  const lines = content.split('\n');
  // lines[0] は "---" (または "---\r")
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    if (line === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    return { content, frontmatter: null, body: content };
  }

  const yamlText = lines
    .slice(1, closeIndex)
    .map((l) => l.replace(/\r$/, ''))
    .join('\n');
  const body = lines.slice(closeIndex + 1).join('\n');

  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch {
    return { content, frontmatter: null, body: content };
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { content, frontmatter: null, body: content };
  }

  return { content, frontmatter: data as Record<string, unknown>, body };
}
