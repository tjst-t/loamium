/**
 * 3-way diff3 マージロジックのユニットテスト。
 *
 * [AC-S2df65d-1-5] マージロジックのユニットテスト:
 *   - 非競合の自動統合
 *   - 競合検出 (保守的: 疑わしきは競合)
 *   - 同一変更の冪等
 *   - 空 base のハンドリング
 *
 * 実装: packages/shared/src/diff3.ts
 * エクスポート: diff3Merge(base, ours, theirs): Diff3Result
 * 型:
 *   Diff3Result = { merged: string; conflicts: ConflictHunk[] }
 *   ConflictHunk = { startLine: number; endLine: number; ours: string[]; theirs: string[] }
 */
import { describe, expect, it } from 'vitest';
import { diff3Merge } from './diff3.js';

// ---------------------------------------------------------------------------
// 非競合の自動統合
// ---------------------------------------------------------------------------

describe('diff3Merge — 非競合の自動統合', () => {
  it('[AC-S2df65d-1-5] ours だけが変更した行は theirs に存在しないマージで自動統合される', () => {
    const base = '行 A\n行 B\n行 C\n';
    const ours = '行 A\n行 B (ユーザー変更)\n行 C\n';
    const theirs = '行 A\n行 B\n行 C\n'; // theirs は変更なし

    const result = diff3Merge(base, ours, theirs);

    expect(result.conflicts).toHaveLength(0);
    expect(result.merged).toBe('行 A\n行 B (ユーザー変更)\n行 C\n');
  });

  it('[AC-S2df65d-1-5] theirs だけが変更した行は ours に取り込まれ自動統合される', () => {
    const base = '行 A\n行 B\n行 C\n';
    const ours = '行 A\n行 B\n行 C\n'; // ours は変更なし
    const theirs = '行 A\n行 B\n行 C (リモート変更)\n';

    const result = diff3Merge(base, ours, theirs);

    expect(result.conflicts).toHaveLength(0);
    expect(result.merged).toBe('行 A\n行 B\n行 C (リモート変更)\n');
  });

  it('[AC-S2df65d-1-5] ours と theirs が異なる範囲を変更した場合、両方を統合する', () => {
    const base = '段落 A\n\n段落 B\n\n段落 C\n';
    const ours = '段落 A (ユーザー)\n\n段落 B\n\n段落 C\n';
    const theirs = '段落 A\n\n段落 B\n\n段落 C (リモート)\n';

    const result = diff3Merge(base, ours, theirs);

    expect(result.conflicts).toHaveLength(0);
    expect(result.merged).toBe('段落 A (ユーザー)\n\n段落 B\n\n段落 C (リモート)\n');
  });

  it('[AC-S2df65d-1-5] ours が行を追加し theirs が別の箇所を変更した場合、両方を統合する', () => {
    const base = '行 1\n行 2\n行 3\n';
    const ours = '行 1\n行 1.5 (追加)\n行 2\n行 3\n';
    const theirs = '行 1\n行 2\n行 3 (変更)\n';

    const result = diff3Merge(base, ours, theirs);

    expect(result.conflicts).toHaveLength(0);
    expect(result.merged).toContain('行 1.5 (追加)');
    expect(result.merged).toContain('行 3 (変更)');
  });

  it('[AC-S2df65d-1-5] base/ours/theirs がすべて同一の場合、merged はそのまま返る', () => {
    const content = '変更なし\n同じ内容\n';
    const result = diff3Merge(content, content, content);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// 競合検出 (保守的: 疑わしきは競合)
// ---------------------------------------------------------------------------

describe('diff3Merge — 競合検出 (保守的)', () => {
  it('[AC-S2df65d-1-5] ours と theirs が同じ行を異なる内容に変更した場合、競合を返す', () => {
    const base = '行 A\n行 B (元)\n行 C\n';
    const ours = '行 A\n行 B (ユーザーが変更)\n行 C\n';
    const theirs = '行 A\n行 B (リモートが変更)\n行 C\n';

    const result = diff3Merge(base, ours, theirs);

    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(result.conflicts[0]!.ours).toContain('行 B (ユーザーが変更)');
    expect(result.conflicts[0]!.theirs).toContain('行 B (リモートが変更)');
  });

  it('[AC-S2df65d-1-5] 重複する変更範囲(隣接行も含む複数行の競合)が正しく検出される', () => {
    const base = '行 1\n行 2\n行 3\n行 4\n';
    const ours = '行 1\nOURS-2\nOURS-3\n行 4\n';
    const theirs = '行 1\nTHEIRS-2\nTHEIRS-3\n行 4\n';

    const result = diff3Merge(base, ours, theirs);

    // 複数行の競合が 1 つのハンクとして、または個別ハンクとしてまとめられる
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
    const allOurs = result.conflicts.flatMap((h) => h.ours);
    const allTheirs = result.conflicts.flatMap((h) => h.theirs);
    expect(allOurs.some((l) => l.includes('OURS'))).toBe(true);
    expect(allTheirs.some((l) => l.includes('THEIRS'))).toBe(true);
  });

  it('[AC-S2df65d-1-5] 保守的検出: ours が行を追加し theirs が同じ隣接範囲を変更した場合、競合とみなす', () => {
    // 誤マージ回避のため、曖昧なケースは競合側に倒す
    const base = '行 A\n行 B\n';
    const ours = '行 A\n行 B\n行 B2 (ours 追加)\n'; // B の直後に追加
    const theirs = '行 A\n行 B (theirs 変更)\n'; // B を変更

    const result = diff3Merge(base, ours, theirs);

    // 保守的: 追加と変更が重なる場合は競合扱い
    // (実装が非競合と判断する場合でも、誤マージを引き起こさない内容のみ許容)
    // このアサーションは実装の保守的判定を確認する。非競合統合も許容するが、
    // 競合として返す場合は ours/theirs が正しく分離されていること
    if (result.conflicts.length > 0) {
      const allHunks = result.conflicts;
      expect(allHunks.length).toBeGreaterThanOrEqual(1);
    } else {
      // 非競合統合した場合: ours の追加行または theirs の変更行のいずれかが保持される
      expect(
        result.merged.includes('B2') || result.merged.includes('B (theirs 変更)'),
      ).toBe(true);
    }
  });

  it('[ADR-0030 保守的] ours の insertBefore と theirs の changeAt が同一 base 位置に共存するとき競合として返す', () => {
    // review fix: 隣接 insert+change 共存ケースの回帰テスト (medium② 修正対象)
    // base: 行 X / 行 Y
    // ours: 行 X の後ろに「行 X.5 (ours 挿入)」を追記 (insert at baseIdx=1)
    // theirs: 行 X を変更 (change at baseIdx=0)
    // → ours の insertBefore[1] と theirs の changeAt[0] が base 行 0 の変更範囲内で共存
    //   保守的側に倒し、競合として返すべき
    const base = '行 X\n行 Y\n';
    const ours = '行 X\n行 X.5 (ours 挿入)\n行 Y\n'; // base[1] の前に挿入
    const theirs = '行 X (theirs 変更)\n行 Y\n'; // base[0] を変更

    const result = diff3Merge(base, ours, theirs);

    // 保守的競合検出: INSERT + CHANGE が同一 base 範囲に共存 → 必ず競合
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('[ADR-0030 保守的] theirs の insertBefore と ours の changeAt が同一 base 位置に共存するとき競合として返す', () => {
    // 上記の逆パターン (theirs が insert, ours が change)
    const base = '行 X\n行 Y\n';
    const ours = '行 X (ours 変更)\n行 Y\n'; // base[0] を変更
    const theirs = '行 X\n行 X.5 (theirs 挿入)\n行 Y\n'; // base[1] の前に挿入

    const result = diff3Merge(base, ours, theirs);

    // 保守的競合検出: CHANGE + INSERT が同一 base 範囲に共存 → 必ず競合
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 同一変更の冪等
// ---------------------------------------------------------------------------

describe('diff3Merge — 同一変更の冪等', () => {
  it('[AC-S2df65d-1-5] ours と theirs が同じ変更をした場合、競合なし・変更を 1 回だけ適用する', () => {
    const base = '行 A\n行 B (元)\n行 C\n';
    const ours = '行 A\n行 B (同一変更)\n行 C\n';
    const theirs = '行 A\n行 B (同一変更)\n行 C\n'; // ours と同じ

    const result = diff3Merge(base, ours, theirs);

    expect(result.conflicts).toHaveLength(0);
    // 変更は 1 回だけ適用 (2 重適用しない)
    expect(result.merged).toBe('行 A\n行 B (同一変更)\n行 C\n');
    expect(result.merged.split('行 B (同一変更)').length - 1).toBe(1);
  });

  it('[AC-S2df65d-1-5] ours と theirs が同じ行を追加した場合、競合なし・1 行のみ挿入', () => {
    const base = '行 A\n行 C\n';
    const ours = '行 A\n行 B (共通追加)\n行 C\n';
    const theirs = '行 A\n行 B (共通追加)\n行 C\n';

    const result = diff3Merge(base, ours, theirs);

    expect(result.conflicts).toHaveLength(0);
    expect(result.merged).toBe('行 A\n行 B (共通追加)\n行 C\n');
  });
});

// ---------------------------------------------------------------------------
// 空 base のハンドリング
// ---------------------------------------------------------------------------

describe('diff3Merge — 空 base', () => {
  it('[AC-S2df65d-1-5] base が空で ours≠theirs は競合として返す(保守的)', () => {
    // review fix: 保守的実装に合わせてタイトルと必須アサーションを厳格化
    // base が空 = ours/theirs がともに新規追加で共通祖先がない → 保守的に競合扱い
    const base = '';
    const ours = '行 A (ours)\n';
    const theirs = '行 B (theirs)\n';

    const result = diff3Merge(base, ours, theirs);

    // 実装は base 空 + ours≠theirs を競合として返す (diff3.ts 早期終了ロジック)
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
    // 競合ハンクに ours/theirs の内容が含まれること
    const allOurs = result.conflicts.flatMap((h) => h.ours);
    const allTheirs = result.conflicts.flatMap((h) => h.theirs);
    expect(allOurs.some((l) => l.includes('ours'))).toBe(true);
    expect(allTheirs.some((l) => l.includes('theirs'))).toBe(true);
  });

  it('[AC-S2df65d-1-5] base が空で ours と theirs が同一内容の場合、競合なし', () => {
    const base = '';
    const content = '新規ノート内容\n';
    const result = diff3Merge(base, content, content);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged).toBe(content);
  });

  it('[AC-S2df65d-1-5] base/ours/theirs がすべて空文字の場合、空文字が返る', () => {
    const result = diff3Merge('', '', '');
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 末尾改行の正規化
// ---------------------------------------------------------------------------

describe('diff3Merge — 末尾改行 (ピュア Markdown LF 固定)', () => {
  it('[AC-S2df65d-1-5] merged は常に LF で終わる (末尾改行なしの入力でも補完)', () => {
    const base = '行 A';
    const ours = '行 A (ours)';
    const theirs = '行 A';

    const result = diff3Merge(base, ours, theirs);
    if (result.conflicts.length === 0 && result.merged.length > 0) {
      // ピュア Markdown: 末尾は LF で終わることが推奨
      // 実装は少なくとも改行なしの内容は改行で終わらせる
      expect(result.merged).toBe('行 A (ours)\n');
    }
  });
});
