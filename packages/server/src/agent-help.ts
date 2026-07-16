/**
 * エージェント help ツール用ガイド本文 (S10a31c-2 / ADR-0014)。
 *
 * ADR-0014 決定: DQL / テンプレート / DataView 等の詳細な使い方は base システムプロンプトに
 * 常駐させず、help ツールがトピック指定で必要時に供給する。
 *
 * ガイド本文は Loamium 同梱・バージョン管理 (このコード内マップが正本)。
 * トピックは小文字 ASCII キーで固定する。未知/未指定トピックはエラーにせず
 * 利用可能トピック一覧を返す (AC-S10a31c-2-1)。
 */

/**
 * トピック名 → ガイド本文。
 * キーは正規化済み (小文字) を前提とする。resolveHelpTopic() で正規化する。
 */
export const AGENT_HELP_TOPICS: Record<string, string> = {
  dql: [
    '# DQL (Loamium Query Language)',
    '',
    'query ツールで実行する簡易クエリ言語です。3 種のクエリ形式があります。',
    '',
    '- `LIST` — 条件に一致するノートを一覧します。例: `LIST FROM #project`',
    '- `TABLE <field>, ...` — 指定フィールドを表形式で返します。例: `TABLE title, tags WHERE folder = "project"`',
    '- `TASK` — ノート内のタスク (チェックボックス) を集計します。例: `TASK WHERE status = "open"`',
    '',
    '句:',
    '- `FROM #tag` — 指定タグを持つノートに絞り込みます。',
    '- `WHERE <field> = "value"` — フィールド値で絞り込みます (frontmatter のキーや folder 等)。',
    '- `SORT <field> [ASC|DESC]` — 並び替えます。',
    '',
    'まず小さなクエリで試し、件数を確認してから条件を足していくのが確実です。',
  ].join('\n'),

  template: [
    '# テンプレート (一覧・テンプレートからのノート作成)',
    '',
    'よく作るノートの雛形です。テンプレートはピュア Markdown で書かれ、',
    '変数を埋めて新規ノートを作成します。関連ツールは `templates_list` と',
    '`template_instantiate` の 2 つで、いずれも REST と同一のテンプレートサービス層',
    '(templates-service.ts) を経由します。',
    '',
    '## templates_list (一覧, 読み取り)',
    '',
    '- 入力: なし。',
    '- 出力: 定義済みテンプレートの一覧。各行に name (instantiate に使う識別子)・',
    '  説明・保存先パターン・必須変数を表示します。壊れたテンプレートはスキップされます。',
    '- 経由サービス: listTemplates (system/templates/ を優先, fallback: templates/)。',
    '',
    '## template_instantiate (ノート作成, 書き込み)',
    '',
    '- 入力パラメータ:',
    '  - `name` — 適用するテンプレート名 (templates_list で確認)。',
    '  - `vars` — 変数名 → 値のマップ (省略可)。テンプレート本文中の可変部分を埋めます。',
    '  - `date` — `{{date}}` の基準日 (YYYY-MM-DD、省略時は今日)。',
    '- 出力: 生成されたノートのパス。必須変数が不足していれば missing 一覧を返します。',
    '- 経由サービス: instantiateTemplate。保存先が既存ノートと衝突する場合は連番で回避します。',
    '',
    '使用例 — 日報テンプレートに変数と基準日を渡してノートを作る:',
    '',
    '- `template_instantiate` に `name: "daily"`,',
    '  `vars: { "title": "定例MTG", "author": "自分" }`, `date: "2026-07-16"` を渡す。',
    '- テンプレート本文の `{{title}}` / `{{author}}` / `{{date}}` が埋められ、',
    '  保存先パターンに従って新規ノートが作られます。',
    '',
    '注意点:',
    '',
    '- 結果ノートはピュア Markdown です。テンプレート記法は解決後に残りません。',
    '- テンプレートに独自記法やブロック ID を持ち込まないでください (ピュア Markdown を維持)。',
    '- 生成 (書き込み) には権限が必要です。読み取り専用の権限セットでは',
    '  template_instantiate は利用できず、templates_list のみ使えます。',
    '- system 領域や機密領域への保存はサービス層のパス検証・deny により拒否されます。',
  ].join('\n'),

  smartfolder: [
    '# スマートフォルダ (ビュー定義)',
    '',
    'スマートフォルダは、条件に一致するノートをまとめて表示する保存済みビュー定義です。',
    '2 種類あります: query (DQL で動的に一致させる) と pin (特定ノート/フォルダ配下を固定)。',
    '関連ツールは 4 つで、いずれも REST と同一のサービス層 (smart-folders-service.ts /',
    'system-store.ts) を経由します。定義は system/smart-folders/{id}.yaml に保存されます。',
    '',
    '## smartfolders_list (一覧, 読み取り)',
    '',
    '- 入力: なし。',
    '- 出力: 定義済みスマートフォルダの一覧。各行に id・name・kind (query|pin)・',
    '  DQL または pin パスを表示します。',
    '',
    '## smartfolder_notes (解決, 読み取り)',
    '',
    '- 入力パラメータ: `id` — 解決するスマートフォルダ id (smartfolders_list で確認)。',
    '- 出力: そのビューに含まれるノートのパス一覧 ([[リンク]] 形式)。',
    '  query は DQL を実行し、pin はノート/フォルダ配下を解決します。',
    '- 機密領域のノートは一覧に含まれません (deny 除外ビュー経由)。',
    '',
    '## smartfolder_write (作成/更新, 書き込み)',
    '',
    '- 入力パラメータ:',
    '  - `id` — スマートフォルダ id (ファイル名。既存なら上書き)。',
    '  - `name` — 表示名。',
    '  - `dql` — DQL クエリ (LIST / TABLE / TASK)。保存前に構文検証されます。',
    '  - `icon` — アイコン名 (任意)。',
    '- 出力: 作成/更新したことと id。DQL 構文が不正なら保存されずエラーを返します。',
    '- 経由サービス: serializeSmartFolderYaml + writeSystemSmartFolder。',
    '',
    '使用例 — DQL クエリでプロジェクトノートを集めるビューを作る:',
    '',
    '- `smartfolder_write` に `id: "projects"`, `name: "進行中プロジェクト"`,',
    '  `dql: "LIST FROM #project WHERE status = \\"open\\""` を渡す。',
    '- 以後 `smartfolder_notes` に `id: "projects"` を渡すと一致ノートを解決できます。',
    '- DQL の文法は help トピック `dql` を参照してください。',
    '',
    '## smartfolder_delete (削除, 書き込み)',
    '',
    '- 入力パラメータ: `id` — 削除するスマートフォルダ id。',
    '- 出力: 削除結果。存在しない id はエラーにせず「削除対象なし」を返します。',
    '',
    '注意点:',
    '',
    '- 作成/更新/削除 (書き込み) には権限が必要です。読み取り専用の権限セットでは',
    '  smartfolders_list / smartfolder_notes のみ利用できます。',
    '- id のパスは正規化・検証されます (`..` 脱出や機密領域への書き込みは拒否)。',
    '- ビュー定義は Loamium が管理する YAML です。手書きの独自記法を持ち込まず、',
    '  必ずこれらのツール経由で操作してください。',
  ].join('\n'),

  command: [
    '# スマートコマンド (定型操作の実行)',
    '',
    'スマートコマンドは、複数ステップの定型操作 (ノート作成・追記・プロパティ設定・',
    'エージェント実行など) を 1 つの id にまとめた保存済み手順です。関連ツールは 2 つで、',
    'いずれも REST と同一のサービス層 (commands-service.ts) を経由します。',
    '定義は system/commands/*.yaml (fallback: commands/*.yaml) に置かれます。',
    '',
    '## commands_list (一覧, 読み取り)',
    '',
    '- 入力: なし。',
    '- 出力: 定義済みコマンドの一覧。各行に id (run に使う識別子)・表示名・説明・',
    '  必須 param を表示します。壊れた定義も無効として一覧に含まれます。',
    '',
    '## command_run (実行, 書き込み)',
    '',
    '- 入力パラメータ:',
    '  - `id` — 実行するコマンド id (commands_list で確認)。',
    '  - `params` — パラメータ名 → 値のマップ (省略可)。ステップ内で参照されます。',
    '- 出力: 各ステップの実行結果 (OK / スキップ / 失敗)。',
    '  必須 param 不足や最初の失敗ステップで停止します (ロールバックなし = fail-stop)。',
    '- 経由サービス: runCommand (REST の run と同一のステップ実行エンジン)。',
    '',
    '使用例 — params を渡して定型ノートを作るコマンドを実行する:',
    '',
    '- まず `commands_list` で id と必須 param を確認する。',
    '- 次に `command_run` に `id: "new-meeting"`,',
    '  `params: { "topic": "設計レビュー", "attendees": "3" }` を渡す。',
    '- コマンド定義のステップが順に実行され、各ステップの結果が返ります。',
    '',
    '注意点:',
    '',
    '- 実行 (書き込み) には権限が必要です。読み取り専用の権限セットでは',
    '  commands_list のみ利用でき、command_run は利用できません。',
    '- append-only モードでは prop-set / note-patch / agent-run を含むコマンドは拒否されます。',
    '- 各ステップの保存先パス検証・機密領域 deny はサービス層が REST と同一に処理します。',
    '- コマンド定義は Loamium が管理する YAML です。独自の実行フォーマットを新設せず、',
    '  必ずこれらのツール経由で操作してください。',
  ].join('\n'),

  dataview: [
    '# DataView 風の集計',
    '',
    'ノート横断の集計・一覧は DQL (query ツール) で行います。',
    'Obsidian の DataView プラグインに相当する用途は、Loamium では DQL に集約されています。',
    '',
    '- 動的一覧が欲しいときは query ツールで `LIST` / `TABLE` を実行します。',
    '- 集計結果をノートに残したい場合は、query の結果を Markdown 表や箇条書きとして書き出します。',
    '- 詳細な文法は help トピック `dql` を参照してください。',
  ].join('\n'),

  wikilink: [
    '# [[ウィキリンク]]',
    '',
    'ノート間の参照は `[[ノート名]]` 記法で表します。',
    '',
    '- `[[design]]` のように拡張子なしのパス/タイトルで参照します。',
    '- 表示名を変えたいときは `[[design|設計メモ]]` と書きます。',
    '- backlinks ツールで、あるノートへの参照元 (バックリンク) 一覧を取得できます。',
    '- 出典を示すときは必ずこの [[リンク]] 記法を使ってください。',
  ].join('\n'),

  journal: [
    '# ジャーナル (日次ノート)',
    '',
    '日付ごとのノートです。ファイル名は `YYYY-MM-DD` 形式の日付を基準にします。',
    '',
    '- 「今日」「昨日」などの相対日付は、実際の日付に解決してから参照します。',
    '- ジャーナルもピュア Markdown です。追記は既存本文を壊さないよう末尾に足すのが基本です。',
    '- 日付に紐づくメモやタスクをまとめる場所として使います。',
  ].join('\n'),

  frontmatter: [
    '# フロントマター (YAML メタデータ)',
    '',
    'ノート先頭の `---` で囲まれた YAML ブロックにメタデータを書きます。',
    '',
    '- 例: `title`, `tags`, `date` などのキーを持てます。',
    '- frontmatter のキーは DQL の `WHERE` / `TABLE` で参照できます。',
    '- 既存の frontmatter を編集するときは YAML 構文を壊さないよう注意してください。',
  ].join('\n'),
};

/** 利用可能トピックのソート済み一覧 (安定した出力のため)。 */
export function helpTopicNames(): string[] {
  return Object.keys(AGENT_HELP_TOPICS).sort();
}

/**
 * トピック指定を解決してガイド本文を返す。
 *
 * - topic が既知トピック (大文字小文字・前後空白は無視) ならその本文を返す。
 * - topic が未指定 (undefined/空文字) または未知トピックの場合は、
 *   エラーにせず利用可能トピック一覧の案内文字列を返す (AC-S10a31c-2-1)。
 */
export function resolveHelpTopic(topic?: string): string {
  const normalized = typeof topic === 'string' ? topic.trim().toLowerCase() : '';
  if (normalized && Object.prototype.hasOwnProperty.call(AGENT_HELP_TOPICS, normalized)) {
    const body = AGENT_HELP_TOPICS[normalized];
    if (body !== undefined) return body;
  }

  const names = helpTopicNames();
  const list = names.map((n) => `- ${n}`).join('\n');
  const header = normalized
    ? `不明なトピック "${topic ?? ''}" です。利用可能なトピック:`
    : '利用可能なトピック (topic を指定してください):';
  return `${header}\n${list}`;
}
