/**
 * Story 6 / Story 7 サーバーサイドテスト。
 *
 * Story 6 (エディタ自動反映): サーバー側ロジックは SSE notes_changed イベント経由で
 * クライアントに通知するだけなので、サーバー単体では検証不可。
 * ここでは agentSendMessageRequestSchema の拡張 (currentNotePath) を検証する。
 *
 * Story 7 (現在文書コンテキスト付与):
 * - agentSendMessageRequestSchema に currentNotePath が追加された
 * - normalizeVaultPath によるパス検証: 正常・../ 脱出・空文字列
 * - コンテキスト注入ロジック: 有効パスがあるとメッセージ先頭に付与される
 * - 無効パス・null・省略時はコンテキストなしで元 content のみ
 */
import { describe, it, expect } from 'vitest';
import { agentSendMessageRequestSchema } from '@loamium/shared';
import { normalizeVaultPath, VaultPathError } from '@loamium/shared';

// ---- agentSendMessageRequestSchema の拡張検証 (Story 7) ----------------------

describe('agentSendMessageRequestSchema (Story 7: currentNotePath 拡張)', () => {
  it('content のみ (currentNotePath 省略) は有効', () => {
    const result = agentSendMessageRequestSchema.safeParse({ content: 'hello' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe('hello');
      expect(result.data.currentNotePath).toBeUndefined();
    }
  });

  it('content + currentNotePath (有効なパス) は有効', () => {
    const result = agentSendMessageRequestSchema.safeParse({
      content: 'この文書を要約して',
      currentNotePath: 'notes/daily.md',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.currentNotePath).toBe('notes/daily.md');
    }
  });

  it('currentNotePath が null は有効 (ノート未オープン)', () => {
    const result = agentSendMessageRequestSchema.safeParse({
      content: 'hello',
      currentNotePath: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.currentNotePath).toBeNull();
    }
  });

  it('currentNotePath が空文字列は有効 (optional nullable)', () => {
    const result = agentSendMessageRequestSchema.safeParse({
      content: 'hello',
      currentNotePath: '',
    });
    expect(result.success).toBe(true);
  });

  it('content が空文字列は無効 (既存制約)', () => {
    const result = agentSendMessageRequestSchema.safeParse({
      content: '',
      currentNotePath: 'notes/test.md',
    });
    expect(result.success).toBe(false);
  });
});

// ---- コンテキスト注入ロジックの検証 (Story 7) ---------------------------------
//
// routes/agent.ts の注入ロジックは `normalizeVaultPath` + 文字列前置で構成される。
// normalizeVaultPath のパス検証を単体で確認する。

describe('Story 7: normalizeVaultPath によるパス検証', () => {
  it('通常の vault 相対パスは成功する', () => {
    expect(() => normalizeVaultPath('notes/daily.md')).not.toThrow();
    expect(normalizeVaultPath('notes/daily.md')).toBe('notes/daily.md');
  });

  it('ルートファイルも成功する', () => {
    expect(normalizeVaultPath('readme.md')).toBe('readme.md');
  });

  it('../ 脱出は VaultPathError を投げる', () => {
    expect(() => normalizeVaultPath('../secret.md')).toThrow(VaultPathError);
  });

  it('../../ 二重脱出も VaultPathError を投げる', () => {
    expect(() => normalizeVaultPath('notes/../../etc/passwd')).toThrow(VaultPathError);
  });

  it('.loamium/ ドットセグメントは拒否される', () => {
    // .loamium/ 配下は hidden vault path として VaultPathError が投げられる
    expect(() => normalizeVaultPath('.loamium/agent.json')).toThrow(VaultPathError);
  });
});

// ---- コンテキスト注入の文字列組み立て検証 (Story 7) --------------------------
//
// routes/agent.ts の注入ロジックをここで再現し、期待文字列と一致するか確認する。

function buildContextContent(content: string, currentNotePath: string | null | undefined): string {
  if (typeof currentNotePath === 'string' && currentNotePath.length > 0) {
    let validPath: string | null = null;
    try {
      validPath = normalizeVaultPath(currentNotePath);
    } catch (err) {
      if (!(err instanceof VaultPathError)) throw err;
      // パス検証失敗 → コンテキスト注入なし
    }
    if (validPath !== null) {
      return `[現在開いているノート: ${validPath}]\n\n${content}`;
    }
  }
  return content;
}

describe('Story 7: コンテキスト注入の文字列組み立て', () => {
  it('有効なパスがある場合、メッセージ先頭にコンテキストが付与される', () => {
    const result = buildContextContent('この文書を要約して', 'notes/daily.md');
    expect(result).toBe('[現在開いているノート: notes/daily.md]\n\nこの文書を要約して');
  });

  it('currentNotePath が null の場合はコンテキストなし', () => {
    const result = buildContextContent('hello', null);
    expect(result).toBe('hello');
  });

  it('currentNotePath が undefined の場合はコンテキストなし', () => {
    const result = buildContextContent('hello', undefined);
    expect(result).toBe('hello');
  });

  it('currentNotePath が空文字列の場合はコンテキストなし', () => {
    const result = buildContextContent('hello', '');
    expect(result).toBe('hello');
  });

  it('../ 脱出パスの場合はコンテキストなし (安全側に倒す)', () => {
    const result = buildContextContent('hello', '../etc/passwd');
    expect(result).toBe('hello');
  });

  it('.loamium/ パスの場合はコンテキストなし (隠しパス)', () => {
    const result = buildContextContent('hello', '.loamium/agent.json');
    expect(result).toBe('hello');
  });

  it('ネストしたパスも正しく付与される', () => {
    const result = buildContextContent('更新して', 'projects/2026/plan.md');
    expect(result).toBe('[現在開いているノート: projects/2026/plan.md]\n\n更新して');
  });
});

// ---- Story 6: エディタ自動反映ロジックの単体検証 ------------------------------
//
// エディタ自動反映ロジックは React フック (App.tsx の handleSseNotesChanged) 内に
// あるため、純粋なサーバー Vitest では直接テストできない。
// ここでは「dirty でないときのみ自動更新」という条件ロジックをピュア関数として検証する。

describe('Story 6: dirty 状態による自動更新判定', () => {
  /**
   * エディタ自動更新の判定ロジックを再現するピュア関数。
   * App.tsx の handleSseNotesChanged 内の条件と一致させる。
   */
  function shouldAutoUpdate(opts: {
    openDocPath: string | null;
    changedPath: string;
    isDirty: boolean;
    isPreview: boolean;
  }): 'auto_update' | 'notify_conflict' | 'no_action' {
    if (opts.openDocPath !== opts.changedPath) return 'no_action';
    if (opts.isPreview) return 'no_action';
    if (opts.isDirty) return 'notify_conflict';
    return 'auto_update';
  }

  it('パスが一致・dirty でない → auto_update', () => {
    expect(
      shouldAutoUpdate({
        openDocPath: 'notes/test.md',
        changedPath: 'notes/test.md',
        isDirty: false,
        isPreview: false,
      }),
    ).toBe('auto_update');
  });

  it('パスが一致・dirty → notify_conflict (編集中は破棄しない)', () => {
    expect(
      shouldAutoUpdate({
        openDocPath: 'notes/test.md',
        changedPath: 'notes/test.md',
        isDirty: true,
        isPreview: false,
      }),
    ).toBe('notify_conflict');
  });

  it('パスが不一致 → no_action', () => {
    expect(
      shouldAutoUpdate({
        openDocPath: 'notes/other.md',
        changedPath: 'notes/test.md',
        isDirty: false,
        isPreview: false,
      }),
    ).toBe('no_action');
  });

  it('開いているノートが null → no_action', () => {
    expect(
      shouldAutoUpdate({
        openDocPath: null,
        changedPath: 'notes/test.md',
        isDirty: false,
        isPreview: false,
      }),
    ).toBe('no_action');
  });

  it('プレビュー中 → no_action (エディタが非表示)', () => {
    expect(
      shouldAutoUpdate({
        openDocPath: 'notes/test.md',
        changedPath: 'notes/test.md',
        isDirty: false,
        isPreview: true,
      }),
    ).toBe('no_action');
  });
});
