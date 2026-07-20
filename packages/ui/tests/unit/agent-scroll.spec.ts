/**
 * Story 3 — 条件付き自動スクロール / 「一番下へ」ボタン のユニットテスト。
 *
 * React Testing Library が未インストールのため、UI ロジックを純粋関数として
 * 切り出した isScrolledToBottom を中心に検証する。
 *
 * 受け入れ基準テストの焦点:
 *   (a) 最下部判定: scrollHeight / scrollTop / clientHeight の閾値計算が正しいこと
 *   (b) 最下部でないとき: 判定が false を返すこと (この状態で UI はボタンを表示する)
 *   (c) 最下部にいるとき: 判定が true を返すこと (この状態では自動追従し、ボタンは非表示)
 *   (d) 閾値の境界値: ちょうど THRESHOLD の距離なら true、超えたら false
 */
import { describe, expect, it } from 'vitest';
import {
  isScrolledToBottom,
  SCROLL_TO_BOTTOM_THRESHOLD,
} from '../../src/components/AgentPane.js';

describe('isScrolledToBottom', () => {
  // コンテナ高: 400px、コンテンツ高: 1000px とする
  const clientHeight = 400;
  const scrollHeight = 1000;

  it('最下部にいる (scrollTop = scrollHeight - clientHeight) → true', () => {
    const scrollTop = scrollHeight - clientHeight; // 600
    expect(isScrolledToBottom(scrollHeight, scrollTop, clientHeight)).toBe(true);
  });

  it('最下部より少し上 (閾値内) → true (「最下部付近」とみなす)', () => {
    // threshold は 80px。閾値ちょうどは true
    const scrollTop = scrollHeight - clientHeight - SCROLL_TO_BOTTOM_THRESHOLD; // 600 - 80 = 520
    expect(isScrolledToBottom(scrollHeight, scrollTop, clientHeight)).toBe(true);
  });

  it('閾値を 1px 超えた位置 → false (ボタンを表示すべき状態)', () => {
    const scrollTop = scrollHeight - clientHeight - SCROLL_TO_BOTTOM_THRESHOLD - 1; // 519
    expect(isScrolledToBottom(scrollHeight, scrollTop, clientHeight)).toBe(false);
  });

  it('一番上 (scrollTop = 0) → false (ボタンを表示すべき状態)', () => {
    expect(isScrolledToBottom(scrollHeight, 0, clientHeight)).toBe(false);
  });

  it('コンテンツがコンテナより短い (スクロール不要) → true (ボタン不要)', () => {
    // scrollHeight <= clientHeight の場合は常に最下部
    expect(isScrolledToBottom(300, 0, 400)).toBe(true);
  });

  it('カスタム閾値を指定できる', () => {
    // threshold = 0 なら完全に最下部のときだけ true
    const scrollTop = scrollHeight - clientHeight - 1; // 1px 手前
    expect(isScrolledToBottom(scrollHeight, scrollTop, clientHeight, 0)).toBe(false);
    expect(isScrolledToBottom(scrollHeight, scrollTop + 1, clientHeight, 0)).toBe(true);
  });

  it('SCROLL_TO_BOTTOM_THRESHOLD は 80 (仕様定義)', () => {
    expect(SCROLL_TO_BOTTOM_THRESHOLD).toBe(80);
  });
});

describe('「一番下へ」ボタン表示ロジック (isAtBottom state との関係)', () => {
  /**
   * React コンポーネントの state (isAtBottom) と UI の関係:
   *   isAtBottom === true  → ボタン非表示 (最下部付近 → 追従中)
   *   isAtBottom === false → ボタン表示 (最下部から離れている)
   *
   * isScrolledToBottom の戻り値がそのまま isAtBottom に格納されるため、
   * 純粋関数の結果でボタン表示ロジックを検証できる。
   */
  it('(a) 最下部近接 → isScrolledToBottom=true → ボタン非表示 (自動追従あり)', () => {
    const atBottom = isScrolledToBottom(1000, 600, 400);
    // UI: !isAtBottom のときボタンが表示される
    const buttonVisible = !atBottom;
    expect(buttonVisible).toBe(false); // ボタンは非表示
  });

  it('(b) 最下部から離れている → isScrolledToBottom=false → ボタン表示 (自動追従なし)', () => {
    const atBottom = isScrolledToBottom(1000, 0, 400); // 一番上
    const buttonVisible = !atBottom;
    expect(buttonVisible).toBe(true); // ボタンを表示
  });

  it('(c) 新メッセージ追加時: isAtBottom=true なら自動追従する (追従フラグ検証)', () => {
    // messagesEndRef.scrollIntoView は isAtBottom=true のときのみ呼ばれる
    // ロジック: if (!isAtBottom) return; → isAtBottom=true なら return しない
    const isAtBottom = isScrolledToBottom(1000, 600, 400);
    // isAtBottom=true なら scrollIntoView を呼ぶべき
    expect(isAtBottom).toBe(true);
  });

  it('(d) 新メッセージ追加時: isAtBottom=false なら自動追従しない', () => {
    const isAtBottom = isScrolledToBottom(1000, 0, 400); // 一番上
    // isAtBottom=false なら scrollIntoView を呼ばない (return early)
    expect(isAtBottom).toBe(false);
  });
});
