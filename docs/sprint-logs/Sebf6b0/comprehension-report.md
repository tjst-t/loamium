# Comprehension Report — Milestone: スマートフォルダ拡張 (Sprint Sebf6b0)

_Generated at milestone arrival. Read this before `autopilot review`._

## What changed

- **pin に物理フォルダを指定できる**(ADR-0005)。フォルダ pin は展開すると配下(サブフォルダ含む)ノートを表示。ノート pin は従来どおり葉。
- **pin 作成時の存在検証**: 実在しないファイル/フォルダのパスは作成ダイアログ内で `存在しないパスです` と表示し保存を弾く。pin パス候補にはノートに加え**フォルダも絞り込み表示**。
- **スマートビューからファイル作成**: ヘッダの「+」の隣にファイル作成ボタン。**新規ファイル**(パスに既存フォルダの補完)か**テンプレートから**(既存の TemplatePicker)を選べる。
- **タグ補完**: スマートフォルダ作成のタグプリセット入力が既存タグ(GET /api/tags)を絞り込みサジェスト。
- **機能ガイド**: 空状態(ウェルカム)に「スマートフォルダの使い方」セクションを追加。

## Why this way

- フォルダ pin は `pin.path` を拡張(ADR-0005)。新しい kind を増やさず、ノート/フォルダを実在性で判定(`.md` 終端=ノート、それ以外=フォルダ)。既存 note-pin は不変で後方互換。
- 存在検証はクライアント側(notes + 派生フォルダ集合)。サーバは安全パスなら受理し、非実在は空解決(ファイルを壊さない)。
- ファイル作成/テンプレート/タグ補完はすべて既存フロー(`createNote` / `TemplatePicker` / `GET /api/tags` + `filterTagSuggestions`)を再利用。

## What to verify

- フォルダ pin の展開表示、ファイル作成のフォルダ補完、タグ補完を実ブラウザで(`! make serve` + `! make serve-ui`)。
- (low) 存在検証はクライアント側のみ。真に空のフォルダを pin すると配下 0 件表示(ADR-0005 の既知トレードオフ)。
- (継続) ターミナル/Claude 系テストはこの環境で node-pty/GLIBC により実行不可(本件と無関係)。

## What was assumed

- フォルダ pin 判定は「パスが `.md` で終わらない=フォルダ」。`.md` という名のフォルダは想定外。
- 機能ガイドは空状態への追記(専用 `/help` 画面は未作成)。
- 新規ファイル作成は full モードのみ(read-only では作成ボタン非表示)。
