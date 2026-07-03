# Loamium

> ローカル Markdown を正本とする個人用ノートアプリ。アウトライナー編集(C 方式)とエージェント統合(REST API / CLI / Skill)を両立する。

## Tech Stack

TypeScript (strict), Node.js 20, npm workspaces モノレポ。
Backend: Hono / Frontend: React + CodeMirror 6 (lezer-markdown) / 検索: Fuse.js / テスト: Vitest / スキーマ検証: zod

## Commands

- `make serve` — API サーバーをバックグラウンド起動 (portman 管理)
- `make serve-ui` — UI 開発サーバーをバックグラウンド起動 (portman 管理)
- `make stop` — サーバー停止
- `make test` — 全 workspace のテスト実行 (JUnit XML を `reports/` に出力)
- `make test-ui` — UI の Playwright テスト (mock + e2e。実サーバー/Vite はハーネスが一時 vault で自動起動)
- `make build` — 全 workspace のビルド
- `make lint` — 型チェック + lint

## Development Rules

- **ピュア Markdown 絶対**: ブロック ID・独自記法をファイルに書き込むコードは書かない。正本は常に Markdown 文字列 1 本(ブロック配列にしない)
- TypeScript strict。`any` 禁止(`unknown` + 絞り込み)。`@ts-ignore` 禁止
- 文字コード UTF-8 / 改行 LF 固定。リンク・パス比較は NFC 正規化を通す
- vault 内パスは必ず `packages/shared` のパス正規化ユーティリティを経由(`..` 脱出の検証込み)
- REST API と CLI コマンドは 1:1 対応。リクエスト/レスポンスは zod スキーマで検証し、型は `packages/shared` で共有
- Markdown パース・リンク解決・ジャーナル日付処理には必ずユニットテストを書く
- 書き込み系 API は監査ログ(`.loamium/audit.log`)に記録する

## Server

- `make serve` はバックグラウンド起動 (portman がポートを管理)。再実行で前プロセスを自動 kill
- ポート番号をハードコードしない。CLI/テストは `portman lease --name loamium` で取得 (旧版 portman の `portman port` にも CLI はフォールバック対応)
- UI 開発サーバー (`make serve-ui`) は `/api` を `portman lease --name loamium` のポートへプロキシする (`LOAMIUM_API_URL` で上書き可)
- 開発用 vault: `dev-vault/` (git 管理外)

## References

- Architecture & system design: `docs/ARCHITECTURE.md`
- Sprint roadmap & task tracking: `docs/ROADMAP.json`
- Product vision: `docs/VISION.json`
- Design principles (autonomous decision rules): `docs/DESIGN_PRINCIPLES.json`
- Original spec / 引き継ぎ: `SPEC.md`
