/**
 * S1bd397-1/3 候補解決ヘルパのユニットテスト。
 *
 * テスト対象:
 *   - resolveOptionsQuery (純関数: DQL 実行 → 候補 + top-N + 打ち切りフラグ)
 *   - validateOptionsDependencies (宣言順・循環/前方参照検出)
 *   - resolveDependentOptionsQuery (上流変数 resolveTemplate 注入 → DQL 実行)
 *
 * test-discipline Rule 1: 各 it は 1 AC を被覆し [AC-...] タグを付ける。
 * test-discipline Rule 6: 純関数は外部 IO なし。
 * test-discipline Rule 7: superRefine を含む後方互換は回帰テストで担保。
 */
import { describe, expect, it } from 'vitest';
import { resolveOptionsQuery, validateOptionsDependencies } from './options-query.js';
import type { QueryableNote } from './dql.js';

// ---- テスト用ノート群 ----

function note(partial: Partial<QueryableNote> & { path: string }): QueryableNote {
  const base = partial.path.split('/').pop() ?? partial.path;
  return {
    title: base.replace(/\.md$/i, ''),
    folder: partial.path.includes('/') ? partial.path.slice(0, partial.path.lastIndexOf('/')) : '',
    mtime: 0,
    tags: [],
    frontmatter: null,
    tasks: [],
    ...partial,
  };
}

const NOTES_PROJECT: QueryableNote[] = [
  note({ path: 'projects/loamium/index.md', tags: ['project'], frontmatter: {} }),
  note({ path: 'projects/webapp/index.md', tags: ['project'], frontmatter: {} }),
  note({ path: 'projects/infra/index.md', tags: ['project'], frontmatter: {} }),
];

const NOTES_EPIC: QueryableNote[] = [
  note({
    path: 'projects/loamium/epic-dql.md',
    tags: ['epic'],
    frontmatter: { project: 'loamium' },
  }),
  note({
    path: 'projects/webapp/epic-ui.md',
    tags: ['epic'],
    frontmatter: { project: 'webapp' },
  }),
];

const ALL_NOTES: QueryableNote[] = [...NOTES_PROJECT, ...NOTES_EPIC];

// ---- AC-S1bd397-1-2: DQL 再利用・単一ヘルパ集約 ----

describe('[AC-S1bd397-1-2] resolveOptionsQuery — DQL エンジン再利用', () => {
  it('LIST FROM #project → プロジェクトタイトル一覧を返す', () => {
    const result = resolveOptionsQuery('LIST FROM #project', ALL_NOTES);
    expect(result.candidates.map((c) => c.value)).toContain('loamium');
    expect(result.candidates.map((c) => c.value)).toContain('webapp');
    // epic タグのノートは含まれない
    expect(result.candidates.map((c) => c.value)).not.toContain('epic-dql');
  });

  it('value と label は同じノートタイトル (v1 仕様)', () => {
    const result = resolveOptionsQuery('LIST FROM #project', ALL_NOTES);
    for (const c of result.candidates) {
      expect(c.value).toBe(c.label);
    }
  });

  it('LIST FROM "folder" → フォルダ絞り込みが効く', () => {
    const result = resolveOptionsQuery('LIST FROM "projects/loamium"', ALL_NOTES);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => c.value.includes('loamium') || c.value.includes('epic'))).toBe(true);
  });

  it('WHERE 条件で絞り込まれた候補が返る', () => {
    const result = resolveOptionsQuery('LIST FROM #epic WHERE project = "loamium"', ALL_NOTES);
    expect(result.candidates.map((c) => c.value)).toContain('epic-dql');
    expect(result.candidates.map((c) => c.value)).not.toContain('epic-ui');
  });
});

// ---- AC-S1bd397-1-3: top-N + 打ち切りフラグ ----

describe('[AC-S1bd397-1-3] top-N と打ち切りフラグ', () => {
  it('候補が topN 以下なら truncated:false', () => {
    const result = resolveOptionsQuery('LIST FROM #project', ALL_NOTES, 50);
    expect(result.truncated).toBe(false);
  });

  it('候補が topN を超えたら topN 件に打ち切り truncated:true', () => {
    // topN=2 で 3 件の #project を絞り込む
    const result = resolveOptionsQuery('LIST FROM #project', NOTES_PROJECT, 2);
    expect(result.candidates).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('topN=1 でも 1 件だけ返し truncated:true', () => {
    const result = resolveOptionsQuery('LIST', ALL_NOTES, 1);
    expect(result.candidates).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

// ---- AC-S1bd397-1-4: 0 件フォールバック ----

describe('[AC-S1bd397-1-4] 0 件は空配列でエラーにしない', () => {
  it('該当ノードなし → candidates:[] truncated:false', () => {
    const result = resolveOptionsQuery('LIST FROM #nonexistent', ALL_NOTES);
    expect(result.candidates).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('WHERE 条件で全件除外 → 空配列', () => {
    const result = resolveOptionsQuery('LIST WHERE title = "存在しない"', ALL_NOTES);
    expect(result.candidates).toEqual([]);
  });
});

// ---- AC-S1bd397-3-2: 宣言順・循環/前方参照エラー ----

describe('[AC-S1bd397-3-2] validateOptionsDependencies — 宣言順・循環禁止', () => {
  it('依存なしは valid (エラーなし)', () => {
    const result = validateOptionsDependencies([
      { name: 'プロジェクト', optionsQuery: 'LIST FROM #project' },
      { name: 'Epic', optionsQuery: 'LIST FROM #epic' },
    ]);
    expect(result.valid).toBe(true);
  });

  it('宣言順の前方参照 (下→上) は valid', () => {
    const result = validateOptionsDependencies([
      { name: 'プロジェクト', optionsQuery: 'LIST FROM #project' },
      { name: 'Epic', optionsQuery: 'LIST FROM #epic WHERE project = "{{プロジェクト}}"' },
    ]);
    expect(result.valid).toBe(true);
  });

  it('後方参照 (まだ宣言されていない変数を参照) はエラー', () => {
    const result = validateOptionsDependencies([
      { name: 'Epic', optionsQuery: 'LIST FROM #epic WHERE project = "{{プロジェクト}}"' },
      { name: 'プロジェクト', optionsQuery: 'LIST FROM #project' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('前方参照');
  });

  it('自己参照 (循環の最小ケース) はエラー', () => {
    const result = validateOptionsDependencies([
      { name: 'X', optionsQuery: 'LIST WHERE title = "{{X}}"' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('循環');
  });

  it('A→B→A の循環はエラー', () => {
    const result = validateOptionsDependencies([
      { name: 'A', optionsQuery: 'LIST WHERE foo = "{{B}}"' },
      { name: 'B', optionsQuery: 'LIST WHERE bar = "{{A}}"' },
    ]);
    expect(result.valid).toBe(false);
  });

  it('optionsQuery を持たない変数は依存グラフの対象外', () => {
    const result = validateOptionsDependencies([
      { name: 'フリー', optionsQuery: undefined },
      { name: '依存先', optionsQuery: 'LIST FROM #project' },
    ]);
    expect(result.valid).toBe(true);
  });
});

// ---- AC-S1bd397-3-1: 依存解決・上流変数注入 ----

describe('[AC-S1bd397-3-1] resolveOptionsQuery — 依存クエリ (上流変数注入)', () => {
  it('resolvedVars を注入してから DQL を実行する', () => {
    // {{プロジェクト}} を 'loamium' に注入した DQL: LIST FROM #epic WHERE project = "loamium"
    const result = resolveOptionsQuery(
      'LIST FROM #epic WHERE project = "{{プロジェクト}}"',
      ALL_NOTES,
      50,
      { プロジェクト: 'loamium' },
    );
    expect(result.candidates.map((c) => c.value)).toContain('epic-dql');
    expect(result.candidates.map((c) => c.value)).not.toContain('epic-ui');
  });

  it('resolvedVars が空のとき {{変数}} は空文字に展開される (エラーにしない)', () => {
    // 上流未確定時のフォールバック: 空展開で DQL 実行 → WHERE 条件は空文字マッチのみ → 通常は 0 件
    const result = resolveOptionsQuery(
      'LIST FROM #epic WHERE project = "{{プロジェクト}}"',
      ALL_NOTES,
      50,
      {},
    );
    // 空文字マッチは 0 件 (project="" のノードはない)
    expect(result.candidates).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

// ---- AC-S1bd397-3-3: 上流変更で下流再解決 ----

describe('[AC-S1bd397-3-3] 上流値変更 → 下流再解決', () => {
  it('上流値を変えると異なる候補セットが返る', () => {
    const r1 = resolveOptionsQuery(
      'LIST FROM #epic WHERE project = "{{プロジェクト}}"',
      ALL_NOTES,
      50,
      { プロジェクト: 'loamium' },
    );
    const r2 = resolveOptionsQuery(
      'LIST FROM #epic WHERE project = "{{プロジェクト}}"',
      ALL_NOTES,
      50,
      { プロジェクト: 'webapp' },
    );
    expect(r1.candidates.map((c) => c.value)).toContain('epic-dql');
    expect(r1.candidates.map((c) => c.value)).not.toContain('epic-ui');
    expect(r2.candidates.map((c) => c.value)).toContain('epic-ui');
    expect(r2.candidates.map((c) => c.value)).not.toContain('epic-dql');
  });
});
