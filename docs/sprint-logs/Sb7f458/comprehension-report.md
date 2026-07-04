# Comprehension Report — 最終マイルストーン (Sprints Sbd061c, S9e5ca4, Sf53ad6, Sb1593c, Sb7f458)

_Generated at milestone arrival. Read this before `autopilot review`._

## What changed

- **Cmd/Ctrl+K のグローバル検索**ができた。パレットにノート名一致と全文ヒット(スニペット・行番号)がインクリメンタルに出て、Enter で開き、全文ヒットは該当行にカーソルが飛ぶ。IME 入力中は検索が暴発しない。
- **Obsidian 互換記法が一通り描画される**ようになった: `![[ノート]]` / `![[ノート#見出し]]` の transclusion カード(循環は深さ制限でエラーカード化、フリーズしない)、`> [!note]`〜`[!danger]` の 5 色 callout(`[!note]-` 折りたたみ対応)、`==highlight==` マーカー。すべて既存の 3 レジストリへの登録で実装され、ファイル形式は 1 バイトも変わらない。
- **添付ファイルが使える**ようになった。エディタへのドラッグ&ドロップ / 画像ペーストで `assets/` にアップロードされ `![[ファイル]]` が自動挿入される(名前衝突は連番)。ツリーに非 .md ファイルも表示され、削除・リネーム(`![[リンク]]` 追従込み)ができる。PDF はビューアブロック、テキスト/ログ/CSV/コードは読み取り専用ブロック(先頭 30 行 + 全体を開く)、その他はファイルカードとしてノート内にプレビューされる。API は `POST/GET/DELETE /api/files` + rename、CLI は `loamium upload` / `loamium files`。
- **dataview 風クエリが動く**。```dataview フェンスに `LIST` / `TABLE 列` / `TASK` + `FROM #tag・"folder"` + `WHERE`(frontmatter・file.* の比較)+ `SORT` を書くと動的に描画され、結果クリックで元ノート(TASK は該当行)へ移動、ファイル変更にも追従する。同じクエリは `POST /api/query` と `loamium query` からも実行できる(タスクはインデックス化済み)。
- **アプリ内 Claude Code タブ**ができた。「ターミナル」タブで vault を cwd とした TUI(既定 `claude`、`LOAMIUM_TERMINAL_CMD` で変更可)を xterm.js で操作できる。**デフォルト無効**で、`LOAMIUM_TERMINAL=1` + `LOAMIUM_MODE=full` の両方を満たすときだけ有効。無効時はタブに理由と有効化手順が表示される。

## Why this way

- **検索は既存 API の再利用のみ**(サーバー変更ゼロ)。ノート名はパレット表示時に一覧取得してローカル部分一致、全文は 200ms デバウンスで /api/search — 役割分担はプロトタイプの注記どおり。
- **記法はすべて Obsidian 標準に限定**(priority 4)。独自記法は 1 つも導入していない。embed のディスパッチは「拡張子→プレビュー種別」のレジストリにしたので、次の形式(音声等)は登録 1 件で足せる。
- **PDF はブラウザ内蔵ビューア**(iframe)にした(却下: pdf.js 同梱 — バンドル肥大に対して個人用途の利得が薄い、priority 5)。
- **アップロードの連番リネームは UI 層の責務**にし、API は決定的な 409 契約を維持(エージェントには明示的な `?overwrite=true` を要求 — priority 2)。
- **クエリエンジンは shared の純関数**(パーサー+評価器)にして server はインデックス供給のみ。/api/query は読み取り分類なので read-only モードでも使える(priority 3)。
- **pty は三重ガード**(env フラグ + full モード + 既定 127.0.0.1 バインド)。さらに verifier の指摘で **WS の Origin 検証**(cross-site WebSocket hijacking 対策)を追加した。監査ログにはセッション開始・終了のみ記録し、入力内容は記録しない(プライバシーと安全のバランス)。
- **node-pty はネイティブモジュール**のため環境の nix ツールチェーンでビルドできず、システム gcc でリビルドして解決(代替実装への逃げはしていない)。

## What to verify

- **未解消の妥協は 0 件**。verifier(全 5 Sprint で独立実行、3 pass / 2 warn→Sprint 内修正)の指摘は CSWSH 対策と E2E アサーション強化としてすべて反映済み。
- **ターミナルの運用ルール**は一度自分の目で確認を: `LOAMIUM_TERMINAL=1` で起動 → タブで対話 → `exit` / 再接続。**terminal 有効 + `HOST=0.0.0.0` の併用は危険**(LAN の誰でも vault 上でコマンド実行できる)。README に警告を書いたが、運用として守られるかはあなた次第。
- **claude 本体との結線は手動確認が必要**。E2E は実シェル(bash)で検証済みだが、`claude` CLI はログイン前提の外部依存のため AC 外(README「アプリ内 Claude Code タブ」参照)。実際に `LOAMIUM_TERMINAL=1 make serve` して claude が上がるか一度見てほしい。
- **dataview の対応範囲**は DQL の簡易サブセット(OR・関数・GROUP BY なし。対応外は位置付きエラー)。実際のクエリで足りるかは使って判断を。
- dataview の変更追従は SSE でなく「表示中ウィジェットの 2 秒ポーリング」。ノートを大量に開くとリクエストが増える設計トレードオフ(現状の個人利用では問題にならない見込み)。
- デモスクリーンショット: `docs/sprint-logs/Sb7f458/demo/`(01: callout/highlight/embed/dataview TASK、02: 検索パレット、03: 実 bash のターミナルタブ)。

## What was assumed

- 検索パレットの全文デバウンスは 200ms、dataview のポーリングは 2 秒、テキストプレビューは先頭 30 行 / 2MB ガード、アップロード上限は 50MB(`LOAMIUM_MAX_UPLOAD` で変更可)— いずれも設定 UI はなし。
- `.md` のアップロードは 400 で notes API へ誘導(LF/UTF-8 正規化を迂回させない)。
- 添付の削除・リネームの CLI コマンドは未提供(backlog 記録済み。API と UI からは可能)。
- ターミナルの Origin 検証は「no-Origin(非ブラウザクライアント)・same-origin・loopback」を許可する設計。認証層ではないので、外部公開時は Cloudflare Access 等を必ず挟む前提のまま。
