/**
 * [AC-Sd22b1f-1-1] LoamiumCommand スキーマ + parseLoamiumCommand のユニットテスト。
 *
 * 正常系 / 未知 kind / 型不一致 / 壊れ YAML (= null frontmatter) / loamium-command キー欠損 を検証。
 */
import { describe, expect, it } from 'vitest';
import {
  commandParamSchema,
  commandStepSchema,
  loamiumCommandSchema,
  parseLoamiumCommand,
  parseLoamiumCommandWithError,
} from './loamium-command.js';

// ---------------------------------------------------------------------------
// commandParamSchema
// ---------------------------------------------------------------------------
describe('[AC-Sd22b1f-1-1] commandParamSchema', () => {
  it('最小定義 (name のみ) が通る', () => {
    const result = commandParamSchema.safeParse({ name: 'title' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('title');
      expect(result.data.type).toBeUndefined();
      expect(result.data.required).toBeUndefined();
    }
  });

  it('全フィールド付き定義が通る', () => {
    const result = commandParamSchema.safeParse({
      name: 'content',
      label: '本文',
      required: true,
      default: '既定値',
      type: 'text',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        name: 'content',
        label: '本文',
        required: true,
        default: '既定値',
        type: 'text',
      });
    }
  });

  it('type が string / text / date を受け入れる', () => {
    for (const t of ['string', 'text', 'date'] as const) {
      const result = commandParamSchema.safeParse({ name: 'x', type: t });
      expect(result.success, `type=${t} should be valid`).toBe(true);
    }
  });

  it('name が空文字は拒否される', () => {
    const result = commandParamSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('未知の type は拒否される', () => {
    const result = commandParamSchema.safeParse({ name: 'x', type: 'select' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// commandStepSchema — 4 種すべての正常系 + 未知 kind
// ---------------------------------------------------------------------------
describe('[AC-Sd22b1f-1-1] commandStepSchema', () => {
  it('journal-append ステップが通る (最小)', () => {
    const result = commandStepSchema.safeParse({
      kind: 'journal-append',
      content: '追記テキスト',
    });
    expect(result.success).toBe(true);
  });

  it('journal-append ステップが通る (全フィールド)', () => {
    const result = commandStepSchema.safeParse({
      kind: 'journal-append',
      content: '追記テキスト',
      date: '2026-01-01',
      section: 'Todo',
      open: true,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'journal-append') {
      expect(result.data.section).toBe('Todo');
      expect(result.data.open).toBe(true);
    }
  });

  it('note-append ステップが通る', () => {
    const result = commandStepSchema.safeParse({
      kind: 'note-append',
      target: 'notes/inbox.md',
      content: '追記内容',
    });
    expect(result.success).toBe(true);
  });

  it('note-create ステップが通る', () => {
    const result = commandStepSchema.safeParse({
      kind: 'note-create',
      target: 'notes/{{title}}.md',
      content: '# {{title}}\n',
      open: true,
    });
    expect(result.success).toBe(true);
  });

  it('template-instantiate ステップが通る (最小)', () => {
    const result = commandStepSchema.safeParse({
      kind: 'template-instantiate',
      template: 'daily',
    });
    expect(result.success).toBe(true);
  });

  it('template-instantiate ステップが通る (vars 付き)', () => {
    const result = commandStepSchema.safeParse({
      kind: 'template-instantiate',
      template: 'meeting',
      vars: { 会議名: '定例' },
      open: false,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'template-instantiate') {
      expect(result.data.vars).toEqual({ 会議名: '定例' });
    }
  });

  it('未知の kind は拒否される', () => {
    const result = commandStepSchema.safeParse({
      kind: 'agent-run',  // v1 では未実装 (予約のみ)
      script: 'echo hello',
    });
    expect(result.success).toBe(false);
  });

  it('kind が欠けていると拒否される', () => {
    const result = commandStepSchema.safeParse({ content: 'x' });
    expect(result.success).toBe(false);
  });

  it('必須フィールドが欠けていると拒否される (note-append の target 欠如)', () => {
    const result = commandStepSchema.safeParse({ kind: 'note-append', content: 'x' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loamiumCommandSchema
// ---------------------------------------------------------------------------
describe('[AC-Sd22b1f-1-1] loamiumCommandSchema', () => {
  it('最小定義 (steps のみ) が通る', () => {
    const result = loamiumCommandSchema.safeParse({
      steps: [{ kind: 'journal-append', content: 'hello' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toEqual([]); // default
    }
  });

  it('全フィールド付き定義が通る', () => {
    const result = loamiumCommandSchema.safeParse({
      name: 'create-todo',
      description: 'Todo をジャーナルに追記する',
      params: [
        { name: 'title', label: 'タイトル', required: true, type: 'string' },
        { name: 'due', type: 'date' },
      ],
      steps: [
        { kind: 'note-create', target: 'todos/{{title}}.md', content: '# {{title}}\n' },
        { kind: 'journal-append', content: '- [ ] [[{{title}}]]' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('create-todo');
      expect(result.data.params).toHaveLength(2);
      expect(result.data.steps).toHaveLength(2);
    }
  });

  it('steps が空配列は拒否される (1 個以上必須)', () => {
    const result = loamiumCommandSchema.safeParse({ steps: [] });
    expect(result.success).toBe(false);
  });

  it('steps が未定義は拒否される', () => {
    const result = loamiumCommandSchema.safeParse({ name: 'test' });
    expect(result.success).toBe(false);
  });

  it('steps 内の未知 kind は拒否される', () => {
    const result = loamiumCommandSchema.safeParse({
      steps: [{ kind: 'unknown-step', foo: 'bar' }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseLoamiumCommand
// ---------------------------------------------------------------------------
describe('[AC-Sd22b1f-1-1] parseLoamiumCommand', () => {
  it('正常な frontmatter から LoamiumCommand を返す', () => {
    const fm: Record<string, unknown> = {
      'loamium-command': {
        name: 'create-todo',
        steps: [{ kind: 'journal-append', content: '- [ ] {{title}}' }],
        params: [{ name: 'title', required: true }],
      },
    };
    const cmd = parseLoamiumCommand(fm);
    expect(cmd).not.toBeNull();
    expect(cmd?.name).toBe('create-todo');
    expect(cmd?.steps).toHaveLength(1);
    expect(cmd?.params).toHaveLength(1);
  });

  it('null frontmatter (壊れ YAML) は null を返す', () => {
    expect(parseLoamiumCommand(null)).toBeNull();
  });

  it('loamium-command キーが存在しない frontmatter は null を返す', () => {
    expect(parseLoamiumCommand({ title: 'foo' })).toBeNull();
  });

  it('loamium-command が非オブジェクト (文字列) は null を返す', () => {
    expect(parseLoamiumCommand({ 'loamium-command': 'これは壊れた定義' })).toBeNull();
  });

  it('steps の未知 kind は null を返す', () => {
    const fm: Record<string, unknown> = {
      'loamium-command': {
        steps: [{ kind: 'agent-run' }],
      },
    };
    expect(parseLoamiumCommand(fm)).toBeNull();
  });

  it('型不一致 (steps が数値) は null を返す', () => {
    expect(parseLoamiumCommand({ 'loamium-command': { steps: 42 } })).toBeNull();
  });

  it('params の name が空は null を返す', () => {
    const fm: Record<string, unknown> = {
      'loamium-command': {
        params: [{ name: '' }],
        steps: [{ kind: 'journal-append', content: 'x' }],
      },
    };
    expect(parseLoamiumCommand(fm)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseLoamiumCommandWithError
// ---------------------------------------------------------------------------
describe('[AC-Sd22b1f-1-1] parseLoamiumCommandWithError', () => {
  it('正常 frontmatter は ok:true + command を返す', () => {
    const fm: Record<string, unknown> = {
      'loamium-command': {
        steps: [{ kind: 'note-append', target: 'inbox.md', content: '追記' }],
      },
    };
    const result = parseLoamiumCommandWithError(fm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.steps[0]?.kind).toBe('note-append');
    }
  });

  it('null frontmatter は ok:false + error を返す', () => {
    const result = parseLoamiumCommandWithError(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('frontmatter');
    }
  });

  it('loamium-command キー欠損は ok:false + error を返す', () => {
    const result = parseLoamiumCommandWithError({ other: 'key' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('loamium-command');
    }
  });

  it('未知の kind は ok:false + error を返す', () => {
    const result = parseLoamiumCommandWithError({
      'loamium-command': { steps: [{ kind: 'unknown' }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
