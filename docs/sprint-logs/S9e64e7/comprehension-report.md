# Milestone Comprehension Report — スマートコマンド DSL v2 + 定義エディタ

対象: **Sf2f114(DSL v2 バックエンド)** + **S9e64e7(定義エディタ・MILESTONE)**
ブランチ: `smart-command`

> review を始める前にこのレポートを読んでください。

## What changed

**Sf2f114 — DSL v2 バックエンド(非 GUI、ADR-0022、加算のみ)**
- テンプレート: `{{param|フォールバック}}`(未定義/空で既定値)、相対日付 `{{date:+3d:FMT}}`、未定義→空。
- `when:` / `when-not:`(真偽・存在のみ、式評価なし)。不成立ステップは `skipped:true` でスキップ(失敗扱いせず後続続行)。
- `note-append` に `section?` / `create?` / `position(bottom|top|section)` を追加、journal-append と統一。
- 新ステップ `prop-set`(frontmatter プロパティ設定)/ `note-patch`(テキスト置換)。既存の round-trip 安全 properties / patch コアを再利用。append-only では拒否。
- param 型 `select`(options 必須)/ `note` / `boolean` / `number`。
- run-command / agent-run はスコープ外(バックログ)。

**S9e64e7 — 定義エディタ(GUI、ADR-0023)**
- `commands/` 配下かつ `loamium-command` frontmatter のノートを開くと、専用スプリットエディタ。左=YAML/Markdown ソース(CodeMirror、補完付き)/ 右=ライブ検証(有効/無効+理由)+ params/steps プレビュー + テスト実行。**保存ボタンは不正だと無効**(保存前バリデーション)。正本は YAML 1 本。
- 左ペイン補完: `kind:` 値(6 種)→ 選ぶと当該フィールドを雛形挿入、`{{...}}` 内の param 名 + `date:`/`now:` トークン + `|fallback`、`type:`/`position:` 値、section/note 補完。語彙は共有スキーマ由来。
- テスト実行: 未保存なら自動保存 → `POST /api/commands/{stem-id}/run`(表示名でなくファイル stem を使用)。
- 機能ガイド(空状態)に「スマートコマンドの使い方」節を追加。

## Why this way
- DSL は制御フロー(IF/FOR/サブルーチン)を持たず宣言的のまま拡張(ADR-0022)。`when:` は真偽・存在のみで「言語化」の一線を守る。複雑処理は将来 agent-run へ委譲。
- エディタは YAML を正本に保ち(ピュア Markdown 原則)、フォームがデータを所有しない。入力しやすさは「全部補完」で担保(ADR-0023、V3 プロトタイプ承認済み)。

## What to verify(実機)
`make serve HOST=0.0.0.0` 稼働中 → http://10.10.254.36:8204/
1. `commands/` に定義ノートを作る(または既存 create-todo)→ 開くと**スプリットエディタ**になるか。左を編集すると右のプレビュー/検証がリアルタイム更新、不正だと保存が無効か。
2. 左で `kind: ` を打つと補完が出て、選ぶとフィールド雛形が入るか。`{{` で param 補完が出るか。
3. 右の**テスト実行**で(未保存なら自動保存され)コマンドが走り結果が出るか。
4. DSL v2: `when: {{flag}}` のスキップ、`{{param|既定}}`、`prop-set` でプロパティ設定、`select` param 等を定義して実行。

## What was assumed / 注意
- **agent-run(議事録要約等)と run-command は未実装**(バックログ)。agent-run は Pi Agent 統合(別ブランチ)マージ + 非同期ジョブ ADR 後に S5a66e4 で。
- **既知の技術負債(backlog)**: `TestRunParamForm` が `ParamFormModal` のフォームロジックを重複(select 等を扱うため)。フォロー Sprint で統合予定。補完 scaffold の手書き・note ピッカー未実装等も backlog。
- **既知フレーク**: `smart-folder-editor.e2e:134` が full-suite 負荷下で稀に失敗(単独 pass、本バッチ未変更)。
- **表示名≠ID バグの教訓**: エディタのテスト実行はファイル stem を実行 ID に使用(過去に表示名を使う不具合があったため厳守)。
- `smart-command` ブランチは main の 59 コミット先行、push 未実施。
