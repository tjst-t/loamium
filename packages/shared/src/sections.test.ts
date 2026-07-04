/**
 * extractSection のユニットテスト (S9e5ca4-1-1 / CLAUDE.md:
 * Markdown パースには必ずユニットテストを書く)。
 */
import { describe, expect, it } from 'vitest';
import { extractSection } from './sections.js';

const BODY = [
  '# タイトル',
  '',
  '導入の段落。',
  '',
  '## インデックス更新',
  'chokidar のイベントをデバウンスする。',
  '',
  '### 詳細',
  'rename は unlink + add として届く。',
  '',
  '## 競合制御',
  'last-write-wins から始める。',
].join('\n');

describe('extractSection', () => {
  it('見出しセクションを次の同レベル見出しの直前まで抜き出す (下位見出しは含む)', () => {
    const s = extractSection(BODY, 'インデックス更新');
    expect(s).toBe(
      [
        '## インデックス更新',
        'chokidar のイベントをデバウンスする。',
        '',
        '### 詳細',
        'rename は unlink + add として届く。',
        '',
      ].join('\n'),
    );
  });

  it('最後のセクションは末尾まで', () => {
    const s = extractSection(BODY, '競合制御');
    expect(s).toBe('## 競合制御\nlast-write-wins から始める。');
  });

  it('上位見出し (# タイトル) は下位見出しで打ち切られない', () => {
    const s = extractSection(BODY, 'タイトル');
    expect(s).toBe(BODY);
  });

  it('大文字小文字不区別 + NFC 正規化で一致する', () => {
    expect(extractSection('## Setup Guide\nbody', 'setup guide')).toBe('## Setup Guide\nbody');
    // NFD 入力 (macOS ゆれ) も NFC の見出しに一致する
    const nfd = 'ガ'.normalize('NFD');
    expect(extractSection('## ガ行\nbody', `${nfd}行`)).toBe('## ガ行\nbody');
  });

  it('見出しが見つからなければ null', () => {
    expect(extractSection(BODY, '存在しない見出し')).toBeNull();
    expect(extractSection(BODY, '')).toBeNull();
  });

  it('コードフェンス内の # 行は見出しとして扱わない', () => {
    const body = ['## 手順', '```bash', '# これはコメント', '```', '続き', '## 次'].join('\n');
    expect(extractSection(body, 'これはコメント')).toBeNull();
    expect(extractSection(body, '手順')).toBe('## 手順\n```bash\n# これはコメント\n```\n続き');
  });

  it('閉じ見出し (## x ##) と行末空白を吸収する', () => {
    expect(extractSection('## メモ ##\nbody', 'メモ')).toBe('## メモ ##\nbody');
    expect(extractSection('##   メモ   \nbody', 'メモ')).toBe('##   メモ   \nbody');
  });
});
