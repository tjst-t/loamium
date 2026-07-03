import { describe, expect, it } from 'vitest';
import { parseNote } from './markdown.js';

describe('parseNote', () => {
  it('extracts YAML frontmatter and body', () => {
    const content = '---\ntitle: Test\ntags:\n  - a\n  - b\n---\n# Hello\n\nBody text.\n';
    const parsed = parseNote(content);
    expect(parsed.frontmatter).toEqual({ title: 'Test', tags: ['a', 'b'] });
    expect(parsed.body).toBe('# Hello\n\nBody text.\n');
    expect(parsed.content).toBe(content); // 正本は無加工
  });

  it('returns null frontmatter when there is none', () => {
    const content = '# Just a note\n';
    const parsed = parseNote(content);
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.body).toBe(content);
  });

  it('does not treat a later --- as frontmatter open', () => {
    const content = 'text\n---\nkey: value\n---\n';
    const parsed = parseNote(content);
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.body).toBe(content);
  });

  it('returns null frontmatter for an unclosed block', () => {
    const content = '---\ntitle: Test\n# no closing fence\n';
    const parsed = parseNote(content);
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.body).toBe(content);
  });

  it('returns null frontmatter for broken YAML without destroying content', () => {
    const content = '---\n{ broken: [ yaml\n---\nbody\n';
    const parsed = parseNote(content);
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.content).toBe(content);
  });

  it('returns null frontmatter when YAML top-level is not an object', () => {
    const content = '---\njust a string\n---\nbody\n';
    const parsed = parseNote(content);
    expect(parsed.frontmatter).toBeNull();
  });

  it('handles empty frontmatter block', () => {
    const content = '---\n---\nbody\n';
    const parsed = parseNote(content);
    // 空 YAML は null → frontmatter なし扱い
    expect(parsed.frontmatter).toBeNull();
  });

  it('handles CRLF content without crashing', () => {
    const content = '---\r\ntitle: T\r\n---\r\nbody\r\n';
    const parsed = parseNote(content);
    expect(parsed.frontmatter).toEqual({ title: 'T' });
  });
});
