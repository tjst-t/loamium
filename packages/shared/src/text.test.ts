import { describe, expect, it } from 'vitest';
import {
  appendText,
  countOccurrences,
  toLf,
  BARE_URL_PATTERN,
  trimUrlTail,
  isExternalHref,
} from './text.js';

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

describe('BARE_URL_PATTERN', () => {
  const scan = (text: string): string[] => {
    const re = new RegExp(BARE_URL_PATTERN, 'g');
    return (text.match(re) ?? []).map((raw) => trimUrlTail(raw));
  };

  it('detects http and https URLs', () => {
    expect(scan('see https://example.com/a and http://foo.test/b here')).toEqual([
      'https://example.com/a',
      'http://foo.test/b',
    ]);
  });

  it('does not match bare domains without a scheme', () => {
    expect(scan('example.com is not linked')).toEqual([]);
  });

  it('stops at whitespace and angle brackets', () => {
    expect(scan('<https://ex.com/x> y')).toEqual(['https://ex.com/x']);
  });
});

describe('trimUrlTail', () => {
  it('strips trailing sentence punctuation', () => {
    expect(trimUrlTail('https://ex.com/a.')).toBe('https://ex.com/a');
    expect(trimUrlTail('https://ex.com/a,')).toBe('https://ex.com/a');
    expect(trimUrlTail('https://ex.com/a。')).toBe('https://ex.com/a');
  });

  it('drops an unbalanced trailing paren but keeps balanced ones', () => {
    // 文中の (https://ex.com) の閉じ括弧は URL 外
    expect(trimUrlTail('https://ex.com/a)')).toBe('https://ex.com/a');
    // Wikipedia 風の釣り合った括弧は保持
    expect(trimUrlTail('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
  });

  it('leaves a clean URL untouched', () => {
    expect(trimUrlTail('https://ex.com/path?q=1#frag')).toBe('https://ex.com/path?q=1#frag');
  });
});

describe('isExternalHref', () => {
  it('is true for http/https/mailto', () => {
    expect(isExternalHref('https://ex.com')).toBe(true);
    expect(isExternalHref('http://ex.com')).toBe(true);
    expect(isExternalHref('mailto:a@b.com')).toBe(true);
    expect(isExternalHref('  HTTPS://EX.com ')).toBe(true);
  });

  it('is false for internal / relative / other schemes', () => {
    expect(isExternalHref('note.md')).toBe(false);
    expect(isExternalHref('/vault/path')).toBe(false);
    expect(isExternalHref('javascript:alert(1)')).toBe(false);
    expect(isExternalHref('../x')).toBe(false);
  });
});
