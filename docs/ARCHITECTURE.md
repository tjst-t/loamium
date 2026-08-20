# Architecture: Loamium

## Overview

Loamium はローカルの `.md` ファイル群(vault)を正本とする個人用ノートアプリ。Hono 製 REST API がファイルシステムとインメモリインデックス(バックリンク・全文検索・タグ)を管理し、React + CodeMirror 6 の UI と Node.js 製 CLI(`loamium`)が同じ API を叩く。エージェント統合は 4 経路で成立する: 外部の Claude Code が CLI / Skill 経由でノートを読み書きし、加えて **Loamium 内蔵エージェント**(pi SDK をサーバーに in-process 同梱)が REST(`/api/agent/*`)経由でノートを読み書き・整理する。内蔵エージェントの推論バックエンドは外部 OpenAI/Anthropic 互換エンドポイントか、**内蔵オフライン LLM**(node-llama-cpp を in-process 同梱、ADR-0025)をユーザーが明示的に選択する。

## Components

### Server (REST API + インデックス)

- **Responsibility**: vault の読み書き、ファイル監視、インメモリインデックス(バックリンク / 全文検索 / タグ)、デイリージャーナル管理、監査ログ、ケーパビリティ権限、内蔵エージェント(pi SDK)とそのツール群、内蔵オフライン LLM エンジン、スマートフォルダ / コマンド / テンプレートの各サービス層、定期実行スケジューラ・ジョブランナー
- **Location**: `packages/server`
- **Key interfaces**: `GET/PUT/DELETE /api/notes/*path`, `POST /api/notes/*path/append`, `POST /api/notes/*path/patch`, `GET /api/journal`(自動生成), `POST /api/journal/append`, `GET /api/health`(実装済 — Sd63ad1)/ `GET /api/search`, `GET /api/backlinks`, `GET /api/notes`(一覧・tag/folder フィルタ), `GET /api/tags`(実装済 — S31ba00)/ `POST /api/notes/*path/rename`(リネーム + vault 全体の [[旧名]] 追従書き換え。実装済 — S6fbf45: compute-then-apply で書き換えを全計算してから適用、移動先既存は 409、解決先が旧パスのリンクのみ書き換え・コードフェンス内不変、監査ログ `note.rename`、インデックス即時追従)/ `GET /api/files/*path`(vault 内ファイルの読み取り専用配信。実装済 — S9e5ca4: 拡張子から Content-Type 推定 + nosniff、.html は text/plain、traversal 400・隠しセグメント (.loamium/.git) は 404 で存在も隠す、read-only モードでも配信)/ `GET /api/files`(添付 = 非 .md ファイル一覧 path/size/mtime)+ `POST /api/files/*path`(raw body アップロード。既存パスは `?overwrite=true` なしで 409、`.md` は 400 use_notes_api で notes API へ誘導、隠しセグメント 400、サイズ上限 LOAMIUM_MAX_UPLOAD 既定 50MB 超過は 413、監査ログ `file.write`、read-only/append-only は 403)+ `DELETE /api/files/*path`(添付削除、`file.delete`)+ `POST /api/files/*path/rename`(添付リネーム + vault 全ノートの ![[旧名]] 追従書き換え — notes rename と同じ compute-then-apply・最短一意表記・フェンス内不変、`file.rename`。実装済 — Sf53ad6)/ `POST /api/query`(dataview 風 DQL 簡易サブセット。LIST / TABLE fields / TASK + FROM #tag・"folder" + WHERE(frontmatter 任意キー・file.name/file.folder/file.mtime・tags、演算子 = != > < >= <= contains・and 結合・!truthy)+ SORT。POST だが純読み取りで permissions は read 分類(read-only モードでも実行可)。構文エラーは 400 `query_syntax` + 位置情報(message「N 行 M 列: …」+ line/column/length フィールド)。タスク(- [ ]/- [x])は shared `extractTasks` でインデックス化され、write-through と chokidar の両経路で追従。実装済 — Sb1593c)/ **内蔵エージェント API**(`POST /api/agent/sessions` 作成 → `{id}`、`GET /api/agent/sessions` 一覧、`GET /api/agent/sessions/{id}` 履歴復元、`PUT /api/agent/sessions/{id}/permissions` セッション毎ケーパビリティ上書き、`DELETE /api/agent/sessions/{id}` 削除、`POST /api/agent/sessions/{id}/messages` は body `{content}` で SSE ストリーム `text_delta`/`tool_start`/`tool_end`/`error`/`done`、`POST /api/agent/sessions/{id}/abort` 中断。pi SDK をサーバー内蔵し、接続設定 `.loamium/agent.json`(api/baseUrl/model/apiKey — `$ENV_VAR` 参照可 + backend `external`/`local` + localModel、ADR-0025)をセッション作成時に遅延読込。ツールはケーパビリティ別に広告される 21 種(下記「エージェントツール」節)。sessionId は allowlist 検証でパストラバーサル拒否。GET /api/health は `agent: {enabled, reason}` を additive に返す。実装済 — S53409d)/ **定期実行 API**(`GET /api/agent/jobs` 一覧、`GET /api/agent/jobs/{name}` 単体、`PUT /api/agent/jobs` 保存、`POST /api/agent/jobs/{name}/run` 即時実行。ジョブは cron 条件で無人実行し、結果は監査済みツール経由で vault へ書く。実装済 — S2fe109 / ADR-0028)/ **内蔵オフライン LLM API**(`POST /api/llm/v1/chat/completions` + `GET /api/llm/v1/models` = pi が繋ぐ OpenAI 互換 shim、`GET /api/llm/models` モデル一覧、`POST /api/llm/models/download` DL 開始、`GET /api/llm/models/download/{id}/status` 進捗、`DELETE /api/llm/models/{filename}` 削除 + アンロード。node-llama-cpp を in-process で駆動、モデルは `.loamium/models/llm/`。実装済 — S8a3f2e / ADR-0025)/ **設定 API**(`GET/PUT /api/settings/system`、`GET/PUT /api/settings/agent/connection`(backend/localModel/api/baseUrl/model/apiKey/webSearch)、`POST /api/settings/agent/connection/test` 疎通確認、`GET /api/settings/agent/models` バックエンド別モデル一覧、`GET/PUT /api/settings/agent/permissions` ケーパビリティ、`GET/PUT /api/settings/agent/privacy` 機密領域 deny)/ **スマートフォルダ / コマンド / テンプレート API**(`GET/PUT /api/smart-folders`、`GET /api/smart-folders/{id}/notes`、`GET /api/commands`、`GET/PUT /api/commands/{id}/source`、`POST /api/commands/{name}/run`、`GET /api/templates`、`POST /api/templates/*` インスタンス化。各サービス層 = 下記「サービス層」節)/ `POST /api/render/:lang`(将来)
- **Depends on**: shared(型・パスユーティリティ・Markdown パーサー)、chokidar(監視)、Fuse.js(検索)、pi SDK(`@earendil-works/pi-coding-agent` — 内蔵エージェント)、node-llama-cpp(内蔵オフライン LLM。ネイティブ addon、動的 import で遅延ロード)

#### エージェントツール(21 種・ケーパビリティ制御・監査済みサービス層経由)

内蔵エージェント(pi SDK)に広告されるカスタムツールは全 21 種。ADR-0016 に従い、いずれも REST と同じ監査済みサービス層を経由し、エージェント専用の直接ファイル操作・独自フォーマットは持たない(REST とのロジック二重管理を排除)。広告は ADR-0015 のケーパビリティで制御し(`deriveToolNames(effectiveCaps)` が広告集合、`agent-service.ts` が実装集合を同じ `effectiveCaps` から導出 — 広告と実行が常に一致)、書込系は書込モードでのみ広告する。機密領域は ADR-0018 の deny リストで一覧・読み取りから除外する。

- **読み取り系(6)**: `search` / `query`(DQL LIST/TABLE/TASK)/ `read_note` / `backlinks` / `tags` / `help`(トピック別ガイド。ADR-0014。どの権限セットでも利用可)— `agent-tools.ts`
- **書き込み系(5)**: `note_create` / `note_edit` / `journal_append` / `dataview_write` / `template_write` — `agent-write-tools.ts`(note-service 経由、成功時に監査エントリを直接記録)
- **Web 収集系(2)**: `web_search` / `web_fetch`(独立ケーパビリティ `web`、既定 off。SSRF ガード = web-guard、URL/クエリのみ監査・本文は非記録。ADR-0017)— `agent-web-tools.ts`
- **スマートフォルダ操作(4)**: `smartfolders_list` / `smartfolder_notes` / `smartfolder_write` / `smartfolder_delete` — `agent-smartfolder-tools.ts`
- **コマンド操作(2)**: `commands_list` / `command_run`(ADR-0018 の deny を書込先に強制)— `agent-command-tools.ts`
- **テンプレート操作(2)**: `templates_list` / `template_instantiate`(同上 deny 強制)— `agent-template-tools.ts`

使い方の詳細(ツール名・入出力・使用例・制約)は base システムプロンプトへ移さず help 知識ベース(`agent-help.ts`)に置く(ADR-0014。常時=base / 詳細=help)。

### 内蔵エージェント & サービス層(REST と共有する監査済み実装)

pi SDK(`@earendil-works/pi-coding-agent`)をサーバー内蔵し、エージェントツールと REST エンドポイントが**同一のサービス層**を叩く(ADR-0016。REST/エージェントで実行・解決・直列化ロジックを二重管理しない)。

- `agent-service.ts` — セッション生成・接続設定(`.loamium/agent.json`)の遅延読込・ツール合成(ケーパビリティ別)・セッション永続化(`.loamium/agent-sessions/` の JSONL)・`getEffectiveCapabilities`。
- `agent-scheduler.ts` / `agent-job-runner.ts` / `agent-jobs-store.ts` — 定期実行(S2fe109 / ADR-0028)。スケジューラは 1 分ごとに cron 条件を評価し anacron 方式でキャッチアップ、ジョブランナーは Pi セッションを生成して無人実行(`maxTurns` / `timeoutSec` で上限)。新規実行基盤は作らず REST と同じランナーを再利用する。
- `note-service.ts` — ノート作成 / 編集 / ジャーナル追記 / DataView・Template 書き込みの正本ロジック。REST の notes 系ルートとエージェント書込ツールの両方がここを経由する。
- `smart-folders-service.ts` / `commands-service.ts` / `templates-service.ts` — スマートフォルダ(保存クエリ)・コマンド(保存プロンプト)・テンプレートの解決 / 実行 / 直列化。REST(`/api/smart-folders`・`/api/commands`・`/api/templates`)とエージェントツールが共有する。
- `agent-privacy.ts`(ADR-0018 機密領域 deny の共通フィルタビュー)/ `agent-session-perms.ts`(ADR-0015 ケーパビリティ)/ `agent-prompt.ts` / `agent-help.ts`(ADR-0014 base / help 分離)。

### 内蔵オフライン LLM エンジン(ADR-0025 / S8a3f2e)

外部 API キーも別サーバーも無いオフライン環境でも、ユーザーがローカルモデルを明示選択すれば内蔵エージェントが動くようにする推論レイヤ。自動フォールバックはせず、設定 UI で `external`(外部エンドポイント)か `local`(内蔵モデル)を明示選択する。

- `local-llm-engine.ts` — node-llama-cpp v3 の薄いラッパー(load/unload/推論)。`node-llama-cpp` は**動的 import(遅延ロード)**し、addon が無い / ロード不可の環境でも server 起動・型チェック・他テストは壊れない。利用不可は握りつぶさず `LocalLlmUnavailableError` で明示的に返す。ロード / 推論は単一 mutex で直列化(単一ユーザーローカル前提)。GPU(Metal/CUDA/Vulkan)があれば使い、無ければ CPU にフォールバック(必須にしない)。
- `local-llm-shim.ts` — OpenAI `/v1/chat/completions`(stream 含む最小サブセット)⇔ LlamaChatSession の変換 + プロセス内エンジンシングルトン。pi の baseUrl をこの shim に向けることで、ADR-0011 のエージェント / ツール / 監査 / セッション配線を無改造で再利用する。
- `model-paths.ts` — モデル置き場の一元管理。`.loamium/models/llm/`(LLM GGUF)と `.loamium/models/asr/`(将来の Whisper 用)に種別で分ける。ファイル名は許可リスト検証でパストラバーサルを封じ、ディレクトリは初回アクセス時に作成。`.loamium/*` は .gitignore 済み=「消しても vault は無傷」の使い捨て資産。
- `model-download.ts` / `routes/llm.ts` — アプリ内 GGUF ダウンロードフローと OpenAI 互換 shim ルート・モデル管理 REST。
- `egress-guard.ts` — オフライン acceptance を CI で決定的に回すためのネットワーク遮断ハーネス(`LOAMIUM_BLOCK_EXTERNAL_FETCH=1` のときだけループバック外の fetch を拒否・計数)。本番コードパスには影響しない。

### Shared (共有ライブラリ)

- **Responsibility**: API の zod スキーマと型、vault 相対パスの正規化(NFC、`..` 脱出検証)、Markdown パース(frontmatter / [[WikiLink]] / #tag / リスト行判定)、ジャーナル日付処理
- **Location**: `packages/shared`
- **Key interfaces**: `normalizeVaultPath()`, `parseNote()`(frontmatter 抽出), `extractTags()` / `extractLinks()`(コードフェンス除外・NFC), `resolveLinkTarget()`(#heading・拡張子省略・NFC/NFD・フォルダ横断解決), `rewriteLinks()`(リネーム追従の [[リンク]] ターゲット書き換え — heading/alias/embed 保存・フェンス/インラインコード/frontmatter 不変。S6fbf45), `preferredLinkTarget()`(最短一意リンク表記 — rename 書き換え先とオートコンプリート挿入の共通ロジック。S6fbf45), `resolveFileLinkTarget()` / `preferredFileLinkTarget()`(添付 = 非 .md 版のリンク解決・最短表記。.md 非補完・拡張子込み — Sf53ad6), `normalizeVaultFilePath()`(.md 非補完の任意ファイル版。隠しセグメントは `HiddenVaultPathError` — S9e5ca4), `extractSection()`(![[note#見出し]] の見出しセクション抽出。フェンス内 # 除外・NFC・大小不区別 — S9e5ca4), `journalPath(date)`, `extractTasks()`(- [ ]/- [x] のタスク抽出 — 行番号・indent、フェンス/frontmatter 除外 — Sb1593c), `parseQuery()` / `executeQuery()`(dataview 風 DQL のパーサー + 純関数評価器。構文エラーは位置情報付き `DqlParseError` — Sb1593c), `parsePropertiesModel()` / `serializeFrontmatterBlock()` / `parsePropInput()`(frontmatter プロパティモデル — スカラー/フラット配列のみ WYSIWYG 編集可、ネスト・アンカー等は complex として原文 verbatim 保持、未編集エントリはバイト不変、直列化は parseNote と同じ yaml パッケージで round-trip 保証 — S9df823), API schema 群

### CLI (`loamium`) (実装済 — S0c9a48)

- **Responsibility**: REST API の薄いラッパー。エンドポイントと 1:1 のサブコマンド(read / write / append / patch / rename / search / query / backlinks / file / upload / files / journal / journal-append / list / tags — rename は S6fbf45、file は S9e5ca4、upload と files は Sf53ad6、query は Sb1593c で追加。file はバイト列を stdout に出すため --json なし。upload は `loamium upload <ローカル> [vault内パス]` で省略時 assets/<ファイル名>、--overwrite で上書き)。全コマンド `--json` で生 JSON 出力。成功 = exit 0 + stdout、失敗 = 非 0 + stderr に 1 行 JSON `{"error","message"}`(exit 1 = API/接続、exit 2 = 使い方)
- **Location**: `packages/cli`(bin は `bin/loamium.js` — tsx ランタイム登録で TS ソースを直接実行、ビルド不要)
- **Depends on**: Server(HTTP 経由)、shared(zod スキーマ・パス正規化)。サーバー URL は `LOAMIUM_URL` → portman (`portman port --name loamium`、無ければ `portman lease --name loamium`) → `http://127.0.0.1:3000` の順で解決

### UI (基盤 Sa704c3 + エディタ体験 S9ab6c3 + リンク機構 S6fbf45 実装済 — MVP スコープ完了)

- **Responsibility**: ファイルツリー、CodeMirror 6 エディタ(ライブプレビュー、リスト行限定のアウトライン操作)、[[リンク]] オートコンプリート、バックリンクパネル、デイリージャーナル
- **Location**: `packages/ui`(Vite + React 19 + CodeMirror 6)
- **実装済 (Sa704c3)**: 3 ペインレイアウト(ツリー / エディタ / バックリンクパネルのシェル)、Markdown ソース編集・Cmd/Ctrl+S + デバウンス自動保存、mtime 楽観的競合検出の警告ダイアログ、ツリーからの新規・リネーム・削除、起動時に今日のジャーナルへ着地 + 日付ナビゲーション。data-testid は `prototype/TESTIDS.md` の契約に従う
- **実装済 (S9ab6c3)**: C 方式のアウトライン操作(`src/outline.ts` — lezer ListItem 判定の Tab/Shift+Tab サブツリーインデント・fold-toggle ガター + fold-pill・task-checkbox クリックトグル。インデント単位 4 スペース、直前兄弟項目がある行のみ indent 可)と、ライブプレビュー(`src/live-preview.ts` — カーソル行はソース、他行は装飾。ブロック装飾は StateField、行内装飾は ViewPlugin)。装飾はすべて表示層のみでファイルはピュア Markdown のまま
- **Key interfaces**: fence / inline / block の 3 レンダラーレジストリ(`src/registries.ts`)。S9ab6c3 で結線済 — ビルトインは `src/renderers/`(mermaid=fence/replace、KaTeX=$…$ inline + $$…$$ block、Shiki=fence/replace で約 30 言語)。すべて npm バンドル同梱(CDN なし、オフライン動作)、mermaid/shiki は dynamic import。新レンダラーは `registerFenceRenderer` / `registerInlineRule` / `registerBlockRule` の登録だけで追加できる。開発時は Vite が `/api` を実サーバーへプロキシ(`LOAMIUM_API_URL` または portman)
- **実装済 (S6fbf45)**: リンク機構(`src/wikilink.ts` — [[ トリガーの CodeMirror autocompletion。部分一致絞り込み・最短一意表記の挿入・「新規ノートを作成してリンク」。`wikilinkEnvFacet` で App のノート一覧/ナビゲーション/作成を注入)。live-preview の [[リンク]] は shared `resolveLinkTarget` で解決され、解決済みはクリック(または Cmd/Ctrl+クリック)で遷移、未解決は赤+破線の壊れリンク表示でクリックすると新規作成(非 .md ターゲットは拒否)。バックリンクパネルは GET /api/backlinks の実データ(参照元+コンテキスト行、クリックで参照元へ、ノート切替・保存で再取得)。ツリーのリネームは POST /rename API に接続し、ダイアログに「[[リンク]] N 件を自動更新」を表示、開いているバッファが書き換え対象なら再読込する
- **実装済 (Sbd061c)**: グローバル検索パレット(`src/components/SearchPalette.tsx` — Cmd/Ctrl+K・サイドバー検索ボタンで開閉、Esc / 外側クリックで閉じる)。ノート名一致は表示時に GET /api/notes を再取得してローカル部分一致(NFC・大文字小文字不区別)、全文は 200ms デバウンスで GET /api/search(line null のタイトルのみ一致は除外)。IME 変換中は compositionend まで検索を確定しない。候補の Enter / クリックでノートを開き、全文ヒットは Editor の `seek` prop({line, token})で該当行へカーソル移動 + センタリング(行番号は本文行数へクランプ)。サーバー変更なし
- **実装済 (S9e5ca4)**: 記法拡張(`src/renderers/embed.ts` / `callout.ts` / `highlight.ts` / `mini-md.ts`)。`![[note]]` は読み取り専用の埋め込みカード(ヘッダクリックで元ノートへ)、`![[note#見出し]]` は shared `extractSection` でセクションのみ、循環 (A→B→A)・深さ超過 (最大 5) は `checkEmbedChain`(純関数)で判定しエラーカードで安全に打ち切る。画像は `![[image.png]]`(block レジストリ)と `![](path)`(lezer Image ノード — エンジン側)を `GET /api/files` 経由で表示。拡張子→プレビュー種別は `registerEmbedFileRenderer` レジストリで、新種別 (PDF・テキスト等) は登録だけで追加できる。callout は `> [!note]/[!info]/[!tip]/[!warning]/[!danger]`(未知タイプは note フォールバック、`[!note]-` は閉状態 + クリック開閉)、highlight は `==text==` の inline rule。registries は additive 拡張(`RenderContext.env/embedChain`、`BlockRule.matchWhile/identity`)
- **実装済 (Sf53ad6)**: ファイルアップロードと埋め込みプレビュー。エディタへの D&D / 画像ペーストで assets/ にアップロードし、カーソル位置へ `![[パス]]` を挿入(`src/upload.ts` — uploadEnvFacet 注入。名前衝突は連番リネーム image-1.png、失敗はエラートースト `upload-toast`)。ツリーに非 .md を `tree-file` として表示(アイコン種別区別 `src/file-kind.ts`、クリックで `FilePreview` ペイン、削除・リネームは files API — リネームは ![[リンク]] 追従)。`![[file]]` は拡張子ディスパッチ(embed レジストリ)で PDF=ブラウザ内蔵ビューア iframe(pdf.js 非同梱)/ テキスト系=読み取り専用ブロック(コード拡張子は Shiki、長文は先頭 30 行 + 全体を開く)/ .md=transclusion / その他=ファイルカード(名前・サイズ・DL)(`src/renderers/file-preview.ts`)。basename 参照 (![[image.png]]) は GET /api/files の添付一覧で実パスに解決
- **実装済 (Sb1593c)**: dataview フェンス描画(`src/renderers/dataview.ts` — fence レジストリに `dataview` を mode: replace で登録)。```dataview フェンスを POST /api/query の結果で置換描画(LIST=ノート一覧 / TABLE=ノート + 列の表・タグ配列はチップ / TASK=ノート別グループのチェックボックス付き行)。結果クリックで元ノートへ移動(TASK は `RenderEnv.openNoteAtLine` — additive 追加 — で該当行へカーソル移動。mousedown + stopPropagation でソース編集切替と衝突しない)。構文エラーはフェンス内に位置情報 + キャレット付きの `dataview-error` 表示でエディタは編集可能なまま。ファイル変更追従は widget DOM が生きている間のみのポーリング(2s、結果の署名が変わったときだけ再描画 — SSE 等の push 基盤は未導入なので最も単純な追従)。fence レンダラーへ `RenderContext.env` を渡すよう FenceWidget を additive 拡張
- **実装済 (S53409d — 内蔵エージェントが旧ターミナルを置換)**: 右サイドバーのトグルは**バックリンク ⇄ エージェント**(`src/components/AgentPane.tsx`)。旧 Claude ターミナル(node-pty / @xterm / WS `/api/terminal`)は **完全撤去**。エージェントは pi SDK(`@earendil-works/pi-coding-agent`)をサーバー内蔵し、OpenAI/Anthropic 互換エンドポイントへ接続(ADR-0011)。SSE でストリーミング表示、ツール実行はチップ可視化、回答内 `[[リンク]]` はクリック遷移(不在は赤)。ツールはケーパビリティ別に広告される 21 種(Server の「エージェントツール」節。組み込み/シェルは excludeTools+allowlist で排除)。未設定時は接続設定ガイド、応答中は中断ボタン。セッションは `.loamium/agent-sessions/` に JSONL 永続化。エージェント表示中もメインのノートは見える。**書き込みツール・ケーパビリティ権限(ADR-0015)・Web 収集ツール(ADR-0017)・定期実行(S2fe109)・内蔵オフライン LLM(ADR-0025)はすべて実装済み**(旧 3段階権限 ADR-0012 はケーパビリティ別トグルへ置換 — ADR-0015)
- **実装済 (Sf1a90a — UI シェル刷新)**: タブ廃止 + History API ルーティング(`src/router.ts` — ノート=/n/{path}・/search・/files。ブラウザ/ヘッダの戻る進む・リロード復帰)。サイドバーは mtime 順直近 N=10 件 +「すべて表示」→/files
- **実装済 (S935867)**: 詳細検索ページ `/search`(`src/components/SearchPage.tsx` — 条件を URL 同期、結果一覧を開いたまま複数閲覧、検索履歴 localStorage。Cmd+K ポップアップと 2 モード共存)
- **実装済 (Seac77a)**: ファイル/フォルダブラウザ `/files`(`src/components/FilesPage.tsx` — フォルダツリー横断でノート + 非ノートを一覧・絞り込み・プレビュー・パスコピー・削除)
- **実装済 (S763a98)**: `/` スラッシュメニュー(`src/slash-menu.ts` — 行頭/空白後の / でコマンド挿入。テーブル/callout/fence/mermaid/dataview/todo/見出し/日付、すべて標準 Markdown。コードフェンス・インラインコード内は lezer 構文木で抑制)
- **実装済 (S9df823)**: frontmatter のプロパティ UI(`src/renderers/properties.ts` + live-preview のブロック置換 — Obsidian Properties 風)。カーソルが frontmatter 外のとき --- ... --- をキー/値一覧(tags 等フラット配列はチップ)として描画し、値のその場編集・チップ追加削除・プロパティ追加削除・『ソースを編集』切替。書き戻しは常に標準 YAML frontmatter(shared の frontmatter モデル経由)。壊れた YAML は widget 化せず生ソースのまま、全プロパティ削除でブロック除去。スラッシュメニューに『プロパティ』(frontmatter 生成) を追加。ノートを開いた初期カーソルは本文先頭(frontmatter 直後)
- **テスト**: Playwright 二層(`tests/e2e/*.mock.spec.ts` は page.route モック、`*.e2e.spec.ts` は一時 vault + 実サーバー。ハーネスは `tests/harness/`)
- **Depends on**: Server(REST API)、shared(zod スキーマ・ジャーナル日付ユーティリティ)

### Skill (claude-skills 形式) (実装済 — S0c9a48)

- **Responsibility**: 自然言語 → `loamium` CLI 変換の例とエラーハンドリングを丁寧に記述。journal-append と search が最重要
- **Location**: `skill/`(`skill/SKILL.md`。構造・実 CLI とのコマンド整合は `tests/acceptance/skill.spec.ts` で検証)

## Data Flow

### 書き込みフロー (UI / CLI / エージェント共通)

client → REST API → パス正規化・権限チェック → ファイル書き込み(UTF-8/LF) → 監査ログ追記 → インデックス即時更新。外部編集(エディタ・Git)は chokidar が検知してインデックス再構築。

**競合制御 (ADR-0030 で更新):**
- **API / CLI / エージェント**: last-write-wins + mtime 楽観的検出。PUT に `baseMtime` を添えると不一致時に 409 conflict (Sa704c3)。エージェント/CLI は従来どおり無条件書き込み。
- **UI (dirty 編集中にリモート変更が来た場合 — 実装済 S2df65d)**: SSE `notes_changed` を受けたとき `diff3Merge(base, ours, theirs)` を実行する 3-way 自動マージを導入。
  - `base` = 最後にサーバーから取得したリモート内容 (OpenDoc.baseMd、セッション内揮発のみ)
  - `ours` = エディタの現在の編集バッファ (contentRef.current)
  - `theirs` = 新しいリモート内容 (SSE 受信後に GET /api/notes/{path} で取得)
  - **非競合ハンク** → CM Transaction でカーソル保持しつつ自動統合。dirty=true を維持。baseMd を theirs に更新。
  - **競合ハンク** → ConflictResolverDialog を表示。ours/theirs を並列カードで提示。各ハンクで解決方法 (こちらを使う/リモート/両方) を選択後、PUT /api/notes/{path} (baseMtime=theirsMtime) で書き戻し → auditMiddleware が監査ログに記録。
  - **非 dirty** → 従来どおり自動リロード (カーソルリセット許容)。
  - **自己エコー抑制**: PUT 後の chokidar→SSE は contentRef と一致するため mtime 更新のみで再マージしない。
  - **IME (日本語入力) 中**: compositionstart/end を監視し合成中は待機キューに積む。
  - **ダイアログ表示中の再 SSE**: 待機キューに積み、ダイアログ閉後に再マージ (多重ダイアログ防止)。
  - **競合マーカー不使用**: <<<, ===, >>> はファイルにも UI にも書かない (priority1 ピュア Markdown 絶対)。
  - **diff3 実装**: packages/shared/src/diff3.ts — 純 JS、外部依存なし、行単位 LCS + 保守的競合検出 (疑わしきは競合)。

### インデックスライフサイクル (実装済 — S31ba00)

起動時に vault 全走査で構築 (`VaultIndex.build`) → 書き込み API 成功時は監査コンテキストをフックに該当ファイルのみ即時再読込 (`indexSyncMiddleware`) → API 外の変更は chokidar が検知して差分更新 (`watcher.ts`、`.loamium/` 等ドット始まりは除外)。インデックスは Map + Fuse.js のインメモリのみ (消しても安全、ファイルが常に正)。ディスクキャッシュは未導入 (必要になったら `.loamium/` 配下に追加)。

### 内蔵エージェントフロー (実装済 — S53409d / S8a3f2e / Sc4b9d1)

UI(AgentPane)/ REST(`/api/agent/sessions/{id}/messages`)/ 定期実行(ジョブランナー)→ `agent-service.ts` が接続設定(`.loamium/agent.json`)を遅延読込しケーパビリティ(ADR-0015)から広告ツール集合を導出 → pi SDK セッション生成 → LLM 推論。バックエンドが `external` なら外部 OpenAI/Anthropic 互換エンドポイントへ、`local` なら内蔵 shim(`/api/llm/v1/chat/completions`)経由で node-llama-cpp へ(自動フォールバックはしない。ADR-0025)。ツール実行はすべて監査済みサービス層(note-service / smart-folders / commands / templates)を経由し、書き込み系は上記「書き込みフロー」に合流して監査ログ + インデックス即時更新を通る(ADR-0016)。機密領域は deny リストで読み取り・一覧から除外(ADR-0018)。

## Directory Structure

```
loamium/
├── packages/
│   ├── shared/    # 型・zodスキーマ・パス/Markdown/日付ユーティリティ
│   ├── server/    # Hono REST API + インデックス + ファイル監視
│   ├── cli/       # loamium CLI (APIの薄いラッパー)
│   ├── ui/        # React + CodeMirror 6
│   ├── app-electron/  # Electron デスクトップ同梱シェル
│   └── app-tauri/     # Tauri デスクトップ同梱シェル
├── skill/         # claude-skills 形式の Skill 定義
├── samples/       # 機能サンプル vault (make samples で LOAMIUM_VAULT へ no-clobber コピー — Sa629e2)
├── dev-vault/     # 開発用 vault (git管理外)
└── docs/          # ドキュメント・ROADMAP
```

## Infrastructure

- **Storage**: ファイルシステムの `.md` のみが正本。vault = Git リポジトリ前提。`.loamium/`(キャッシュ・監査ログ)は .gitignore
- **外部公開**: Cloudflare Tunnel + Access(認証は Access に委譲、ローカルは無認証)
- **内蔵オフライン LLM**: `node-llama-cpp` はネイティブ addon を含む。プレビルドが GLIBC/バインディング検証で失敗する環境(dev VM / CI)では gcc-13 でソースビルドし直す(`CC=/usr/bin/gcc-13 CXX=/usr/bin/g++-13 npx node-llama-cpp source download`)。エンジン層は動的 import で遅延ロードするため、addon 不在でも server 起動・lint・他テストは壊れない(ADR-0025 の攻撃面・CI 注意点)
- **デスクトップ同梱**: `packages/app-electron`(Electron)/ `packages/app-tauri`(Tauri)でサーバー + UI + 内蔵 LLM を同梱配布する
- **将来**: `POST /render/:lang` の server 種別レンダラー(PlantUML 等は Docker 同梱)、音声認識(`.loamium/models/asr/` の Whisper 等)

## Related Documents

- `SPEC.md` — 元の引き継ぎドキュメント(設計判断の経緯・拡張アーキテクチャ・未決事項の全リスト)
- `docs/VISION.json` — プロダクトビジョン(自律実行の判断基準)
- `docs/DESIGN_PRINCIPLES.json` — 設計原則(優先順位ルール・禁止事項)
