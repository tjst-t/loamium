# Skill Retrospective — エージェント基盤の完成 (Sprints S5a66e4 / S8a3f2e / Sc4b9d1)

_マイルストーン到達時に生成。失敗/手戻り → SKILL diff、またはそうしない明示的理由。_

**Signals this batch:** 5 (compromises 0, overlooked 1, reopens 0, ungrounded decisions ~18[大半は ADR 参照で実質 grounded], recurring concern themes 1); concerns empty rate ~高 (verifier は concerns[] を明示出力していない → sensor under-elicited の可能性、self-audit item 3)

| # | Signal (source) | What happened | Root cause | Diff proposal — or reason for deferral |
|---|---|---|---|---|
| 1 | overlooked · verifier · Sc4b9d1-2/3 (AC-2-3/3-3) | `command_run`/`template_instantiate` の書込先に ADR-0018 機密 deny が効かず、実装者は『妥協なし』と自己申告。独立検証者が発見し fix(2123897) で解消 | **SKILL defect** — 新しい書き込み系ツールを追加する際、既存 `createVaultWriteTools` が持つ deny 強制の「セキュリティ不変条件パリティテスト」を必須化する規約が無い。`smartfolder_notes` だけ deny テストがあり非対称 | Propose: `sprint/references/test-discipline.md` に「既存書込ツールと同じ安全不変条件(パス正規化・機密 deny・監査)を持つ新書込ツールは、その不変条件ごとに拒否系の回帰テストを必須」ルールを追加。verifier-agent.md の書込ツール検査に「deny 強制点の網羅(全書込ツールが isDenied を受領・適用)」チェックを追加 |
| 2 | rework · S8a3f2e-2→-5 | shim の 3 欠陥(PORT=0/遅延ロード欠落=常時503/content 配列400)がユニット(engine スタブ + in-process app.request)を全通過し、実サーバー経路を通す S8a3f2e-5 で初めて露見 | **SKILL defect** — 外部クライアント統合(baseUrl 差替・adapter・shim)ストーリーで、実サーバー+実クライアント経路の smoke を「統合するストーリー内」で要求する規約が無く、後続ストーリーへ後ろ倒しできてしまう | Propose: `sprint/references/sprint-run.md`(または plan の DoD)に「外部クライアントが叩く接続点(baseUrl/shim/adapter)を作るストーリーは、in-process request でなく実サーバー起動+実クライアント経路の smoke を同一ストーリーの AC に含める」を追加 |
| — | (共通テーマ) | #1 と #2 は同一テーマ: **境界をスタブしたユニットが緑でも、実統合面・セキュリティ面が未テスト**。2 スプリントに跨って再発 | mesh の反復的ギャップ | 上記 #1/#2 の diff で個別に対処。テーマとしては「スタブ境界の外側(実経路・不変条件)を必ず1本通す」原則を test-discipline に総則化する余地あり |
| 3 | ungrounded decisions · 全 3 sprint | VISION-drift チェックで decisions の ~64% が VISION/DESIGN_PRINCIPLES を直接参照しない | **task-local(誤検知)** — 大半は ADR(0016/0018/0021/0025/0028 等)を参照しており、本プロジェクトでは ADR が VISION/原則から導かれた拘束制約。真のドリフトではない | Deferral(低): ただし VISION-drift チェックのヒューリスティックが ADR 参照を grounding として数えないため、ADR リッチなプロジェクトで false drift を出す。将来 `autopilot-operations.md` の drift 計算に「ADR-NNNN 参照も grounded とみなす」を足す余地あり。今回は実害なしのため defer |
| 4 | mis-flag · S5a66e4 pre-flight | agent-run を『Pi Agent 未マージでブロック』と誤判定→ユーザー指摘で撤回 | **task-local(軽微)** — コード grep が浅く、git log のマージコミット(S53409d-2 pi SDK / S2fe109 job runner)を確認していなかった | Deferral: pre-flight の blocker 主張は「コード grep だけでなく git log --grep でマージ済みか」を併せて確認すべき、という運用上の学び。SKILL 変更は要さない(escalate 前の裏取り徹底で足りる) |

## Deferred (carried from prior milestones)

- (none — 本プロジェクトで skill-retrospective は初回生成。過去マイルストーンには遡及生成しない)
