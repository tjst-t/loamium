/**
 * Story Sfa11c0: メッセージ編集 → 以降切り捨て → 再送信のサーバーサイドテスト。
 *
 * truncateSessionMessages の単体テスト:
 *   - fromUserMessageIndex で指定されたユーザーメッセージ以降の履歴が切り捨てられる
 *   - sessionManager.branch / resetLeaf が適切に呼ばれる
 *   - agent.state.messages が更新される
 *   - 範囲外インデックスは Error を投げる
 *
 * Vitest でモック: pi SDK の AgentSession / SessionManager を決定的スタブに差し替える。
 * zod 検証は agentTruncateRequestSchema のユニットテストで確認する。
 */
import { describe, it, expect, vi } from 'vitest';
import { truncateSessionMessages } from './agent-service.js';
import { agentTruncateRequestSchema } from '@loamium/shared';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

// ---- モックヘルパー -----------------------------------------------------------

/** ユーザーメッセージ用のSessionMessageEntryスタブを生成する。 */
function makeUserMsgEntry(id: string, parentId: string | null) {
  return {
    id,
    parentId,
    type: 'message' as const,
    timestamp: new Date().toISOString(),
    message: { role: 'user' as const, content: 'test user message' },
  };
}

/** アシスタントメッセージ用のSessionMessageEntryスタブを生成する。 */
function makeAssistantMsgEntry(id: string, parentId: string | null) {
  return {
    id,
    parentId,
    type: 'message' as const,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant' as const, content: 'test assistant response' },
  };
}

type AnyEntry = ReturnType<typeof makeUserMsgEntry> | ReturnType<typeof makeAssistantMsgEntry>;

/**
 * AgentSession のモックを生成する。
 * getBranch: entriesを返す、branch/resetLeaf/buildSessionContext はスパイ。
 */
function makeSessionMock(branchEntries: AnyEntry[]) {
  const agentState: { messages: unknown[] } = { messages: [] };
  const branch = vi.fn((_id: string) => undefined as void);
  const resetLeaf = vi.fn(() => undefined as void);
  const buildSessionContext = vi.fn(() => ({ messages: [] }));

  const sessionManager = {
    getBranch: vi.fn(() => branchEntries),
    branch,
    resetLeaf,
    buildSessionContext,
  };

  const session = {
    sessionManager,
    agent: { state: agentState },
  } as unknown as AgentSession;

  return { session, branch, resetLeaf, buildSessionContext, agentState };
}

// ---- テスト ------------------------------------------------------------------

describe('truncateSessionMessages', () => {
  // 典型的な会話履歴: user0 → assistant0 → user1 → assistant1
  // ツリー構造: root=user0 → assistant0 → user1 → assistant1
  const entries = [
    makeUserMsgEntry('u0', null),          // user[0] parentId=null (root)
    makeAssistantMsgEntry('a0', 'u0'),     // assistant[0]
    makeUserMsgEntry('u1', 'a0'),          // user[1]
    makeAssistantMsgEntry('a1', 'u1'),     // assistant[1]
  ];

  describe('fromUserMessageIndex = 0 (最初のユーザーメッセージから切り捨て)', () => {
    it('resetLeaf を呼ぶ (parentId が null のため)', () => {
      const { session, resetLeaf, branch } = makeSessionMock(entries);
      truncateSessionMessages(session, 0);
      expect(resetLeaf).toHaveBeenCalledOnce();
      expect(branch).not.toHaveBeenCalled();
    });

    it('返り値が 0 (切り捨て後のユーザーメッセージ数)', () => {
      const { session } = makeSessionMock(entries);
      const result = truncateSessionMessages(session, 0);
      expect(result).toBe(0);
    });

    it('agent.state.messages を buildSessionContext の結果で更新する', () => {
      const { session, agentState } = makeSessionMock(entries);
      truncateSessionMessages(session, 0);
      // buildSessionContext は空配列を返すモック
      expect(agentState.messages).toEqual([]);
    });
  });

  describe('fromUserMessageIndex = 1 (2番目のユーザーメッセージから切り捨て)', () => {
    it('branch(a0) を呼ぶ (user1 の parentId = a0)', () => {
      const { session, branch, resetLeaf } = makeSessionMock(entries);
      truncateSessionMessages(session, 1);
      expect(branch).toHaveBeenCalledWith('a0');
      expect(resetLeaf).not.toHaveBeenCalled();
    });

    it('返り値が 1', () => {
      const { session } = makeSessionMock(entries);
      const result = truncateSessionMessages(session, 1);
      expect(result).toBe(1);
    });
  });

  describe('範囲外インデックス', () => {
    it('fromUserMessageIndex がユーザーメッセージ数以上のとき Error を投げる', () => {
      const { session } = makeSessionMock(entries);
      // entries に user は 2 件 → index=2 は範囲外
      expect(() => truncateSessionMessages(session, 2)).toThrow(/out of range/);
    });

    it('entries が空のとき index=0 で Error を投げる', () => {
      const { session } = makeSessionMock([]);
      expect(() => truncateSessionMessages(session, 0)).toThrow(/out of range/);
    });
  });

  describe('アシスタントのみのエントリがある場合', () => {
    it('アシスタントエントリはユーザーメッセージカウントに含まない', () => {
      // user0 → assistant0 → assistant1 (ツール応答等)
      const mixedEntries = [
        makeUserMsgEntry('u0', null),
        makeAssistantMsgEntry('a0', 'u0'),
        makeAssistantMsgEntry('a1', 'a0'),
      ];
      const { session, resetLeaf } = makeSessionMock(mixedEntries);
      // ユーザーメッセージは1件のみ → index=0 でresetLeaf
      truncateSessionMessages(session, 0);
      expect(resetLeaf).toHaveBeenCalledOnce();
    });
  });
});

// ---- agentTruncateRequestSchema zod 検証テスト --------------------------------

describe('agentTruncateRequestSchema', () => {
  it('有効なリクエストをパースする', () => {
    const result = agentTruncateRequestSchema.safeParse({ fromUserMessageIndex: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fromUserMessageIndex).toBe(0);
    }
  });

  it('fromUserMessageIndex が正の整数でも有効', () => {
    const result = agentTruncateRequestSchema.safeParse({ fromUserMessageIndex: 5 });
    expect(result.success).toBe(true);
  });

  it('fromUserMessageIndex が負の値は無効', () => {
    const result = agentTruncateRequestSchema.safeParse({ fromUserMessageIndex: -1 });
    expect(result.success).toBe(false);
  });

  it('fromUserMessageIndex が小数は無効 (int チェック)', () => {
    const result = agentTruncateRequestSchema.safeParse({ fromUserMessageIndex: 1.5 });
    expect(result.success).toBe(false);
  });

  it('fromUserMessageIndex がない場合は無効', () => {
    const result = agentTruncateRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('fromUserMessageIndex が文字列は無効', () => {
    const result = agentTruncateRequestSchema.safeParse({ fromUserMessageIndex: '1' });
    expect(result.success).toBe(false);
  });
});
