# Skill Retrospective — Milestone S2fe109 (Sprints S2fe109)

_Generated at milestone arrival. Failure/rework → SKILL diff, or an explicit reason not to._

**Signals this batch:** 5 (compromises 4, overlooked 2, reopens 0, ungrounded decisions 0, recurring concern themes 0); concerns empty rate 0% (concerns were filed)

| # | Signal (source) | What happened | Root cause | Diff proposal — or reason for deferral |
|---|---|---|---|---|
| 1 | overlooked · C-S2fe109-03 | `void maxTurns` — maxTurns パラメータがセッションに渡されていなかった。実装セッションは単体テストが「定数 === 10」を確認するだけで配線を検証していなかった | SKILL 欠陥 — `verifier-agent.md` Category 1 の「call path grep: zero hits ⇒ fail」が maxTurns の配線の不存在を捕捉できる仕様だが、実装セッションは call path grep を API エンドポイント登録のみに適用し、値の配線を対象外にした。独立検証者がコードを直接読んで発見した | 提案: `sprint/references/test-discipline.md` に「パラメータ受け取り ≠ パラメータ配線」注記を追加。Rule 6 の diff scan に「引数として受け取ったが `void xxx` / `_xxx` で破棄されている変数」の検出パターンを追加する。Target: `test-discipline.md` Rule 6 + `verifier-agent.md` Category 1 (call-path grep の対象を "関数の引数も追う" と明示する) |
| 2 | overlooked · C-S2fe109-04 | CLI テストが TODO コメントのみ。実装セッションが「API パス確認済み」を AC 充足とみなした | SKILL 欠陥 — `test-discipline.md` Rule 2 (CLI は subprocess で exec する) が存在するが、story-scenarios.md の CLI テンプレートと acceptance test の 1:1 対応チェックが `sprint run` のストーリー完了判定に組み込まれていない。実装セッションはテストファイルの TODO を残したまま story を `done` にした | 提案: `sprint/references/sprint-run.md` の Story 完了チェックリストに「CLI story: `runCli` 等で subprocess を spawn するテストが存在するか確認」を追加する |
| 3 | compromise · C-S2fe109-02 | `['journal_append'] as const` → `as ['journal_append']` 型キャスト。readonly tuple が mutable array に代入不可 | task-local — `as const` の適用範囲の誤解。SKILL には「as const を配列に使うと readonly になる」注記はなく、TypeScript の標準仕様。繰り返しが見られればルール化の価値があるが、単発では不要 | 据え置き: task-local。TypeScript strict でコンパイルエラーが出るので次回も検出可能。SKILL 変更不要 |
| 4 | compromise · C-S2fe109-01 | pre-existing Playwright 600+ 失敗。S2fe109 以前から存在し S2fe109 の変更との因果関係なし | SKILL 欠陥候補 — `sprint verify` は `make test-ui` の失敗を overall_machine_status: fail として記録するが、pre-existing 失敗の「S2fe109 差分ゼロ確認」を自動化するロジックがない。結果、毎回手動の `git diff -- <failing-file>` 確認が必要になる | 提案 (low priority): `run-verify.py` に `--baseline-branch` オプションを追加し、failing test files の diff を自動チェックして「pre-existing 判定」を機械的に出力する。または `verify.json` に `allowedPreExistingFailures` フィールドを追加してホワイトリスト化する |
| 5 | concern · theme `worktree-old-base` (既存 memory 記録あり) | S2fe109-1 実装サブエージェントが worktree isolation で old base から branch し、追加済みコードが見えなかった。memory に記録済みの pitfall が再発した | SKILL 欠陥 — `autopilot-start.md` の worktree 使用ガイドラインが「共有ファイルを持つ story では non-worktree を使う」と明記されていない。memory は主観的ルールとして存在するが SKILL テキストに反映されていない | 提案: `autopilot/references/autopilot-start.md` に worktree 選択ルールを明記: 「同一 sprint 内で前 story の成果物 (新規ファイル・schema 追加) に依存する story は isolation:'worktree' を使わず sequential agent で実行する」。memory から SKILL へ昇格させる |

## Deferred (carried from prior milestones)

- (なし — このバッチが最初のマイルストーン到達)
