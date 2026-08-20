# 理解レポート — S2df65d リモート変更時の編集競合を 3-way 自動マージ(ADR-0030)

## What changed(何が変わったか)
- **3-way マージ層**(`packages/shared/src/diff3.ts`, 純 JS): `diff3Merge(base, ours, theirs)`。行単位 LCS + ハンク境界、**保守的競合検出**(疑わしきは競合)。外部依存なし。
- **競合解決 UI**(`ConflictResolverDialog.tsx`): 競合ハンクのみを ours/theirs 並列で提示し、ハンク単位で「自分/リモート/両方」を選択。全解決後に保存。モバイル(≤680px)縦積み・タップ 44px。
- **SSE 統合**(`App.tsx`): 編集中(dirty)に現在ノートのリモート変更を受けたら 3-way マージ。**非競合は自動統合(ダイアログ無し)**、競合ハンクがあるときだけダイアログ。**非 dirty は従来どおり自動リロード**。IME 合成中は待機、ダイアログ表示中の再 SSE はキュー。
- 書き戻しは**既存 `PUT /api/notes/{path}` 経由**(監査ログに記録=ADR-0016)。競合マーカー(`<<< === >>>`)は**ファイルに一切書かない**(UI 表示のみ)。正本はピュア Markdown 1 本のまま。

## Why this way(なぜこの設計か)
- ADR-0030(受理済み)の決定に準拠。CRDT 化せず(ピュア Markdown 絶対 priority 1)、diff3 は差し替え可能な単一純関数に閉じた(ADR-0001 と同じ「既存/単一機構」精神)。
- 誤マージ回避のため競合検出は保守側へ。自己エコー抑制を**全書き込み経路で一貫化**(下記の回帰対応)。

## What to verify(レビュー観点)
- 実機で「別デバイス/エージェントがリモート変更 → 編集中でも非競合は自動で入り、真の競合だけダイアログ」が期待どおりか。
- 競合ダイアログの文言・情報設計(「◯件自動マージ / △件を解決」)。
- モバイルでの縦積み・操作性。

## What was assumed / 注意
- **検証中に自己回帰を1件発見・修正**: プロパティ(frontmatter)書き込みの自己エコーが抑制漏れし、競合ダイアログが誤表示していた(`properties.e2e:215` が失敗)。`lastSavedContentRef` + 保存時の `baseMd` 更新で全書込経路の抑制を一貫化して修正。回帰テスト `props-no-conflict-dialog.mock` を追加。修正後 `properties.e2e:215` は pass。
- **verify ゲートの既存問題(S2df65d 由来ではない)**: `make test-ui` は base でも 9 件失敗(モバイルレイアウト mock 5 + 環境依存 e2e 4: dataview/editor/journal/smart-folder)。`.claude/verify.json` は `make test-ui`(フル)を宣言しているが、Makefile は決定的ゲートを `test-ui-mock` と規定。既存フレーク(backlog #13/#23/#28)。**推奨: verify.json の ui-tests を test-ui-mock に向ける or フレーク根治**。
- S2df65d の全 AC は機械的に pass、S2df65d 由来の新規失敗はゼロ(base 比較で確認)。
