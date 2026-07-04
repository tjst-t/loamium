---
name: loamium
description: Loamium (ローカル Markdown ノートアプリ) を loamium CLI で操作する。「これジャーナルにメモして」「今日の作業ログに残して」「〜について書いたノート探して」「〜のノート読んで/開いて」「ノートに追記して」など、ノートへの記録・検索・読み書きを頼まれたときに使う。journal-append (デイリージャーナルへの追記) と search (全文検索) が最重要ユースケース。
---

# Loamium Skill

ローカル Markdown vault を正本とするノートアプリ Loamium を、`loamium` CLI で操作するための Skill。
REST API とサブコマンドは 1:1 対応で、成功時は exit 0 + stdout、失敗時は非 0 + stderr に 1 行 JSON `{"error","message"}` が返る。

## 前提

- サーバーが起動していること (`make serve`)。接続先は `LOAMIUM_URL` → portman (`portman port --name loamium`、無ければ `portman lease --name loamium`) → `http://127.0.0.1:3000` の順で自動解決される。通常は何も設定しなくてよい。
- CLI はリポジトリ内なら `node packages/cli/bin/loamium.js`、bin がリンク済みなら `loamium` で起動する。
- パスは vault 相対 (例: `projects/hydra.md`)。vault 外 (`../` や絶対パス) は `invalid_path` で拒否される。
- 機械処理したいときは任意のコマンドに `--json` を付けると API レスポンスの生 JSON が stdout に出る。

## 最重要 1: ジャーナルへのメモ — journal-append

「メモして」「記録して」「作業ログに残して」「決定事項を書いておいて」は、原則デイリージャーナル (`journals/YYYY-MM-DD.md`、自動生成) への追記に変換する。

| 自然言語の依頼 | コマンド |
|---|---|
| 「これジャーナルにメモして: リリースは金曜に延期」 | `loamium journal-append "リリースは金曜に延期"` |
| 「今日の作業ログに『CLI 実装完了、テスト 15 件 pass』って残して」 | `loamium journal-append -- "- CLI 実装完了、テスト 15 件 pass"` |
| 「さっき決めたことをジャーナルに書いておいて」 | `loamium journal-append "## 決定事項\n- パーサは commander を採用\n- エラーは stderr に 1 行 JSON"` |
| 「1月15日のジャーナルに追記して」 | `loamium journal-append "過去分の記録" 2026-01-15` |
| 「今日のジャーナル見せて」 | `loamium journal` |
| 「昨日のジャーナル読んで」 | `loamium journal 2026-07-02` (日付は YYYY-MM-DD で明示) |

コツ:
- 複数行は `"- 項目1\n- 項目2"` のように 1 回の journal-append にまとめる (追記は末尾に改行区切りで積まれる)。
- **内容が `-` で始まるとき (リスト項目・frontmatter `---` 等) は、内容の前に `--` を置く**: `loamium journal-append -- "- リスト項目"`。`--` なしだと CLI がオプションと誤解釈して `usage` エラーになる。迷ったら常に `--` を付けてよい (write / append / patch でも同様)。
- 「何を記録したか」をユーザーに返すときは追記した内容をそのまま引用すればよい。日付・パスは stdout (`appended to journal 2026-07-03 (journals/2026-07-03.md)`) に出る。

## 最重要 2: ノートを探す — search

「〜について書いたノートどれだっけ」「〜のメモ探して」は全文検索に変換する。出力は `パス:行番号: マッチ行` 形式。

| 自然言語の依頼 | コマンド |
|---|---|
| 「監査ログについて書いたノート探して」 | `loamium search "監査ログ"` |
| 「Hydra の設計メモどこだっけ」 | `loamium search "Hydra 設計"` |
| 「先週メモした commander の話、探して中身見せて」 | `loamium search "commander"` → ヒットしたパスを `loamium read <path>` |
| 「dev タグのノート一覧見せて」 | `loamium list --tag dev` (タグ絞り込みは search より list) |
| 「projects フォルダに何がある?」 | `loamium list --folder projects` |

コツ:
- search は曖昧一致 (Fuse.js)。ヒットが多すぎたら語を足して絞る、ゼロなら語を減らす・別の言い回しにする。
- 「タグ」「フォルダ」で探す依頼は `search` ではなく `loamium list --tag <tag>` / `loamium list --folder <folder>` が正確。
- どんなタグがあるか分からないときは `loamium tags` (タグ一覧 + 件数)。

## 構造化クエリ — query (dataview 風 DQL)

「未完了タスク全部見せて」「status が done じゃないプロジェクトの一覧」のような、タグ・frontmatter・タスク状態による**条件付き抽出**は全文検索ではなく `loamium query` に変換する (Obsidian dataview の簡易サブセット)。

| 自然言語の依頼 | コマンド |
|---|---|
| 「未完了のタスク、vault 全部から出して」 | `loamium query "TASK where !completed"` |
| 「project タグのノート一覧」 | `loamium query "LIST from #project"` |
| 「projects フォルダで status が done 以外を更新順で」 | `loamium query 'TABLE status, updated from "projects" where status != "done" sort updated desc'` |
| 「7月に触ったノートは?」 | `loamium query 'LIST where file.mtime >= "2026-07-01"'` |

構文: `LIST / TABLE 列1, 列2 / TASK` + `FROM #tag か "folder"` + `WHERE 条件 (and 結合)` + `SORT フィールド [asc|desc]`。キーワードは大文字小文字どちらでもよい。
- where のフィールド: frontmatter の任意キー (status 等) + 組み込み `file.name` / `file.folder` / `file.mtime` + `tags`。TASK では `completed` / `text` / `line` も使える。
- 演算子: `=` `!=` `>` `<` `>=` `<=` `contains`。真偽は bare (`completed`) / 否定 (`!completed`)。
- 構文エラーは非 0 exit + stderr JSON `{"error":"query_syntax","message":"N 行 M 列: ..."}` (位置情報付き)。message を見てクエリを直す。OR や関数は未対応 — 複数条件は `and` で書く。

## その他のコマンド (全 15 コマンド)

```sh
loamium read projects/hydra.md                 # ノート本文を表示 (GET /api/notes/{path})
loamium write notes/new.md "# 新規ノート"       # 作成・上書き (PUT)。上書きなので既存に足すなら append を使う
loamium append projects/hydra.md "追記する行"   # 末尾追記 (POST .../append)
loamium patch projects/hydra.md --old "旧文字列" --new "新文字列"  # 一意な old を new に置換 (POST .../patch)
loamium rename projects/hydra.md projects/hydra-v2.md  # リネーム + 全ノートの [[旧名]] リンクを自動追従 (POST .../rename)
loamium journal                                # 今日のジャーナル取得 (無ければ自動生成)
loamium journal-append "メモ" [YYYY-MM-DD]     # ジャーナル追記 (最重要)
loamium search "クエリ"                         # 全文検索
loamium query "TASK where !completed"          # dataview 風 DQL (POST /api/query)。条件付き抽出はこちら
loamium backlinks meeting.md                   # そのノートへの [[リンク]] 元一覧
loamium list [--tag <tag>] [--folder <dir>]    # ノート一覧・絞り込み
loamium tags                                   # タグ一覧 (件数付き)
loamium upload ./screenshot.png                # ファイルを vault へアップロード (POST /api/files/{path})。保存先省略時は assets/<ファイル名>
loamium upload ./report.pdf docs/report.pdf    # 保存先を明示してアップロード。既存パスは conflict (--overwrite で上書き)
loamium file assets/screenshot.png             # vault 内ファイルのバイト列を stdout へ (GET /api/files/{path})
loamium files                                  # 添付 (非 .md) ファイル一覧 (GET /api/files)
```

添付ファイル (アップロード) のコツ:
- 「このスクリーンショット/PDF/ログをノートに添付して」は `loamium upload <ローカルパス>` → 返ってきた vault パスを `![[assets/ファイル名]]` としてノートに `append` する、の 2 段で行う。
- `.md` はアップロードできない (`use_notes_api` で拒否)。ノートは `write` / `append` を使う。
- サイズ上限は既定 50MB (`LOAMIUM_MAX_UPLOAD`)。超えると `too_large` になる。

使い分けの原則:
- **既存ノートに足す**のは `append` / `journal-append`。`write` は全文上書きなので、ユーザーが「書き換えて」と明示したときだけ使う。
- **部分修正**は `patch`。`--old` はノート内で一意な文字列にする (曖昧だと `ambiguous_match` で拒否される — データ保護のための仕様)。
- ノート同士の関連を聞かれたら `backlinks` (「このノートどこから参照されてる?」)。
- **ノート名の変更・移動**は `rename`。vault 内の `[[旧名]]` (見出し `#` / 表示名 `|` 形式含む) が自動で書き換わる。`write` + 手動リンク修正はしない。リネーム先が既にあると `conflict` で拒否される。

## エラー対処

失敗時は stderr に 1 行 JSON が出る。`error` フィールドで分岐する:

| error | 意味 | 対処 |
|---|---|---|
| `server_unreachable` | サーバー未起動 (または接続先違い) | `make serve` でサーバーを起動してからリトライ。それでも失敗するなら `LOAMIUM_URL` の指す先を確認 |
| `not_found` | ノート不在 | パスの打ち間違いの可能性が高い。`loamium search "<ノート名の一部>"` か `loamium list` で正しいパスを探し直す。新規作成の意図なら `write` を使う |
| `old_not_found` | patch の `--old` がノート内に無い | `loamium read <path>` で現物を確認し、実際の文字列を `--old` に指定し直す |
| `ambiguous_match` | patch の `--old` が複数箇所に一致 | `--old` に前後の文脈を含めて一意にする |
| `invalid_path` | vault 外パス・不正パス | vault 相対パス (例: `projects/note.md`) に直す。`../` や絶対パスは使えない |
| `forbidden` | サーバーが read-only / append-only モード | 書き込みできない設定で起動している。ユーザーにモード変更 (LOAMIUM_MODE) を確認する |
| `conflict` | アップロード/リネーム先に同名ファイルが既にある | 別名にするか、上書きの意図が明確なら `loamium upload <file> <path> --overwrite` |
| `too_large` | アップロードがサイズ上限超過 (既定 50MB) | ファイルを小さくするか、ユーザーに上限変更 (LOAMIUM_MAX_UPLOAD) を確認する |
| `use_notes_api` | `.md` を files API で操作しようとした | ノートは `write` / `append` / `read` を使う |
| `query_syntax` | query の DQL 構文エラー | message の「N 行 M 列」を見てクエリを直す。OR・関数は未対応 (`and` で結合する) |
| `invalid_date` | 日付形式が不正 | `YYYY-MM-DD` 形式で指定し直す (「昨日」「先週」は具体日付に変換する) |
| `usage` (exit 2) | 引数不足・不明コマンド | `loamium --help` / `loamium <cmd> --help` で使い方を確認 |

対処してもリトライが失敗し続ける場合は、stderr の `message` (人間可読) をそのままユーザーに見せて指示を仰ぐ。
