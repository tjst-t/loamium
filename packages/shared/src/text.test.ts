import { describe, expect, it } from 'vitest';
import { appendText, countOccurrences, toLf } from './text.js';

describe('toLf', () => {
  it('converts CRLF and lone CR to LF', () => {
    expect(toLf('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
});

describe('appendText', () => {
  it('appends to empty content with trailing newline', () => {
    expect(appendText('', 'hello')).toBe('hello\n');
  });

  it('inserts a newline when existing content lacks one', () => {
    expect(appendText('line1', 'line2')).toBe('line1\nline2\n');
  });

  it('does not double newlines when existing content ends with one', () => {
    expect(appendText('line1\n', 'line2')).toBe('line1\nline2\n');
  });

  it('normalizes CRLF in the addition', () => {
    expect(appendText('a\n', 'b\r\nc')).toBe('a\nb\nc\n');
  });
});

describe('countOccurrences', () => {
  it('counts non-overlapping occurrences', () => {
    expect(countOccurrences('aaa', 'aa')).toBe(1);
    expect(countOccurrences('foo bar foo', 'foo')).toBe(2);
    expect(countOccurrences('abc', 'x')).toBe(0);
    expect(countOccurrences('abc', '')).toBe(0);
  });
});
