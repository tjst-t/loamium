# Loamium (rebuild)

> ローカル Markdown を正本とする個人用ノートアプリ。**cordis** ベースのプラグイン型サーバーと **ProseMirror** ベースの WYSIWYG エディタで作り直す。

**⚠️ このブランチにはまだ実装がありません。** `rebuild` は orphan ブランチで、`docs/` と本ファイルだけを持って始まっています。旧実装 (TS/TSX 約 79k 行) は `main` に無傷で残っており、いつでも参照・移植できます:

```sh
git show main:packages/server/src/index.ts     # 旧実装を読む
git grep -n 'ensureDir' main -- packages/      # 旧ツリーを横断検索
git checkout main -- <path>                    # 必要なものだけ引く
```

## 2 つの不変条件 (最優先)

旧 `CLAUDE.md` の「ピュア Markdown 絶対」は 3 つの主張を束ねていた。作り直しでは **(a) を死守し、(c) を捨て、代わりに round-trip 保存性を昇格**する。

1. **標準 Markdown ファイルが正本。** ブロック ID・独自記法をファイルに書き込まない。Obsidian や素のエディタで開いても壊れない (VISION の `problem` 文そのもの = プロダクトの存在理由)
2. **round-trip 差分ゼロ。** `parse → serialize` がバイト単位で一致する。git sync と 3-way merge があるため、1 文字打っただけでリストマーカーや表の桁が正規化されると diff が爆発し merge が壊れる

**採らない方式:**
- **行単位 Raw 表示 (旧 live preview)** — VISION に要求が無く ADR も存在しなかった、Logseq からの無検証の輸入。Logseq でこれが成立するのはブロックが原子的で短いからで、Loamium はそのブロックモデルを VISION で明確に拒否している。前提を捨てたのにインタラクションだけ輸入していた
- **メモリ上の正本を Markdown 文字列 1 本に固定すること** — CodeMirror が強いた実装都合であり、(a) さえ守れば不要

> **最初のタスク:** 既存 vault の全 `.md` を parse→serialize してバイト差分ゼロを CI で gate する。ここが通らなければ ProseMirror 案は成立しない、という判定ライン。

## Tech Stack

TypeScript (strict), Node.js 22, npm workspaces モノレポ。

| 領域 | 採用 |
|---|---|
| サーバー | Hono + **cordis** (AOP / DI / プラグイン) |
| エディタ | **ProseMirror 系** (Tiptap / Milkdown) |
| Markdown | **unified / remark に一本化** (旧実装の `marked` × lezer-markdown の二重パーサを解消。shared でサーバーと共有) |
| サーバー状態 | TanStack Query |
| クライアント状態 | Zustand または Jotai |
| UI プリミティブ | Radix UI または Base UI (ヘッドレス) |
| スタイル | Tailwind v4 (旧 `styles.css` 7,576 行 / 674 クラスは**移植しない**) |
| コマンドパレット | cmdk |
| フォーム | react-hook-form + zod |
| テーブル | TanStack Table |
| アイコン | lucide-react (inline SVG を手書きしない) |
| テスト | Vitest + Playwright |

## Development Rules

### cordis / サーバー

- **本番ビルドはプラグインを静的登録する。`@cordisjs/loader` と HMR は dev 専用。**
  最大の地雷。パッケージ版サーバーは `bun --compile` の単一実行ファイルで、cordis の設定駆動な動的 `import()` は静的解決できず必ず壊れる。後から分離するのは極めて痛いので、最初から分ける
- **1 機能 = 1 プラグイン。** REST ルート・エージェントツール・help トピック・ケーパビリティ宣言を**同じプラグイン内で同時に登録**する。これにより「新機能にはエージェントツールも必ず実装」が規約(人間の努力)ではなく構造で担保される
- **サービスは `ctx` 経由で取得する。** 位置引数 DI (`createApp(config, index, dqlCache?, sse?, sync?)`) と手書きシングルトン (`getSyncService()`) を再発明しない
- **イベントは `ctx.on()`。** リスナー 1 本しか持てないコールバックスロット (旧 `index.setOnChange`) を作らない。旧実装ではそこに無関係な 4 つの関心事が詰まり、1 つ throw すると後続が全部死んでいた
- **teardown は各プラグインの `ctx.effect()` が返す disposable。** 手書きの逆順 shutdown チェーンを書かない。`ctx.fiber.dispose()` が登録順の逆で自動的に畳む (検証済み)
- 生成順序を「TDZ 回避」のようなコメントで守らない。`inject` で宣言する

#### cordis 4 固有の落とし穴 (spike で実地確認済み / 2026-08-21)

採用バージョンは **`cordis@4.0.0-rc.8`**。npm の `latest` タグが RC を指している (stable の最終は `3.18.1`)。**RC なので必ず完全一致でピンする。**

- **Service で `#private` フィールドを使わない。** cordis は Service を Proxy 経由で公開するため、`ctx.foo.bar` の内部で `this` が Proxy になり `TypeError: Cannot access invalid private field` で落ちる。TS の `private` (コンパイル時のみ・実体は通常プロパティ) を使う
- **プラグイン関数に `.name` を代入しない。** `Function.name` は readonly で、ESM は strict mode なので `TypeError: Attempted to assign to readonly property`。関数宣言の名前がそのまま使われるので代入は不要。`.inject` の代入は問題ない
- **ロガーは exporter を登録するまで完全に無音。** cordis 4 の `LoggerService` に既定の出力先は無い。`ctx.logger.exporter({ export(msg) {...} })` を最初のプラグインとして登録する (`plugins/logging.ts`)
- **teardown の逆順実行は自前で書かなくてよい。** 登録順 `logging → vault → noteIndex → sse → sync → http` に対し、`ctx.fiber.dispose()` が `sync → sse → ...` の逆順で effect を畳むことを実測で確認済み

### エディタ

- **ソースモードのトグルは一級市民。** 外部エディタ・git・エージェントが同じファイルを直接触る以上、必須。文書単位で切り替える (行単位ではない)
- **`Escape` / `Mod+Enter` でノードを抜ける挙動を最初から作り込む。** リストやコードブロックから抜けられない・書式が引きずられるのは ProseMirror 系の古典的な不満で、Markdown ネイティブなユーザーほど強く効く。後入れは苦しいので**最初のスプリントの受け入れ条件に含める**
- **ProseMirror スキーマには「Markdown に往復変換できるもの」だけを入れる。** スキーマが Markdown 表現力の型になり、不変条件 2 の実装手段になる。Confluence 的なパネル・バッジ・複雑レイアウトは標準 Markdown に落ちないので採用しない
- **Markdown ショートカット入力 (input rules) は維持する。** `# ` で見出し、`- ` でリスト、`**bold**`。打鍵は Markdown のまま、結果だけリッチになる
- リストの Tab / Shift+Tab インデント (VISION の C 方式) は `sinkListItem` / `liftListItem` の標準機能を使う。旧 `outline.ts` 1,670 行を再実装しない
- frontmatter は doc の中に押し込まず、**エディタ外のプロパティパネル**に出す (VISION: frontmatter はデータモデルの第一級市民)
- DQL / dataview 等の動的ブロックは NodeView で描き、**Markdown へはコードフェンス (` ```dataview `) として落とす**。Obsidian 互換の既存慣行に乗る (独自記法禁止と整合)
- 共同編集はしない (VISION `out_of_scope`)。ProseMirror の collab モジュールは使わない

### 共通

- TypeScript strict。`any` 禁止 (`unknown` + 絞り込み)。`@ts-ignore` 禁止
- 文字コード UTF-8 / 改行 LF 固定。リンク・パス比較は NFC 正規化を通す
- vault 内パスは必ず `packages/shared` のパス正規化ユーティリティを経由 (`..` 脱出の検証込み)
- REST API と CLI コマンドは 1:1 対応。リクエスト/レスポンスは zod スキーマで検証し、型は `packages/shared` で共有
- Markdown パース・リンク解決・ジャーナル日付処理・**round-trip 保存性**には必ずユニットテストを書く
- 書き込み系 API は監査ログ (`.loamium/audit.log`) に記録する
- **生のファイル API 禁止 / 書き込み配線は共通ヘルパー経由**: サーバーの書き込みで `fs.mkdir(recursive)` を直接呼ばない。必ず共通の `ensureDir()` を経由する。理由: `bun --compile` 済みサーバーは **bun on Windows** で既存ディレクトリへの `mkdir(recursive)` が **EEXIST を投げる** (Node/tsx・bun-linux では再現しない)。OneDrive 配下 vault で顕在化する。新規サーバーコードを足したら `grep 'mkdir(' <新規ファイル>` で確認する
- **モバイルレスポンシブ規約**: すべての UI 機能はモバイル考慮。タップターゲット 44px 以上。ブレークポイント: ≤680px = モバイル / 681–960px = タブレット / ≥961px = デスクトップ。
  なお WYSIWYG 化により、旧 VISION が `out_of_scope` としていた「モバイルでの本格的な編集体験」は射程に入る (生 Markdown をモバイルで触らせるより明確に有利)。扱いを見直す余地がある
- **エージェント操作ツール必須**: 新機能には必ずエージェント用ツールも実装し、help 知識ベースに使い方を追加する。ツールは監査済みサービス層を経由する (ADR-0016)。権限はケーパビリティで制御し (ADR-0015)、機密領域は deny リストで除外する (ADR-0018)。使い方の詳細は base プロンプトでなく help トピックへ (ADR-0014)
- **機能ガイド更新義務**: 新機能追加・仕様変更時は、対応するガイド Markdown (`機能ガイド/`) を追加・更新する。ピュア Markdown で書き、`loamium init-samples` で取得できる形に保つ

## Commands

**未整備。** 新しい Makefile はまだ無い。旧版のターゲット構成 (`make serve` / `serve-ui` / `stop` / `test` / `test-ui` / `build` / `lint`) を踏襲する予定。

- ポート番号をハードコードしない。`portman lease --name loamium` で取得する
- 開発用 vault: `dev-vault/` (git 管理外)。**現状このチェックアウトには存在しないので、作り直す必要がある**

## 着手順

1. ~~**cordis で `vault → index → SSE → sync` の 4 プラグインを白紙で組み、`bun --compile` を通す**~~ — **✅ 2026-08-21 完了。地雷は不発。**
   `cordis@4.0.0-rc.8` + Hono が `bun build --compile` で 79MB の単一実行ファイルになり、`node_modules` の無い場所で起動・API 応答・日本語ファイル名・ネストディレクトリ書き込み・SIGTERM での正常終了まで確認済み。**静的登録である限り問題ない**という前提が裏付けられた
2. **round-trip 差分ゼロの CI gate** ← 次はここ
3. エディタ本体

## References

- Architecture Decision Records (ADR): `docs/DESIGN/adr/` — **34 本すべて有効な資産**。エージェント統合 (ADR-0014/0015/0016/0018)、sync (ADR-0030/0032)、スマートコマンド (ADR-0020〜0024) 等
- Product vision: `docs/VISION.json`
- Design principles: `docs/DESIGN_PRINCIPLES.json`
- 旧実装: `git show main:<path>` / `git grep <pattern> main -- packages/`

### 陳腐化しているので要書き換え

- `docs/ARCHITECTURE.md` — 旧構成 (CodeMirror / 手書き DI) 前提。cordis + ProseMirror で書き直す
- `docs/ROADMAP.v1-archive.json` — 旧実装の完了スプリント記録。**アクティブなロードマップではない** (`sprint init` で新規に引き直す)
- `docs/sprint-logs/` — 旧実装の履歴。参照用に残す
- 新プロジェクトの **ADR-0001 は「Markdown 正本の不変条件を (a) 標準 Markdown + round-trip 保存性 に再定義し、行単位 Raw 表示を採らない」**を書くこと。旧リポジトリではこの最重要判断だけが ADR 化されていなかった
