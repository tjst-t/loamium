# Comprehension Report — Milestone: スマートフォルダ / ブックマーク (Sprints S32940c, S8086d9)

_Generated at milestone arrival. Read this before `autopilot review`._

## What changed

- サイドバーに「物理ビュー ⇄ スマートビュー」トグルが付いた。スマートビューは、クエリ(DQL)で動的に集めたファイル群(`query`)と、指名した単一ノート(`pin`)を並べて表示する。切替は localStorage に永続。
- DQL に `LIMIT n` と `file.tasks` / `file.open_tasks` が加わった。「最近更新 N 件」「未完了 TODO を含むノート」がクエリで書け、ノート内 ```dataview``` フェンスも同じ恩恵を受ける(加算・後方互換)。
- スマートフォルダ定義は `.loamium/smart-folders.json`(**git 追跡**)に保存され、REST `GET/PUT /api/smart-folders` と `GET /api/smart-folders/{id}/notes`、CLI `smart-folders` / `smart-folders set` / `smart-folder <id>` から読み書き・解決できる。
- ノートヘッダ右上に**ブックマークスター**が常時表示。クリックで frontmatter の `bookmark: true` を付与/解除し、`LIST WHERE bookmark` のスマートフォルダに反映される。
- frontmatter を round-trip 安全に書く汎用 API `POST /api/notes/{path}/properties`(+ CLI `prop set/unset`)が追加された。スターはこの上の一機能。
- (インフラ)ターミナルの node-pty を遅延ロード化し、ネイティブモジュールが無い環境でもサーバーが起動できるようにした。

## Why this way

- クエリは既存 **DQL エンジンを再利用・拡張**(ADR-0001)。独自クエリ機構を作らず、フェンスと契約を一本化。
- 定義は **git 追跡の設定ファイル**(ADR-0002)。「.loamium は使い捨て」原則への明示的例外として、保存ビューが clone / 別マシンへ旅するようにした。
- 要素は **pin | query の 2 種**(ADR-0003)。手動複数リスト(pins)は property+query で代替できるため不採用。
- ブックマークは **frontmatter プロパティ**(ADR-0004)。純 Markdown・Obsidian 互換でノートに状態が載り、既存 DQL の truthy でそのまま解決(DQL 変更不要)。書込は汎用 properties API に一般化。
- **バックエンド(α)→ UI(β)の 2 Sprint** 構成(priority 3: API-first、GUI E2E は実サーバ必須)。

## What to verify

- ⚠️ (a11y, medium) スマートフォルダの `aria-expanded` が開閉ボタンではなくラッパー `div` に付いている(gui-spec の testid 契約に合わせた結果)。スクリーンリーダーで開閉状態が正しく読まれない可能性。実際に確認し、ボタン側へ移すか判断を。
- ⚠️ (env) ターミナル/Claude パネルの e2e(5 件)+ terminal acceptance(7 件)は、このサンドボックスで node-pty が GLIBC 不整合によりロードできず**実行不可**。**スマートフォルダ/ブックマークとは無関係**。ターミナル機能自体の実機確認は別環境で。
- スマートビューの見た目・アイコン(時計/星/絵文字フォールバック)・展開操作を実ブラウザで。スターの塗り/枠の視認性と位置。
- query フォルダは一度開くと結果を**キャッシュ**し再展開で再取得しない。vault 変更時に古い結果が出るため、リフレッシュ導線が要るか判断を。

## What was assumed

- ビュー切替は URL ルートにせず localStorage 永続(中央ペインを変えない UI 状態のため)。ブラウザ戻る/進むの対象外で良いと仮定。
- 組み込みアイコン名のセット(clock/star/bookmark/hash/calendar/check-square/file-text/folder/search/pin/flame/inbox)は固定。未知文字列は絵文字としてそのまま描画。任意アイコンを増やす UI は未実装。
- read-only / append-only では書込系(スター・PUT smart-folders・properties)を 403 / 無効化。full モード運用を前提と仮定。
