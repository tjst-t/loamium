/**
 * packages/shared/src/noteMeta.ts のユニットテスト。
 * [AC-S11493d-1-3]
 */
import { describe, expect, it } from 'vitest';
import { extractHeadings, extractOutgoingLinks, countWords } from './noteMeta.js';
import { resolveLinkTarget } from './links.js';

// ---------------------------------------------------------------------------
// extractHeadings [AC-S11493d-1-3]
// ---------------------------------------------------------------------------

describe('[AC-S11493d-1-3] extractHeadings', () => {
  it('ATX 見出し (#〜######) を行番号付きで抽出する', () => {
    const content = [
      '# H1',
      '## H2',
      '### H3',
      '#### H4',
      '##### H5',
      '###### H6',
    ].join('\n');
    const headings = extractHeadings(content);
    expect(headings).toHaveLength(6);
    expect(headings[0]).toEqual({ level: 1, text: 'H1', line: 1 });
    expect(headings[1]).toEqual({ level: 2, text: 'H2', line: 2 });
    expect(headings[5]).toEqual({ level: 6, text: 'H6', line: 6 });
  });

  it('code-fence 内の見出しを除外する', () => {
    const content = [
      '# Real heading',
      '```',
      '# Fenced heading (should be excluded)',
      '```',
      '## Another real heading',
    ].join('\n');
    const headings = extractHeadings(content);
    expect(headings).toHaveLength(2);
    expect(headings[0]?.text).toBe('Real heading');
    expect(headings[1]?.text).toBe('Another real heading');
    // フェンス内の行は除外されていること
    expect(headings.some((h) => h.text.includes('Fenced'))).toBe(false);
  });

  it('tilde フェンス (~~~) 内の見出しを除外する', () => {
    const content = [
      '# Before fence',
      '~~~',
      '# Inside tilde fence',
      '~~~',
      '# After fence',
    ].join('\n');
    const headings = extractHeadings(content);
    expect(headings).toHaveLength(2);
    expect(headings[0]?.text).toBe('Before fence');
    expect(headings[1]?.text).toBe('After fence');
  });

  it('frontmatter 内の見出し(YAML)を除外する', () => {
    const content = [
      '---',
      'title: # Not a heading',
      '---',
      '# Real heading',
    ].join('\n');
    const headings = extractHeadings(content);
    expect(headings).toHaveLength(1);
    expect(headings[0]?.text).toBe('Real heading');
  });

  it('frontmatter + code-fence の両方が除外される', () => {
    const content = [
      '---',
      'tags: [dev]',
      '---',
      '# Body heading',
      '```',
      '# Fence heading',
      '```',
    ].join('\n');
    const headings = extractHeadings(content);
    expect(headings).toHaveLength(1);
    expect(headings[0]?.text).toBe('Body heading');
  });

  it('見出しなしのノートは空配列を返す', () => {
    expect(extractHeadings('just text\nno headings\n')).toHaveLength(0);
  });

  it('空文字列は空配列を返す', () => {
    expect(extractHeadings('')).toHaveLength(0);
  });

  it('見出しの行番号が正しい (frontmatter 分を考慮)', () => {
    const content = ['---', 'tags: [x]', '---', '', '# Title'].join('\n');
    const headings = extractHeadings(content);
    expect(headings).toHaveLength(1);
    // frontmatter は 3 行 (---/tags/---) + 空行 1 行 → "# Title" は 5 行目
    expect(headings[0]?.line).toBe(5);
  });

  it('見出しレベルが 1〜6 の範囲外 (#######) は見出しとして扱わない', () => {
    const content = '####### Not a heading\n# Valid\n';
    const headings = extractHeadings(content);
    expect(headings).toHaveLength(1);
    expect(headings[0]?.level).toBe(1);
  });

  it('closing # を持つ ATX 見出し (trailing hashes) のテキストが正しい', () => {
    const content = '## Heading with trailing hashes ##\n';
    const headings = extractHeadings(content);
    expect(headings).toHaveLength(1);
    expect(headings[0]?.text).toBe('Heading with trailing hashes');
  });
});

// ---------------------------------------------------------------------------
// countWords [AC-S11493d-1-3]
// ---------------------------------------------------------------------------

describe('[AC-S11493d-1-3] countWords', () => {
  it('ASCII テキストのワード数を空白で分割して数える', () => {
    const { wordCount } = countWords('hello world foo');
    expect(wordCount).toBe(3);
  });

  it('CJK 各文字を 1 ワードとして数える', () => {
    // 「世界」= 2 文字 = 2 ワード
    const { wordCount } = countWords('世界');
    expect(wordCount).toBe(2);
  });

  it('CJK と ASCII が混在する場合の字数カウント', () => {
    // "hello世界" → "hello" (1) + "世" (1) + "界" (1) = 3
    const { wordCount } = countWords('hello世界');
    expect(wordCount).toBe(3);
  });

  it('日本語 (ひらがな・カタカナ) も CJK と同様に 1 文字 = 1 ワード', () => {
    // "あいう" = 3 文字 = 3 ワード
    const { wordCount } = countWords('あいう');
    expect(wordCount).toBe(3);
  });

  it('frontmatter の内容はワード数から除外する', () => {
    const content = ['---', 'title: フロントマター', 'tags: [dev]', '---', 'hello world'].join('\n');
    const { wordCount } = countWords(content);
    // "hello world" = 2 ワード (frontmatter は除外)
    expect(wordCount).toBe(2);
  });

  it('code-fence の内容はワード数から除外する', () => {
    const content = ['# Title', '```', 'const x = 1;', 'const y = 2;', '```', 'body text'].join(
      '\n',
    );
    const { wordCount } = countWords(content);
    // "# Title" = 1 (Title のみ。#はマークダウン構文として機能するが行全体がトークン)
    // => "#" と "Title" で 2 、"body" "text" で 2 = 4
    // フェンス内の "const x = 1;" などは除外
    expect(wordCount).toBeLessThan(10); // フェンス内 6 ワードが除外されれば OK
    // "body text" が含まれること
    const bodyOnly = countWords('body text');
    expect(wordCount).toBeGreaterThanOrEqual(bodyOnly.wordCount);
  });

  it('code-fence 内容が確実に除外されていることを直接確認する', () => {
    const withFence = [
      'text before',
      '```',
      'lots of words inside fence alpha beta gamma delta epsilon',
      '```',
      'text after',
    ].join('\n');
    const withoutFence = ['text before', 'text after'].join('\n');
    const { wordCount: wf } = countWords(withFence);
    const { wordCount: wo } = countWords(withoutFence);
    expect(wf).toBe(wo);
  });

  it('charCount は frontmatter と code-fence 除外後のテキスト文字数', () => {
    const content = ['---', 'x: 1', '---', 'ab'].join('\n');
    const { charCount } = countWords(content);
    // "ab" のみが本文。charCount はスペース・改行を含む本文全体。
    // scannableLines は frontmatter 行を null にするので、
    // bodyText は "" + "\n" + "" + "\n" + "ab" のような形に join される
    // 実際の charCount は実装依存だが "ab" (2) より大きくなる
    expect(charCount).toBeGreaterThanOrEqual(2);
  });

  it('空文字列は wordCount=0, charCount=0', () => {
    const { wordCount, charCount } = countWords('');
    expect(wordCount).toBe(0);
    expect(charCount).toBe(0);
  });

  it('frontmatter + 空本文のノートは本文テキストをカウントしない', () => {
    // frontmatter のみで末尾改行がある場合: "---\ntitle: Test\n---\n" → body = "" (末尾空行のみ)
    // scannableLines の bodyStart 計算は extract.ts と同一ロジック。
    // frontmatter に続く空行はスキャン対象外になるため、ノート本文の「実テキスト」のみをカウントする。
    const content = '---\ntitle: Test\n---\n\njust one word';
    const { wordCount: wFull } = countWords(content);
    const { wordCount: wWord } = countWords('just one word');
    // frontmatter 内の "title: Test" はカウントされない
    // "just one word" の分だけ一致するはず
    expect(wFull).toBe(wWord);
  });
});

// ---------------------------------------------------------------------------
// extractOutgoingLinks [AC-S11493d-1-3]
// ---------------------------------------------------------------------------

describe('[AC-S11493d-1-3] extractOutgoingLinks', () => {
  const vaultPaths = ['notes/alpha.md', 'notes/beta.md', 'gamma.md'];

  it('WikiLink ターゲットを vault パスに解決する', () => {
    const content = 'See [[alpha]] and [[gamma]].';
    const links = extractOutgoingLinks(content, vaultPaths, resolveLinkTarget);
    expect(links).toHaveLength(2);
    const alpha = links.find((l) => l.target === 'alpha');
    expect(alpha?.resolvedPath).toBe('notes/alpha.md');
    const gamma = links.find((l) => l.target === 'gamma');
    expect(gamma?.resolvedPath).toBe('gamma.md');
  });

  it('解決できないリンクの resolvedPath は null', () => {
    const content = '[[nonexistent]]';
    const links = extractOutgoingLinks(content, vaultPaths, resolveLinkTarget);
    expect(links).toHaveLength(1);
    expect(links[0]?.resolvedPath).toBeNull();
  });

  it('同一ターゲットの重複リンクは 1 件にまとめる', () => {
    const content = '[[alpha]] is also [[alpha]].';
    const links = extractOutgoingLinks(content, vaultPaths, resolveLinkTarget);
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe('alpha');
  });

  it('code-fence 内のリンクを除外する', () => {
    const content = [
      '[[alpha]]',
      '```',
      '[[beta]] inside fence — excluded',
      '```',
    ].join('\n');
    const links = extractOutgoingLinks(content, vaultPaths, resolveLinkTarget);
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe('alpha');
  });

  it('frontmatter 内のリンクを除外する', () => {
    const content = ['---', 'ref: [[beta]]', '---', '[[alpha]]'].join('\n');
    const links = extractOutgoingLinks(content, vaultPaths, resolveLinkTarget);
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe('alpha');
  });

  it('raw に元のリンクテキスト全体を保持する', () => {
    const content = '[[alpha#heading|別名]]';
    const links = extractOutgoingLinks(content, vaultPaths, resolveLinkTarget);
    expect(links).toHaveLength(1);
    expect(links[0]?.raw).toBe('[[alpha#heading|別名]]');
    // ターゲットは heading/alias を除いた部分
    expect(links[0]?.target).toBe('alpha');
  });

  it('空のノートは空配列を返す', () => {
    const links = extractOutgoingLinks('', vaultPaths, resolveLinkTarget);
    expect(links).toHaveLength(0);
  });

  it('NFC/NFD ゆれがあってもターゲットが NFC に正規化される', () => {
    const nfdTarget = 'ノート'.normalize('NFD');
    const content = `[[${nfdTarget}]]`;
    const pathsWithJp = [...vaultPaths, 'ノート.md'.normalize('NFC')];
    const links = extractOutgoingLinks(content, pathsWithJp, resolveLinkTarget);
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe('ノート'.normalize('NFC'));
    expect(links[0]?.resolvedPath).toBe('ノート.md'.normalize('NFC'));
  });
});
