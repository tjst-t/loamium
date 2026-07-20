/**
 * Sfa11c0 後続修正: 推論(thinking)モデルの応答表示。
 *
 * extractSessionMessages が assistant メッセージの thinking ブロックを reasoning として
 * 抽出し、text 本文が無い「思考のみ」応答も復元対象に含めることを検証する。
 *
 * 背景: 推論モデル (deepseek 等) は毎ターン thinking を出力し、短い入力に対しては
 * text 本文なし (thinking のみ) で応答を終えることがある。従来は text も tool も無い
 * assistant を丸ごとスキップしていたため、復元・表示時に空欄になり「反応が無い」ように
 * 見えていた (実データで確認)。reasoning を保持することでこれを解消する。
 */
import { describe, it, expect } from 'vitest';
import { extractSessionMessages } from './agent-service.js';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

/** session.messages だけを持つ最小スタブを AgentSession として渡す。 */
function makeSession(messages: unknown[]): AgentSession {
  return { messages } as unknown as AgentSession;
}

describe('extractSessionMessages — 推論(thinking)抽出', () => {
  it('thinking + text の assistant は content と reasoning の両方を返す', () => {
    const msgs = extractSessionMessages(
      makeSession([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'まず要件を整理する。' },
            { type: 'text', text: '承知しました。' },
          ],
        },
      ]),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe('承知しました。');
    expect(msgs[0]?.reasoning).toBe('まず要件を整理する。');
  });

  it('thinking のみ (text なし) の assistant も復元対象に含める', () => {
    const msgs = extractSessionMessages(
      makeSession([
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '了解の返信なので追加アクションは不要。' }],
        },
      ]),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe('assistant');
    expect(msgs[0]?.content).toBe('');
    expect(msgs[0]?.reasoning).toBe('了解の返信なので追加アクションは不要。');
  });

  it('複数の thinking ブロックは連結される', () => {
    const msgs = extractSessionMessages(
      makeSession([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'A' },
            { type: 'thinking', thinking: 'B' },
            { type: 'text', text: 'done' },
          ],
        },
      ]),
    );
    expect(msgs[0]?.reasoning).toBe('AB');
  });

  it('text も thinking も tool も無い真の空 assistant はスキップする', () => {
    const msgs = extractSessionMessages(
      makeSession([{ role: 'assistant', content: [] }]),
    );
    expect(msgs).toHaveLength(0);
  });

  it('reasoning が無い通常応答は reasoning フィールドを持たない', () => {
    const msgs = extractSessionMessages(
      makeSession([
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ]),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.reasoning).toBeUndefined();
  });

  it('user メッセージは reasoning を持たない', () => {
    const msgs = extractSessionMessages(
      makeSession([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[0]?.reasoning).toBeUndefined();
  });
});
