# Comprehension Report — マイルストーン Sf4ee2f (batch: S10a31c + Sf4ee2f)

対象: エージェント基盤(S53409d)に「役割の土台」と「機密の壁」を足した 2 スプリント。

## What changed(何が変わったか)

### S10a31c — システムプロンプト + help ツール(ADR-0010)
- エージェントに **base システムプロンプトをコードで注入**するようになった(`packages/server/src/agent-prompt.ts` の `buildAgentSystemPrompt()`)。役割=この vault のノート補助、絶対制約=ピュア Markdown / [[リンク]]出典 / 与えられたツールのみ / 権限と機密領域の尊重 / 日本語簡潔、のみを含む。
- 注入は pi の `DefaultResourceLoader({ systemPrompt })` を `createAgentSession` に渡す形(createPiSession/openPiSession 両経路)。
- **help ツール**を追加(読み取り系、allowlist 所属)。トピック(dql/template/dataview/wikilink/journal/frontmatter)でガイド本文を返し、未知/未指定はトピック一覧を返す。詳細知識はここに集約し、base プロンプトを小さく保つ。

### Sf4ee2f — 機密領域 deny リスト(ADR-0014)
- `.loamium/agent-privacy.json`(git 追跡・.gitignore 再包含)の **deny glob** でエージェントから隠す領域を定義。
- 強制は**共通フィルタに集約**: `packages/shared/src/privacy-glob.ts`(NFC/大小吸収の glob マッチャ)+ `packages/server/src/agent-privacy.ts`(設定ロード + privacy-filtered index ビュー)。
- read_note/backlinks は deny を**未発見として**返し(存在を隠す)、search/query/tags/backlinks の結果からも deny ノートを除外。tags は非 deny ノートから**再集約**して deny 限定タグの漏れを防ぐ。deny > allow。

## Why this way(なぜこの設計か)
- 常時必要な「役割・制約」と、必要時だけの「詳細な使い方」を分離(ADR-0010)。プロンプト肥大・陳腐化を避け、Loamium 側でバージョン管理できる。
- 機密は権限(ケーパビリティ)と直交する軸なので独立に定義(ADR-0014)。散らすとザル漏れになるため単一の共通フィルタに集約。
- 設定破損時は **fail-closed(deny-all)**。DESIGN_PRINCIPLES priority 2「迷ったらファイルを守る側」に従い、露出よりエージェントの読み取り停止を選ぶ。

## What to verify(ユーザーに見てほしい点)
- base プロンプト文言(`agent-prompt.ts`)が意図どおりか。エージェントが「ファイルもコマンドも実行できる」と誤自己紹介しなくなったか(実チャットで確認推奨)。
- deny glob の粒度が期待どおりか(`private/**` 等)。`.loamium/agent-privacy.json` は既定不在=何も隠さない。
- help のガイド本文が現行の DQL/テンプレート仕様と整合しているか。

## What was assumed(前提・非自明な判断)
- privacy 設定はセッション生成時にロード(agent.json と同様)。長時間セッション中の設定変更は次セッションから反映。
- 壊れた privacy JSON は deny-all にフォールバック(意図的な安全側倒し。decisions.json Sf4ee2f-D3)。
- glob は自前軽量実装(minimatch 非導入)。`**`/`*`/`?` のみサポート。
