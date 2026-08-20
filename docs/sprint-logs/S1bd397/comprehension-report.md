# 理解レポート — S1bd397 テンプレート/コマンドの動的選択肢(ADR-0031 optionsQuery)

## What changed(何が変わったか)
- **スキーマ**: `TemplateVar`(schemas.ts)と `CommandParam`(loamium-command.ts)に任意 `optionsQuery`(DQL 文字列)を加算(後方互換)。
- **候補解決**(shared/server 単一ヘルパ): `resolveOptionsQuery`(既存 dql.ts の parseQuery/executeQuery を再利用、LIST → `{value,label}`=ノートタイトル、top-N 50、truncated)/ `validateOptionsDependencies`(宣言順・循環/前方参照検出)。**POST /api/options-query**(`{dql,resolvedVars?,topN?}`→`{candidates,truncated}`)。
- **厳格 select 検証**: `instantiateTemplate` と `runCommand` で `select+optionsQuery` の候補外を `invalid_select_value`(422)で拒否。`text+optionsQuery` は自由入力(検証なし)。候補 0 件はスキップ。REST/CLI/agent で同一経路(ADR-0016)。
- **依存クエリ**: optionsQuery が `{{他変数}}` を参照する場合、宣言順で解決済みの上流値を差し込んでから実行。上流変更で下流再解決。
- **UI**: TemplateModal・コマンド param フォーム(ParamFormModal パレット + CommandEditor TestRunParamForm)に、**select→動的ドロップダウン / text→オートコンプリート(自由入力可)/ note→絞り込みノートピッカー**。loading/空(→自由入力フォールバック)/truncated ヒント。**ウィジェット種別注釈は出さない**(ユーザーレビュー指摘 D-S1bd397-proto-1)。モバイル 44px。
- **エージェント**: 新ツールは作らず(agent 書込は既存経路が optionsQuery 制約を尊重)、agent-help の template/command トピック + 機能ガイドに optionsQuery を追記。

## Why this way(なぜこの設計か)
- ADR-0031: 入力ウィジェット `type` と**直交する optionsQuery フィールド**にして、新しい type を増やさず select/text/note に効かせる。DQL を再利用し**第二のクエリ機構を作らない**(ADR-0001)。テンプレート/コマンドで**同一フィールド・同一経路**(ADR-0016)。生成物はピュア Markdown(optionsQuery は定義側=設定のみ)。

## What to verify(レビュー観点)
- **あなたの当初の要望**: Epic テンプレートで「プロジェクト名」を `select` + `optionsQuery: "LIST FROM #project"` にすると、作成ダイアログに **既存 #project ノートがドロップダウン候補**として出る(実サーバー e2e で確認済み)。
- text+optionsQuery の自由入力(新規プロジェクト名も打てる)/ 依存クエリ(上流→下流絞り込み)/ 0 件フォールバックの体験。
- 候補の**値=ノートタイトル**で妥当か(将来 path や TABLE 列選択は加算的後追い)。

## What was assumed / 注意
- **検証中に自己回帰1件を発見・修正**: UI 実装がモバイル対応で App.tsx サイドバーを改変した際に `sidebar-new-folder` を削除 → 新規フォルダ作成テスト(sidebar-tree.mock:88)が回帰。構造を復元し、モバイル導線はオーバーレイ経由に統一して修正(修正後 green)。
- **環境劣化**: この VM が Node 22→20 に劣化しており(undici で server/agent テストが偽陽性 fail)、`~/.local/node22` に Node 22 を導入 + chromium 再インストールして正しく検証した([[dev-vm-node22-required]] にも記録)。
- 全 AC は機械的に pass(make test 1772 / dynamic-options 12)、S1bd397 由来の新規失敗ゼロ。残る 9 件の test-ui 失敗は base でも落ちる既存フレーク。
- スコープ外(ADR どおり): note 型はテンプレートに未追加(Epic は select+title で足りる)/ value=path・TABLE 列選択 / 本文への静的クエリ(ライブ dataview フェンスで代替)。
