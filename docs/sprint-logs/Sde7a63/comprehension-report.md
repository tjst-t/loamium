# Milestone Comprehension Report — スマートコマンド + 統合コマンドパレット

対象バッチ: **Sd22b1f(スマートコマンド基盤)** + **Sde7a63(統合コマンドパレット UI・MILESTONE)**
ブランチ: `smart-command`(main と同期の上に本バッチを積載)

> review を始める前に、このレポートを読んでください。

## What changed(何が変わったか)

**Sd22b1f — スマートコマンド基盤(バックエンド + CLI、非 GUI)**
- スマートコマンド定義 = vault 内 `commands/*.md`(frontmatter `loamium-command` に params/steps、ADR-0020)。shared に zod スキーマ(`loamiumCommandSchema` / `commandStepSchema` 判別ユニオン 4 種 / `commandParamSchema`)+ `parseLoamiumCommand`。
- `GET /api/commands`(寛容 read — 壊れた定義は `valid:false`+error で 200 維持)、CLI `loamium commands`。
- `POST /api/commands/{name}/run`(サーバー側同期・逐次実行、`resolveTemplate` 展開、最初のエラーで停止・ロールバックなし、`openPath` 返却、ADR-0021)、CLI `command run --param k=v`。権限モード(read-only 403 / append-only 許可)+ 監査(`command.run` + 各ステップ書込)。**パス脱出は 400 拒否**。
- `POST /api/journal/append` に `section?` 追加(見出し配下末尾へ挿入、shared `insertUnderHeading`)、CLI `--section`。create-todo を実サーバー受け入れテストで実証。

**Sde7a63 — 統合コマンドパレット(UI)**
- UI コマンドレジストリ(`commandRegistry.tsx`、Map upsert)+ 組み込み 5 コマンド(新規ノート/テンプレート/スマートフォルダ作成/詳細検索/今日のジャーナル)を既存ハンドラへ接続。Ctrl-K パレットに「コマンド」セクション追加(ノート/全文と共存)。
- `>` コマンド専用モード(prefix 解析を `palettePrefix.ts` に単一集約、ADR-0019。将来 `#` 等を加算可能)。
- スマートコマンド表示(`source='smart'`、`valid:false` は非選択+理由)、`ParamFormModal`(required 検証・text→textarea・date→日付・default 反映)→ `POST run`。成功時 `openPath` 遷移、失敗時ステップ結果表示。
- **create-todo の全フロー(Ctrl-K → `>` 絞り込み → フォーム → 実行 → ジャーナル `## Todo` セクション追記)を実サーバー E2E で検証**(raw ジャーナルファイル読取でセクション配下を確認)。

## Why this way(なぜこの設計か)
- **定義を vault 内 Markdown に**: ピュア Markdown 原則 + Git 一体管理 + Loamium 自身/エージェントが普通のノート API で編集可能(ADR-0020)。専用 CRUD API を作らない。
- **サーバー側同期実行 + 閉じたステップ・ユニオン**: REST/CLI 1:1・監査・権限モードが単一経路に乗る(PRINCIPLES 優先度 3)。プラグイン API を作らない(forbidden)。ステップ語彙は加算拡張。
- **パレットは既存 SearchPalette の加算拡張**: 1 キー(Ctrl-K)で全機能到達、発見性重視(ADR-0019)。レジストリは builtin/smart を同列に扱う。

## What to verify(あなたに見てほしい点)
1. `make serve` で起動 → **Ctrl-K** を押し、コマンドセクションと組み込み 5 コマンドが出るか。各コマンドが既存モーダル/ルーティングに繋がるか。
2. `>` を打つとコマンド専用に絞れるか(ノート/全文が消える)。プレースホルダ/バッジでモードが分かるか。
3. `dev-vault/commands/create-todo.md` を用意(または既存)→ パレットから create todo を選び、フォームに概要を入れて実行 → **今日のジャーナルの Todo セクションに `- [ ]` 行**が追記されるか。
4. 見た目: パレット/フォームモーダルのスタイル、アイコンサイズ(過去にアイコン肥大化の前例あり — 今回 `:where(svg)` フォールバック + 明示サイズで対処済み)。

## What was assumed(前提・注意)
- **agent-run ステップ(議事録まとめ等)は v1 スコープ外**。Pi Agent 統合(別ブランチ進行中)のマージ後に、非同期ジョブモデルを新 ADR で決めてから S5a66e4(コアース)で実装。目玉の議事録要約は現時点では未提供。
- CLI `journal-append` で `- ` 始まりの content は Commander 制約により `--` セパレータ必須(ヘルプ明記・テスト済み)。create-todo は run 経由なので影響なし。
- **既知フレーク 2 件**(`watch.spec.ts`・`smart-folder-editor.e2e.spec.ts`)が full-suite 負荷下で稀に失敗するが単独では pass。本バッチは未変更。
- **環境修復**: この VM の既定 gcc(Nix 15)が GLIBC_2.42 にリンクし node-pty がロード不可だった件を `CC=/usr/bin/gcc-13` リビルドで解消(node_modules 再 install 時は再実行が必要)。
- **経緯**: 本ブランチは当初 main の S11493d/Sa8ee62 実装を未取込のまま古い ROADMAP を持っており、autopilot 開始直後にそれを検出。main を統合し直し、ROADMAP を「main の完了状態 + コマンドパレット 3 Sprint」へ整合させてから本バッチを実行した。
