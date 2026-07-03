# Comprehension Report — M1: エージェント統合 MVP (Sprints Sd63ad1, S31ba00, S0c9a48)

_Generated at milestone arrival. Read this before `autopilot review`._

## What changed

- **Loamium が「エージェントから使えるノートシステム」として一通り動くようになった。** ローカルの vault(.md ファイル群)に対して、REST API・`loamium` CLI・Claude Code 用 Skill の 3 つの入口から読み書き・検索ができる。
- **ノート操作**: 取得 / 作成・上書き / 末尾追記 / 部分置換(patch)/ 削除。patch は置換対象が曖昧(複数一致)だと拒否する — エージェントの誤爆からファイルを守るため。
- **デイリージャーナル**: `journals/YYYY-MM-DD.md` を自動生成し、`loamium journal-append "メモ"` の 1 コマンドで今日のジャーナルに追記できる(最重要ユースケース)。
- **検索とリンク**: 全文検索(あいまい一致)、`#tag` / frontmatter tags / フォルダでの絞り込み、`[[WikiLink]]` のバックリンク一覧。外部エディタや Git でファイルを直接変更しても数百 ms でインデックスに反映される(chokidar 監視)。
- **安全機構**: すべての書き込みが `.loamium/audit.log`(JSONL)に記録される。サーバーを `LOAMIUM_MODE=read-only / append-only` で起動するとエージェントの操作を制限できる。vault 外へのパス脱出は二重に遮断。
- **Skill**: `skill/SKILL.md` に「これジャーナルにメモして」→ `loamium journal-append ...` などの自然言語→コマンド変換例とエラー対処表を整備。記載例が実 CLI から乖離すると落ちる doc-drift テスト付き。

## Why this way

- **正本は常に Markdown 文字列 1 本**(ブロック配列にしない)。インデックスはインメモリ + 都度再構築可能で、壊れてもファイルは無傷(PRINCIPLES priority 1, 6)。ブロック ID は一切ファイルに書き込まない(バイト同一性テストで機械検証)。
- **notes API は `.md` のみ扱う**。添付ファイル等は将来の別エンドポイント(却下: 任意拡張子の読み書き — エージェントに vault 内の任意ファイル改変を許すのはデータ安全性 priority 2 に反する)。
- **append-only モードでは新規作成(PUT)も 403**(却下: 新規のみ許可 — 「追記のみ」の意味論を保守側に倒した。journal-append と append は通る)。
- **リンク解決は Obsidian 互換規則**: NFC 正規化・大文字小文字不区別・`.md` 省略可・フォルダ横断のファイル名一致、複数候補は最短パス。`[[note#heading]]` は読み取り解決のみ。
- **CLI は API の薄い 1:1 ラッパー**で `delete` コマンドだけ意図的に未提供(エージェントの誤削除防止、priority 2。API には DELETE があり UI からは使う)。
- **パッケージは TS ソース直配布 + tsx 実行**(ビルド工程なし)。個人用モノレポで最短の開発ループを優先(priority 5)。
- **機械検証基盤を Sprint 1 で自作**: `.claude/verify.json` + `hooks/run-verify.py` が実 exit code / JUnit から pass/fail を機械導出し、モデルの自己申告を信用しない構造にした。

## What to verify

- 妥協(テスト弱体化・エラー握りつぶし等)は **3 Sprint 通して 0 件**。独立 verifier(別セッション・opus・read-only)も 3 Sprint すべて overall=pass、申告漏れ 0。
- ⚠️ (structural, Sprint Sd63ad1) 機械検証基盤そのものが被検証コードと同一セッションで実装された点を verifier が warn として記録(fabrication でないことは verifier が実読で確認済み)。以後の Sprint はこの基盤の恩恵を受けるため実質解消。
- **競合制御は last-write-wins のまま**(楽観ロック未実装)。UI・CLI・エージェントが同一ノートを同時編集すると後勝ち。SPEC §9 高-1 の完全解決は UI Sprint の mtime 警告 + 将来バックログ。実運用で困るか自分の使い方で確認を。
- タグは Obsidian 同様「`#` の直前が空白か行頭」のときだけ認識される。`〜到達。#milestone` のように **CJK 句読点の直後の `#tag` は認識されない**(デモで観測)。不便なら要調整。
- CLI で `-` や `---`(frontmatter)で始まる内容を渡すときは `--` 区切りが必要(`loamium write note.md -- "---\n..."`)。SKILL.md には記載済みだが、人間が直接使うときに引っかかりうる。

## What was assumed

- ジャーナルの置き場所は `journals/` 固定、テンプレートなし・空ファイル生成(SPEC は「テンプレート有無」を未決としていた。設定化はしていない)。
- タイムゾーンはサーバーローカル。「今日」の境界は 00:00(深夜メモは翌日のジャーナルに入る)。
- ジャーナル自動生成は read-only モードでは行わない(読み取りが書き込みを誘発しない、を優先)。
- CLI の接続先解決は `LOAMIUM_URL` → `portman port --name loamium` → `http://127.0.0.1:3000` の順(このマシンの portman は `port` サブコマンド未対応でデフォルトにフォールバックすることを確認済み)。
- 認証はローカル無認証のまま(Cloudflare Access に委譲する前提。Tunnel 構成はバックログ)。
