# Comprehension Report — マイルストーン S5e0206 (batch: S5bd678 + S5e0206)

対象: エージェントに「権限(何ができるか)」と「Web(外に出られるか)」を与え、書き込みと外部アクセスを opt-in で解禁した 2 スプリント。到達目標 S5e0206(ADR-0013 Web)まで完了。

## What changed(何が変わったか)

### S5bd678 — ケーパビリティ権限モデル + 書き込みツール(ADR-0011/0012)
- 権限を **7 ケーパビリティの独立トグル**に(read / journal_append / note_create / note_edit / template_write / dataview_write / web)。ADR-0008 の3段階を supersede。
  - `packages/shared/src/agent-capabilities.ts`: プリセット(読取のみ/ノートRW/フル)、`resolvePermissions`、`deriveToolNames`(有効ケーパビリティ→広告ツール名)、`clampByMode`(実効 = 権限 ∩ LOAMIUM_MODE)。
  - 既定は **read-only プリセット(read のみ)** — 書き込みは明示 opt-in(安全側)。
  - セッション単位の上書きは `.loamium/agent-session-perms.json` に永続化 → サーバー再起動後も同じツール集合を導出。
- **書き込みツール5種**(`agent-write-tools.ts`)= journal_append / note_create / note_edit(非破壊 patch)/ template_write(templates/ 配下ノート)/ dataview_write(```dataview フェンス)。
  - **既存の監査済みサービス層を共有**するため `note-service.ts` を切り出し、REST ルート(notes/journal)もこれを呼ぶようリファクタ。ピュア Markdown・normalizeVaultPath・audit.log を自動継承。独自書き込み実装・新フォーマットなし。
  - rename/delete はエージェントに与えない(一括破壊の forbidden)。privacy deny(ADR-0014)を書き込みでも適用。
- **チャット UI**(AgentPane)にプリセット + ケーパビリティ別トグル、実効権限バッジ、LOAMIUM_MODE で剥がれたケーパビリティの区別表示。

### S5e0206 — Web アクセス opt-in(ADR-0013)
- **web ツール2種**(`agent-web-tools.ts`)= `web_fetch`(URL 取得)/ `web_search`(クエリ検索、プロバイダは agent.json 設定、未設定時は明示メッセージ)。web ケーパビリティが有効なときだけ広告・生成。
- **SSRF ガード**(`web-guard.ts` の `isPublicHttpUrl`): http/https のみ、localhost・プライベート IP・リンクローカル・クラウドメタデータ(169.254.169.254)・IPv6 ULA/link-local を拒否。純関数で網羅ユニットテスト。
- **監査**: すべての Web アクセスは URL / クエリを audit.log に記録(**取得内容は記録しない**)。
- **UI 警告**: web トグル on で漏洩リスク(プロンプトインジェクション経由の vault 情報流出)を明示警告。S5bd678 の「(未実装)」注記を除去。

## Why this way(なぜこの設計か)
- 権限は独立トグル(ADR-0011): 「読むだけ」「ノートRWだが Web 無し」等に応え、web を書き込みと別軸で制御。実効 = 権限 ∩ MODE でサーバー最終ガードを維持。
- 書き込みは既存経路を共有(ADR-0012): ピュア Markdown・パス安全・監査・リンク追従の不変条件を二重管理せず継承。Template/DataView は通常ノート書き込み(新フォーマットを作らない)。
- web は既定 off + 明示警告 + URL 監査(ADR-0013): 安全側の既定でユーザーが意図的にリスクを引き受ける。SSRF ガードで踏み台化を防ぐ。機密領域(ADR-0014)は web 設定に関わらず常に非開示。

## What to verify(ユーザーに見てほしい点)
- **チャット UI で権限を実際に切り替えて**、プリセット/トグルの挙動・実効権限表示が期待どおりか(refine 対象)。
- 書き込みツールの実挙動(journal_append / note_create / note_edit)を full 権限セッションで試し、生成物がピュア Markdown か。
- web トグル on の警告文言と、web_fetch/web_search の実挙動(検索プロバイダを設定する場合は agent.json の `webSearch`)。
- **既知の制約**(backlog 化済み): エージェントは現状 `LOAMIUM_MODE=full` 前提。read-only/append-only では session 作成・メッセージが 403(既存 permissionMiddleware の pin)。restricted mode で read-only エージェントを実稼働させるには control-plane の分離設計が別途必要。

## What was assumed(前提・非自明な判断)
- 既定 permissions = read-only、web 既定 off(DESIGN priority 2 安全側)。
- LOAMIUM_MODE クランプ表: read-only→{read,web}、append-only→{read,web,journal_append}、full→恒等。
- 書き込みツールは 5 種、rename/delete は非提供。note_edit は非破壊 patch のみ。
- web_search のプロバイダ実体は sprint ローカル(agent.json 設定・未設定可)。SSRF は数値 IP 判定のみ(DNS 解決による rebind はスコープ外)。
- セッション権限は作成時ロード + サイドカー永続化(agent.json と同様、長時間セッション中の設定変更は次セッションから反映)。

## 検証メモ
各スプリントの独立検証は orchestrator が直接実施(make lint、全 workspace テスト、forbidden 差分スキャン、done-judgment Guard4-6、call-path 存在確認)。専用 verifier サブエージェントは起動せず、per-sprint の対話レビューはユーザー方針により省略。実装中に検出した2件の問題(false pre-existing 申告 / 蓄積 e2e リグレッション)はいずれも修正済み(compromises.json 参照)。
