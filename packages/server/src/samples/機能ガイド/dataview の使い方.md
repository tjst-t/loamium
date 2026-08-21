# dataview の使い方

言語名を `dataview` にしたコードフェンス(バッククォート 3 つで囲み、1 行目を `` ```dataview `` にする)を書くと、その場に**クエリ結果が描画**されます(ファイルにはクエリ文字列だけが残ります)。
Loamium は Obsidian dataview のサブセット(LIST / TABLE / TASK + FROM / WHERE / SORT)に対応しています。

クエリの実データは [[プロジェクト Hydra]] [[プロジェクト Loamium]] [[読書メモ 失敗の科学]] [[読書メモ SF短編集]](`samples/データ/` フォルダ)です。

## LIST — ノートの一覧

`FROM #タグ` でタグの付いたノートを列挙します。下の例は `#sample-book` が付いた読書メモ 2 件が出ます。

```dataview
LIST FROM #sample-book
```

`FROM "フォルダ"` はフォルダで絞ります。`SORT file.name ASC` で名前順に並びます。
下の例は `samples/データ/` の 4 ノートが名前順で出ます。

```dataview
LIST FROM "samples/データ" SORT file.name ASC
```

## WHERE — frontmatter の値で絞り込む

各ノートの frontmatter(ファイル先頭の `---` ブロック)の任意のキーで絞り込めます。
条件は `AND` で複数つなげられます。演算子は `=` `!=` `>` `<` `>=` `<=` `contains`。

下の例は `status: 読了` のノートだけ(→ [[読書メモ 失敗の科学]] の 1 件)が出ます。

```dataview
LIST FROM "samples/データ" WHERE status = "読了"
```

`tags contains "値"` のような配列の包含判定もできます(→ 読書メモ 2 件)。

```dataview
LIST FROM "samples/データ" WHERE tags contains "sample-book"
```

## TABLE — 列を指定して表にする

`TABLE 列1, 列2` で frontmatter の値を表として表示します。列は必須です。
下の例は読書メモ 2 件が rating の高い順に、status と rating の列付きで出ます。

```dataview
TABLE status, rating FROM #sample-book SORT rating DESC
```

`file.name` / `file.folder` / `file.path` / `file.mtime` の組み込みフィールドも列にできます。
下の例はプロジェクト 2 件を priority 昇順で表にします。

```dataview
TABLE status, priority FROM #sample-project WHERE priority >= 1 SORT priority ASC
```

## TASK — チェックボックスを横断で集める

`- [ ]` タスク行をノート横断で列挙します。結果のチェックボックスをクリックすると**元のファイルが書き換わります**。
下の例は `#sample-project` のノートにあるタスク(完了/未完了とも)が出ます。

```dataview
TASK FROM #sample-project
```

未完了だけに絞るには `WHERE !completed` を使います。

```dataview
TASK FROM #sample-project WHERE !completed
```

## 対応構文のまとめ

| 節 | 書き方 | 例 |
| --- | --- | --- |
| タイプ | LIST / TABLE 列,列 / TASK | `TABLE status, rating` |
| FROM | `#タグ` または `"フォルダ"`(1 つだけ) | `FROM #sample-book` |
| WHERE | `field op 値` を AND で連結。`field` / `!field`(truthy)も可 | `WHERE rating >= 4 AND status = "読了"` |
| SORT | `field [ASC\|DESC]`(1 キーのみ) | `SORT rating DESC` |

対応外の構文(OR・関数・複数 SORT など)は、位置付きの構文エラーとして表示されます。
