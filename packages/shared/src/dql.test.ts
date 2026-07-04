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
    expect(parseQuery('LIST')).toEqual({ type: 'list', fields: [], from: null, where: [], sort: null });
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
        { line: 5, text: 'DNS TTL を短縮', checked: false, indent: 0 },
        { line: 6, text: 'NFS エクスポート許可', checked: true, indent: 4 },
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
      tasks: [{ line: 3, text: '第 2 章を読む', checked: false, indent: 0 }],
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
      { path: 'projects/hydra.md', title: 'hydra', line: 5, text: 'DNS TTL を短縮', checked: false, indent: 0 },
      { path: 'projects/hydra.md', title: 'hydra', line: 6, text: 'NFS エクスポート許可', checked: true, indent: 4 },
      { path: 'reading/book.md', title: 'book', line: 3, text: '第 2 章を読む', checked: false, indent: 0 },
    ]);
  });

  it('TASK where !completed は未完了のみ、completed は完了のみ', () => {
    const open = runQuery('TASK where !completed', notes);
    if (open.type !== 'task') expect.unreachable();
    expect(open.results.map((r) => r.line)).toEqual([5, 3]);
    const done = runQuery('TASK where completed', notes);
    if (done.type !== 'task') expect.unreachable();
    expect(done.results).toEqual([
      { path: 'projects/hydra.md', title: 'hydra', line: 6, text: 'NFS エクスポート許可', checked: true, indent: 4 },
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
