# Comprehension Report — frontmatter プロパティ UI (Sprint S9df823)

_Generated at milestone arrival. Read this before `autopilot review`._

「frontmatter を GUI に自然に溶け込ませたい」という要望への対応です。

## What changed

- **frontmatter が生の YAML ではなく、Obsidian の Properties 風のプロパティブロックとして表示・編集できるようになった。** ノート冒頭の `--- ... ---` は、カーソルを本文に置くと**キー・値の整った一覧**として描画されます。`tags` などのフラット配列は**チップ**表示(× で削除、+ で追加)、各キーには型アイコンが付きます。
- **値をその場で編集でき、プロパティの追加・削除ができる。** 変更は**常に標準 YAML frontmatter としてファイルに書き戻り**ます。frontmatter が無いノートでも「+ プロパティを追加」やスラッシュメニューの**『プロパティ』**で frontmatter を生成できます。全プロパティを削除すると `--- ---` ブロック自体が消えます。
- **『ソースを編集』で生 YAML 編集に切り替えられる。** テーブル WYSIWYG と同じ UX です。
- **複雑な値は壊さない。** ネストしたオブジェクト・YAML アンカー/エイリアス・block scalar 等は round-trip を保証できないため、原文をそのまま(バイト単位で)保持し読み取り専用表示にして、編集はソースへ誘導します。

## Why this way

- テーブル WYSIWYG(Sd40b63/Sa629e2)で確立した「**表示層でリッチに編集、ファイルは標準記法のまま**」パターンをそのまま frontmatter に適用(input 差し替え・commit-on-blur・DOM 位置ベースのフォーカス復元)。frontmatter は DESIGN_PRINCIPLES で**第一級市民**と定めており、この UI はその方針の具現化です。
- **YAML 直列化は shared の frontmatter モデル経由で、`parseNote` と読み戻して同値になることを構造的に自己検証**(unit test で round-trip を網羅)。未編集のプロパティは**verbatim 保持**(フロースタイル・キー順序・コメントを勝手に変えない)。壊れた YAML はウィジェット化せずファイル不変。→ ユーザーが手で書いた frontmatter が意図せず変形するリスクを抑えています。
- **スカラー・文字列・フラット配列だけを WYSIWYG 編集対象**にし、複雑値は安全側(verbatim + ソース誘導)に倒しました(priority: データを壊さない)。

## What to verify

- 実機で(**ハードリロード Cmd/Ctrl+Shift+R 推奨**): `samples/` のプロジェクトノートや任意の frontmatter 付きノートを開き、プロパティブロックの表示・tags チップの追加削除・値編集→保存でファイルが標準 YAML になっているか・「+ プロパティを追加」・スラッシュメニュー『プロパティ』・「ソースを編集」を確認してください。デモ画像は `docs/sprint-logs/S9df823/demo/01-properties.png`。
- ⚠️ **今回は実装サブエージェントが Anthropic の利用上限に達し、verify 最終化の直前で停止**しました。親(autopilot)がフル `make test`(412)/`make test-ui`(207)/`make lint` を回して全 pass を確認し、機械判定・6ガード・独立 verifier(opus, pass)で裏取りして確定しています。動作・検証に問題はありませんが、経緯として記録します。
- 複雑な YAML 値(ネスト等)は GUI で編集できず「ソースを編集」に回ります(仕様)。個人用のメタデータでは通常足ります。

## What was assumed

- WYSIWYG 編集の対象はスカラー(文字列・数値・真偽・日付らしき文字列)とフラット配列(tags 等)。ネスト・アンカー・block scalar は verbatim 保持 + 読み取り専用。
- 値の型は素朴に推定(見た目で数値/日付/真偽/文字列)。`:` や `#` を含む文字列は必要に応じてクオート。
- ノートを開いた初期カーソルは本文先頭(frontmatter 直後)に置き、開いた瞬間からプロパティブロックが描画される。
