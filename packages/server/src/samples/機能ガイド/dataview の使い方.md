# dataview の使い方

言語名を `dataview` にしたコードフェンスを書くと、その場に**結果が描画**されます。**ファイルに残るのはクエリ文字列だけ**で、結果は書き戻しません(Obsidian dataview と同じ書き方で、独自記法ではありません)。

Loamium が読むのはサブセットです: `LIST` / `TABLE` / `TASK` + `FROM` / `WHERE` / `SORT` / `LIMIT`。

## LIST — ノートを並べる

`FROM #タグ` でタグの付いたノートを、`FROM "フォルダ"` でフォルダを絞ります(子タグ・下位フォルダも含みます)。

```dataview
LIST FROM "機能ガイド" SORT file.name ASC LIMIT 5
```

## WHERE — 値で絞る

frontmatter([[プロパティ]])の任意のキーで絞れます。演算子は `=` `!=` `>` `<` `>=` `<=` `contains`、`and` でつなげます。

```dataview
LIST WHERE bookmark
```

値を書かなければ「そのキーを持っているか」、`!` を付ければ否定です(上の例は ★ を付けたノート = [[ブックマーク]])。

## TABLE — 列を指定して表にする

```dataview
TABLE file.folder, file.mtime FROM "機能ガイド" SORT file.mtime DESC LIMIT 5
```

列には frontmatter のキーのほか、`file.name` / `file.path` / `file.folder` / `file.mtime` / `file.tags` / `file.link` が使えます。`列 AS "見出し"` で表示名も付けられます。

## TASK — チェックボックスを横断で集める

```dataview
TASK FROM "機能ガイド" WHERE !completed LIMIT 5
```

結果のチェックボックスを押すと**元のファイルのその行**が書き換わります([[タスク]]と同じ経路なので、完了と `[status:: …]` の同期も効きます)。

TASK では `text` / `completed` と、インラインフィールド(`status` / `priority` / `due`)でも絞れます。

```dataview
TASK WHERE priority = "high"
```

## ポイント

- **索引を持たず、毎回 vault を走査します。**外部エディタやエージェントが書いた直後でも結果が最新です
- 書き方が違うときは黙って空にせず、**理由を赤で出します**
- 0 件のときは「何件を見て 0 件だったか」を出します
- **直すとき**は結果にマウスを乗せる(モバイルはタップする)と出る操作バーの **編集** から。読んでいる間はクエリを畳んで結果だけを見せます
- 編集中はクエリと結果が **1 枚のカード**になり、打つそばから件数と中身が変わります(上が式、下がその答え)
- 畳んだクエリは、その**直後で Backspace**(直前で Delete)でブロックごと 1 回で消せます
- エージェントからは `run_query` で同じクエリを走らせられます
