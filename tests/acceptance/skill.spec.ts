/**
 * Story S0c9a48-2「Loamium Skill」受け入れテスト。
 * scenario-S0c9a48-2.json を機械的に実行する。
 *
 * Skill の「利用者」は SKILL.md をロードする Claude Code なので、
 * このテストは配布物 skill/SKILL.md そのもの (公開 API 相当) を読み、
 * claude-skills 形式の構造と記載内容 (journal-append / search 中心の変換例・
 * エラー対処・実 CLI とのコマンド整合) を検証する。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
const skillPath = path.join(repoRoot, 'skill/SKILL.md');

/** CLI に実在するサブコマンド (packages/cli/src/main.ts と 1:1)。 */
const REAL_COMMANDS = [
  'read',
  'write',
  'append',
  'patch',
  'journal',
  'journal-append',
  'search',
  'backlinks',
  'list',
  'tags',
] as const;

/** CLI に実在するフラグ。 */
const REAL_FLAGS = new Set(['--json', '--old', '--new', '--tag', '--folder', '--help']);

let raw: string;
let frontmatter: Record<string, unknown>;
let body: string;

/** ドキュメント中の loamium コマンド例 (インラインコード + フェンスコードブロック) を抽出する。 */
function extractLoamiumInvocations(text: string): string[] {
  const out: string[] = [];
  // フェンスコードブロック内の loamium 行
  for (const fence of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    const block = fence[1] ?? '';
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('loamium ')) out.push(trimmed);
    }
  }
  // インラインコード (テーブルセル・本文) 内の loamium コマンド
  const noFences = text.replace(/```[a-z]*\n[\s\S]*?```/g, '');
  for (const inline of noFences.matchAll(/`([^`\n]*)`/g)) {
    const code = (inline[1] ?? '').trim();
    if (code.startsWith('loamium ')) out.push(code);
  }
  return out;
}

beforeAll(async () => {
  raw = await readFile(skillPath, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('skill/SKILL.md に YAML frontmatter (--- 区切り) がない');
  const parsed: unknown = parseYaml(m[1] ?? '');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('frontmatter が YAML オブジェクトとしてパースできない');
  }
  frontmatter = parsed as Record<string, unknown>;
  body = m[2] ?? '';
});

describe('[AC-S0c9a48-2-1] skill/SKILL.md が claude-skills 形式で構造的に妥当', () => {
  it('frontmatter に非空の name と description がある', () => {
    expect(typeof frontmatter.name).toBe('string');
    expect((frontmatter.name as string).trim().length).toBeGreaterThan(0);
    expect(typeof frontmatter.description).toBe('string');
    expect((frontmatter.description as string).trim().length).toBeGreaterThan(0);
  });

  it('description にいつ使うか (ジャーナルへのメモ・ノート検索のトリガー) が書かれている', () => {
    const desc = frontmatter.description as string;
    expect(desc).toContain('ジャーナル');
    expect(desc).toMatch(/探して|検索/);
    expect(desc).toContain('journal-append');
    expect(desc).toContain('search');
  });
});

describe('[AC-S0c9a48-2-1] journal-append / search 中心の自然言語→コマンド変換例', () => {
  it('自然言語の依頼とコマンドの対応例が記載されている', () => {
    expect(body).toContain('自然言語の依頼');
  });

  it('journal-append の変換例が 3 例以上ある (最重要ユースケース)', () => {
    const examples = extractLoamiumInvocations(body).filter((c) =>
      c.startsWith('loamium journal-append'),
    );
    expect(examples.length).toBeGreaterThanOrEqual(3);
    // 日付指定 (過去日への追記) の例も含む
    expect(examples.some((c) => /\d{4}-\d{2}-\d{2}/.test(c))).toBe(true);
  });

  it('search の変換例が 2 例以上あり、list によるタグ/フォルダ絞り込みへの誘導もある', () => {
    const searches = extractLoamiumInvocations(body).filter((c) => c.startsWith('loamium search'));
    expect(searches.length).toBeGreaterThanOrEqual(2);
    const lists = extractLoamiumInvocations(body).filter((c) => c.startsWith('loamium list'));
    expect(lists.length).toBeGreaterThanOrEqual(1);
  });

  it('全 10 コマンドの用例が記載されている', () => {
    const invocations = extractLoamiumInvocations(body);
    for (const cmd of REAL_COMMANDS) {
      const found = invocations.some(
        (c) => c === `loamium ${cmd}` || c.startsWith(`loamium ${cmd} `),
      );
      expect(found, `loamium ${cmd} の用例が SKILL.md にない`).toBe(true);
    }
  });
});

describe('[AC-S0c9a48-2-1] エラー対処 (サーバー未起動・ノート不在等) が記載されている', () => {
  it('サーバー未起動: server_unreachable → make serve での復旧手順がある', () => {
    expect(body).toContain('server_unreachable');
    expect(body).toContain('make serve');
  });

  it('ノート不在: not_found → search / list で探し直す手順がある', () => {
    expect(body).toContain('not_found');
    const notFoundRow = body
      .split('\n')
      .find((line) => line.includes('not_found') && !line.includes('old_not_found'));
    expect(notFoundRow, 'not_found の対処行がない').toBeDefined();
    expect(notFoundRow).toMatch(/search|list/);
  });

  it('patch の失敗 (old_not_found / ambiguous_match) と権限 (forbidden) の対処がある', () => {
    expect(body).toContain('old_not_found');
    expect(body).toContain('ambiguous_match');
    expect(body).toContain('forbidden');
  });

  it('失敗時の出力形式 (stderr の 1 行 JSON {error, message}) が説明されている', () => {
    expect(body).toContain('stderr');
    expect(body).toMatch(/\{"error","message"\}|\{"error", ?"message"\}|`error`/);
  });
});

describe('[AC-S0c9a48-2-1] 記載コマンドが実 CLI と食い違わない', () => {
  it('すべての loamium コマンド例のサブコマンドが実在の 10 コマンド (+--help) である', () => {
    const invocations = extractLoamiumInvocations(raw);
    expect(invocations.length).toBeGreaterThan(0);
    for (const inv of invocations) {
      const sub = inv.split(/\s+/)[1] ?? '';
      // `<cmd>` のようなプレースホルダは用例として妥当 (例: loamium <cmd> --help)
      const ok =
        (REAL_COMMANDS as readonly string[]).includes(sub) ||
        sub === '--help' ||
        /^<.+>$/.test(sub);
      expect(ok, `SKILL.md に実在しないサブコマンドの例がある: ${inv}`).toBe(true);
    }
  });

  it('すべての loamium コマンド例のフラグが実在のフラグである', () => {
    for (const inv of extractLoamiumInvocations(raw)) {
      for (const token of inv.split(/\s+/)) {
        const flag = token.replace(/^\[/, '').replace(/\]$/, '');
        // 裸の `--` は end-of-options 区切り (commander 標準) であってフラグではない
        if (flag === '--') continue;
        if (flag.startsWith('--')) {
          expect(REAL_FLAGS.has(flag), `SKILL.md に実在しないフラグの例がある: ${inv} (${flag})`).toBe(
            true,
          );
        }
      }
    }
  });
});
