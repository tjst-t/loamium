/**
 * [AC-Sd22b1f-1-1] LoamiumCommand スキーマ + parseLoamiumCommand のユニットテスト。
 * [AC-Sf2f114-2-1] evaluateCondition (when / when-not の truthy/falsey 評価) のユニットテスト。
 *
 * 正常系 / 未知 kind / 型不一致 / 壊れ YAML (= null frontmatter) / loamium-command キー欠損 を検証。
 */
import { describe, expect, it } from 'vitest';
import {
  commandParamSchema,
  commandStepSchema,
  evaluateCondition,
  loamiumCommandSchema,
  parseLoamiumCommand,
  parseLoamiumCommandWithError,
  parseLoamiumCommandFile,
  parseLoamiumCommandFileWithError,
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

  it('type が string / text / date を受け入れる (既存 3 種 — 後方互換)', () => {
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
    const result = commandParamSchema.safeParse({ name: 'x', type: 'foobar' });
    expect(result.success).toBe(false);
  });

  // ---- [AC-Sf2f114-5-1] 新規 4 型 ----

  it('[AC-Sf2f114-5-1] type=boolean が通る', () => {
    const result = commandParamSchema.safeParse({ name: 'flag', type: 'boolean' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('boolean');
    }
  });

  it('[AC-Sf2f114-5-1] type=number が通る', () => {
    const result = commandParamSchema.safeParse({ name: 'count', type: 'number' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('number');
    }
  });

  it('[AC-Sf2f114-5-1] type=note が通る', () => {
    const result = commandParamSchema.safeParse({ name: 'target', type: 'note' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('note');
    }
  });

  it('[AC-Sf2f114-5-1] type=select + options (非空) が通る', () => {
    const result = commandParamSchema.safeParse({
      name: 'priority',
      type: 'select',
      options: ['low', 'medium', 'high'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('select');
      expect(result.data.options).toEqual(['low', 'medium', 'high']);
    }
  });

  it('[AC-Sf2f114-5-1] type=select で options が空配列 → 無効', () => {
    const result = commandParamSchema.safeParse({
      name: 'priority',
      type: 'select',
      options: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.errors.map((e) => e.message).join(' ');
      expect(msgs).toContain('options');
    }
  });

  it('[AC-Sf2f114-5-1] type=select で options が省略 → 無効', () => {
    const result = commandParamSchema.safeParse({
      name: 'priority',
      type: 'select',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.errors.map((e) => e.message).join(' ');
      expect(msgs).toContain('options');
    }
  });

  it('[AC-Sf2f114-5-1] type=string で options を付けても通る (ignored at runtime)', () => {
    // select 以外で options を含む場合は許容する (additive — 無視)
    const result = commandParamSchema.safeParse({
      name: 'x',
      type: 'string',
      options: ['a', 'b'],
    });
    expect(result.success).toBe(true);
  });

  it('[AC-Sf2f114-5-1] 既存の string / text / date は options なしで変わらず通る', () => {
    for (const t of ['string', 'text', 'date'] as const) {
      const result = commandParamSchema.safeParse({ name: 'x', type: t });
      expect(result.success, `type=${t} (no options) should still be valid`).toBe(true);
    }
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
      kind: 'shell-exec',  // ユニオンに存在しない kind (プラグイン禁止)
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

// ---------------------------------------------------------------------------
// [AC-Sf2f114-2-1] evaluateCondition — truthy / falsey 判定
// ---------------------------------------------------------------------------
describe('[AC-Sf2f114-2-1] evaluateCondition', () => {
  // falsey ケース
  it('空文字列 "" → falsey', () => {
    expect(evaluateCondition('')).toBe(false);
  });

  it('空白のみ文字列 "  " → falsey (trim 後が空)', () => {
    expect(evaluateCondition('  ')).toBe(false);
  });

  it('"false" → falsey', () => {
    expect(evaluateCondition('false')).toBe(false);
  });

  it('"false" (前後空白付き) → falsey (trim 後 "false")', () => {
    expect(evaluateCondition('  false  ')).toBe(false);
  });

  it('"0" → falsey', () => {
    expect(evaluateCondition('0')).toBe(false);
  });

  it('"0" (前後空白付き) → falsey (trim 後 "0")', () => {
    expect(evaluateCondition('  0  ')).toBe(false);
  });

  // truthy ケース
  it('"true" → truthy', () => {
    expect(evaluateCondition('true')).toBe(true);
  });

  it('"1" → truthy', () => {
    expect(evaluateCondition('1')).toBe(true);
  });

  it('"yes" → truthy', () => {
    expect(evaluateCondition('yes')).toBe(true);
  });

  it('任意の非空・非 false・非 0 文字列 → truthy', () => {
    expect(evaluateCondition('hello')).toBe(true);
    expect(evaluateCondition('任意テキスト')).toBe(true);
    expect(evaluateCondition('FALSE')).toBe(true); // 大文字は truthy
    expect(evaluateCondition('0.0')).toBe(true);   // "0.0" は "0" ではない
  });
});

// ---------------------------------------------------------------------------
// [AC-Sf2f114-2-1] commandStepSchema — when / when-not フィールドのスキーマ検証
// ---------------------------------------------------------------------------
describe('[AC-Sf2f114-2-1] commandStepSchema with when / when-not', () => {
  it('journal-append に when フィールドが追加できる', () => {
    const result = commandStepSchema.safeParse({
      kind: 'journal-append',
      content: '追記テキスト',
      when: '{{flag}}',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'journal-append') {
      expect(result.data.when).toBe('{{flag}}');
    }
  });

  it('journal-append に when-not フィールドが追加できる', () => {
    const result = commandStepSchema.safeParse({
      kind: 'journal-append',
      content: '追記テキスト',
      'when-not': '{{skip_flag}}',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'journal-append') {
      expect(result.data['when-not']).toBe('{{skip_flag}}');
    }
  });

  it('note-append に when / when-not が追加できる', () => {
    const result = commandStepSchema.safeParse({
      kind: 'note-append',
      target: 'notes/inbox.md',
      content: '追記内容',
      when: 'truthy',
      'when-not': '',
    });
    expect(result.success).toBe(true);
  });

  it('note-create に when / when-not が追加できる', () => {
    const result = commandStepSchema.safeParse({
      kind: 'note-create',
      target: 'notes/{{title}}.md',
      content: '# {{title}}\n',
      when: '{{create_flag}}',
    });
    expect(result.success).toBe(true);
  });

  it('template-instantiate に when / when-not が追加できる', () => {
    const result = commandStepSchema.safeParse({
      kind: 'template-instantiate',
      template: 'daily',
      'when-not': 'false',
    });
    expect(result.success).toBe(true);
  });

  it('when / when-not なしの既存ステップも引き続き通る (後方互換)', () => {
    const result = commandStepSchema.safeParse({
      kind: 'note-create',
      target: 'notes/test.md',
      content: '# test',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'note-create') {
      expect(result.data.when).toBeUndefined();
      expect(result.data['when-not']).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// [ADR-0024] parseLoamiumCommandFile — ファイル全体 YAML パース
// ---------------------------------------------------------------------------
describe('[ADR-0024] parseLoamiumCommandFile', () => {
  it('有効な全体 YAML → LoamiumCommand を返す', () => {
    const yaml = [
      'name: create-todo',
      'description: Todo を追記する',
      'params:',
      '  - name: title',
      '    required: true',
      'steps:',
      '  - kind: journal-append',
      '    content: "- [ ] {{title}}"',
    ].join('\n');
    const cmd = parseLoamiumCommandFile(yaml);
    expect(cmd).not.toBeNull();
    expect(cmd?.name).toBe('create-todo');
    expect(cmd?.steps).toHaveLength(1);
    expect(cmd?.params).toHaveLength(1);
  });

  it('steps のみ (最小定義) → LoamiumCommand を返す', () => {
    const yaml = 'steps:\n  - kind: journal-append\n    content: "hello"';
    const cmd = parseLoamiumCommandFile(yaml);
    expect(cmd).not.toBeNull();
    expect(cmd?.steps[0]?.kind).toBe('journal-append');
  });

  it('空文字列 → null を返す', () => {
    expect(parseLoamiumCommandFile('')).toBeNull();
    expect(parseLoamiumCommandFile('   ')).toBeNull();
  });

  it('壊れた YAML (パースエラー) → null を返す', () => {
    const badYaml = 'name: foo\nsteps: [\nunclosed: bracket';
    expect(parseLoamiumCommandFile(badYaml)).toBeNull();
  });

  it('steps が空配列 → null を返す (1 個以上必須)', () => {
    const yaml = 'name: empty\nsteps: []';
    expect(parseLoamiumCommandFile(yaml)).toBeNull();
  });

  it('steps が未定義 → null を返す', () => {
    const yaml = 'name: no-steps';
    expect(parseLoamiumCommandFile(yaml)).toBeNull();
  });

  it('未知の kind → null を返す', () => {
    const yaml = 'steps:\n  - kind: agent-run\n    script: echo hello';
    expect(parseLoamiumCommandFile(yaml)).toBeNull();
  });

  it('loamium-command: ラッパーキーを持つ古い形式 → 無効 (name/params/steps が欠ける)', () => {
    // ADR-0024: トップレベルが LoamiumCommand であるべき。
    // loamium-command: をトップキーに持つ場合、steps が欠けるため invalid になる。
    const yaml = [
      'loamium-command:',
      '  name: create-todo',
      '  steps:',
      '    - kind: journal-append',
      '      content: "hello"',
    ].join('\n');
    // トップレベルに steps がないため null
    expect(parseLoamiumCommandFile(yaml)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [ADR-0024] parseLoamiumCommandFileWithError
// ---------------------------------------------------------------------------
describe('[ADR-0024] parseLoamiumCommandFileWithError', () => {
  it('有効な全体 YAML → ok:true + command を返す', () => {
    const yaml = 'steps:\n  - kind: note-create\n    target: "out.md"\n    content: "# out"';
    const result = parseLoamiumCommandFileWithError(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.steps[0]?.kind).toBe('note-create');
    }
  });

  it('空ファイル → ok:false + error を返す', () => {
    const result = parseLoamiumCommandFileWithError('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('empty');
    }
  });

  it('壊れた YAML → ok:false + error (YAML parse error message) を返す', () => {
    const result = parseLoamiumCommandFileWithError('name: foo\nsteps: [\nunclosed:');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('スキーマ不合格 (steps 空) → ok:false + error を返す', () => {
    const result = parseLoamiumCommandFileWithError('name: x\nsteps: []');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('loamium-command: ラッパーキーを持つ旧形式 → ok:false (steps 欠如)', () => {
    const yaml = [
      'loamium-command:',
      '  name: create-todo',
      '  steps:',
      '    - kind: journal-append',
      '      content: "hello"',
    ].join('\n');
    const result = parseLoamiumCommandFileWithError(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// agent-run ステップ (ADR-0028 / S5a66e4-2) — 加算スライス
// 既存 6 種の定義・パース・テストは不変。ここでは 7 種目のみを検証する。
// ---------------------------------------------------------------------------
describe('[AC-S5a66e4-2-1] commandStepSchema with agent-run', () => {
  it('agent-run ステップが通る (prompt のみ = 最小)', () => {
    const result = commandStepSchema.safeParse({
      kind: 'agent-run',
      prompt: '直近の議事録を要約して当日ジャーナルの ## 議事録 に追記して',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'agent-run') {
      expect(result.data.prompt).toContain('議事録');
      // 省略時は undefined (既定 20/120 は実行側 commands.ts で補完する)
      expect(result.data.maxTurns).toBeUndefined();
      expect(result.data.timeoutSec).toBeUndefined();
      expect(result.data.permissions).toBeUndefined();
    }
  });

  it('agent-run ステップが通る (全フィールド: permissions/maxTurns/timeoutSec/open/when)', () => {
    const result = commandStepSchema.safeParse({
      kind: 'agent-run',
      prompt: '{{source}} を要約して',
      permissions: ['read', 'journal_append'],
      maxTurns: 30,
      timeoutSec: 300,
      open: true,
      when: '{{do_summarize}}',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'agent-run') {
      expect(result.data.permissions).toEqual(['read', 'journal_append']);
      expect(result.data.maxTurns).toBe(30);
      expect(result.data.timeoutSec).toBe(300);
      expect(result.data.when).toBe('{{do_summarize}}');
    }
  });

  it("permissions プリセット文字列 'full' も通る", () => {
    const result = commandStepSchema.safeParse({
      kind: 'agent-run',
      prompt: 'x',
      permissions: 'full',
    });
    expect(result.success).toBe(true);
  });

  it('prompt 欠落は拒否される', () => {
    const result = commandStepSchema.safeParse({ kind: 'agent-run' });
    expect(result.success).toBe(false);
    if (!result.success) {
      // discriminatedUnion は正しく agent-run 分岐へ入り prompt required を報告する
      const promptIssue = result.error.errors.find((e) => e.path.includes('prompt'));
      expect(promptIssue).toBeDefined();
    }
  });

  it('prompt 空文字は拒否される (min(1))', () => {
    const result = commandStepSchema.safeParse({ kind: 'agent-run', prompt: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const promptIssue = result.error.errors.find((e) => e.path.includes('prompt'));
      expect(promptIssue).toBeDefined();
    }
  });

  it('maxTurns が範囲外 (51) は拒否される', () => {
    const result = commandStepSchema.safeParse({ kind: 'agent-run', prompt: 'x', maxTurns: 51 });
    expect(result.success).toBe(false);
  });

  it('timeoutSec が範囲外 (5) は拒否される', () => {
    const result = commandStepSchema.safeParse({ kind: 'agent-run', prompt: 'x', timeoutSec: 5 });
    expect(result.success).toBe(false);
  });

  it('未知の permissions ケーパビリティは拒否される', () => {
    const result = commandStepSchema.safeParse({
      kind: 'agent-run',
      prompt: 'x',
      permissions: ['read', 'nope'],
    });
    expect(result.success).toBe(false);
  });
});

describe('[AC-S5a66e4-2-3] parseLoamiumCommandFileWithError with agent-run', () => {
  it('agent-run を含む有効な YAML → ok:true', () => {
    const yaml = [
      'name: meeting-summary',
      'steps:',
      '  - kind: agent-run',
      '    prompt: "{{source}} を読んで要約し当日ジャーナルの {{section}} へ追記して"',
      '    maxTurns: 25',
      '    timeoutSec: 300',
    ].join('\n');
    const result = parseLoamiumCommandFileWithError(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const step = result.command.steps[0];
      expect(step?.kind).toBe('agent-run');
      if (step?.kind === 'agent-run') {
        expect(step.prompt).toContain('要約');
        expect(step.maxTurns).toBe(25);
      }
    }
  });

  it('agent-run で prompt 欠落 → ok:false + 具体的エラー', () => {
    const yaml = ['steps:', '  - kind: agent-run', '    maxTurns: 10'].join('\n');
    const result = parseLoamiumCommandFileWithError(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('prompt');
    }
  });

  it('agent-run で prompt 空文字 → ok:false + 具体的エラー', () => {
    const yaml = ['steps:', '  - kind: agent-run', '    prompt: ""'].join('\n');
    const result = parseLoamiumCommandFileWithError(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('prompt');
    }
  });
});
