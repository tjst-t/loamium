# Go-to-Market メモ(参考・投機的)

> **ステータス: 参考ドキュメント / 投機的。実行予定は低い(現時点で「たぶんやらない」)。**
> これはコミットされた計画ではない。プロダクト化(→ [ADR-0009](adr/ADR-0009-productization-agent-native-self-host-first-obsidian-model.json), tentative)を将来検討する場合の思考メモとして残す。
> 前提が変わったら [ADR-0009](adr/ADR-0009-productization-agent-native-self-host-first-obsidian-model.json) と共に再評価する。

## 論点
無名の個人開発者が、知名度ゼロから Loamium をどうアピール・宣伝するか。

## 原則: 市場ではなくニッチを取る
- 大衆ノート市場(Notion/Obsidian)は予算勝負で不利。**尖った一点なら無名でも第一人者になれる。**
- ポジショニングは「もう一つの Obsidian」ではなく **「エージェントが読み書きできる個人ナレッジベース」**。

## Loamium の「無名でも刺さる」3 資産
1. **エージェントネイティブ**(REST/CLI/Skill で Claude Code 等が操作) — 競合が薄くタイムリー。AI 開発者に直で刺さる。
2. **self-host できる**([ADR-0008](adr/ADR-0008-deployment-tauri-and-container-not-workers.json)) — r/selfhosted 等の「自分で建てたい層」に強い。
3. **AI エージェント(Claude Code + sprint/autopilot)で作っている**メタ物語 — VISION/ADR/autopilot ログという語れる素材が既に大量にある。

## チャネル(客がいる場所 / 深く狭く)
- **r/selfhosted・awesome-selfhosted・self-host 系ニュースレター**(self-host 訴求)
- **Hacker News (Show HN)・Lobsters**(無名技術者が novel を出す王道)
- **Claude/Anthropic 開発者コミュニティ・AI 開発系ニュースレター/Discord**
- **r/ObsidianMD・r/PKM**(クローンでなく「別物・補完」として)
- **X(build in public)**(継続的な母集団形成)
- まず **「X build-in-public + r/selfhosted + HN ローンチ」の 3 本**に絞る。

## 効く戦術
- **Build in public**: 意思決定・スクショ・詰まりを毎週共有。ADR/autopilot ログがあるのでネタ切れしない。
- **デモ駆動**: 30–60 秒 GIF/動画。killer flow(例: 「Claude に今週をまとめてと言ったら日誌に書き込まれた」)を 1 本、繰り返し見せる。
- **README が最重要ランディング**: 先頭に GIF、3 行で新規性、`docker compose up`/ワンクリックデプロイまで最短。OSS なら信頼障壁が下がり trending/awesome-list 流入も。
- **メタ物語の武器化**: 「AI エージェントのオーケストレーションでノートアプリを作った — 設計ドキュメントと自律実行ログ全公開」。エージェントネイティブ製品として二重にオンブランド。
- **ロングテール SEO**: 「Claude Code + 自分の Markdown vault」等の具体 how-to。
- **ローンチは仕込んでから**: 動く self-host + 尖ったデモが揃った日に Show HN/Product Hunt/Reddit 同日。ただし一発より継続 build-in-public が本命。

## 正直な注意点
- 配布は開発より難しい。伝える時間を作る覚悟が要る。
- 無名は「一貫して役立つ」で早く消える。コミュニティで淡々と出し続けるのが最短。
- ニッチは小さいが到達可能で手薄 → 無名・早い・具体的が有利に働く数少ない場所。

## 参考にした収益化モデル(→ ADR-0009 context)
- **Obsidian**: 無料ローカルコア(機能ゲートなし)+ Sync ~$4-5/mo(E2E)+ Publish ~$8-10/mo + 商用ライセンス $50/user/yr。ブートストラップ・黒字・データ預からない。**Loamium と最も親和的。**
- **Logseq**: OSS 無料コア + Sync $5/mo(E2E)+ Sponsor $15/mo。$4.1M seed。同じ Sync 課金型だが VC 路線。
- 共通教訓: **機能をゲートしない / E2E Sync が主課金 / ホスト型エディタにはしない。**
