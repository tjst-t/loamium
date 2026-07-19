import { describe, expect, it } from 'vitest';
import {
  extractLinks,
  extractTags,
  extractTasks,
  frontmatterTags,
  matchInlineTags,
  noteTitle,
  rewriteLinks,
} from './extract.js';

describe('extractTags', () => {
  it('extracts inline #tags from the body', () => {
    expect(extractTags('memo #dev and #issue/42 here')).toEqual(['dev', 'issue/42']);
  });

  it('extracts Japanese and unicode tags', () => {
    expect(extractTags('今日の #日記 と #メモ-2')).toEqual(['日記', 'メモ-2']);
  });

  it('merges frontmatter tags (array form) with inline tags, deduplicated', () => {
    const content = '---\ntags: [dev, project]\n---\nbody with #dev\n';
    expect(extractTags(content)).toEqual(['dev', 'project']);
  });

  it('accepts frontmatter tags as a comma-separated string', () => {
    const content = '---\ntags: dev, project\n---\nbody\n';
    expect(extractTags(content)).toEqual(['dev', 'project']);
  });

  it('strips a leading # from frontmatter tags', () => {
    const content = '---\ntags: ["#dev"]\n---\nbody\n';
    expect(extractTags(content)).toEqual(['dev']);
  });

  it('ignores #tags inside fenced code blocks', () => {
    const content = 'real #yes\n```sh\necho #no-fence\n```\nafter\n';
    expect(extractTags(content)).toEqual(['yes']);
  });

  it('ignores #tags inside tilde fences', () => {
    const content = '~~~\n#no\n~~~\n#yes\n';
    expect(extractTags(content)).toEqual(['yes']);
  });

  it('ignores #tags inside inline code', () => {
    const content = 'use `#not-a-tag` but #real-tag\n';
    expect(extractTags(content)).toEqual(['real-tag']);
  });

  it('does not treat markdown headings as tags', () => {
    expect(extractTags('# Heading\n## Sub\nbody #tag\n')).toEqual(['tag']);
  });

  it('rejects numeric-only tags (Obsidian rule)', () => {
    expect(extractTags('#123 #2024 but #v2 ok\n')).toEqual(['v2']);
  });

  it('does not extract tags glued to a word or in URLs', () => {
    expect(extractTags('word#no https://x.test/page#frag\n')).toEqual([]);
  });

  it('NFC-normalizes tags (NFD input)', () => {
    const nfd = 'パネル'.normalize('NFD');
    expect(extractTags(`#${nfd}\n`)).toEqual(['パネル'.normalize('NFC')]);
  });

  it('deduplicates case-insensitively keeping first spelling', () => {
    expect(extractTags('#Dev then #dev\n')).toEqual(['Dev']);
  });
});

describe('frontmatterTags', () => {
  it('returns [] for null frontmatter', () => {
    expect(frontmatterTags(null)).toEqual([]);
  });
  it('handles the singular "tag" key too', () => {
    expect(frontmatterTags({ tag: 'solo' })).toEqual(['solo']);
  });
  it('ignores non-string values safely', () => {
    expect(frontmatterTags({ tags: [true, { a: 1 }, 'ok'] })).toEqual(['ok']);
  });
});

describe('extractLinks', () => {
  it('extracts simple [[WikiLink]] with line number and context', () => {
    const links = extractLinks('first line\nsee [[Hydra]] here\n');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      raw: '[[Hydra]]',
      target: 'Hydra',
      heading: null,
      line: 2,
      context: 'see [[Hydra]] here',
      embed: false,
    });
  });

  it('parses [[note#heading|alias]] into target + heading', () => {
    const links = extractLinks('see [[notes/hydra#設計|the design]]\n');
    expect(links[0]).toMatchObject({
      target: 'notes/hydra',
      heading: '設計',
    });
  });

  it('treats ^block references as read-compat (not headings)', () => {
    const links = extractLinks('ref [[hydra#^abc123]]\n');
    expect(links[0]).toMatchObject({ target: 'hydra', heading: null });
  });

  it('marks embeds (![[...]])', () => {
    const links = extractLinks('![[diagram.drawio.svg]]\n');
    expect(links[0]).toMatchObject({ target: 'diagram.drawio.svg', embed: true });
  });

  it('extracts multiple links on one line in order', () => {
    const links = extractLinks('[[A]] and [[B]]\n');
    expect(links.map((l) => l.target)).toEqual(['A', 'B']);
  });

  it('ignores links inside fenced code blocks and inline code', () => {
    const content = '[[real]]\n```\n[[fenced]]\n```\nand `[[inline]]` end\n';
    expect(extractLinks(content).map((l) => l.target)).toEqual(['real']);
  });

  it('ignores links inside frontmatter', () => {
    const content = '---\nrelated: "[[not-a-link]]"\n---\n[[yes]]\n';
    expect(extractLinks(content).map((l) => l.target)).toEqual(['yes']);
  });

  it('skips same-note links ([[#heading]] with no target)', () => {
    expect(extractLinks('see [[#local heading]]\n')).toEqual([]);
  });

  it('NFC-normalizes targets (NFD input)', () => {
    const nfd = 'がいよう'.normalize('NFD');
    const links = extractLinks(`[[${nfd}]]\n`);
    expect(links[0]?.target).toBe('がいよう'.normalize('NFC'));
  });
});

describe('noteTitle', () => {
  it('returns the basename without .md', () => {
    expect(noteTitle('projects/loamium.md')).toBe('loamium');
  });
  it('NFC-normalizes', () => {
    const nfd = 'がいよう.md'.normalize('NFD');
    expect(noteTitle(nfd)).toBe('がいよう'.normalize('NFC'));
  });
});

describe('rewriteLinks (リネーム追従の書き換え)', () => {
  const renameOld = (target: string): string | null => (target === '旧名' ? '新名' : null);

  it('rewrites plain / heading / alias / embed link forms, preserving decorations', () => {
    const content = [
      '[[旧名]] と [[旧名#見出し]] と [[旧名|表示名]] と ![[旧名]]',
      '[[旧名#見出し|表示名]] も。',
    ].join('\n');
    const res = rewriteLinks(content, renameOld);
    expect(res.count).toBe(5);
    expect(res.content).toBe(
      ['[[新名]] と [[新名#見出し]] と [[新名|表示名]] と ![[新名]]', '[[新名#見出し|表示名]] も。'].join('\n'),
    );
  });

  it('leaves fenced code, inline code and frontmatter untouched', () => {
    const content = [
      '---',
      'title: "[[旧名]]"',
      '---',
      '本文 [[旧名]]',
      '```',
      'code [[旧名]]',
      '```',
      'inline `[[旧名]]` と [[旧名]]',
    ].join('\n');
    const res = rewriteLinks(content, renameOld);
    expect(res.count).toBe(2);
    expect(res.content).toBe(
      [
        '---',
        'title: "[[旧名]]"',
        '---',
        '本文 [[新名]]',
        '```',
        'code [[旧名]]',
        '```',
        'inline `[[旧名]]` と [[新名]]',
      ].join('\n'),
    );
  });

  it('does not touch links the callback declines (別ノート向け・同一ノート内リンク)', () => {
    const content = '[[別ノート]] [[#見出しだけ]] [[旧名]]';
    const res = rewriteLinks(content, renameOld);
    expect(res.count).toBe(1);
    expect(res.content).toBe('[[別ノート]] [[#見出しだけ]] [[新名]]');
  });

  it('preserves block references (#^block) verbatim', () => {
    const res = rewriteLinks('参照 [[旧名#^abc123]]', renameOld);
    expect(res.content).toBe('参照 [[新名#^abc123]]');
  });

  it('normalizes NFD targets before calling back (macOS ゆれ)', () => {
    const nfd = '旧名'.normalize('NFD');
    const res = rewriteLinks(`[[${nfd}]]`, renameOld);
    expect(res.count).toBe(1);
    expect(res.content).toBe('[[新名]]');
  });

  it('trims whitespace around the target when rewriting', () => {
    const res = rewriteLinks('[[ 旧名 ]] と [[ 旧名 |表示]]', renameOld);
    expect(res.count).toBe(2);
    expect(res.content).toBe('[[新名]] と [[新名|表示]]');
  });

  it('returns the original content object semantics when nothing matches', () => {
    const content = 'リンクなしの本文\n```\n[[旧名]]\n```';
    const res = rewriteLinks(content, renameOld);
    expect(res.count).toBe(0);
    expect(res.content).toBe(content);
  });

  it('rewrites multiple links on the same line at correct offsets', () => {
    const res = rewriteLinks('a [[旧名]] b `x` c [[旧名|エイリアス]] d', renameOld);
    expect(res.content).toBe('a [[新名]] b `x` c [[新名|エイリアス]] d');
  });
});

describe('extractTasks (Sb1593c-1)', () => {
  it('extracts unchecked and checked tasks with 1-based line numbers', () => {
    const content = '# タイトル\n\n- [ ] 未完了タスク\n- [x] 完了タスク\n- ただのリスト行\n';
    expect(extractTasks(content)).toEqual([
      { line: 3, text: '未完了タスク', checked: false, indent: 0, status: null, priority: null, due: null },
      { line: 4, text: '完了タスク', checked: true, indent: 0, status: null, priority: null, due: null },
    ]);
  });

  it('records indent for nested tasks and accepts [X] as checked', () => {
    const content = '- [ ] 親タスク\n    - [X] 子タスク\n\t- [ ] タブ子\n';
    expect(extractTasks(content)).toEqual([
      { line: 1, text: '親タスク', checked: false, indent: 0, status: null, priority: null, due: null },
      { line: 2, text: '子タスク', checked: true, indent: 4, status: null, priority: null, due: null },
      { line: 3, text: 'タブ子', checked: false, indent: 1, status: null, priority: null, due: null },
    ]);
  });

  it('accepts *, + and ordered list markers (Obsidian 互換)', () => {
    const content = '* [ ] star\n+ [x] plus\n1. [ ] ordered\n2) [ ] paren\n';
    expect(extractTasks(content).map((t) => t.text)).toEqual(['star', 'plus', 'ordered', 'paren']);
  });

  it('ignores tasks inside code fences and frontmatter', () => {
    const content = '---\ntitle: x\n---\n- [ ] 本物\n```\n- [ ] フェンス内は無視\n```\n';
    const tasks = extractTasks(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({ line: 4, text: '本物', checked: false, indent: 0, status: null, priority: null, due: null });
  });

  it('does not match non-task syntax ([y] や checkbox なしのリンク行)', () => {
    const content = '- [y] 不正なチェック文字\n- [link](url)\n[ ] リストマーカーなし\n';
    expect(extractTasks(content)).toEqual([]);
  });

  it('keeps inline code and tags in the task text verbatim', () => {
    const content = '- [ ] `code` を含む #tag タスク\n';
    expect(extractTasks(content)[0]?.text).toBe('`code` を含む #tag タスク');
  });

  // ---- Se3b7a2-1 回帰: status/priority/due フィールドが extractTasks に含まれる ----

  it('[AC-Se3b7a2-1-5] status/priority/due フィールドを持つタスク行を正しく抽出する', () => {
    const content = '- [ ] タスク A [status:: progress] [priority:: high] [due:: 2026-07-25]\n- [x] タスク B\n';
    const tasks = extractTasks(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      line: 1,
      text: 'タスク A [status:: progress] [priority:: high] [due:: 2026-07-25]',
      checked: false,
      indent: 0,
      status: 'progress',
      priority: 'high',
      due: '2026-07-25',
    });
    // フィールドなしのタスクは null
    expect(tasks[1]).toMatchObject({
      line: 2,
      checked: true,
      status: null,
      priority: null,
      due: null,
    });
  });

  it('[AC-Se3b7a2-1-5] チェックボックス文字は done/not-done のみを示す (ADR-0029)', () => {
    // [ ] は unchecked、[x] は checked — status フィールドとは独立
    const content = '- [ ] タスク [status:: done]\n- [x] タスク [status:: todo]\n';
    const tasks = extractTasks(content);
    expect(tasks[0]).toMatchObject({ checked: false, status: 'done' });
    expect(tasks[1]).toMatchObject({ checked: true, status: 'todo' });
  });

  it('[AC-Se3b7a2-1-5] インラインコード内のフィールドは無視される', () => {
    const content = '- [ ] タスク `[status:: done]` テキスト\n';
    const tasks = extractTasks(content);
    expect(tasks[0]).toMatchObject({ status: null });
  });
});

describe('matchInlineTags', () => {
  it('returns #tag positions for a single line', () => {
    // "この本は #sample-book です"
    const line = 'この本は #sample-book です';
    const hashPos = line.indexOf('#');
    expect(matchInlineTags(line)).toEqual([
      { start: hashPos, end: hashPos + '#sample-book'.length, tag: 'sample-book' },
    ]);
  });

  it('does not match an ATX heading (# followed by a space)', () => {
    expect(matchInlineTags('# 見出し')).toEqual([]);
    expect(matchInlineTags('## Section')).toEqual([]);
  });

  it('matches a tag at line start when no space follows the #', () => {
    expect(matchInlineTags('#tag body')).toEqual([{ start: 0, end: 4, tag: 'tag' }]);
  });

  it('ignores #tags inside inline code', () => {
    expect(matchInlineTags('code `#nope` and #yes')).toEqual([
      { start: 'code `#nope` and '.length, end: 'code `#nope` and '.length + 4, tag: 'yes' },
    ]);
  });

  it('drops a trailing separator from the matched range', () => {
    // "#foo/" — the trailing slash is not part of the tag
    expect(matchInlineTags('a #foo/')).toEqual([{ start: 2, end: 6, tag: 'foo' }]);
  });

  it('agrees with extractTags on which tags a body line yields', () => {
    const line = 'この本は #sample-book と #science でタグ付け';
    expect(matchInlineTags(line).map((m) => m.tag)).toEqual(['sample-book', 'science']);
    expect(extractTags(line)).toEqual(['sample-book', 'science']);
  });
});
