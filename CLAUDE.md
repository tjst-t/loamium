# Loamium

> ローカル Markdown を正本とする個人用ノートアプリ。アウトライナー編集(C 方式)とエージェント統合(REST API / CLI / Skill)を両立する。

## Tech Stack

TypeScript (strict), Node.js 22, npm workspaces モノレポ。
Backend: Hono / Frontend: React + CodeMirror 6 (lezer-markdown) / 検索: Fuse.js / テスト: Vitest / スキーマ検証: zod

## Commands

- `make serve` — API + UI 開発サーバーをまとめてバックグラウンド起動 (portman 管理。`.env` があれば自動読込)
- `make serve-ui` — UI 開発サーバーのみをバックグラウンド起動 (portman 管理)
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
- **エージェント操作ツール必須**: 新機能(REST エンドポイント・スマートフォルダ / コマンド / テンプレート等の主要機能)を追加するときは、エージェントがその機能を操作できるツールも必ず実装し、help 知識ベース(`packages/server/src/agent-help.ts`)に使い方(ツール名・入出力・使用例・制約)を追加する。エージェント統合を後付けにしない
  - ツールは既存の監査済みサービス層を経由する(ADR-0016)。REST と重複する独自の実行・解決・直列化ロジックを新設しない(二重管理の排除)。エージェント専用の直接ファイル操作・独自フォーマットは禁止(「ピュア Markdown 絶対」と整合)
  - 権限はケーパビリティで制御し(ADR-0015)、書き込み系ツールは書込モードでのみ広告する。機密領域は deny リストで一覧・書き込みから除外する(ADR-0018)
  - 使い方の詳細は base システムプロンプトへ移さず help トピックに置く(ADR-0014。常時=base / 詳細=help)。help はどの権限セットでも利用可能を維持する

## Server

- `make serve` はバックグラウンド起動 (portman がポートを管理)。再実行で前プロセスを自動 kill
- ポート番号をハードコードしない。CLI/テストは `portman lease --name loamium` で取得 (旧版 portman の `portman port` にも CLI はフォールバック対応)
- UI 開発サーバー (`make serve-ui`) は `/api` を `portman lease --name loamium` のポートへプロキシする (`LOAMIUM_API_URL` で上書き可)
- 開発用 vault: `dev-vault/` (git 管理外)

### 内蔵オフライン LLM / ネイティブ addon (ADR-0025 / S8a3f2e)

- `packages/server` は `node-llama-cpp` v3 (ESM, Node 22+) を依存に持つ。これは **ネイティブ addon** を含む。プレビルドバイナリを同梱するが、環境によってはソースビルド (llama.cpp を CMake でコンパイル) が走る。
- **ビルド注意 (dev VM / CI)**: プレビルドの実行が GLIBC/バインディング検証で失敗する環境がある。その場合は gcc-13 でソースビルドし直す:
  ```sh
  CC=/usr/bin/gcc-13 CXX=/usr/bin/g++-13 npx node-llama-cpp source download
  ```
  ビルド成果物は `node_modules/node-llama-cpp/llama/localBuilds` (git 管理外)。`getLlama()` は最新のローカルビルドを自動採用する。GPU (Metal/CUDA/Vulkan) があれば使い、無ければ CPU にフォールバックする (必須にしない)。
- **環境非依存の担保**: エンジン層 (`src/local-llm-engine.ts`) は `node-llama-cpp` を **動的 import (遅延ロード)** する。addon が無い / ロード不可でも server の起動・型チェック・他テストは壊れない。利用不可は握りつぶさず `LocalLlmUnavailableError` (明示エラー) で返す。ユニットテストはロード層 (`EngineLoader`) を決定的スタブに差し替えて検証する (小型 GGUF を用意しない)。
- **攻撃面 (CI/セキュリティ注意点)**: node-llama-cpp の再導入で、ADR-0011 が node-pty 撤去で減らしたネイティブ依存・攻撃面が部分的に戻る (ADR-0025 consequences)。OS 別プレビルド配布・CI・Tauri 同梱の手当てが必要。CI ではネイティブビルド失敗が workspace 全体の lint/test を壊さないこと (遅延ロード設計で担保) を維持する。
- **モデル置き場 (種別サブフォルダ)**: `src/model-paths.ts` に一元化。`.loamium/models/llm/` (LLM GGUF) と `.loamium/models/asr/` (音声認識・将来 Whisper 用) に分ける。`.loamium/*` は .gitignore 済み・models/ は再包含なし = 「消しても vault は無傷」の使い捨て資産。ディレクトリは初回アクセス時に作成する。

## References

- Architecture & system design: `docs/ARCHITECTURE.md`
- Architecture Decision Records (ADR): `docs/DESIGN/adr/`(例: エージェント統合は ADR-0014 help / ADR-0015 ケーパビリティ / ADR-0016 監査済みサービス層経由 / ADR-0018 機密領域 deny)
- Sprint roadmap & task tracking: `docs/ROADMAP.json`
- Product vision: `docs/VISION.json`
- Design principles (autonomous decision rules): `docs/DESIGN_PRINCIPLES.json`
- Original spec / 引き継ぎ: `SPEC.md`
