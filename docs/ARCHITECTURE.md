# Architecture: Loamium

## Overview

Loamium はローカルの `.md` ファイル群(vault)を正本とする個人用ノートアプリ。Hono 製 REST API がファイルシステムとインメモリインデックス(バックリンク・全文検索・タグ)を管理し、React + CodeMirror 6 の UI と Node.js 製 CLI(`loamium`)が同じ API を叩く。エージェント(Claude Code)は CLI / Skill 経由でノートを読み書きする。

## Components

### Server (REST API + インデックス)

- **Responsibility**: vault の読み書き、ファイル監視、インメモリインデックス(バックリンク / 全文検索 / タグ)、デイリージャーナル管理、監査ログ、権限モード
- **Location**: `packages/server`
- **Key interfaces**: `GET/PUT/DELETE /api/notes/*path`, `POST /api/notes/*path/append`, `POST /api/notes/*path/patch`, `GET /api/journal`(自動生成), `POST /api/journal/append`, `GET /api/health`(実装済 — Sd63ad1)/ `GET /api/search`, `GET /api/backlinks`, `GET /api/notes`(一覧・tag/folder フィルタ), `GET /api/tags`(実装済 — S31ba00)/ `POST /api/notes/*path/rename`(リネーム + vault 全体の [[旧名]] 追従書き換え。実装済 — S6fbf45: compute-then-apply で書き換えを全計算してから適用、移動先既存は 409、解決先が旧パスのリンクのみ書き換え・コードフェンス内不変、監査ログ `note.rename`、インデックス即時追従)/ `POST /api/render/:lang`(将来)
- **Depends on**: shared(型・パスユーティリティ・Markdown パーサー)、chokidar(監視)、Fuse.js(検索)

### Shared (共有ライブラリ)

- **Responsibility**: API の zod スキーマと型、vault 相対パスの正規化(NFC、`..` 脱出検証)、Markdown パース(frontmatter / [[WikiLink]] / #tag / リスト行判定)、ジャーナル日付処理
- **Location**: `packages/shared`
- **Key interfaces**: `normalizeVaultPath()`, `parseNote()`(frontmatter 抽出), `extractTags()` / `extractLinks()`(コードフェンス除外・NFC), `resolveLinkTarget()`(#heading・拡張子省略・NFC/NFD・フォルダ横断解決), `rewriteLinks()`(リネーム追従の [[リンク]] ターゲット書き換え — heading/alias/embed 保存・フェンス/インラインコード/frontmatter 不変。S6fbf45), `preferredLinkTarget()`(最短一意リンク表記 — rename 書き換え先とオートコンプリート挿入の共通ロジック。S6fbf45), `journalPath(date)`, API schema 群

### CLI (`loamium`) (実装済 — S0c9a48)

- **Responsibility**: REST API の薄いラッパー。エンドポイントと 1:1 のサブコマンド(read / write / append / patch / rename / search / backlinks / journal / journal-append / list / tags — rename は S6fbf45 で追加)。全コマンド `--json` で生 JSON 出力。成功 = exit 0 + stdout、失敗 = 非 0 + stderr に 1 行 JSON `{"error","message"}`(exit 1 = API/接続、exit 2 = 使い方)
- **Location**: `packages/cli`(bin は `bin/loamium.js` — tsx ランタイム登録で TS ソースを直接実行、ビルド不要)
- **Depends on**: Server(HTTP 経由)、shared(zod スキーマ・パス正規化)。サーバー URL は `LOAMIUM_URL` → portman (`portman port --name loamium`、無ければ `portman lease --name loamium`) → `http://127.0.0.1:3000` の順で解決

### UI (基盤 Sa704c3 + エディタ体験 S9ab6c3 + リンク機構 S6fbf45 実装済 — MVP スコープ完了)

- **Responsibility**: ファイルツリー、CodeMirror 6 エディタ(ライブプレビュー、リスト行限定のアウトライン操作)、[[リンク]] オートコンプリート、バックリンクパネル、デイリージャーナル
- **Location**: `packages/ui`(Vite + React 19 + CodeMirror 6)
- **実装済 (Sa704c3)**: 3 ペインレイアウト(ツリー / エディタ / バックリンクパネルのシェル)、Markdown ソース編集・Cmd/Ctrl+S + デバウンス自動保存、mtime 楽観的競合検出の警告ダイアログ、ツリーからの新規・リネーム・削除、起動時に今日のジャーナルへ着地 + 日付ナビゲーション。data-testid は `prototype/TESTIDS.md` の契約に従う
- **実装済 (S9ab6c3)**: C 方式のアウトライン操作(`src/outline.ts` — lezer ListItem 判定の Tab/Shift+Tab サブツリーインデント・fold-toggle ガター + fold-pill・task-checkbox クリックトグル。インデント単位 4 スペース、直前兄弟項目がある行のみ indent 可)と、ライブプレビュー(`src/live-preview.ts` — カーソル行はソース、他行は装飾。ブロック装飾は StateField、行内装飾は ViewPlugin)。装飾はすべて表示層のみでファイルはピュア Markdown のまま
- **Key interfaces**: fence / inline / block の 3 レンダラーレジストリ(`src/registries.ts`)。S9ab6c3 で結線済 — ビルトインは `src/renderers/`(mermaid=fence/replace、KaTeX=$…$ inline + $$…$$ block、Shiki=fence/replace で約 30 言語)。すべて npm バンドル同梱(CDN なし、オフライン動作)、mermaid/shiki は dynamic import。新レンダラーは `registerFenceRenderer` / `registerInlineRule` / `registerBlockRule` の登録だけで追加できる。開発時は Vite が `/api` を実サーバーへプロキシ(`LOAMIUM_API_URL` または portman)
- **実装済 (S6fbf45)**: リンク機構(`src/wikilink.ts` — [[ トリガーの CodeMirror autocompletion。部分一致絞り込み・最短一意表記の挿入・「新規ノートを作成してリンク」。`wikilinkEnvFacet` で App のノート一覧/ナビゲーション/作成を注入)。live-preview の [[リンク]] は shared `resolveLinkTarget` で解決され、解決済みはクリック(または Cmd/Ctrl+クリック)で遷移、未解決は赤+破線の壊れリンク表示でクリックすると新規作成(非 .md ターゲットは拒否)。バックリンクパネルは GET /api/backlinks の実データ(参照元+コンテキスト行、クリックで参照元へ、ノート切替・保存で再取得)。ツリーのリネームは POST /rename API に接続し、ダイアログに「[[リンク]] N 件を自動更新」を表示、開いているバッファが書き換え対象なら再読込する
- **テスト**: Playwright 二層(`tests/e2e/*.mock.spec.ts` は page.route モック、`*.e2e.spec.ts` は一時 vault + 実サーバー。ハーネスは `tests/harness/`)
- **Depends on**: Server(REST API)、shared(zod スキーマ・ジャーナル日付ユーティリティ)

### Skill (claude-skills 形式) (実装済 — S0c9a48)

- **Responsibility**: 自然言語 → `loamium` CLI 変換の例とエラーハンドリングを丁寧に記述。journal-append と search が最重要
- **Location**: `skill/`(`skill/SKILL.md`。構造・実 CLI とのコマンド整合は `tests/acceptance/skill.spec.ts` で検証)

## Data Flow

### 書き込みフロー (UI / CLI / エージェント共通)

client → REST API → パス正規化・権限チェック → ファイル書き込み(UTF-8/LF) → 監査ログ追記 → インデックス即時更新。外部編集(エディタ・Git)は chokidar が検知してインデックス再構築。競合は last-write-wins + mtime による楽観的検出 (実装済 — Sa704c3: GET/PUT レスポンスが `mtime` を返し、PUT に `baseMtime` を添えると不一致時に 409 conflict。UI は警告ダイアログで上書き / 再読込を選ばせる。エージェント/CLI は従来どおり無条件書き込み)。

### インデックスライフサイクル (実装済 — S31ba00)

起動時に vault 全走査で構築 (`VaultIndex.build`) → 書き込み API 成功時は監査コンテキストをフックに該当ファイルのみ即時再読込 (`indexSyncMiddleware`) → API 外の変更は chokidar が検知して差分更新 (`watcher.ts`、`.loamium/` 等ドット始まりは除外)。インデックスは Map + Fuse.js のインメモリのみ (消しても安全、ファイルが常に正)。ディスクキャッシュは未導入 (必要になったら `.loamium/` 配下に追加)。

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
