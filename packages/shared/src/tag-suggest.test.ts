import { describe, expect, it } from 'vitest';
import { filterTagSuggestions, isValidTagName, normalizeTagQuery } from './tag-suggest.js';
import type { TagCount } from './schemas.js';

const TAGS: TagCount[] = [
  { tag: 'sample-book', count: 12 },
  { tag: 'sample-project', count: 7 },
  { tag: 'science', count: 3 },
  { tag: '日記', count: 5 },
];

describe('normalizeTagQuery', () => {
  it('strips leading # and NFC-normalizes', () => {
    expect(normalizeTagQuery('#sam')).toBe('sam');
    expect(normalizeTagQuery('##sam')).toBe('sam');
    expect(normalizeTagQuery('sam')).toBe('sam');
  });
});

describe('isValidTagName', () => {
  it('accepts unicode / _ - / but rejects numeric-only and edge separators', () => {
    expect(isValidTagName('sample-book')).toBe(true);
    expect(isValidTagName('issue/42')).toBe(true);
    expect(isValidTagName('日記')).toBe(true);
    expect(isValidTagName('123')).toBe(false);
    expect(isValidTagName('-x')).toBe(false);
    expect(isValidTagName('x/')).toBe(false);
    expect(isValidTagName('a b')).toBe(false);
    expect(isValidTagName('')).toBe(false);
  });
});

describe('filterTagSuggestions', () => {
  it('returns all existing tags for an empty query (no create item)', () => {
    const out = filterTagSuggestions(TAGS, '');
    expect(out.map((s) => s.tag)).toEqual(['sample-book', 'sample-project', 'science', '日記']);
    expect(out.every((s) => !s.isCreate)).toBe(true);
    expect(out[0]?.count).toBe(12);
  });

  it('incrementally filters by substring (case-insensitive) with a match range', () => {
    const out = filterTagSuggestions(TAGS, '#sam');
    expect(out.filter((s) => !s.isCreate).map((s) => s.tag)).toEqual([
      'sample-book',
      'sample-project',
    ]);
    expect(out[0]?.matchRange).toEqual([0, 3]);
  });

  it('appends a 新規作成 item when the query is a valid, non-existing tag', () => {
    const out = filterTagSuggestions(TAGS, 'sam');
    const create = out.find((s) => s.isCreate);
    expect(create).toBeDefined();
    expect(create?.tag).toBe('sam');
    expect(create?.count).toBe(0);
  });

  it('does not append 新規作成 when the query exactly matches an existing tag', () => {
    const out = filterTagSuggestions(TAGS, 'science');
    expect(out.some((s) => s.isCreate)).toBe(false);
  });

  it('does not append 新規作成 for an invalid (numeric-only) query', () => {
    const out = filterTagSuggestions(TAGS, '123');
    expect(out.some((s) => s.isCreate)).toBe(false);
  });

  it('preserves the input (server) ordering of existing tags', () => {
    const out = filterTagSuggestions(TAGS, 's');
    expect(out.filter((s) => !s.isCreate).map((s) => s.tag)).toEqual([
      'sample-book',
      'sample-project',
      'science',
    ]);
  });
});
