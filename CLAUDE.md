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
2. **round-trip 保存性。** git sync と 3-way merge があるため、1 文字打っただけでリストマーカーや表の桁が正規化されると diff が爆発し merge が壊れる。**実測の結果、判定は 3 段階に分ける** (`make roundtrip` / `scripts/roundtrip-check.ts`):

   | | 内容 | 状態 |
   |---|---|---|
   | **A** | 原文バイト一致 (任意の Markdown をそのまま保存) | 42.3% — **報告のみ。gate しない** |
   | **B** | 冪等性 (一度正規化した後は二度と変化しない) | **100% — hard gate** |
   | **C** | 意味の保存 (正規化で mdast が変化しない) | **100% — hard gate** |

   A を 100% にするのは高コストで、**B と C が通っていれば git sync は壊れない** (vault を一度 `fmt` すれば、以後 1 文字編集の diff は 1 行で済む)。初回の正規化コミットだけが大きくなる。

   **さらに D. 書き手の収束を課す (hard gate)。** ファイルへ書き戻す経路はエディタ (Milkdown の serializer) とサーバー/CLI (`packages/shared`) の 2 つあり、**両者の serializer は別物**なので素のままだと正規形が食い違う。片方が保存 → もう片方が書き直す、で git の diff が永久に振動する。実測で一致は 46.2% しかなかった。

   > **書き戻しは必ず `normalizeForSave()` を通すこと。** これが唯一の正規形の出口。エディタの保存経路もサーバーの書き込みもここに一本化する。Milkdown が空セル・空リスト項目に差し込む `<br />` の除去もここで行う (書式でなく**内容の混入**なので不変条件 1 に関わる)。

   gate は 2 本立て: `make roundtrip` (shared 単体) と `make test` (Milkdown 実体 + 収束、jsdom)。**`make gate` で lint 込みの全部**を回す (CI: `.github/workflows/gate.yml`)

**採らない方式:**
- **行単位 Raw 表示 (旧 live preview)** — VISION に要求が無く ADR も存在しなかった、Logseq からの無検証の輸入。Logseq でこれが成立するのはブロックが原子的で短いからで、Loamium はそのブロックモデルを VISION で明確に拒否している。前提を捨てたのにインタラクションだけ輸入していた
- **メモリ上の正本を Markdown 文字列 1 本に固定すること** — CodeMirror が強いた実装都合であり、(a) さえ守れば不要

> **判定結果 (2026-08-21):** ✅ 成立する。`unified` / `remark` で B・C ともに 26/26。
> **A が崩れる残り 4 カテゴリ** (対処は任意・優先度順): テーブル区切り行の幅 (`| --- |` → `| - |`) 16 行 / CJK 隣接の強調のエスケープ 10 行 / ネストリストのインデント幅 2 行 / その他 2 行。
>
> ⚠️ **エスケープを一律で無効化してはいけない。** `[[WikiLink]]` と callout `> [!tip]` を通すために `text` ハンドラでエスケープを切ったところ、**表セル内の `\|` まで剥がれて再パース時に列区切りと解釈され、2 列の表が 4 列に化けた**。`\[` のみ選択的に復元すること。この破壊を検出したのが判定 C で、gate の有効性そのものの裏付けになっている。
>
> ⚠️ **CJK に隣接する `**強調**` は CommonMark の flanking 規則で強調と解釈されないことがある。** 旧実装の `marked` より remark のほうが厳格なので、**既存ノートの見え方が変わる箇所がある**。移行時に要確認。

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
| スタイル | 手書きの CSS トークン 1 ファイル (`packages/ui/src/styles.css`)。Tailwind は入れていない — 設計は `docs/DESIGN/ui-design-system.md` |
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
- **1 機能 = 1 フォルダ (`packages/features/<機能名>/`)。フロントとバックにまたがる機能を 1 か所にまとめる。**
  `contract.ts` (両側で共有する型と REST パス / React も Node も含めない) / `server.ts` (`defineFeature`) / `ui.tsx` (`defineUiFeature`)。
  登録は `packages/server/src/app.ts` と `packages/ui/src/features.ts` の 2 行だけ。**機能を捨てるならフォルダごと消して 2 行消す。**
  ⚠️ `server.ts` と `ui.tsx` を同じ barrel から再エクスポートしないこと (UI のバンドルに Node 依存を引き込む)
- **サービスは `ctx` 経由で取得する。** 位置引数 DI (`createApp(config, index, dqlCache?, sse?, sync?)`) と手書きシングルトン (`getSyncService()`) を再発明しない
- **イベントは `ctx.on()`。** リスナー 1 本しか持てないコールバックスロット (旧 `index.setOnChange`) を作らない。旧実装ではそこに無関係な 4 つの関心事が詰まり、1 つ throw すると後続が全部死んでいた
- **teardown は各プラグインの `ctx.effect()` が返す disposable。** 手書きの逆順 shutdown チェーンを書かない。`ctx.fiber.dispose()` が登録順の逆で自動的に畳む (検証済み)
- 生成順序を「TDZ 回避」のようなコメントで守らない。`inject` で宣言する

#### cordis 4 固有の落とし穴 (spike で実地確認済み / 2026-08-21)

採用バージョンは **`cordis@4.0.0-rc.8`**。npm の `latest` タグが RC を指している (stable の最終は `3.18.1`)。**RC なので必ず完全一致でピンする。**

- **Service で `#private` フィールドを使わない。** cordis は Service を Proxy 経由で公開するため、`ctx.foo.bar` の内部で `this` が Proxy になり `TypeError: Cannot access invalid private field` で落ちる。TS の `private` (コンパイル時のみ・実体は通常プロパティ) を使う
- **プラグイン関数に `.name` を代入しない。** `Function.name` は readonly で、ESM は strict mode なので `TypeError: Attempted to assign to readonly property`。関数宣言の名前がそのまま使われるので代入は不要。`.inject` の代入は問題ない
- **ロガーは exporter を登録するまで完全に無音。** cordis 4 の `LoggerService` に既定の出力先は無い。`ctx.logger.exporter({ export(msg) {...} })` を最初のプラグインとして登録する (`plugins/logging.ts`)
- **`await ctx.plugin(...)` は async effect の解決までは待たない (実測)。** 初期化の完了を呼び出し側が待つ必要がある場合は、サービスに `ready: Promise<void>` を持たせ、`ctx.inject([...], c => c.svc.ready.then(...))` で「サービスの生成」と「初期化の完了」の両方を待つこと。`noteIndex` がこの形
- **teardown の逆順実行は自前で書かなくてよい。** 登録順 `logging → vault → noteIndex → sse → sync → http` に対し、`ctx.fiber.dispose()` が `sync → sse → ...` の逆順で effect を畳むことを実測で確認済み

### UI (機能レジストリ)

- **UI 側も 1 機能 = 1 プラグイン。** `defineUiFeature` で「エディタ拡張 / 情報パネルの節 / 画面 / サイドバーの入口 / 重ねるもの (パレット) / コマンド」を宣言し、`packages/ui/src/features.ts` が静的に登録する。`App.tsx` はスロットを描くシェルに徹する (props のバケツリレーを増やさない)。登録順がサイドバーの並び順
- **キーバインドは機能が `commands` で宣言する。** シェルは `Mod+k` のような表記を照合して張るだけで、何のキーかを知らない。ESC の blur だけはどの機能にも属さないのでシェルが持つ
- **機能の内部状態はシェルに持たせない。** パレットの開閉のような状態は機能フォルダの中に閉じる (`useSyncExternalStore` で購読する小さなストアで足りる)
- **`requires` にサーバー機能名を書く。** `GET /api/features` に無ければ UI 側も丸ごと無効になる。
  `app.ts` から `ctx.plugin(tagsFeature)` を消せば、**UI をリロードするだけで**タグ関連の UI が消える (UI のコードは触らない)
- **Milkdown プラグインの順序は型で持つ** (`order: 'before-preset' | 'after-preset'`)。`[[` / `#` の補完は Enter / Tab をリストのコマンドより先に拾う必要があり、コメントでは守れない。
  並びの出所は `features.ts` の 1 か所だけ。**`Editor.tsx` と `milkdown-transform.ts` で手で揃えない** (以前は 2 箇所同期で、足し忘れると本番とテストの構成がずれる状態だった)
- **見た目の規則は `docs/DESIGN/ui-design-system.md` に従う。** 要点: ディスク上の文字列 (パス・ファイル名・タグ・行番号・コード) は等幅、アプリの言葉は比例フォント / 色は信号 (アクセント = いまここ、フラグ = 直すべきもの) / 派手さは地層レール 1 か所だけ
- **UI に cordis は入れない。** 実測でブラウザでも動き React とも 5 行で繋がる (`useSyncExternalStore`) が、フロントで欲しいのは「機能を束ねる器」だけで、それは型と配列で足りる (+15KB を払う理由が今は無い)。実行時の着脱やサードパーティ拡張が必要になったら、レジストリを `defineFeature` に置き換えて移行する
- **UI 機能の動的ロード (vault から JS) は採らない。** 任意コード実行なので ADR とセットの判断になる

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
- **vault 内パスは必ず `packages/shared` の `resolveVaultPath()` / `normalizeVaultPath()` を経由する** (`..` 脱出の検証込み)。
  ⚠️ **ルーティング層の正規化に依存しないこと。** Hono は生の `../` を含む URL は 404 にするが、**URL エンコードした `%2e%2e%2f` はデコードされてハンドラに届く**。実際にこれで vault 外のファイルを読み書きできる状態になっていた (2026-08-21 に修正)。検証は必ずサービス層で行う
- REST API と CLI コマンドは 1:1 対応。リクエスト/レスポンスは zod スキーマで検証し、型は `packages/shared` で共有
- Markdown パース・リンク解決・ジャーナル日付処理・**round-trip 保存性**には必ずユニットテストを書く
- 書き込み系 API は監査ログ (`.loamium/audit.log`) に記録する。監査の失敗で書き込み自体を落とさない
- **生のファイル API 禁止 / 書き込み配線は共通ヘルパー経由**: サーバーの書き込みで `fs.mkdir(recursive)` を直接呼ばない。必ず共通の `ensureDir()` を経由する。理由: `bun --compile` 済みサーバーは **bun on Windows** で既存ディレクトリへの `mkdir(recursive)` が **EEXIST を投げる** (Node/tsx・bun-linux では再現しない)。OneDrive 配下 vault で顕在化する。新規サーバーコードを足したら `grep 'mkdir(' <新規ファイル>` で確認する
- **モバイルレスポンシブ規約**: すべての UI 機能はモバイル考慮。タップターゲット 44px 以上。ブレークポイント: ≤680px = モバイル / 681–960px = タブレット / ≥961px = デスクトップ。
  なお WYSIWYG 化により、旧 VISION が `out_of_scope` としていた「モバイルでの本格的な編集体験」は射程に入る (生 Markdown をモバイルで触らせるより明確に有利)。扱いを見直す余地がある
- **エージェント操作ツール必須**: 新機能には必ずエージェント用ツールも実装し、help 知識ベースに使い方を追加する。ツールは監査済みサービス層を経由する (ADR-0016)。権限はケーパビリティで制御し (ADR-0015)、機密領域は deny リストで除外する (ADR-0018)。使い方の詳細は base プロンプトでなく help トピックへ (ADR-0014)
- **機能ガイド更新義務**: 新機能追加・仕様変更時は、対応するガイド Markdown (`機能ガイド/`) を追加・更新する。ピュア Markdown で書き、`loamium init-samples` で取得できる形に保つ

### 使わないワークフロー

- **`autopilot` / `project-init` / `sprint` スキルは使用しない。** スプリント駆動の自動進行 (roadmap → plan → run → verify → review) はこのプロジェクトでは採用しない。作業は通常の対話で進め、`docs/ROADMAP.v1-archive.json` と `docs/sprint-logs/` は履歴の参照用としてのみ残す

## Commands

| ターゲット | 内容 |
|---|---|
| `make gate` | **CI が回すゲート一式** (lint + roundtrip + test) |
| `make lint` | shared / server / ui / cli の型検査 |
| `make test` | vitest (Milkdown 実体・書き手の収束・vault・feature 契約) |
| `make roundtrip` | shared のプロセッサ単体の round-trip 判定 |
| `make serve` / `serve-ui` | 開発サーバ (別ターミナルで併用) |
| `make fmt` | vault 全体を正規形へ揃える (`ARGS=--dry-run` で確認) |
| `make build` | `bun --compile` で単一実行ファイル |

⚠️ **ツールチェーンが PATH に無い。** `/usr/bin/node` は **v20** で、Node 22 は nvm 側 (`~/.nvm/versions/node/v22.23.1`) にしかない。`bun` も `~/.bun/bin/bun` (1.4.0)。Makefile が両方を明示的に解決しているので、**コマンドは直接叩かず `make` 経由で実行する**。

- ポート番号をハードコードしない。`portman lease --name loamium` で取得する
- 開発用 vault: `dev-vault/` (git 管理外)。**現状このチェックアウトには存在しないので、作り直す必要がある**

## 着手順

1. ~~**cordis で `vault → index → SSE → sync` の 4 プラグインを白紙で組み、`bun --compile` を通す**~~ — **✅ 2026-08-21 完了。地雷は不発。**
   `cordis@4.0.0-rc.8` + Hono が `bun build --compile` で 79MB の単一実行ファイルになり、`node_modules` の無い場所で起動・API 応答・日本語ファイル名・ネストディレクトリ書き込み・SIGTERM での正常終了まで確認済み。**静的登録である限り問題ない**という前提が裏付けられた
2. ~~**round-trip 差分ゼロの CI gate**~~ — **✅ 2026-08-21 完了。** `make roundtrip` で B/C を gate。詳細は上の不変条件 2 の表
3. **エディタ本体** ← 次はここ

## References

- **ADR-0035** — 本ファイルの「2 つの不変条件」の根拠 ADR。作り直しの起点となる判断 (不変条件の再定義 / 行単位 Raw 表示の不採用 / ProseMirror 採用)。**迷ったらまずこれを読む**
- Architecture Decision Records (ADR): `docs/DESIGN/adr/` — **35 本すべて有効な資産**。エージェント統合 (ADR-0014/0015/0016/0018)、sync (ADR-0030/0032)、スマートコマンド (ADR-0020〜0024) 等
- Product vision: `docs/VISION.json`
- Design principles: `docs/DESIGN_PRINCIPLES.json`
- 旧実装: `git show main:<path>` / `git grep <pattern> main -- packages/`

### 陳腐化しているので要書き換え

- `docs/ARCHITECTURE.md` — 旧構成 (CodeMirror / 手書き DI) 前提。cordis + ProseMirror で書き直す
- `docs/ROADMAP.v1-archive.json` — 旧実装の完了スプリント記録。**アクティブなロードマップではない**
- `docs/sprint-logs/` — 旧実装の履歴。参照用に残す

