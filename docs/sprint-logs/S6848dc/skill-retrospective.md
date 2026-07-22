# Skill Retrospective — S6848dc「エディタ/リスト修正まとめ 3」

_Generated at milestone arrival. Failure/rework → SKILL diff, or an explicit reason not to._

**Signals this batch:** 3 (compromises 3, overlooked 0, reopens 0, ungrounded decisions 0, recurring concern themes 0); concerns empty rate ~100%(verifier プロンプトで concerns[] を明示要求しなかったため未収集 — センサー未励起、下記 #4 参照)

| # | Signal (source) | What happened | Root cause | Diff proposal — or reason for deferral |
|---|---|---|---|---|
| 1 | compromise · C-S6848dc-3(#2 verification_gap) | 「リスト内画像が表示されない」というユーザー報告に対し fix-Story を作ったが、現 HEAD では既に描画されており実装不要だった(回帰テストのみ追加) | **SKILL 欠陥(軽)** — `autopilot review` の ①/② ルーティングも `sprint fix` も、fix-Story 作成前に「現 HEAD でバグが再現するか」を確認する手順を持たない。再現しないバグに実装枠を割く/実装エージェントが調査に時間を使う | Propose: `autopilot` SKILL の Review Mode ①/② と `sprint/references/sprint-fix.md` に「fix-Story 着手前に現 HEAD で再現を 1 度確認(再現しなければ回帰テスト固定 or クローズ)」の前段を追加。Target: `autopilot/SKILL.md` Review Mode + `sprint fix`。 |
| 2 | compromise · C-S6848dc-1(test_stability) | 初回 make verify で既存フレーク `wikilink.mock:90` が 1 件失敗し verify ゲートが赤に。main でも 2/10 再現の既存フレーク(本 Sprint 無関係)を決定化して解消 | **task-local(リポジトリ設定)** — SKILL は正しく機能した(赤 verify を握り潰さず、main 比較で pre-existing を実証してから安定化)。真因は playwright mock の `retries:0` + 既存フレークテストで、autopilot/sprint SKILL の法には起因しない | Deferral(SKILL 変更なし)。代わりにリポジトリ backlog へ: 「playwright mock に retries を設定 or 既存フレーク(wikilink.mock 他)の根治」。SKILL の『赤 verify を pass にしない』規律はむしろ有効に働いた。 |
| 3 | compromise · C-S6848dc-2(#4 behavior_change) | 非リスト行 Tab の挙動を S9ab6c3 の確立挙動から変更(フォーカス移動→タブ挿入) | **task-local** — ユーザー要望の意図的な挙動変更で、プロトタイプ承認 + story + decisions で正規に記録。AC-S9ab6c3-1-2 の境界は維持。SKILL が失敗を許した事象ではない | 差分なし。過去 AC 挙動の変更は compromises/comprehension-report に明示済み(法の変更ではなく製品判断)。 |

## 補足観測(SKILL/プロセス健全性)

- **concerns[] センサー未励起(自己監査 item 3)**: 今回の独立 verifier プロンプトは AC/禁止改変/ADR 整合の判定に集中させ、`verification-report.json` の `concerns[]`(規則充足だが違和感、のセンサー)を明示的に求めなかった。empty rate ~100% は「違和感ゼロ」の証明ではなくセンサー未収集。次回以降、verifier サブエージェントに concerns[] の起票を明示要求すべき(単発の concern は diff にしないが、2+ Story で同テーマなら新 AC/不変条件の候補)。
- **逐次実装の判断は妥当に機能**: 全 6 ストーリーが outline.ts / styles.css を共有する状況で worktree 並列を避け逐次にした(既知の old-base 落とし穴回避)。各実装エージェントが全テストを回し回帰を即検知。SKILL の該当ガイダンス(共有ファイルは逐次)は有効。

## Deferred (carried from prior milestones)

- (none — 本 Sprint が本ロードマップで最初の retrospective 生成。過去 milestone は skill-retrospective 未生成のため back-fill しない)
