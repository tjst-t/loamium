import { describe, expect, it } from 'vitest';
import { extractLinks, extractTags, frontmatterTags, noteTitle } from './extract.js';

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
