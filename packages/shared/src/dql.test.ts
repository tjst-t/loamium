/**
 * DQL パーサー + 評価器のユニットテスト (Sb1593c-1 — ユニットテスト必須)。
 * パーサー (構文 → AST / 位置情報付きエラー) と評価器 (from / where / sort) の両方。
 */
import { describe, expect, it } from 'vitest';
import { DqlParseError, executeQuery, parseQuery, runQuery, type QueryableNote } from './dql.js';

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

describe('parseQuery — 構文', () => {
  it('LIST 単独をパースする', () => {
    expect(parseQuery('LIST')).toEqual({ type: 'list', fields: [], from: null, where: [], sort: null, limit: null });
  });

  it('キーワードは大文字小文字両対応 (list / List / LIST)', () => {
    for (const q of ['list from #a', 'List FROM #a', 'LIST from #a']) {
      expect(parseQuery(q).from).toEqual({ kind: 'tag', tag: 'a' });
    }
  });

  it('TABLE の列リスト (カンマ区切り) をパースする', () => {
    const ast = parseQuery('TABLE status, updated from "projects"');
    expect(ast.type).toBe('table');
    expect(ast.fields).toEqual(['status', 'updated']);
    expect(ast.from).toEqual({ kind: 'folder', folder: 'projects' });
  });

  it('TABLE で列を省略すると構文エラー', () => {
    expect(() => parseQuery('TABLE from #a')).toThrow(DqlParseError);
  });

  it('from #tag と from "folder" の両方をパースする', () => {
    expect(parseQuery('TASK from #project').from).toEqual({ kind: 'tag', tag: 'project' });
    expect(parseQuery('TASK from "dir/sub"').from).toEqual({ kind: 'folder', folder: 'dir/sub' });
  });

  it('where の比較演算子 (= != > < >= <= contains) をパースする', () => {
    const ast = parseQuery(
      'LIST where a = "x" and b != 2 and c > 1 and d < 1 and e >= 1 and f <= 1 and g contains "y"',
    );
    expect(ast.where).toHaveLength(7);
    expect(ast.where[0]).toEqual({ kind: 'compare', field: 'a', op: '=', value: 'x' });
    expect(ast.where[1]).toEqual({ kind: 'compare', field: 'b', op: '!=', value: 2 });
    expect(ast.where[6]).toEqual({ kind: 'compare', field: 'g', op: 'contains', value: 'y' });
  });

  it('bare フィールドと !フィールド (truthy / 否定) をパースする', () => {
    const ast = parseQuery('TASK where !completed and archived');
    expect(ast.where[0]).toEqual({ kind: 'truthy', field: 'completed', negated: true });
    expect(ast.where[1]).toEqual({ kind: 'truthy', field: 'archived', negated: false });
  });

  it('sort field asc/desc (省略時 asc) をパースする', () => {
    expect(parseQuery('LIST sort updated desc').sort).toEqual({ field: 'updated', direction: 'desc' });
    expect(parseQuery('LIST sort updated').sort).toEqual({ field: 'updated', direction: 'asc' });
  });

  it('true / false リテラルをパースする', () => {
    const ast = parseQuery('LIST where draft = true');
    expect(ast.where[0]).toEqual({ kind: 'compare', field: 'draft', op: '=', value: true });
  });
});

describe('parseQuery — 構文エラー (位置情報付き)', () => {
  it("prototype の例: 'LIST form #reading' は 1 行 6 列でエラー", () => {
    try {
      parseQuery('LIST form #reading');
      expect.unreachable('構文エラーになるはず');
    } catch (err) {
      expect(err).toBeInstanceOf(DqlParseError);
      const e = err as DqlParseError;
      expect(e.line).toBe(1);
      expect(e.column).toBe(6);
      expect(e.length).toBe(4);
      expect(e.message).toContain('1 行 6 列');
      expect(e.message).toContain("'form'");
    }
  });

  it('先頭が LIST/TABLE/TASK 以外はエラー', () => {
    expect(() => parseQuery('SELECT id FROM notes')).toThrow(/LIST.*TABLE.*TASK/);
  });

  it('空クエリはエラー', () => {
    expect(() => parseQuery('')).toThrow(DqlParseError);
  });

  it('対応外の構文 (where の or) は明確なエラー', () => {
    expect(() => parseQuery('LIST where a = "x" or b = "y"')).toThrow(DqlParseError);
  });

  it('閉じられていない文字列リテラルはエラー', () => {
    expect(() => parseQuery('LIST from "projects')).toThrow(/閉じられていない/);
  });

  it('複数行クエリのエラーは 2 行目の位置を指す', () => {
    try {
      parseQuery('LIST from #a\nwhere status ~ "x"');
      expect.unreachable('構文エラーになるはず');
    } catch (err) {
      const e = err as DqlParseError;
      expect(e.line).toBe(2);
      expect(e.column).toBe(14);
    }
  });

  it('FROM の後にタグ/フォルダ以外が来るとエラー', () => {
    expect(() => parseQuery('LIST from projects')).toThrow(/#タグ.*フォルダ/);
  });
});

describe('executeQuery — 評価', () => {
  const notes: QueryableNote[] = [
    note({
      path: 'projects/hydra.md',
      mtime: Date.parse('2026-07-03'),
      tags: ['project', 'infra'],
      frontmatter: { status: 'in-progress', updated: '2026-07-03', priority: 2 },
      tasks: [
        { line: 5, text: 'DNS TTL を短縮', checked: false, indent: 0, status: null, priority: null, due: null },
        { line: 6, text: 'NFS エクスポート許可', checked: true, indent: 4, status: null, priority: null, due: null },
      ],
    }),
    note({
      path: 'projects/garden.md',
      mtime: Date.parse('2026-06-21'),
      tags: ['project'],
      frontmatter: { status: 'paused', updated: '2026-06-21', priority: 5 },
    }),
    note({
      path: 'reading/book.md',
      mtime: Date.parse('2026-05-01'),
      tags: ['reading'],
      frontmatter: { status: 'done' },
      tasks: [{ line: 3, text: '第 2 章を読む', checked: false, indent: 0, status: null, priority: null, due: null }],
    }),
    note({ path: 'inbox.md', mtime: Date.parse('2026-07-01') }),
  ];

  it('LIST from #tag はタグ付きノートのみ (パス昇順)', () => {
    const res = runQuery('LIST from #project', notes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results.map((r) => r.path)).toEqual(['projects/garden.md', 'projects/hydra.md']);
    expect(res.results[1]).toEqual({ path: 'projects/hydra.md', title: 'hydra', folder: 'projects' });
  });

  it('from #tag はネストタグにもマッチする (Obsidian 互換)', () => {
    const tagged = [note({ path: 'a.md', tags: ['dev/api'] }), note({ path: 'b.md', tags: ['devops'] })];
    const res = runQuery('LIST from #dev', tagged);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results.map((r) => r.path)).toEqual(['a.md']);
  });

  it('from "folder" はサブフォルダも含む', () => {
    const res = runQuery('LIST from "projects"', notes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results).toHaveLength(2);
  });

  it('TABLE は fields のセル値 (frontmatter / 欠損 null) を返し、sort desc が効く', () => {
    const res = runQuery('TABLE status, updated from "projects" where status != "done" sort updated desc', notes);
    if (res.type !== 'table') expect.unreachable();
    expect(res.fields).toEqual(['status', 'updated']);
    expect(res.results.map((r) => r.title)).toEqual(['hydra', 'garden']);
    expect(res.results[0]?.values).toEqual(['in-progress', '2026-07-03']);
  });

  it('where の数値比較 (> / <=) が効く', () => {
    const res = runQuery('LIST where priority > 2', notes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results.map((r) => r.path)).toEqual(['projects/garden.md']);
  });

  it('組み込みフィールド file.name / file.folder / file.path が使える', () => {
    const byName = runQuery('LIST where file.name = "hydra"', notes);
    if (byName.type !== 'list') expect.unreachable();
    expect(byName.results.map((r) => r.path)).toEqual(['projects/hydra.md']);

    const byFolder = runQuery('LIST where file.folder = "reading"', notes);
    if (byFolder.type !== 'list') expect.unreachable();
    expect(byFolder.results.map((r) => r.path)).toEqual(['reading/book.md']);

    const byPath = runQuery('LIST where file.path contains "inbox"', notes);
    if (byPath.type !== 'list') expect.unreachable();
    expect(byPath.results.map((r) => r.path)).toEqual(['inbox.md']);
  });

  it('file.mtime は日付文字列と比較できる', () => {
    const res = runQuery('LIST where file.mtime >= "2026-07-01"', notes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results.map((r) => r.path)).toEqual(['inbox.md', 'projects/hydra.md']);
  });

  it('tags contains はタグ配列の要素一致 (大文字小文字不区別)', () => {
    const res = runQuery('LIST where tags contains "INFRA"', notes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results.map((r) => r.path)).toEqual(['projects/hydra.md']);
  });

  it('文字列フィールドの contains は部分一致', () => {
    const res = runQuery('LIST where status contains "progress"', notes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results.map((r) => r.path)).toEqual(['projects/hydra.md']);
  });

  it('欠損フィールドは = で false、!= で true', () => {
    const eq = runQuery('LIST where nonexistent = "x"', notes);
    if (eq.type !== 'list') expect.unreachable();
    expect(eq.results).toHaveLength(0);
    const ne = runQuery('LIST where nonexistent != "x"', notes);
    if (ne.type !== 'list') expect.unreachable();
    expect(ne.results).toHaveLength(4);
  });

  it('TASK は行番号・ネスト付きで全タスクを返す (パス → 行番号順)', () => {
    const res = runQuery('TASK', notes);
    if (res.type !== 'task') expect.unreachable();
    expect(res.results).toEqual([
      { path: 'projects/hydra.md', title: 'hydra', line: 5, text: 'DNS TTL を短縮', checked: false, indent: 0, status: null, priority: null, due: null },
      { path: 'projects/hydra.md', title: 'hydra', line: 6, text: 'NFS エクスポート許可', checked: true, indent: 4, status: null, priority: null, due: null },
      { path: 'reading/book.md', title: 'book', line: 3, text: '第 2 章を読む', checked: false, indent: 0, status: null, priority: null, due: null },
    ]);
  });

  it('TASK where !completed は未完了のみ、completed は完了のみ', () => {
    const open = runQuery('TASK where !completed', notes);
    if (open.type !== 'task') expect.unreachable();
    expect(open.results.map((r) => r.line)).toEqual([5, 3]);
    const done = runQuery('TASK where completed', notes);
    if (done.type !== 'task') expect.unreachable();
    expect(done.results).toEqual([
      { path: 'projects/hydra.md', title: 'hydra', line: 6, text: 'NFS エクスポート許可', checked: true, indent: 4, status: null, priority: null, due: null },
    ]);
  });

  it('TASK from "folder" + text contains の組み合わせ', () => {
    const res = runQuery('TASK from "projects" where text contains "DNS"', notes);
    if (res.type !== 'task') expect.unreachable();
    expect(res.results.map((r) => r.line)).toEqual([5]);
  });

  it('sort の欠損値は方向に関わらず末尾', () => {
    const asc = runQuery('LIST sort status', notes);
    if (asc.type !== 'list') expect.unreachable();
    expect(asc.results[asc.results.length - 1]?.path).toBe('inbox.md');
    const desc = runQuery('LIST sort status desc', notes);
    if (desc.type !== 'list') expect.unreachable();
    expect(desc.results[desc.results.length - 1]?.path).toBe('inbox.md');
  });

  it('executeQuery は入力ノート配列を変更しない (読み取り専用)', () => {
    const before = JSON.stringify(notes);
    executeQuery(parseQuery('TABLE status from "projects" sort status desc'), notes);
    expect(JSON.stringify(notes)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// LIMIT 節のパーステスト
// ---------------------------------------------------------------------------

describe('[AC-S32940c-1-1][AC-S32940c-1-3] parseQuery — LIMIT 節', () => {
  it('LIMIT n をパースして limit フィールドに保持する', () => {
    const ast = parseQuery('LIST LIMIT 5');
    expect(ast.limit).toBe(5);
  });

  it('SORT と LIMIT の組み合わせをパースする (Obsidian dataview 互換)', () => {
    const ast = parseQuery('LIST SORT file.mtime DESC LIMIT 10');
    expect(ast.sort).toEqual({ field: 'file.mtime', direction: 'desc' });
    expect(ast.limit).toBe(10);
  });

  it('[AC-S32940c-1-5] LIMIT 0 は合法で 0 件を意味する', () => {
    const ast = parseQuery('LIST LIMIT 0');
    expect(ast.limit).toBe(0);
  });

  it('[AC-S32940c-1-5] 巨大な LIMIT n は受け入れる', () => {
    const ast = parseQuery('LIST LIMIT 999999');
    expect(ast.limit).toBe(999999);
  });

  it('[AC-S32940c-1-3][AC-S32940c-1-5] LIMIT 負値は DqlParseError (位置情報付き)', () => {
    try {
      parseQuery('LIST LIMIT -1');
      expect.unreachable('エラーになるはず');
    } catch (err) {
      expect(err).toBeInstanceOf(DqlParseError);
      const e = err as DqlParseError;
      expect(e.line).toBe(1);
      expect(e.column).toBeGreaterThan(0);
      expect(e.length).toBeGreaterThan(0);
      expect(e.message).toMatch(/整数/);
    }
  });

  it('[AC-S32940c-1-3][AC-S32940c-1-5] LIMIT 非整数 (小数) は DqlParseError (位置情報付き)', () => {
    try {
      parseQuery('LIST LIMIT 1.5');
      expect.unreachable('エラーになるはず');
    } catch (err) {
      expect(err).toBeInstanceOf(DqlParseError);
      const e = err as DqlParseError;
      expect(e.line).toBe(1);
      expect(e.column).toBeGreaterThan(0);
      expect(e.length).toBeGreaterThan(0);
    }
  });

  it('[AC-S32940c-1-3][AC-S32940c-1-5] LIMIT 非整数 (単語) は DqlParseError (位置情報付き)', () => {
    try {
      parseQuery('LIST SORT file.mtime DESC LIMIT abc');
      expect.unreachable('エラーになるはず');
    } catch (err) {
      expect(err).toBeInstanceOf(DqlParseError);
      const e = err as DqlParseError;
      expect(e.line).toBe(1);
      expect(e.column).toBeGreaterThan(0);
      expect(e.length).toBe(3); // 'abc' の長さ
    }
  });

  it('LIMIT なしのクエリは limit: null を返す (後方互換)', () => {
    const ast = parseQuery('LIST from #project where status = "in-progress" sort updated desc');
    expect(ast.limit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LIMIT 節の評価テスト
// ---------------------------------------------------------------------------

describe('[AC-S32940c-1-1][AC-S32940c-1-3] executeQuery — LIMIT 適用', () => {
  const manyNotes: QueryableNote[] = [
    note({ path: 'a.md', mtime: 100 }),
    note({ path: 'b.md', mtime: 200 }),
    note({ path: 'c.md', mtime: 300 }),
    note({ path: 'd.md', mtime: 400 }),
    note({ path: 'e.md', mtime: 500 }),
    note({ path: 'f.md', mtime: 600 }),
  ];

  it('[AC-S32940c-1-1] LIST SORT mtime DESC LIMIT 3 は SORT 後の先頭 3 件', () => {
    const res = runQuery('LIST SORT file.mtime DESC LIMIT 3', manyNotes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results).toHaveLength(3);
    // SORT DESC → f(600) b(400) ... 先頭 3 件
    expect(res.results.map((r) => r.path)).toEqual(['f.md', 'e.md', 'd.md']);
  });

  it('[AC-S32940c-1-5] LIMIT 0 は 0 件返す', () => {
    const res = runQuery('LIST LIMIT 0', manyNotes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results).toHaveLength(0);
  });

  it('[AC-S32940c-1-5] 巨大 n (全件より多い) は全件返す', () => {
    const res = runQuery('LIST LIMIT 999999', manyNotes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results).toHaveLength(manyNotes.length);
  });

  it('[AC-S32940c-1-3] LIMIT なしクエリは従来通り全件返す (後方互換)', () => {
    const res = runQuery('LIST', manyNotes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results).toHaveLength(manyNotes.length);
  });

  it('[AC-S32940c-1-1] TABLE LIMIT が機能する', () => {
    const tableNotes = [
      note({ path: 'x.md', frontmatter: { status: 'a' } }),
      note({ path: 'y.md', frontmatter: { status: 'b' } }),
      note({ path: 'z.md', frontmatter: { status: 'c' } }),
    ];
    const res = runQuery('TABLE status LIMIT 2', tableNotes);
    if (res.type !== 'table') expect.unreachable();
    expect(res.results).toHaveLength(2);
  });

  it('[AC-S32940c-1-1] TASK LIMIT が機能する', () => {
    const taskNotes: QueryableNote[] = [
      note({ path: 'p.md', tasks: [{ line: 1, text: 'T1', checked: false, indent: 0, status: null, priority: null, due: null }, { line: 2, text: 'T2', checked: false, indent: 0, status: null, priority: null, due: null }] }),
      note({ path: 'q.md', tasks: [{ line: 1, text: 'T3', checked: false, indent: 0, status: null, priority: null, due: null }] }),
    ];
    const res = runQuery('TASK LIMIT 2', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    expect(res.results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// file.tasks / file.open_tasks フィールドのテスト
// ---------------------------------------------------------------------------

describe('[AC-S32940c-1-2] noteField — file.tasks / file.open_tasks', () => {
  const notesWithTasks: QueryableNote[] = [
    // ノート A: 未完了タスクあり
    note({
      path: 'noteA.md',
      tasks: [
        { line: 1, text: 'open task', checked: false, indent: 0, status: null, priority: null, due: null },
        { line: 2, text: 'closed task', checked: true, indent: 0, status: null, priority: null, due: null },
      ],
    }),
    // ノート B: 完了のみ
    note({
      path: 'noteB.md',
      tasks: [{ line: 1, text: 'done', checked: true, indent: 0, status: null, priority: null, due: null }],
    }),
    // ノート C: タスク無し
    note({ path: 'noteC.md' }),
  ];

  it('[AC-S32940c-1-2] LIST WHERE file.open_tasks は未完了タスクを持つノートのみ返す', () => {
    const res = runQuery('LIST WHERE file.open_tasks', notesWithTasks);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results.map((r) => r.path)).toEqual(['noteA.md']);
  });

  it('[AC-S32940c-1-2] LIST WHERE file.tasks はタスクが存在するノートのみ返す', () => {
    const res = runQuery('LIST WHERE file.tasks', notesWithTasks);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results.map((r) => r.path)).toContain('noteA.md');
    expect(res.results.map((r) => r.path)).toContain('noteB.md');
    expect(res.results.map((r) => r.path)).not.toContain('noteC.md');
  });

  it('[AC-S32940c-1-5] タスク 0 件のノートは file.open_tasks で除外される', () => {
    const zeroTaskNotes: QueryableNote[] = [note({ path: 'zero.md', tasks: [] })];
    const res = runQuery('LIST WHERE file.open_tasks', zeroTaskNotes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results).toHaveLength(0);
  });

  it('[AC-S32940c-1-5] 完了タスクのみのノートは file.open_tasks で除外される', () => {
    const allDoneNotes: QueryableNote[] = [
      note({ path: 'alldone.md', tasks: [{ line: 1, text: 'done', checked: true, indent: 0, status: null, priority: null, due: null }] }),
    ];
    const res = runQuery('LIST WHERE file.open_tasks', allDoneNotes);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results).toHaveLength(0);
  });

  it('[AC-S32940c-1-2] file.open_tasks は数値として比較できる', () => {
    const res = runQuery('LIST WHERE file.open_tasks > 0', notesWithTasks);
    if (res.type !== 'list') expect.unreachable();
    expect(res.results.map((r) => r.path)).toEqual(['noteA.md']);
  });

  it('[AC-S32940c-1-3] 既存クエリ (LIMIT・新フィールド未使用) の結果は不変', () => {
    const res = runQuery('LIST from #project', notesWithTasks);
    if (res.type !== 'list') expect.unreachable();
    // タグなしノートなので全て除外されるべき (後方互換確認)
    expect(res.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Se3b7a2-3: TASK WHERE status / priority / due フィルタ + SORT
// [AC-Se3b7a2-3-1][AC-Se3b7a2-3-2][AC-Se3b7a2-3-3][AC-Se3b7a2-3-4][AC-Se3b7a2-3-5]
// ---------------------------------------------------------------------------

describe('[Se3b7a2-3] TASK status/priority/due フィルタ + SORT', () => {
  const taskNotes: QueryableNote[] = [
    note({
      path: 'todo.md',
      tasks: [
        {
          line: 1,
          text: 'タスク A (progress, high, 2026-07-10)',
          checked: false,
          indent: 0,
          status: 'progress',
          priority: 'high',
          due: '2026-07-10',
        },
        {
          line: 2,
          text: 'タスク B (todo, low, 2026-08-01)',
          checked: false,
          indent: 0,
          status: 'todo',
          priority: 'low',
          due: '2026-08-01',
        },
        {
          line: 3,
          text: 'タスク C (blocked, high, null)',
          checked: false,
          indent: 0,
          status: 'blocked',
          priority: 'high',
          due: null,
        },
        {
          line: 4,
          text: 'タスク D (null, null, 2026-06-01)',
          checked: false,
          indent: 0,
          status: null,
          priority: null,
          due: '2026-06-01',
        },
      ],
    }),
  ];

  // ---- AC-Se3b7a2-3-1: status フィルタ ----

  it('[AC-Se3b7a2-3-1] TASK WHERE status = "progress" は status=progress のタスクのみ返す', () => {
    const res = runQuery('TASK WHERE status = "progress"', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.line).toBe(1);
    expect(res.results[0]?.status).toBe('progress');
  });

  it('[AC-Se3b7a2-3-1] TASK WHERE status = "blocked" は status=blocked のタスクのみ返す', () => {
    const res = runQuery('TASK WHERE status = "blocked"', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.line).toBe(3);
  });

  it('[AC-Se3b7a2-3-1] status が null のタスクは status フィルタから除外される (null-false ルール)', () => {
    const res = runQuery('TASK WHERE status = "todo"', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    // タスク B のみ
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.line).toBe(2);
  });

  // ---- AC-Se3b7a2-3-2: due フィルタ ----

  it('[AC-Se3b7a2-3-2] TASK WHERE due < "2026-08-01" は due が文字列比較で小さいタスクのみ返す', () => {
    const res = runQuery('TASK WHERE due < "2026-08-01"', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    // タスク A (2026-07-10) と タスク D (2026-06-01) がマッチ (タスク C は due=null で除外)
    expect(res.results.map((r) => r.line).sort((a, b) => a - b)).toEqual([1, 4]);
  });

  it('[AC-Se3b7a2-3-2] due が null のタスクは due フィルタから除外される', () => {
    const res = runQuery('TASK WHERE due >= "2026-01-01"', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    // タスク C は due=null なので除外
    const lines = res.results.map((r) => r.line).sort((a, b) => a - b);
    expect(lines).not.toContain(3);
  });

  // ---- AC-Se3b7a2-3-3: priority フィルタ ----

  it('[AC-Se3b7a2-3-3] TASK WHERE priority = "high" は priority=high のタスクのみ返す', () => {
    const res = runQuery('TASK WHERE priority = "high"', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    // タスク A とタスク C がマッチ
    expect(res.results.map((r) => r.line).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('[AC-Se3b7a2-3-3] priority が null のタスクは priority フィルタから除外される', () => {
    const res = runQuery('TASK WHERE priority = "low"', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    // タスク B のみ (タスク D は priority=null で除外)
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.line).toBe(2);
  });

  // ---- AC-Se3b7a2-3-4: SORT due (null 末尾) ----

  it('[AC-Se3b7a2-3-4] TASK SORT due ASC は due 昇順で返し null は末尾', () => {
    const res = runQuery('TASK SORT due ASC', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    const lines = res.results.map((r) => r.line);
    // due: 2026-06-01(4) → 2026-07-10(1) → 2026-08-01(2) → null(3)
    expect(lines).toEqual([4, 1, 2, 3]);
  });

  it('[AC-Se3b7a2-3-4] TASK SORT due DESC は due 降順で返し null は末尾', () => {
    const res = runQuery('TASK SORT due DESC', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    const lines = res.results.map((r) => r.line);
    // due: 2026-08-01(2) → 2026-07-10(1) → 2026-06-01(4) → null(3)
    expect(lines).toEqual([2, 1, 4, 3]);
  });

  // ---- AC-Se3b7a2-3-5: TABLE status/priority/due の task 行回帰 ----

  it('[AC-Se3b7a2-3-5] TASK 結果行に status/priority/due が含まれる (後方互換回帰)', () => {
    const res = runQuery('TASK', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    expect(res.results[0]).toMatchObject({
      line: 1,
      status: 'progress',
      priority: 'high',
      due: '2026-07-10',
    });
    expect(res.results[1]).toMatchObject({
      line: 2,
      status: 'todo',
      priority: 'low',
      due: '2026-08-01',
    });
    // フィールドなしのタスク (タスク D) は null
    expect(res.results[3]).toMatchObject({
      line: 4,
      status: null,
      priority: null,
      due: '2026-06-01',
    });
  });

  // ---- AND 複合フィルタ ----

  it('[AC-Se3b7a2-3-1] TASK WHERE status = "progress" AND priority = "high" の複合フィルタ', () => {
    const res = runQuery('TASK WHERE status = "progress" AND priority = "high"', taskNotes);
    if (res.type !== 'task') expect.unreachable();
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.line).toBe(1);
  });
});
