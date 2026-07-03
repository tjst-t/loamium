# Architecture: Loamium

## Overview

Loamium はローカルの `.md` ファイル群(vault)を正本とする個人用ノートアプリ。Hono 製 REST API がファイルシステムとインメモリインデックス(バックリンク・全文検索・タグ)を管理し、React + CodeMirror 6 の UI と Node.js 製 CLI(`loamium`)が同じ API を叩く。エージェント(Claude Code)は CLI / Skill 経由でノートを読み書きする。

## Components

### Server (REST API + インデックス)

- **Responsibility**: vault の読み書き、ファイル監視、インメモリインデックス(バックリンク / 全文検索 / タグ)、デイリージャーナル管理、監査ログ、権限モード
- **Location**: `packages/server`
- **Key interfaces**: `GET/PUT /api/notes/*path`, `POST /api/notes/*path/append`, `POST /api/notes/*path/patch`, `GET /api/search`, `GET /api/backlinks`, `GET/POST /api/journal`, `GET /api/notes`(一覧), `GET /api/tags`, `POST /api/render/:lang`(将来)
- **Depends on**: shared(型・パスユーティリティ・Markdown パーサー)、chokidar(監視)、Fuse.js(検索)

### Shared (共有ライブラリ)

- **Responsibility**: API の zod スキーマと型、vault 相対パスの正規化(NFC、`..` 脱出検証)、Markdown パース(frontmatter / [[WikiLink]] / #tag / リスト行判定)、ジャーナル日付処理
- **Location**: `packages/shared`
- **Key interfaces**: `normalizeVaultPath()`, `parseNote()`(frontmatter + links + tags 抽出), `journalPath(date)`, API schema 群

### CLI (`loamium`)

- **Responsibility**: REST API の薄いラッパー。エンドポイントと 1:1 のサブコマンド(read / write / append / patch / search / backlinks / journal / journal-append / list / tags)
- **Location**: `packages/cli`
- **Depends on**: Server(HTTP 経由)、shared(型)。サーバーの URL は `LOAMIUM_URL` または portman から解決

### UI

- **Responsibility**: ファイルツリー、CodeMirror 6 エディタ(ライブプレビュー、リスト行限定のアウトライン操作)、[[リンク]] オートコンプリート、バックリンクパネル、デイリージャーナル
- **Location**: `packages/ui`
- **Key interfaces**: fence / inline / block の 3 レンダラーレジストリ(Mermaid / KaTeX / Shiki を最初に実証)
- **Depends on**: Server(REST API)

### Skill (claude-skills 形式)

- **Responsibility**: 自然言語 → `loamium` CLI 変換の例とエラーハンドリングを丁寧に記述。journal-append と search が最重要
- **Location**: `skill/`

## Data Flow

### 書き込みフロー (UI / CLI / エージェント共通)

client → REST API → パス正規化・権限チェック → ファイル書き込み(UTF-8/LF) → 監査ログ追記 → インデックス即時更新。外部編集(エディタ・Git)は chokidar が検知してインデックス再構築。競合は last-write-wins + mtime による楽観的検出。

### インデックスライフサイクル

起動時に vault 全走査で構築 → chokidar で差分更新 → `.loamium/` にキャッシュ(消しても安全、ファイルが常に正)。

## Directory Structure

```
loamium/
├── packages/
│   ├── shared/    # 型・zodスキーマ・パス/Markdown/日付ユーティリティ
│   ├── server/    # Hono REST API + インデックス + ファイル監視
│   ├── cli/       # loamium CLI (APIの薄いラッパー)
│   └── ui/        # React + CodeMirror 6
├── skill/         # claude-skills 形式の Skill 定義
├── dev-vault/     # 開発用 vault (git管理外)
└── docs/          # ドキュメント・ROADMAP
```

## Infrastructure

- **Storage**: ファイルシステムの `.md` のみが正本。vault = Git リポジトリ前提。`.loamium/`(キャッシュ・監査ログ)は .gitignore
- **外部公開**: Cloudflare Tunnel + Access(認証は Access に委譲、ローカルは無認証)
- **将来**: `POST /render/:lang` の server 種別レンダラー(PlantUML 等は Docker 同梱)、Tauri デスクトップ化、node-pty + xterm.js の Claude Code タブ

## Related Documents

- `SPEC.md` — 元の引き継ぎドキュメント(設計判断の経緯・拡張アーキテクチャ・未決事項の全リスト)
- `docs/VISION.json` — プロダクトビジョン(自律実行の判断基準)
- `docs/DESIGN_PRINCIPLES.json` — 設計原則(優先順位ルール・禁止事項)
