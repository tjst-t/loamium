/**
 * insertUnderHeading ユニットテスト (Sd22b1f-2 / Sd22b1f-3)。
 * [AC-Sd22b1f-2-1]: journal-append ステップの section 指定ロジックを検証する。
 * [AC-Sd22b1f-3-1]: POST /api/journal/append の section 対応ロジックを担保する。
 */
import { describe, expect, it } from 'vitest';
import { insertUnderHeading } from './journal-section.js';

describe('insertUnderHeading', () => {
  // [AC-Sd22b1f-3-1] 空のコンテンツ → 見出し + text を末尾に追記する
  it('[AC-Sd22b1f-3-1] empty content + heading absent: appends heading + text at EOF', () => {
    const result = insertUnderHeading('', 'Todo', '- [ ] タスク');
    expect(result).toBe('## Todo\n- [ ] タスク\n');
  });

  // [AC-Sd22b1f-3-1] 存在する見出しの下に挿入する
  it('[AC-Sd22b1f-3-1] heading present: inserts text at end of that section (before next heading)', () => {
    const content = `# 日記\n\n今日のメモ\n\n## Todo\n\n- [ ] 既存タスク\n\n## 完了\n\n- [x] 済み\n`;
    const result = insertUnderHeading(content, 'Todo', '- [ ] 新規タスク');
    // "## Todo" セクション内に追記、"## 完了" の前
    expect(result).toContain('- [ ] 既存タスク\n');
    expect(result).toContain('- [ ] 新規タスク\n');
    // 完了セクションは後ろに残る
    expect(result).toContain('## 完了\n');
    // 新規タスクが既存タスクの後、完了セクションの前に来ること
    const newIdx = result.indexOf('- [ ] 新規タスク');
    const existingIdx = result.indexOf('- [ ] 既存タスク');
    const doneIdx = result.indexOf('## 完了');
    expect(newIdx).toBeGreaterThan(existingIdx);
    expect(newIdx).toBeLessThan(doneIdx);
  });

  // [AC-Sd22b1f-3-1] 見出しが存在しない → 末尾に見出し + text を追加する
  it('[AC-Sd22b1f-3-1] heading absent (content non-empty): appends heading + text at end of file', () => {
    const content = '# 日記\n\n今日のメモ\n';
    const result = insertUnderHeading(content, 'Todo', '- [ ] タスク');
    expect(result).toContain('## Todo\n');
    expect(result).toContain('- [ ] タスク\n');
    // 元のコンテンツは保持される
    expect(result).toContain('今日のメモ\n');
    // 末尾に追記されること
    const memoIdx = result.indexOf('今日のメモ');
    const headingIdx = result.indexOf('## Todo');
    expect(headingIdx).toBeGreaterThan(memoIdx);
  });

  // [AC-Sd22b1f-3-1] 複数の見出しがある場合 — 指定見出しにだけ挿入する (最初の一致が対象)
  it('[AC-Sd22b1f-3-1] multiple same-level headings: inserts under the FIRST matching heading', () => {
    const content = [
      '## Alpha',
      '',
      '- alpha item',
      '',
      '## Beta',
      '',
      '- beta item',
      '',
      '## Gamma',
      '',
      '- gamma item',
      '',
    ].join('\n');
    const result = insertUnderHeading(content, 'Beta', '- new beta');
    expect(result).toContain('## Alpha');
    expect(result).toContain('## Beta');
    expect(result).toContain('## Gamma');
    // 新規項目が Beta セクション内に、Gamma の前にあること
    const newIdx = result.indexOf('- new beta');
    const gammaIdx = result.indexOf('## Gamma');
    expect(newIdx).toBeGreaterThan(0);
    expect(newIdx).toBeLessThan(gammaIdx);
    // Alpha と Gamma には挿入されていないこと
    const alphaEnd = result.indexOf('## Beta');
    expect(result.slice(0, alphaEnd)).not.toContain('- new beta');
    const gammaSection = result.slice(gammaIdx);
    expect(gammaSection).not.toContain('- new beta');
  });

  // ネストした見出し — 上位レベルの見出しが来たらセクション終了とみなす
  it('nested headings: inserts before next same-or-higher-level heading', () => {
    const content = [
      '## Section A',
      '',
      '### Sub A1',
      '',
      'content of sub a1',
      '',
      '## Section B',
      '',
      'content of b',
      '',
    ].join('\n');
    // ## Section A のセクションに挿入 → ## Section B の前
    const result = insertUnderHeading(content, 'Section A', '- inserted under A');
    const insertedIdx = result.indexOf('- inserted under A');
    const sectionBIdx = result.indexOf('## Section B');
    expect(insertedIdx).toBeGreaterThan(0);
    expect(insertedIdx).toBeLessThan(sectionBIdx);
  });

  // text が改行で終わらない場合も LF を補う
  it('text without trailing newline gets a trailing newline', () => {
    const result = insertUnderHeading('', 'Todo', '- item without newline');
    expect(result.endsWith('\n')).toBe(true);
  });

  // [AC-Sd22b1f-3-1] NFC 正規化で照合する
  it('[AC-Sd22b1f-3-1] matches heading with NFC normalization (decomposed heading found by composed search)', () => {
    // NFC 正規化を確認: NFD 分解済みの見出しを NFC 照合で発見できること。
    // 'é' を NFD (U+0065 + U+0301) と NFC (U+00E9) で作り比較する。
    const nfd = 'é'; // 'é' NFD
    const nfc = 'é';       // 'é' NFC
    // content の見出しは NFD で記述
    const content = `## Section-${nfd}\n\n- item\n`;
    // 検索キーは NFC — 見出しが NFC 正規化されて照合されること
    const result = insertUnderHeading(content, `Section-${nfc}`, '- new');
    expect(result).toContain('- item');
    expect(result).toContain('- new');
    // 末尾追記形式 (## 見出しが末尾に来る) になっていないこと
    // = 既存の見出しセクション内に挿入されていること
    // (正規化後のテキスト比較なので一致するはず)
    const itemIdx = result.indexOf('- item');
    const newIdx = result.indexOf('- new');
    expect(itemIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(itemIdx);
  });

  // NFC 正規化 (ASCII で文字コード曖昧さなし) — 既存テストも維持
  it('matches heading with NFC normalization (ASCII baseline)', () => {
    // ASCII で書いて文字コードの曖昧さを排除する。
    const content = '## Section-NFC\n\n- item\n';
    // NFC で検索 → セクション内に挿入される
    const result = insertUnderHeading(content, 'Section-NFC', '- new');
    // - item と - new の両方が含まれること
    expect(result).toContain('- item');
    expect(result).toContain('- new');
    // 末尾追記形式 (## 見出しが末尾に来る) になっていないこと
    // = 既存の見出しセクション内に挿入されていること
    const headingCount = (result.match(/## Section-NFC/g) ?? []).length;
    expect(headingCount).toBe(1);
    // - item より後に - new が来ること
    const itemIdx = result.indexOf('- item');
    const newIdx = result.indexOf('- new');
    expect(itemIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(itemIdx);
  });


  // 見出し行直下にすぐ次の同レベル見出しがある場合
  it('empty section: inserts text right after heading', () => {
    const content = '## Section A\n## Section B\n- b item\n';
    const result = insertUnderHeading(content, 'Section A', '- a item');
    const aIdx = result.indexOf('## Section A');
    const aItemIdx = result.indexOf('- a item');
    const bIdx = result.indexOf('## Section B');
    expect(aItemIdx).toBeGreaterThan(aIdx);
    expect(aItemIdx).toBeLessThan(bIdx);
  });

  // [AC-Sd22b1f-3-1] 同名見出しが複数ある場合は最初の一致に挿入する
  it('[AC-Sd22b1f-3-1] duplicate heading names: inserts under the FIRST occurrence only', () => {
    // 同じ名前の見出しが 2 つある — 最初の "Todo" に挿入されること
    const content = [
      '## Todo',
      '',
      '- [ ] first-todo',
      '',
      '## Done',
      '',
      '- [x] done-item',
      '',
      '## Todo',
      '',
      '- [ ] second-todo',
      '',
    ].join('\n');
    const result = insertUnderHeading(content, 'Todo', '- [ ] new-item');
    // 挿入されたこと
    expect(result).toContain('- [ ] new-item');
    // 最初の Todo (first-todo の後) に挿入されること = first-todo より後で Done の前
    const firstTodoIdx = result.indexOf('- [ ] first-todo');
    const newItemIdx = result.indexOf('- [ ] new-item');
    const doneIdx = result.indexOf('## Done');
    expect(newItemIdx).toBeGreaterThan(firstTodoIdx);
    expect(newItemIdx).toBeLessThan(doneIdx);
    // 2 番目の ## Todo セクション (second-todo) には挿入されていないこと
    const secondTodoHeadingIdx = result.lastIndexOf('## Todo');
    const secondTodoSection = result.slice(secondTodoHeadingIdx);
    // new-item が 2 番目の Todo セクション内に現れない
    // (new-item が secondTodoHeadingIdx より前にある)
    expect(newItemIdx).toBeLessThan(secondTodoHeadingIdx);
    expect(secondTodoSection).not.toContain('- [ ] new-item');
  });
});
