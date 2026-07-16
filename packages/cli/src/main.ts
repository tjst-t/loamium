/**
 * loamium CLI — REST API の薄いラッパー。エンドポイントとサブコマンドは 1:1 対応
 * (DESIGN_PRINCIPLES architecture / ARCHITECTURE.md CLI)。
 *
 *   read <path>                          GET    /api/notes/{path}
 *   write <path> <content>               PUT    /api/notes/{path}
 *   append <path> <content>              POST   /api/notes/{path}/append
 *   patch <path> --old <s> --new <s>     POST   /api/notes/{path}/patch
 *   rename <path> <new-path>             POST   /api/notes/{path}/rename
 *   journal [date]                       GET    /api/journal[?date=]
 *   journal-append <content> [date]      POST   /api/journal/append
 *   search <query>                       GET    /api/search?q=
 *   query <dql>                          POST   /api/query (dataview 風 DQL)
 *   backlinks <path>                     GET    /api/backlinks?path=
 *   file <path>                          GET    /api/files/{path} (バイト列を stdout へ)
 *   upload <local> [vault-path]          POST   /api/files/{path} (省略時 assets/<ファイル名>)
 *   files                                GET    /api/files (添付ファイル一覧)
 *   list [--tag] [--folder]              GET    /api/notes[?tag=&folder=]
 *   tags                                 GET    /api/tags
 *   new --template <n> [--var k=v ...]   POST   /api/templates/{name}/instantiate
 *   prop set <path> <key> <value>         POST   /api/notes/{path}/properties (set)
 *   prop unset <path> <key>              POST   /api/notes/{path}/properties (unset)
 *   smart-folders                        GET    /api/smart-folders (定義一式取得)
 *   smart-folders set <json-file>        PUT    /api/smart-folders (定義全置換)
 *   smart-folder <id>                    GET    /api/smart-folders/{id}/notes (解決)
 *   note-meta <path>                     GET    /api/notes/{path}/meta (ノートメタ集約)
 *
 * 出力規約 (AC-S0c9a48-1-2):
 * - 成功: exit 0、結果を stdout へ。--json で API レスポンスの生 JSON をそのまま出す
 * - 失敗: 非 0 exit、stderr に 1 行 JSON {"error","message"} (機械可読 + 人間可読 message)
 *   exit 1 = API / 接続エラー、exit 2 = 使い方エラー (引数不足・不明コマンド等)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Command, CommanderError } from 'commander';
import {
  backlinksResponseSchema,
  fileListResponseSchema,
  fileWriteResponseSchema,
  journalAppendResponseSchema,
  journalResponseSchema,
  noteListResponseSchema,
  notePropertyWriteResponseSchema,
  templateInstantiateResponseSchema,
  noteRenameResponseSchema,
  noteResponseSchema,
  noteWriteResponseSchema,
  noteMetaResponseSchema,
  parsePropInput,
  queryResponseSchema,
  searchResponseSchema,
  tagsResponseSchema,
  smartViewConfigSchema,
  smartFoldersResolveResponseSchema,
  commandsResponseSchema,
  commandRunResponseSchema,
  appSettingsResponseSchema,
  systemFileListResponseSchema,
  systemFileSourceResponseSchema,
  systemFileSourceWriteResponseSchema,
  agentConnectionResponseSchema,
  agentConnectionTestResponseSchema,
  agentPermissionsResponseSchema,
  agentPrivacySettingsResponseSchema,
  agentModelsResponseSchema,
  agentJobListResponseSchema,
  agentJobRunResponseSchema,
} from '@loamium/shared';
import {
  apiFetch,
  apiFetchBytes,
  CliError,
  encodeFilePath,
  encodeNotePath,
  postBytes,
  postJson,
  putJson,
  toVaultPath,
  type ApiResult,
} from './client.js';
import { resolveBaseUrl } from './url.js';

/** 失敗を stderr の 1 行 JSON + 非 0 exit code に変換する。 */
function fail(code: string, message: string, exitCode: number): never {
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exit(exitCode);
}

function printRaw(result: ApiResult): void {
  const text = result.raw.endsWith('\n') ? result.raw : `${result.raw}\n`;
  process.stdout.write(text);
}

function println(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** サーバーレスポンスを期待スキーマで検証して返す (契約ずれは protocol_error)。 */
function parseAs<T>(result: ApiResult, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, what: string): T {
  const parsed = schema.safeParse(result.data);
  if (!parsed.success || parsed.data === undefined) {
    throw new CliError('protocol_error', `unexpected ${what} response shape from server (is LOAMIUM_URL pointing at a loamium server?)`);
  }
  return parsed.data;
}

interface JsonOpt {
  json?: boolean;
}

/** --json 指定時は生 JSON、それ以外は human() の整形で stdout に出す。 */
function output(opts: JsonOpt, result: ApiResult, human: () => void): void {
  if (opts.json === true) {
    printRaw(result);
    return;
  }
  human();
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('loamium')
    .description('loamium CLI — REST API と 1:1 のノート操作コマンド');

  /** サブコマンドを作る (全コマンド共通の --json フラグ付き)。 */
  const sub = (name: string, description: string): Command => {
    const c = new Command(name);
    c.description(description);
    c.option('--json', 'API レスポンスの生 JSON をそのまま出力する');
    program.addCommand(c);
    return c;
  };

  sub('read', 'ノートを取得して本文を表示する (GET /api/notes/{path})')
    .argument('<path>', 'vault 相対パス (例: projects/hydra.md)')
    .action(async (path: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, `/api/notes/${encodeNotePath(path)}`);
      output(opts, result, () => {
        const note = parseAs(result, noteResponseSchema, 'note');
        process.stdout.write(note.content.endsWith('\n') || note.content === '' ? note.content : `${note.content}\n`);
      });
    });

  sub('write', 'ノートを作成・上書きする (PUT /api/notes/{path})')
    .argument('<path>', 'vault 相対パス')
    .argument('<content>', 'ノート全文')
    .action(async (path: string, content: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, `/api/notes/${encodeNotePath(path)}`, putJson({ content }));
      output(opts, result, () => {
        const res = parseAs(result, noteWriteResponseSchema, 'write');
        println(`${res.created ? 'created' : 'updated'} ${res.path}`);
      });
    });

  sub('append', 'ノート末尾に追記する (POST /api/notes/{path}/append)')
    .argument('<path>', 'vault 相対パス')
    .argument('<content>', '追記するテキスト')
    .action(async (path: string, content: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, `/api/notes/${encodeNotePath(path)}/append`, postJson({ content }));
      output(opts, result, () => {
        const res = parseAs(result, noteWriteResponseSchema, 'append');
        println(`appended to ${res.path}`);
      });
    });

  sub('patch', 'ノートの一意な old 文字列を new に置換する (POST /api/notes/{path}/patch)')
    .argument('<path>', 'vault 相対パス')
    .requiredOption('--old <string>', '置換前の文字列 (ノート内で一意であること)')
    .requiredOption('--new <string>', '置換後の文字列')
    .action(async (path: string, opts: JsonOpt & { old: string; new: string }) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(
        base,
        `/api/notes/${encodeNotePath(path)}/patch`,
        postJson({ old: opts.old, new: opts.new }),
      );
      output(opts, result, () => {
        const res = parseAs(result, noteWriteResponseSchema, 'patch');
        println(`patched ${res.path}`);
      });
    });

  sub('rename', 'ノートをリネームし、vault 内の全 [[旧名]] リンクを追従書き換えする (POST /api/notes/{path}/rename)')
    .argument('<path>', '現在の vault 相対パス')
    .argument('<new-path>', 'リネーム先の vault 相対パス (.md 省略可)')
    .action(async (path: string, newPath: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(
        base,
        `/api/notes/${encodeNotePath(path)}/rename`,
        postJson({ newPath: toVaultPath(newPath) }),
      );
      output(opts, result, () => {
        const res = parseAs(result, noteRenameResponseSchema, 'rename');
        println(`renamed ${res.oldPath} -> ${res.path}`);
        for (const u of res.updatedNotes) {
          println(`updated ${u.path} (${String(u.links)} link${u.links === 1 ? '' : 's'})`);
        }
        println(`${String(res.updatedLinks)} link(s) rewritten`);
      });
    });

  sub('journal', 'デイリージャーナルを取得する。無ければ自動生成 (GET /api/journal)')
    .argument('[date]', 'YYYY-MM-DD (省略時は今日)')
    .action(async (date: string | undefined, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const qs = date === undefined ? '' : `?date=${encodeURIComponent(date)}`;
      const result = await apiFetch(base, `/api/journal${qs}`);
      output(opts, result, () => {
        const res = parseAs(result, journalResponseSchema, 'journal');
        process.stdout.write(res.content.endsWith('\n') || res.content === '' ? res.content : `${res.content}\n`);
      });
    });

  sub(
    'journal-append',
    // Note: content that starts with "-" (e.g. "- [ ] task") must be passed after
    // the "--" end-of-options separator to avoid Commander treating it as an option flag.
    // Example: loamium journal-append --section Todo -- "- [ ] task"
    'デイリージャーナル末尾に追記する (POST /api/journal/append)\n  Note: "-" で始まる content は -- 区切り後に渡す: loamium journal-append --section Todo -- "- [ ] task"',
  )
    .argument('<content>', '追記するテキスト ("-" 始まりの場合は -- 区切り後に渡す)')
    .argument('[date]', 'YYYY-MM-DD (省略時は今日)')
    .option('--section <heading>', '挿入先 ATX 見出しテキスト (指定時は見出し配下の末尾に挿入、見出しが無ければ末尾に追記) [AC-Sd22b1f-3-2]')
    .action(async (content: string, date: string | undefined, opts: JsonOpt & { section?: string }) => {
      const base = await resolveBaseUrl();
      const body: { content: string; date?: string; section?: string } = { content };
      if (date !== undefined) body.date = date;
      if (opts.section !== undefined) body.section = opts.section;
      const result = await apiFetch(base, '/api/journal/append', postJson(body));
      output(opts, result, () => {
        const res = parseAs(result, journalAppendResponseSchema, 'journal-append');
        println(`appended to journal ${res.date} (${res.path})`);
      });
    });

  sub('search', '全文検索する (GET /api/search)')
    .argument('<query>', '検索クエリ')
    .action(async (query: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, `/api/search?q=${encodeURIComponent(query)}`);
      output(opts, result, () => {
        const res = parseAs(result, searchResponseSchema, 'search');
        for (const r of res.results) {
          println(r.line === null ? `${r.path}: ${r.snippet}` : `${r.path}:${r.line}: ${r.snippet}`);
        }
      });
    });

  sub('query', 'dataview 風 DQL クエリを実行する (POST /api/query)')
    .argument('<dql>', 'クエリ (例: \'TABLE status from "projects" where status != "done" sort updated desc\')')
    .action(async (dql: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/query', postJson({ query: dql }));
      output(opts, result, () => {
        const res = parseAs(result, queryResponseSchema, 'query');
        if (res.type === 'list') {
          for (const r of res.results) println(r.path);
        } else if (res.type === 'table') {
          println(['path', ...res.fields].join('\t'));
          for (const r of res.results) {
            const cells = r.values.map((v) =>
              v === null ? '' : Array.isArray(v) ? v.join(',') : String(v),
            );
            println([r.path, ...cells].join('\t'));
          }
        } else {
          for (const r of res.results) {
            println(`${r.path}:${String(r.line)}: [${r.checked ? 'x' : ' '}] ${r.text}`);
          }
        }
      });
    });

  sub('backlinks', 'ノートへのバックリンク一覧を表示する (GET /api/backlinks)')
    .argument('<path>', 'vault 相対パス')
    .action(async (path: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, `/api/backlinks?path=${encodeURIComponent(toVaultPath(path))}`);
      output(opts, result, () => {
        const res = parseAs(result, backlinksResponseSchema, 'backlinks');
        for (const src of res.backlinks) {
          for (const link of src.links) {
            println(`${src.source}:${link.line}: ${link.context}`);
          }
        }
      });
    });

  // file はバイナリを stdout に流すため --json を持たない (sub() を使わない)
  program.addCommand(
    new Command('file')
      .description('vault 内のファイルを取得してバイト列を stdout へ出す (GET /api/files/{path})')
      .argument('<path>', 'vault 相対パス (例: assets/figure.png)')
      .action(async (path: string) => {
        const base = await resolveBaseUrl();
        const bytes = await apiFetchBytes(base, `/api/files/${encodeFilePath(path)}`);
        await new Promise<void>((resolve, reject) => {
          process.stdout.write(bytes, (err) => (err ? reject(err) : resolve()));
        });
      }),
  );

  sub('upload', 'ローカルファイルを vault にアップロードする (POST /api/files/{path})')
    .argument('<local-file>', 'アップロードするローカルファイルのパス')
    .argument('[vault-path]', '保存先の vault 相対パス (省略時 assets/<ファイル名>)')
    .option('--overwrite', '既存の同名ファイルを上書きする (なしなら 409 conflict)')
    .action(async (localFile: string, vaultPath: string | undefined, opts: JsonOpt & { overwrite?: boolean }) => {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(localFile));
      } catch (err) {
        const code = err instanceof Error && 'code' in err && err.code === 'ENOENT'
          ? 'local_file_not_found'
          : 'local_read_error';
        throw new CliError(code, `could not read local file: ${localFile}`);
      }
      const dest = vaultPath ?? `assets/${basename(localFile)}`;
      const base = await resolveBaseUrl();
      const qs = opts.overwrite === true ? '?overwrite=true' : '';
      const result = await apiFetch(base, `/api/files/${encodeFilePath(dest)}${qs}`, postBytes(bytes));
      output(opts, result, () => {
        const res = parseAs(result, fileWriteResponseSchema, 'upload');
        println(`${res.created ? 'uploaded' : 'overwrote'} ${res.path} (${String(res.size)} bytes)`);
      });
    });

  sub('files', '添付 (非 .md) ファイル一覧を表示する (GET /api/files)')
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/files');
      output(opts, result, () => {
        const res = parseAs(result, fileListResponseSchema, 'files');
        for (const f of res.files) {
          println(`${f.path}\t${String(f.size)}`);
        }
      });
    });

  sub('list', 'ノート一覧を表示する。--tag / --folder で絞り込み (GET /api/notes)')
    .option('--tag <tag>', 'タグで絞り込む (# なし)')
    .option('--folder <folder>', 'vault 相対フォルダで絞り込む')
    .action(async (opts: JsonOpt & { tag?: string; folder?: string }) => {
      const base = await resolveBaseUrl();
      const params = new URLSearchParams();
      if (opts.tag !== undefined) params.set('tag', opts.tag);
      if (opts.folder !== undefined) params.set('folder', opts.folder);
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      const result = await apiFetch(base, `/api/notes${qs}`);
      output(opts, result, () => {
        const res = parseAs(result, noteListResponseSchema, 'list');
        for (const note of res.notes) {
          println(note.path);
        }
      });
    });

  sub('new', 'テンプレートからノートを新規作成する (POST /api/templates/{name}/instantiate)')
    .requiredOption('--template <name>', 'テンプレート名 (templates/ 配下、拡張子なし)')
    .option(
      '--var <key=value>',
      '変数の指定 (複数回指定可。例: --var 会議名=定例)',
      (value: string, acc: string[]) => [...acc, value],
      [],
    )
    .option('--date <YYYY-MM-DD>', '{{date:...}} の基準日 (省略時はサーバー今日)')
    .action(
      async (opts: JsonOpt & { template: string; var: string[]; date?: string }) => {
        const vars: Record<string, string> = {};
        for (const kv of opts.var) {
          const eq = kv.indexOf('=');
          if (eq <= 0) {
            fail('usage', `--var の形式が不正です (key=value を期待): "${kv}"`, 2);
          }
          vars[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        const reqBody: { vars: Record<string, string>; date?: string } = { vars };
        if (opts.date !== undefined) reqBody.date = opts.date;
        const name = opts.template
          .split('/')
          .map((seg) => encodeURIComponent(seg))
          .join('/');
        const base = await resolveBaseUrl();
        const result = await apiFetch(
          base,
          `/api/templates/${name}/instantiate`,
          postJson(reqBody),
        );
        output(opts, result, () => {
          const res = parseAs(result, templateInstantiateResponseSchema, 'new');
          println(`created ${res.path}`);
        });
      },
    );

  sub('tags', 'タグ一覧を件数付きで表示する (GET /api/tags)')
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/tags');
      output(opts, result, () => {
        const res = parseAs(result, tagsResponseSchema, 'tags');
        for (const t of res.tags) {
          println(`${t.tag}\t${t.count}`);
        }
      });
    });

  // ---- フロントマタープロパティ書込 (S32940c-3) ------------------------------------------

  // prop コマンド: POST /api/notes/{path}/properties + set/unset サブコマンド
  const propCmd = new Command('prop');
  propCmd
    .description('ノートのフロントマタープロパティを操作する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  // prop set <path> <key> <value>
  propCmd
    .command('set')
    .description('フロントマタープロパティを追加・更新する (POST /api/notes/{path}/properties)')
    .argument('<path>', 'vault 相対パス (例: projects/note.md)')
    .argument('<key>', 'プロパティキー名')
    .argument('<value>', 'スカラー値 ("true"/"false" → 真偽、整数/小数 → 数値、空 → null、その他 → 文字列)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (path: string, key: string, value: string, opts: JsonOpt) => {
      const scalar = parsePropInput(value);
      const base = await resolveBaseUrl();
      const result = await apiFetch(
        base,
        `/api/notes/${encodeNotePath(path)}/properties`,
        postJson({ set: { [key]: scalar } }),
      );
      output(opts, result, () => {
        const res = parseAs(result, notePropertyWriteResponseSchema, 'prop set');
        println(`set ${key} on ${res.path}`);
      });
    });

  // prop unset <path> <key>
  propCmd
    .command('unset')
    .description('フロントマタープロパティを削除する (POST /api/notes/{path}/properties)')
    .argument('<path>', 'vault 相対パス')
    .argument('<key>', '削除するプロパティキー名')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (path: string, key: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(
        base,
        `/api/notes/${encodeNotePath(path)}/properties`,
        postJson({ unset: [key] }),
      );
      output(opts, result, () => {
        const res = parseAs(result, notePropertyWriteResponseSchema, 'prop unset');
        println(`unset ${key} on ${res.path}`);
      });
    });

  program.addCommand(propCmd);

  // ---- スマートフォルダ (S32940c-2) ------------------------------------------

  // smart-folders コマンド: GET /api/smart-folders + set サブコマンド (PUT)
  const smartFoldersCmd = new Command('smart-folders');
  smartFoldersCmd
    .description('スマートフォルダ定義を管理する (GET /api/smart-folders)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/smart-folders');
      output(opts, result, () => {
        const res = parseAs(result, smartViewConfigSchema, 'smart-folders');
        for (const item of res.items) {
          println(`${item.id}\t${item.kind}\t${item.name ?? ''}`);
        }
      });
    });

  // smart-folders set <json-file> (PUT /api/smart-folders)
  smartFoldersCmd
    .command('set')
    .description('スマートフォルダ定義を全置換する (PUT /api/smart-folders)')
    .argument('<json-file>', '定義 JSON ファイルのローカルパス')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (jsonFile: string, opts: JsonOpt) => {
      let raw: string;
      try {
        raw = await readFile(jsonFile, 'utf8');
      } catch (err) {
        const code =
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'local_file_not_found'
            : 'local_read_error';
        throw new CliError(code, `could not read local file: ${jsonFile}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        throw new CliError('invalid_json', `file is not valid JSON: ${jsonFile}`);
      }
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/smart-folders', putJson(body));
      output(opts, result, () => {
        const res = parseAs(result, smartViewConfigSchema, 'smart-folders set');
        println(`saved ${String(res.items.length)} smart folder item(s)`);
      });
    });

  program.addCommand(smartFoldersCmd);

  // smart-folder <id> (GET /api/smart-folders/{id}/notes)
  sub('smart-folder', 'スマートフォルダの内容 (NoteMeta) を解決する (GET /api/smart-folders/{id}/notes)')
    .argument('<id>', 'スマートフォルダの id')
    .action(async (id: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, `/api/smart-folders/${encodeURIComponent(id)}/notes`);
      output(opts, result, () => {
        const res = parseAs(result, smartFoldersResolveResponseSchema, 'smart-folder');
        for (const n of res.notes) {
          println(n.path);
        }
      });
    });

  // ---- ノートメタ集約 (S11493d-1) ----

  // note-meta <path> (GET /api/notes/{path}/meta)
  sub('note-meta', 'ノートのメタ情報 (見出し・リンク・タグ・字数) を取得する (GET /api/notes/{path}/meta)')
    .argument('<path>', 'vault 相対パス (例: projects/hydra.md)')
    .action(async (path: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, `/api/notes/${encodeNotePath(path)}/meta`);
      output(opts, result, () => {
        const res = parseAs(result, noteMetaResponseSchema, 'note-meta');
        println(`path:      ${res.path}`);
        println(`mtime:     ${String(res.mtime)}`);
        println(`wordCount: ${String(res.wordCount)}`);
        println(`charCount: ${String(res.charCount)}`);
        if (res.tags.length > 0) {
          println(`tags:      ${res.tags.join(', ')}`);
        }
        if (res.headings.length > 0) {
          println('headings:');
          for (const h of res.headings) {
            println(`  ${'#'.repeat(h.level)} ${h.text} (line ${String(h.line)})`);
          }
        }
        if (res.outgoingLinks.length > 0) {
          println('links:');
          for (const l of res.outgoingLinks) {
            const resolved = l.resolvedPath !== null ? l.resolvedPath : '(unresolved)';
            println(`  ${l.target} -> ${resolved}`);
          }
        }
      });
    });

  // ---- スマートコマンド一覧 (Sd22b1f-1) ----

  // commands (GET /api/commands)
  sub('commands', 'スマートコマンド定義を一覧する (GET /api/commands)')
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/commands');
      output(opts, result, () => {
        const res = parseAs(result, commandsResponseSchema, 'commands');
        for (const cmd of res.commands) {
          if (cmd.valid) {
            const desc = cmd.description !== undefined ? `\t${cmd.description}` : '';
            println(`${cmd.name}\t${cmd.path}${desc}`);
          } else {
            println(`${cmd.name}\t${cmd.path}\t[INVALID] ${cmd.error}`);
          }
        }
      });
    });

  // ---- スマートコマンド実行 (Sd22b1f-2) ----

  // command run <name> --param k=v (POST /api/commands/{name}/run)
  // [AC-Sd22b1f-2-4]
  const commandCmd = new Command('command');
  commandCmd
    .description('スマートコマンドを実行する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  commandCmd
    .command('run')
    .description('コマンドをステップ順に実行する (POST /api/commands/{name}/run)')
    .argument('<name>', 'コマンド名 (commands/ 配下のファイル名、拡張子なし)')
    .option(
      '--param <key=value>',
      'パラメータの指定 (複数回指定可。例: --param title=メモ)',
      (value: string, acc: string[]) => [...acc, value],
      [] as string[],
    )
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (name: string, opts: JsonOpt & { param: string[] }) => {
      const params: Record<string, string> = {};
      for (const kv of opts.param) {
        const eq = kv.indexOf('=');
        if (eq <= 0) {
          fail('usage', `--param の形式が不正です (key=value を期待): "${kv}"`, 2);
        }
        params[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      const encodedName = name
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      const base = await resolveBaseUrl();
      const result = await apiFetch(
        base,
        `/api/commands/${encodedName}/run`,
        postJson({ params }),
      );
      output(opts, result, () => {
        const res = parseAs(result, commandRunResponseSchema, 'command run');
        for (const step of res.results) {
          if (step.skipped === true) {
            println(`skip\t${step.kind}`);
          } else if (step.ok) {
            println(`ok\t${step.kind}${step.path !== undefined ? `\t${step.path}` : ''}`);
          } else {
            println(`fail\t${step.kind}\t${step.error ?? ''}`);
          }
        }
        if (res.openPath !== undefined) {
          println(`open\t${res.openPath}`);
        }
      });
    });

  program.addCommand(commandCmd);

  // ---- 設定 API (Sa10026-5) ----
  // REST と 1:1 対応する loamium settings 系サブコマンド (AC-Sa10026-5-3)

  const settingsCmd = new Command('settings');
  settingsCmd
    .description('設定を管理する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  // loamium settings system (GET /api/settings/system)
  settingsCmd
    .command('system')
    .description('アプリ全体設定を取得する (GET /api/settings/system)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/settings/system');
      output(opts, result, () => {
        const res = parseAs(result, appSettingsResponseSchema, 'settings system');
        println(JSON.stringify(res.settings, null, 2));
      });
    });

  // loamium settings system set <json-string> (PUT /api/settings/system)
  settingsCmd
    .command('system-set')
    .description('アプリ全体設定を保存する (PUT /api/settings/system)')
    .argument('<json>', '設定 JSON 文字列 (例: \'{}\')')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (json: string, opts: JsonOpt) => {
      let settings: unknown;
      try {
        settings = JSON.parse(json) as unknown;
      } catch {
        throw new CliError('invalid_json', 'settings must be valid JSON');
      }
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/settings/system', putJson({ settings }));
      output(opts, result, () => {
        parseAs(result, appSettingsResponseSchema, 'settings system-set');
        println('settings saved');
      });
    });

  // loamium settings agent-connection (GET /api/settings/agent/connection)
  settingsCmd
    .command('agent-connection')
    .description('agent 接続設定を取得する (GET /api/settings/agent/connection)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/settings/agent/connection');
      output(opts, result, () => {
        const res = parseAs(result, agentConnectionResponseSchema, 'settings agent-connection');
        if (res.connection === null) {
          println('agent connection: not configured');
        } else {
          println(`api:      ${res.connection.api}`);
          println(`baseUrl:  ${res.connection.baseUrl}`);
          println(`model:    ${res.connection.model}`);
          println(`apiKey:   ${res.connection.apiKeyRef}`);
          if (res.connection.webSearch !== undefined) {
            println(`webSearch.endpoint: ${res.connection.webSearch.endpoint}`);
          }
        }
      });
    });

  // loamium settings agent-connection-set (PUT /api/settings/agent/connection)
  settingsCmd
    .command('agent-connection-set')
    .description('agent 接続設定を保存する (PUT /api/settings/agent/connection)')
    .requiredOption('--api <api>', 'API 種別: openai | anthropic')
    .requiredOption('--base-url <url>', 'ベース URL (例: https://api.openai.com/v1)')
    .requiredOption('--model <model>', 'モデル名 (例: gpt-4o)')
    .requiredOption('--api-key <ref>', 'apiKey の $ENV_VAR 参照名 (例: $OPENAI_API_KEY)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt & { api: string; baseUrl: string; model: string; apiKey: string }) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(
        base,
        '/api/settings/agent/connection',
        putJson({ api: opts.api, baseUrl: opts.baseUrl, model: opts.model, apiKey: opts.apiKey }),
      );
      output(opts, result, () => {
        println('agent connection settings saved');
      });
    });

  // loamium settings agent-connection-test (POST /api/settings/agent/connection/test)
  settingsCmd
    .command('agent-connection-test')
    .description('agent 接続をテストする (POST /api/settings/agent/connection/test)。model 不要で /models エンドポイントにより疎通確認。')
    .option('--base-url <url>', 'テスト対象の baseUrl (省略時は agent.json の値)')
    .option('--api <api>', 'API 種別: openai | anthropic (省略時は agent.json の値)')
    .option('--api-key-ref <ref>', 'apiKey 参照名または直値 (省略時は agent.json の値)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt & { baseUrl?: string; api?: string; apiKeyRef?: string }) => {
      const body: Record<string, string> = {};
      if (opts.baseUrl !== undefined) body.baseUrl = opts.baseUrl;
      if (opts.api !== undefined) body.api = opts.api;
      if (opts.apiKeyRef !== undefined) body.apiKeyRef = opts.apiKeyRef;
      const base = await resolveBaseUrl();
      const result = await apiFetch(
        base,
        '/api/settings/agent/connection/test',
        postJson(body),
      );
      output(opts, result, () => {
        const res = parseAs(result, agentConnectionTestResponseSchema, 'settings agent-connection-test');
        if (res.ok) {
          const modelCount = res.models !== undefined ? res.models.length : 0;
          println(`ok\tmodels=${String(modelCount)}\tlatencyMs=${String(res.latencyMs ?? 0)}`);
          if (res.models !== undefined) {
            for (const m of res.models) {
              println(`  ${m}`);
            }
          }
        } else {
          println(`fail\t${res.error ?? 'unknown error'}`);
        }
      });
    });

  // loamium settings agent-models (GET /api/settings/agent/models)
  settingsCmd
    .command('agent-models')
    .description('agent 接続先のモデル一覧を取得する (GET /api/settings/agent/models)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/settings/agent/models');
      output(opts, result, () => {
        const res = parseAs(result, agentModelsResponseSchema, 'settings agent-models');
        if (res.source === 'fallback') {
          println(`source: fallback${res.error !== undefined ? ` (${res.error})` : ''}`);
        }
        for (const model of res.models) {
          println(model);
        }
      });
    });

  // loamium settings agent-permissions (GET /api/settings/agent/permissions)
  settingsCmd
    .command('agent-permissions')
    .description('agent 権限・capability を取得する (GET /api/settings/agent/permissions)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/settings/agent/permissions');
      output(opts, result, () => {
        const res = parseAs(result, agentPermissionsResponseSchema, 'settings agent-permissions');
        if (res.permissions === null) {
          println('agent permissions: not configured');
        } else {
          const value = res.permissions.value !== null
            ? (Array.isArray(res.permissions.value) ? res.permissions.value.join(',') : String(res.permissions.value))
            : '(none)';
          println(`permissions: ${value}`);
          println(`effective:   ${res.permissions.effective.join(',')}`);
        }
      });
    });

  // loamium settings agent-permissions-set <value> (PUT /api/settings/agent/permissions)
  settingsCmd
    .command('agent-permissions-set')
    .description('agent 権限・capability を保存する (PUT /api/settings/agent/permissions)')
    .argument('<permissions>', 'プリセット名 (read-only/notes-rw/full) またはコンマ区切りケーパビリティ (例: read,note_edit)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (perms: string, opts: JsonOpt) => {
      // "read,note_edit" のようなコンマ区切りはケーパビリティ配列として扱う
      const permissions = perms.includes(',') ? perms.split(',').map((s) => s.trim()) : perms;
      const base = await resolveBaseUrl();
      const result = await apiFetch(
        base,
        '/api/settings/agent/permissions',
        putJson({ permissions }),
      );
      output(opts, result, () => {
        println('agent permissions saved');
      });
    });

  // loamium settings agent-privacy (GET /api/settings/agent/privacy)
  settingsCmd
    .command('agent-privacy')
    .description('privacy deny-list を取得する (GET /api/settings/agent/privacy)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/settings/agent/privacy');
      output(opts, result, () => {
        const res = parseAs(result, agentPrivacySettingsResponseSchema, 'settings agent-privacy');
        for (const glob of res.deny) {
          println(glob);
        }
      });
    });

  // loamium settings agent-privacy-set <glob...> (PUT /api/settings/agent/privacy)
  settingsCmd
    .command('agent-privacy-set')
    .description('privacy deny-list を設定する (PUT /api/settings/agent/privacy)')
    .argument('<globs...>', 'vault 相対 glob パターン (例: private/** secret.md)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (globs: string[], opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/settings/agent/privacy', putJson({ deny: globs }));
      output(opts, result, () => {
        parseAs(result, agentPrivacySettingsResponseSchema, 'settings agent-privacy-set');
        println(`privacy deny-list saved (${String(globs.length)} glob(s))`);
      });
    });

  program.addCommand(settingsCmd);

  // ---- system/ 設定ファイル (Sa10026-9 #1) — REST と 1:1 対応 ----

  const systemFilesCmd = new Command('system-files');
  systemFilesCmd
    .description('system/ 設定ファイルを管理する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  // loamium system-files list (GET /api/system-files)
  systemFilesCmd
    .command('list')
    .description('system/ 配下の設定ファイル (yaml + md) を一覧する (GET /api/system-files)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/system-files');
      output(opts, result, () => {
        const res = parseAs(result, systemFileListResponseSchema, 'system-files list');
        for (const f of res.files) {
          println(`${f.path}\t${String(f.size)}`);
        }
      });
    });

  // loamium system-files get <path> (GET /api/system-files/{path}/source)
  systemFilesCmd
    .command('get')
    .description('system/ ファイルの生テキストを取得する (GET /api/system-files/{path}/source)')
    .argument('<path>', 'vault 相対パス (例: system/settings.yaml)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (path: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, `/api/system-files/${encodeFilePath(path)}/source`);
      output(opts, result, () => {
        const res = parseAs(result, systemFileSourceResponseSchema, 'system-files get');
        process.stdout.write(res.content);
      });
    });

  // loamium system-files set <path> <content> (PUT /api/system-files/{path}/source)
  systemFilesCmd
    .command('set')
    .description('system/ ファイルへ生テキストを書き込む (PUT /api/system-files/{path}/source)')
    .argument('<path>', 'vault 相対パス (例: system/settings.yaml)')
    .argument('<content>', '書き込む生テキスト (YAML / Markdown)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (path: string, content: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(
        base,
        `/api/system-files/${encodeFilePath(path)}/source`,
        putJson({ content }),
      );
      output(opts, result, () => {
        const res = parseAs(result, systemFileSourceWriteResponseSchema, 'system-files set');
        println(res.created ? `created ${res.path}` : `updated ${res.path}`);
      });
    });

  program.addCommand(systemFilesCmd);

  // ---- エージェントジョブ (S2fe109) ----

  const agentJobsCmd = new Command('agent-jobs')
    .description('エージェント定期実行ジョブを管理する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  // loamium agent-jobs list (GET /api/agent/jobs)
  agentJobsCmd
    .command('list')
    .description('ジョブ一覧と最終実行状態を表示する (GET /api/agent/jobs)')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, '/api/agent/jobs');
      output(opts, result, () => {
        const res = parseAs(result, agentJobListResponseSchema, 'agent-jobs list');
        for (const job of res.jobs) {
          const status = job.enabled ? 'enabled' : 'disabled';
          const last = job.state.lastRunAt ?? 'never';
          const lastResult = job.state.lastResult ?? '-';
          println(`${job.name}\t${job.schedule}\t${status}\t${last}\t${lastResult}`);
        }
      });
    });

  // loamium agent-jobs run <name> (POST /api/agent/jobs/:name/run)
  agentJobsCmd
    .command('run')
    .description('ジョブを即時実行する (POST /api/agent/jobs/:name/run)')
    .argument('<name>', 'ジョブ名')
    .option('--json', 'API レスポンスの生 JSON をそのまま出力する')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .action(async (name: string, opts: JsonOpt) => {
      const base = await resolveBaseUrl();
      const result = await apiFetch(base, `/api/agent/jobs/${encodeURIComponent(name)}/run`, {
        method: 'POST',
      });
      output(opts, result, () => {
        const res = parseAs(result, agentJobRunResponseSchema, 'agent-jobs run');
        println(`result: ${res.result}  duration: ${res.durationMs}ms`);
        if (res.error) println(`error: ${res.error}`);
      });
    });

  program.addCommand(agentJobsCmd);

  // ---- エクスポート (ADR-0006 / Sa8ee62-1) ----

  // export <path> (GET /api/notes/{path}/export?format=pdf|html)
  // バイナリ (PDF) を扱うため --json を持たない (sub() を使わない)
  program.addCommand(
    new Command('export')
      .description('ノートを PDF または HTML にエクスポートする (GET /api/notes/{path}/export)')
      .argument('<path>', 'vault 相対パス (例: projects/hydra.md)')
      .option('--format <format>', 'エクスポート形式: pdf | html (既定: pdf)', 'pdf')
      .option('-o, --output <file>', '出力ファイルパス (省略時は stdout へ出力)')
      .action(async (path: string, opts: { format: string; output?: string }) => {
        if (opts.format !== 'pdf' && opts.format !== 'html') {
          fail('usage', `--format に無効な値が指定されました: "${opts.format}" (pdf | html のいずれか)`, 2);
        }
        const base = await resolveBaseUrl();
        const url = `/api/notes/${encodeNotePath(path)}/export?format=${encodeURIComponent(opts.format)}`;
        const bytes = await apiFetchBytes(base, url);

        if (opts.output !== undefined) {
          // ファイル出力 (binary-safe)
          await writeFile(opts.output, bytes);
          println(`exported ${path} to ${opts.output}`);
        } else {
          // stdout へ流す (バイナリ — PDF / HTML 両対応)
          await new Promise<void>((resolve, reject) => {
            process.stdout.write(bytes, (err) => (err ? reject(err) : resolve()));
          });
        }
      }),
  );

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  // commander の自前 stderr 出力と process.exit を止め、規約どおりの
  // 1 行 JSON + 終了コードに正規化する
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  for (const c of program.commands) {
    c.exitOverride();
    c.configureOutput({ writeErr: () => {} });
  }
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / help コマンドは正常終了扱い
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help' || err.code === 'commander.version') {
        process.exit(err.exitCode);
      }
      fail('usage', err.message.trim(), 2);
    }
    if (err instanceof CliError) {
      fail(err.code, err.message, err.exitCode);
    }
    fail('internal_error', err instanceof Error ? err.message : String(err), 1);
  }
}

await main();
