/**
 * エージェント help ツール用ガイド本文 (S10a31c-2 / ADR-0010)。
 *
 * ADR-0010 決定: DQL / テンプレート / DataView 等の詳細な使い方は base システムプロンプトに
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
    '# テンプレート',
    '',
    'よく作るノートの雛形です。テンプレートはピュア Markdown で書かれ、',
    'プレースホルダを埋めて新規ノートを作成します。',
    '',
    '- テンプレート本文はそのまま Markdown としてノートにコピーされます。',
    '- 日付や表題などの可変部分は、作成時に具体的な値へ置き換えます。',
    '- テンプレートに独自記法やブロック ID を持ち込まないでください (ピュア Markdown を維持)。',
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
