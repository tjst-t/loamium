# Loamium

> **ファイルはピュア Markdown、編集はアウトライナー、操作はエージェントからも。**

Loamium は、[Obsidian](https://obsidian.md/) と [LogSeq](https://logseq.com/) の「いいとこどり」を狙った個人用ノートアプリです。ローカルの `.md` ファイル群(vault)を唯一の正本とし、アウトライナー編集・デイリージャーナル・バックリンクと、エージェント(Claude Code 等)からの読み書きを両立します。

- **Obsidian から**: ローカルの `.md` がすべて。ロックインなし。フォルダ構造そのまま。Git やお好みのエディタで直接触れます。
- **LogSeq から**: アウトライナー編集(リスト行の Tab インデント・折りたたみ)、デイリージャーナル中心のワークフロー、チェックボックスによるタスク管理。
- **Loamium 独自**: REST API / CLI / Skill を通じて、エージェントがノートを読み書き・検索・整理できます。「作業ログを自動でジャーナルに書かせる」が最重要ユースケースです。

## 特徴

### ✍️ エディタ(React + CodeMirror 6)

- **ライブプレビュー**: 見出し・太字・`[[リンク]]`・インラインコードはカーソル行以外で装飾表示され、カーソルを置いた行だけソースが見える(Obsidian Live Preview 相当)
- **Obsidian 互換記法**: `![[embed]]` transclusion(ノート/見出し/画像、循環は安全に遮断)、`> [!note]` callout、`==highlight==`、```dataview フェンス(LIST / TABLE / TASK + FROM / WHERE / SORT の DQL サブセット)
- **グローバル検索**: Cmd/Ctrl+K のパレットでノート名+全文からジャンプ(該当行へカーソル移動)
- **添付ファイル**: ドラッグ&ドロップ / 画像ペーストで `assets/` にアップロードし `![[ファイル]]` を自動挿入。PDF・テキスト・CSV・コードはノート内で埋め込みプレビュー
- **アウトライン操作はリスト行限定(C 方式)**: `-` / `1.` / `- [ ]` の行でのみ Tab / Shift+Tab のインデント(子要素追従)と折りたたみが効きます。見出しや段落は普通の Markdown のまま — 文章ノートが箇条書き地獄になりません
- **図・数式・ハイライト**: Mermaid 図、KaTeX 数式(`$…$` / `$$…$$`)、Shiki コードハイライトをローカルバンドルで描画(オフライン動作)
- **リンク機構**: `[[` でノート名オートコンプリート、壊れリンクの赤表示(クリックで新規作成)、バックリンクパネル、**リネーム時の全 `[[リンク]]` 自動追従**
- **デイリージャーナル**: 起動すると今日の `journals/YYYY-MM-DD.md`(自動生成)に着地

### 🤖 エージェント統合(REST API / CLI / Skill)

REST API と CLI は 1:1 対応。`curl` でも叩けるため、特定のエージェントに依存しません。

```sh
loamium journal-append "- 今日決めたこと: パーサは commander を採用"
loamium search "監査ログ"
loamium read projects/loamium.md
loamium write notes/new.md -- "# 新規ノート"
loamium rename old.md new.md        # vault 内の [[old]] も全部書き換わる
```

`skill/SKILL.md` は claude-skills 形式で、Claude Code に「これジャーナルにメモして」と頼むだけで上記 CLI に変換されます。

### 🔒 データ安全性

- **書き込みはすべて監査ログに記録**(`.loamium/audit.log`、JSONL)
- **権限モード**: `LOAMIUM_MODE=read-only / append-only / full` でエージェントの操作を制限
- **vault 外へのパス脱出は二重に遮断**。patch(部分置換)は対象が曖昧なら拒否
- **インデックスは使い捨て**: 検索・バックリンクのインデックスはインメモリで、常にファイルから再構築可能。壊れてもファイルは無傷

### 📐 設計上の割り切り

- **ブロック ID を生成しない**: `^blockid` / `((uuid))` で本文を汚しません(既存 ID の読み取り互換のみ)。ピュア Markdown の正本性が最優先です
- **全行リスト化しない**: LogSeq のような強制ブロック化はせず、標準記法をそのまま保存
- **独自記法なし・プラグイン API なし**: Obsidian や素のエディタで開いても壊れないことが絶対条件
- **vault = Git リポジトリ推奨**: 履歴・バックアップ・競合解決は Git に任せる(`.loamium/` は gitignore)

詳細な設計判断は [`SPEC.md`](SPEC.md) と [`docs/DESIGN_PRINCIPLES.json`](docs/DESIGN_PRINCIPLES.json) を参照してください。

## クイックスタート

要件: **Node.js 20+** / npm

```sh
git clone https://github.com/tjst-t/loamium.git
cd loamium
npm install
```

### 起動(手動)

```sh
# API サーバー (vault の場所とポートを指定)
LOAMIUM_VAULT="$PWD/dev-vault" PORT=3000 npx tsx packages/server/src/index.ts

# UI 開発サーバー (別ターミナルで)
LOAMIUM_API_URL=http://127.0.0.1:3000 npx vite packages/ui --port 5173
```

ブラウザで http://localhost:5173/ を開くと、今日のジャーナルに着地します。

### 起動(Makefile / [portman](https://github.com/tjst-t/port-manager) がある場合)

```sh
make serve      # API サーバー (バックグラウンド、ポートは portman 管理)
make serve-ui   # UI 開発サーバー
make stop       # 停止
```

LAN 内の他デバイスからアクセスする場合は `make serve HOST=0.0.0.0 && make serve-ui HOST=0.0.0.0`(**無認証なので信頼できるネットワーク限定**。外部公開は Cloudflare Tunnel + Access を想定 — 未同梱)。

### CLI

```sh
export LOAMIUM_URL=http://127.0.0.1:3000   # 省略時もこの値にフォールバック
node packages/cli/bin/loamium.js journal-append "はじめてのメモ"
```

全 11 コマンド: `read` / `write` / `append` / `patch` / `rename` / `journal` / `journal-append` / `search` / `backlinks` / `list` / `tags`。すべて `--json` で生 JSON 出力、失敗時は非 0 終了 + stderr に 1 行 JSON(`{"error","message"}`)を返すため、スクリプトやエージェントから扱いやすくなっています。内容が `-` で始まるとき(リスト・frontmatter)は `--` 区切りを使ってください: `loamium write note.md -- "---\ntags: [x]\n---"`。

## 右サイドバーの Claude(ターミナル)

UI の右サイドバーは **バックリンク ⇄ Claude** のトグルです。Claude タブに切り替えると、vault を作業ディレクトリとした TUI(既定は [Claude Code](https://docs.anthropic.com/claude-code) の `claude`)をそのまま操作できます(xterm.js + WebSocket + node-pty)。**メインのノートは見えたまま**なので、ノートを見ながら対話できます。バックリンクと Claude を切り替えても xterm セッションは維持されます。

ターミナルは **vault 上で任意コマンドを実行できるため、デフォルト無効** です。次の 2 つを両方満たすときだけ有効になります(SPEC §6 の明示オプトイン):

```sh
# 明示オプトイン (full モード必須)。バインドは既定 127.0.0.1 のまま
LOAMIUM_TERMINAL=1 LOAMIUM_MODE=full LOAMIUM_VAULT="$PWD/dev-vault" PORT=3000 \
  npx tsx packages/server/src/index.ts

# 起動コマンドを変える場合 (既定: claude)
LOAMIUM_TERMINAL_CMD=bash  # シェルなども指定可 (引数なしの単一コマンド)
```

- **claude を使う場合の前提**: サーバーを動かすマシンで `claude` にログイン済みであること(認証はサーバー側のローカル環境に従います)。初回起動時は「Do you trust this folder?(このフォルダを信頼しますか)」の信頼プロンプトが右サイドバーに表示されるので、`1`(Yes)を選んで Enter すると対話に入れます。vault ルートに CLAUDE.md や Skill(`skill/`)を置いておくと、ノートを踏まえた対話ができます
- pty へ渡す環境変数は整えてあります: 既定 `claude` が確実に起動するよう、`TERM=xterm-256color` / `COLORTERM=truecolor` / `LANG`(未設定時 `C.UTF-8`)を設定し、Loamium サーバー自身を Claude Code 配下で動かしている場合に子 `claude` が誤動作しないよう `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_SSE_PORT` を継承させません
- read-only / append-only モードでは `LOAMIUM_TERMINAL=1` でも無効です(サイドバーに理由と有効化手順が表示されます)
- セッションの開始・終了は監査ログ(`.loamium/audit.log`)に記録されます。**入力したコマンドの内容は記録されません**
- 切断時(`exit` やサーバー再起動)は子プロセスを確実に終了し、サイドバーに **終了コード**と「再接続」ボタンが表示されます(三重ガード + Origin 検証は維持されます)
- WS `/api/terminal` は Origin を検証し、遠隔サイト(あなたが訪れた別の Web ページ)からの cross-site WebSocket hijacking を拒否します。許可されるのはループバック配信の UI と 同一オリジンのみです
- `LOAMIUM_TERMINAL=1` のまま LAN 公開(`HOST=0.0.0.0`)すると、ネットワーク上の誰でも vault でコマンド実行できてしまいます(LAN オリジンは Origin 検証でも弾かれますが、そもそも 公開しないのが安全)。**ターミナル有効時はローカルバインド(既定 127.0.0.1)のまま使うか、Cloudflare Access 等の認証層を必ず挟んでください**

## REST API 概要

| エンドポイント | 機能 |
|---|---|
| `GET / PUT / DELETE /api/notes/{path}` | ノート取得(frontmatter 込み)/ 作成・上書き(`baseMtime` による楽観的競合検出対応)/ 削除 |
| `POST /api/notes/{path}/append` | 末尾追記 |
| `POST /api/notes/{path}/patch` | 部分置換(old が一意でなければ 409) |
| `POST /api/notes/{path}/rename` | リネーム + vault 内の全 `[[リンク]]` 書き換え |
| `GET /api/notes?tag=&folder=` | ノート一覧・絞り込み |
| `GET /api/journal?date=` / `POST /api/journal/append` | デイリージャーナル取得(自動生成)/ 追記 |
| `GET /api/search?q=` | 全文検索(Fuse.js、スニペット付き) |
| `GET /api/backlinks?path=` | バックリンク一覧(コンテキスト行付き) |
| `GET /api/tags` | タグ一覧(`#tag` + frontmatter tags、件数付き) |
| `WS /api/terminal` | アプリ内ターミナル(node-pty ブリッジ)。**デフォルト無効** — `LOAMIUM_TERMINAL=1` + `LOAMIUM_MODE=full` で明示オプトイン |

外部エディタや Git でファイルを直接変更しても、ファイル監視(chokidar)がインデックスを自動更新します。

## アーキテクチャ

```
UI (React + CodeMirror 6) ──┐
CLI (loamium) ──────────────┼── REST API (Hono) ── ファイルシステム (.md が正本)
Skill (Claude Code) ── CLI ─┘        └── インメモリインデックス (検索・バックリンク・タグ)
```

npm workspaces のモノレポです:

```
packages/
├── shared/   # 型・zod スキーマ・パス正規化 (NFC/脱出検証)・Markdown パーサー・日付処理
├── server/   # Hono REST API + インデックス + ファイル監視 + 監査ログ/権限モード
├── cli/      # loamium CLI (API の薄い 1:1 ラッパー)
└── ui/       # React + CodeMirror 6 (fence/inline/block の 3 レンダラーレジストリ)
skill/        # Claude Code 用 Skill (自然言語 → CLI 変換)
```

拡張レンダリング(Mermaid / KaTeX / Shiki)は fence / inline / block の 3 レジストリに登録する方式で、新しい記法・言語はレジストリ登録 1 件で追加できます。詳細は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 開発

```sh
make test      # Vitest (shared ユニット + API/CLI 受け入れテスト、JUnit XML を reports/ に出力)
make test-ui   # Playwright (mock + 実サーバー E2E。初回は npx playwright install chromium)
make lint      # tsc --noEmit (全 workspace)
make build     # ビルド
```

テストは「ユーザーの入口から」が原則です — API は実 HTTP、CLI はサブプロセス起動、UI は実ブラウザ + 実サーバーの E2E で受け入れ条件を検証しています(2026-07 時点: Vitest 352 件 + Playwright 152 件)。

開発の進め方・ロードマップは [`docs/ROADMAP.json`](docs/ROADMAP.json)、プロダクトの狙いは [`docs/VISION.json`](docs/VISION.json) を参照してください。

## ステータスと今後

**ロードマップ 15 Sprint 完了**(2026-07): エディタ・ジャーナル・検索(Cmd+K + 詳細検索ページ)・バックリンク・リンク追従・記法拡張(embed / callout / highlight / dataview)・添付ファイルと埋め込みプレビュー・ファイル/フォルダブラウザ・`/` スラッシュメニュー・ブラウザ的ルーティング(戻る/進む)・右サイドバーの Claude(ターミナル)・CLI/Skill 統合まで動作します。今後の候補(バックログ):

- Cloudflare Tunnel + Access による外部公開手順
- デスクトップ化(Tauri / Deno Desktop 再評価)
- グラフビュー(D3.js)
- 検索の SQLite FTS5 移行(大規模 vault 対応)
- 添付ファイル削除・リネームの CLI コマンド化

## 名前の由来

`Loamium` は loam(肥沃な土壌)由来の造語。「知識が育つ場」というメタファーが、ジャーナル・アウトライン・エージェント統合のすべてにかかっています。

## ライセンス

未定(現在は個人プロジェクトとして公開しています)。
