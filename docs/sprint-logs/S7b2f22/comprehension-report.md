# Comprehension Report — Milestone: スマートフォルダ作成 UI (Sprint S7b2f22)

_Generated at milestone arrival. Read this before `autopilot review`._

## What changed

- スマートビューに **作成 / 編集 / 削除 / 並べ替え UI** が付いた。ヘッダの「+」で作成フォーム(名前・アイコン・種別 query/pin)が開く。
- `query` は**プリセット**(最近更新N件 / 特定タグ / journal直近N件 / 未完了TODO)を選ぶと DQL が自動生成され、**生 DQL も直接編集**できる。`pin` はノートパスを指定。
- 各項目に**編集・削除・上下移動**が付き、変更は `PUT /api/smart-folders` で全置換保存され、表示に即反映される。
- **read-only / append-only** モードでは +/編集/削除/並べ替えの導線が非表示。

## Why this way

- 保存する正本は **DQL 文字列**(ADR-0001)。プリセットは編集可能な DQL フィールドを埋める UI 糖衣に過ぎず、保存時は常に DQL 文字列を持つ。
- 要素は **pin | query** の判別ユニオンのまま(ADR-0003)。新しい種別は増やさない。
- バックエンド `PUT /api/smart-folders`(S32940c で実装済み)をそのまま使い、UI と `api.putSmartFolders` クライアントを追加しただけ。

## What to verify

- フォームの操作感・アイコン入力(組み込み名/絵文字)・並べ替えの手触りを実ブラウザで。`! make serve` + `! make serve-ui` → スマートビュー右上「+」。
- (low, テスト債務) **生 DQL 直接編集**と **movedown** は自動テスト未整備(実装は verifier がコードで正しさ確認済み)。→ backlog。
- (継続) node-pty のターミナル系テストはこのサンドボックスで実行不可(GLIBC)。スマートフォルダとは無関係。

## What was assumed

- アイコンは組み込み名 or 絵文字の**テキスト入力**。ビジュアルなアイコンパレット UI は未実装(要望あれば追加可)。
- 保存は毎回 config **全体を PUT(全置換)**。単一ユーザー前提で同時編集の競合制御はなし。
- 作成フォームはモーダルダイアログ。サイドバー内インライン展開ではない。
