# data-testid 契約表 — Loamium GUI プロトタイプ

Sprint Sa704c3 / S9ab6c3 / S6fbf45 の実装と Playwright E2E テストは、この表の testid をそのまま使うこと。
複数要素に付く testid(tree-item / wikilink 等)は、併記の `data-*` 属性で個体を特定する。

## サイドバー(左ペイン)

| data-testid | 画面 | 役割 |
|---|---|---|
| `sidebar` | 全画面 | 左サイドバーのコンテナ |
| `sidebar-settings` | 全画面 | 設定ボタン(ヘッダ右) |
| `sidebar-new-note` | 全画面 | 新規ノート作成ボタン |
| `sidebar-new-folder` | 全画面 | 新規フォルダ作成ボタン |
| `file-tree` | 全画面 | ファイルツリーのコンテナ |
| `tree-folder` | 全画面 | フォルダ行(開閉トグル)。`data-path` でフォルダ特定 |
| `tree-item` | 全画面 | ノート行(クリックで開く)。`data-path` でノート特定 |
| `tree-empty` | editor-empty | 空 vault 時のツリー empty state |

## ジャーナル日付ナビゲーション

| data-testid | 画面 | 役割 |
|---|---|---|
| `journal-nav` | 全画面 | 日付ナビゲーションのコンテナ |
| `journal-prev` | 全画面 | 前日のジャーナルへ移動 |
| `journal-next` | 全画面 | 翌日のジャーナルへ移動 |
| `journal-today` | 全画面 | 今日のジャーナルを開く(現在日付表示) |
| `journal-open-list` | 全画面 | ジャーナル一覧ポップアップの開閉 |
| `journal-list` | journal | ジャーナル一覧ポップアップ |
| `journal-list-item` | journal | 一覧内の日付項目。`data-date` で日付特定 |

## エディタ(中央ペイン)

| data-testid | 画面 | 役割 |
|---|---|---|
| `editor` | 全画面 | CodeMirror エディタのコンテナ |
| `save-status` | 全画面 | 保存状態インジケータ。`data-state="saved" \| "dirty"` |
| `fold-toggle` | journal, editor, editor-outline | 折りたたみガターのトグル。`data-line` で行特定、折りたたみ中は `data-folded="true"` |
| `fold-pill` | editor-outline | 折りたたまれたサブツリーの「… N 行」ピル(クリックで展開) |
| `task-checkbox` | journal, editor, editor-outline | `- [ ]` チェックボックスのトグル。`data-line` で行特定 |
| `wikilink` | 全編集画面 | 解決済み [[リンク]](クリックで対象ノートへ)。`data-target` で対象特定 |
| `wikilink-broken` | wikilink-autocomplete | 壊れリンク(赤 + 破線。クリックで新規作成)。`data-target` で対象特定 |
| `fence-widget` | editor | フェンスレンダラーの描画結果。`data-lang="mermaid" \| "bash" 等` |
| `math-inline` | editor | $…$ インライン数式の描画結果 |
| `math-block` | editor | $$…$$ ブロック数式の描画結果 |
| `editor-empty-state` | editor-empty | ノート未オープン時の empty state コンテナ |
| `empty-open-journal` | editor-empty | 「今日のジャーナルを開始」ボタン |
| `empty-new-note` | editor-empty | 「新規ノートを作成」ボタン |

## [[リンク]] オートコンプリート

| data-testid | 画面 | 役割 |
|---|---|---|
| `wikilink-autocomplete` | wikilink-autocomplete | 候補ポップアップのコンテナ |
| `wikilink-autocomplete-option` | wikilink-autocomplete | 候補項目(選択で挿入)。`data-note` でノート特定 |
| `wikilink-autocomplete-create` | wikilink-autocomplete | 「新規ノートを作成してリンク」項目 |

## バックリンクパネル(右ペイン)

| data-testid | 画面 | 役割 |
|---|---|---|
| `backlink-panel` | 全画面 | バックリンクパネルのコンテナ |
| `backlink-count` | 全画面 | バックリンク件数バッジ |
| `backlink-panel-toggle` | 全画面 | パネルの開閉ボタン |
| `backlink-item` | journal, editor 等 | 参照元 + コンテキスト行(クリックで参照元へ移動)。`data-source` で参照元特定 |
| `backlink-empty` | editor-empty | バックリンク 0 件時の empty state |

## ツリーのコンテキストメニュー / リネームダイアログ

| data-testid | 画面 | 役割 |
|---|---|---|
| `tree-context-menu` | tree-rename | ツリー項目の右クリックメニュー |
| `context-open` | tree-rename | メニュー: 開く |
| `context-new-note` | tree-rename | メニュー: 同じフォルダに新規ノート |
| `context-rename` | tree-rename | メニュー: リネームダイアログを開く |
| `context-delete` | tree-rename | メニュー: 削除(確認へ) |
| `rename-dialog` | tree-rename | リネームダイアログ |
| `rename-input` | tree-rename | 新しいノート名の入力欄 |
| `rename-link-note` | tree-rename | 「[[リンク]] N 件を自動更新」の説明表示 |
| `rename-confirm` | tree-rename | リネーム実行(リンク追従つき) |
| `rename-cancel` | tree-rename | キャンセル |

## 備考

- ツリー行・バックリンク項目・オートコンプリート候補など繰り返し要素は「共通 testid + `data-path` / `data-source` / `data-note` / `data-date` / `data-line`」で特定する方針。Playwright では `page.getByTestId('tree-item').filter(...)` または `[data-testid="tree-item"][data-path="..."]` を使う。
- `save-status` の `data-state` は保存 AC(AC-Sa704c3-1-2)の待機条件に使う。
- プロトタイプ内の琥珀色破線ボックス(`.proto-note`)と右下のチップは注記であり、製品 UI ではない。実装対象外。

## Sa704c3 実装時追加(ダイアログ・エラー表示)

プロトタイプに無い UI(新規作成・削除確認・mtime 競合警告・エラー表示)のために
Sa704c3 実装で追加した testid。既存行の変更はなし(契約は additive にのみ拡張)。

| data-testid | 画面 | 役割 |
|---|---|---|
| `new-note-dialog` | 全画面 | 新規ノート作成ダイアログ |
| `new-note-input` | 全画面 | 新規ノート名の入力欄 |
| `new-note-confirm` | 全画面 | 新規ノート作成の実行 |
| `new-note-cancel` | 全画面 | キャンセル |
| `new-folder-dialog` | 全画面 | 新規フォルダ作成ダイアログ |
| `new-folder-input` | 全画面 | 新規フォルダ名の入力欄 |
| `new-folder-confirm` | 全画面 | 新規フォルダ作成の実行 |
| `new-folder-cancel` | 全画面 | キャンセル |
| `delete-dialog` | 全画面 | ノート削除の確認ダイアログ |
| `delete-confirm` | 全画面 | 削除の実行 |
| `delete-cancel` | 全画面 | キャンセル |
| `conflict-dialog` | 全画面 | 保存競合(mtime 不一致)の警告ダイアログ |
| `conflict-overwrite` | 全画面 | 上書き保存(baseMtime なしで再 PUT) |
| `conflict-reload` | 全画面 | 再読み込み(自分の編集を破棄して最新を取得) |
| `tree-error` | 全画面 | ノート一覧の取得失敗表示 |
| `app-error` | 全画面 | API エラーのバナー表示(エディタヘッダ内) |

### S6fbf45 で実装済 (2026-07-03) — 契約 testid 全結線完了

- `backlink-count` / `backlink-item` — S6fbf45-2(バックリンクパネルの実データ。GET /api/backlinks)
- `rename-link-note` — S6fbf45-3(リネームダイアログの「[[リンク]] N 件を自動更新」表示)
- `wikilink-broken` — S6fbf45-1(壊れリンク: 赤+破線、クリックで新規作成)
- `wikilink-autocomplete` / `wikilink-autocomplete-option` / `wikilink-autocomplete-create` — S6fbf45-1
- `wikilink` の `data-target` は S6fbf45-1 から**解決済み vault パス**(例: `projects/Hydra 設計メモ.md`)。
  未解決 (`wikilink-broken`) は従来どおり「記法どおり + .md 補完」

#### S6fbf45 実装時追加(契約は additive にのみ拡張)

| data-testid | 画面 | 役割 |
|---|---|---|
| `backlink-error` | 全画面 | バックリンク取得失敗時のパネル内エラー表示 |

### S9ab6c3 で実装済 (2026-07-03)

- `fold-toggle` / `fold-pill` / `task-checkbox` — アウトライン操作 (S9ab6c3-1)
- `wikilink` / `fence-widget` / `math-inline` / `math-block` — ライブプレビュー (S9ab6c3-2)。
  `wikilink` の `data-target` は現時点では記法どおりのターゲット + `.md` 補完 (パス解決・クリック遷移は S6fbf45-1)

## Sprint 7-11 (第2バッチ) プロトタイプ追加分 (2026-07-04)

Sprint Sbd061c / S9e5ca4 / Sf53ad6 / Sb1593c / Sb7f458 の実装と E2E はこの表に追従する。
既存表の変更はなし(契約は additive にのみ拡張)。

### グローバル検索パレット (Sbd061c-1)

| data-testid | 画面 | 役割 |
|---|---|---|
| `sidebar-search` | 全画面 | サイドバーの検索ボタン(Cmd/Ctrl+K と同じくパレットを開く) |
| `search-palette` | search-palette | 検索パレットのモーダルコンテナ |
| `search-palette-backdrop` | search-palette | 背景(外側クリックで閉じる) |
| `search-input` | search-palette | 検索入力欄(デバウンス付きインクリメンタル検索) |
| `search-section-notes` | search-palette | ノート名一致セクションの見出し |
| `search-section-fulltext` | search-palette | 全文検索ヒットセクションの見出し |
| `search-result-note` | search-palette | ノート名一致の候補(Enter/クリックで開く)。`data-path` で特定。選択中は `aria-selected="true"` |
| `search-result-fulltext` | search-palette | 全文ヒットの候補(該当行へカーソル移動)。`data-path` + `data-line` で特定 |
| `search-empty` | search-palette | 一致 0 件時の empty state(実装時に additive 追加) |
| `search-error` | search-palette | 全文検索 API 失敗時のパレット内エラー表示(実装時に additive 追加) |

### ![[embed]] transclusion・画像 (S9e5ca4-1/2)

| data-testid | 画面 | 役割 |
|---|---|---|
| `embed-card` | embed-preview | ノート/セクション埋め込みカード。`data-target` で対象、セクション埋め込みは `data-section` 付き |
| `embed-card-open` | embed-preview | 埋め込みカードのヘッダ(クリックで元ノートへ移動) |
| `embed-error` | embed-preview | 循環・深さ超過・壊れ embed のエラーカード。`data-target` で対象 |
| `embed-image` | embed-preview | `![[image.png]]` / `![](path)` の画像表示。`data-path` で対象 |

### callout・highlight (S9e5ca4-3/4)

| data-testid | 画面 | 役割 |
|---|---|---|
| `callout` | callout-highlight | callout ボックス。`data-type="note" \| "info" \| "tip" \| "warning" \| "danger"`(未知タイプは note)。折りたたみ中は `data-folded="true"` |
| `callout-fold` | callout-highlight | 折りたたみ callout(`[!note]-`)のタイトル(クリックで開閉) |
| `highlight` | callout-highlight | `==text==` のハイライト表示(カーソル行ではソース表示) |

### S9e5ca4 で実装済 (2026-07-04) — embed / 画像 / callout / highlight 全結線完了

- `embed-card` / `embed-card-open` / `embed-error` / `embed-image` — S9e5ca4-1/2(block レジストリ + GET /api/files)
- `callout` / `callout-fold` / `highlight` — S9e5ca4-3/4(block / inline レジストリ)
- 契約 testid はプロトタイプどおり全て実装。additive な追加属性:
  - `embed-image` の `data-error="true"` — 画像の読み込み失敗 (404 等) 時に付く
  - `callout-fold` の `aria-expanded` — 開閉状態(prototype と同じ)

### アップロード UX (Sf53ad6-2)

| data-testid | 画面 | 役割 |
|---|---|---|
| `drop-overlay` | upload | ファイルドラッグ中のドロップオーバーレイ(エディタ上) |
| `upload-toast` | upload | アップロードのトースト。`data-kind="progress" \| "renamed" \| "error"` で状態特定 |
| `tree-file` | upload, file-preview | ツリーの非 .md ファイル行(クリックでプレビュー)。`data-path` で特定。アイコン色で種別区別 |

### 埋め込みプレビューブロック (Sf53ad6-3)

| data-testid | 画面 | 役割 |
|---|---|---|
| `file-embed` | file-preview | `![[file]]` のプレビューブロック。`data-kind="pdf" \| "text" \| "card"` + `data-path` で特定(.md は `embed-card` と同一表示) |
| `file-embed-open-full` | file-preview | テキストプレビューの「全体を開く」/ PDF の「新しいタブで開く」 |
| `file-embed-download` | file-preview | プレビュー不能ファイルカードのダウンロードリンク |

### Sf53ad6 で実装済 (2026-07-04) — アップロード / ツリー添付 / 埋め込みプレビュー全結線完了

- `drop-overlay` / `upload-toast` / `tree-file` — Sf53ad6-2(D&D・ペースト・ツリー添付)
- `file-embed` / `file-embed-open-full` / `file-embed-download` — Sf53ad6-3(PDF / テキスト / カード)
- 契約 testid はプロトタイプどおり全て実装。additive な追加:
  - `file-preview-pane` — ツリーの `tree-file` クリックで開く添付プレビューペイン(中身は
    埋め込みと同一の `file-embed` / `embed-image` を再利用)
  - `file-embed` の `data-error="true"` — テキスト取得失敗・ファイル不在時に付く
  - `file-embed` の `data-expanded="true"` — テキストプレビューの「全体を開く」展開後に付く
  - `rename-dialog` / `delete-dialog` は添付ファイルにも共用(delete-dialog の見出しは
    「ファイルを削除」に変わる)

### dataview フェンス (Sb1593c-2)

| data-testid | 画面 | 役割 |
|---|---|---|
| `dataview-widget` | dataview | ```dataview フェンスの描画結果。`data-query-type="list" \| "table" \| "task" \| "error"` |
| `dataview-item` | dataview | LIST / TABLE の結果ノート(クリックで元ノートへ)。`data-path` で特定 |
| `dataview-task` | dataview | TASK の結果行(チェックボックス付き、クリックで該当行へ)。`data-path` + `data-line` で特定 |
| `dataview-error` | dataview | 構文エラーの表示(位置情報付きメッセージ) |

### ターミナルタブ (Sb7f458-2)

| data-testid | 画面 | 役割 |
|---|---|---|
| `workspace-tabs` | terminal | エディタ / ターミナルのタブバー |
| `tab-editor` | terminal | エディタタブ(クリックでエディタ表示) |
| `tab-terminal` | terminal | ターミナルタブ。選択中は `aria-selected="true"` |
| `terminal` | terminal | xterm.js ターミナルのコンテナ(リサイズ追従) |
| `terminal-disabled` | terminal | サーバー側で無効時の理由 + 有効化手順(LOAMIUM_TERMINAL=1)の表示 |
| `terminal-reconnect-bar` | terminal | 切断時の通知バー |
| `terminal-reconnect` | terminal | 再接続ボタン |

### Sb1593c で実装済 (2026-07-04) — dataview フェンス全結線完了

- `dataview-widget` / `dataview-item` / `dataview-task` / `dataview-error` — Sb1593c-2(fence レジストリ + POST /api/query)

### Sb7f458 で実装済 (2026-07-04) — ターミナルタブ全結線完了

- `workspace-tabs` / `tab-editor` / `tab-terminal` / `terminal` / `terminal-disabled` /
  `terminal-reconnect-bar` / `terminal-reconnect` — Sb7f458-2(xterm.js + WS /api/terminal、
  接続中/切断/無効の 3 状態)
- 契約 testid はプロトタイプどおり全て実装。additive な追加属性:
  - `tab-editor` / `tab-terminal` の `aria-selected` — 両タブに true/false を明示
  - `terminal-wrap` 直下の `data-terminal-status="loading" | "connecting" | "connected" |
    "disconnected" | "disabled"` — テスト/デバッグ用の状態表示 (コンテナの class ではなく属性)

## Sprint 12-15 (第3バッチ・UI シェル刷新) プロトタイプ追加分 (2026-07-04)

Sprint Sf1a90a / S935867 / Seac77a / S763a98 の実装と E2E はこの表に追従する。
このバッチは **タブ廃止 → ブラウザ的ルーティング + Claude を右サイドバーへ移設** の方向転換。
既存表の変更はなし(契約は additive にのみ拡張)。`workspace-tabs` / `tab-editor` / `tab-terminal`
(Sb7f458) は本バッチで右サイドバーのトグルへ置換されるため、実装時に段階的に廃止する。

### 新シェル: ルーティングと戻る/進む (Sf1a90a-1)

| data-testid | 画面 | 役割 |
|---|---|---|
| `nav-back` | shell-routing 他ルート全画面 | 履歴を 1 つ戻る(History API back)。戻れないときは `disabled` |
| `nav-forward` | 全画面 | 履歴を 1 つ進む(History API forward)。進めないときは `disabled` |
| `route-display` | 全画面 | 現在ルート表示(`/n/{path}` / `/search` / `/files`)。パンくず兼用(タブは無し) |

### サイドバー: 直近ファイル + すべて表示 (Sf1a90a-3)

| data-testid | 画面 | 役割 |
|---|---|---|
| `sidebar-show-all` | 全画面 | 「すべてのファイルを表示」導線。ファイル一覧ページ(`/files`)へ遷移 |

- `file-tree` / `tree-item` は直近更新の N 件(既定 10)に絞った一覧に流用(`data-path` で特定)。
- ツリーの `tree-folder`(`data-path="assets"`)クリックはファイル一覧ページへ遷移する (AC-Seac77a-1-3)。

### 右サイドバー トグル(バックリンク | Claude)(Sf1a90a-2)

| data-testid | 画面 | 役割 |
|---|---|---|
| `right-sidebar` | 全画面 | 右サイドバーのコンテナ(旧 `backlink-panel` を内包) |
| `right-tab-backlinks` | 全画面 | バックリンク表示に切替。選択中は `aria-selected="true"` |
| `right-tab-claude` | 全画面 | Claude(ターミナル)表示に切替。選択中は `aria-selected="true"` |
| `right-sidebar-toggle` | 全画面 | 右サイドバー自体の開閉ボタン |
| `claude-panel` | claude-sidebar | 右サイドバー内 Claude ペイン。`data-terminal-status="connected" \| "disabled" \| "disconnected"` |

- `backlink-panel` / `backlink-count` / `backlink-item` / `backlink-empty` は `right-sidebar` 内で従来どおり使う。
- Claude の中身は既存 `terminal` / `terminal-disabled` / `terminal-reconnect-bar` / `terminal-reconnect`
  (Sb7f458)をそのまま右サイドバーへ移設して再利用する。トグル開閉で xterm セッションは維持。

### 詳細検索ページ (S935867-1)

| data-testid | 画面 | 役割 |
|---|---|---|
| `search-form` | search-page | 検索条件フォーム(送信で URL クエリに同期) |
| `search-field-fulltext` | search-page | 全文キーワード入力 |
| `search-field-tag` | search-page | タグ絞り込み入力(`#tag` 空白区切りで AND) |
| `search-field-folder` | search-page | フォルダ絞り込み select |
| `search-field-sort` | search-page | 並び順 select(更新日時 / 関連度 / 名前) |
| `search-submit` | search-page | 検索実行ボタン |
| `search-results` | search-page | 結果一覧コンテナ(1 件開いても閉じない) |
| `search-result-item` | search-page | 結果行(クリックで左にノートを開く。一覧は保持)。`data-path` で特定、閲覧中は `active` |
| `search-history` | search-page | 検索履歴リストのコンテナ(localStorage) |
| `search-history-item` | search-page | 履歴項目(クリックで同じ検索を再実行)。`data-query` で条件特定 |

- Cmd+K パレット(`search-palette`)はジャンプ用として存続。パレット側に詳細検索ページへの導線を足す想定。
- 実装時 additive: 0 件時の `search-empty`、API 失敗時の `search-error` を追加してよい。

### S935867 で実装済 (2026-07-04) — 詳細検索ページ全結線完了

- `search-page` — 検索ページのルートコンテナ (実装時 additive)。ルートは `/search?q=&tag=&folder=&sort=`。
- `search-form` / `search-field-fulltext` / `search-field-tag` / `search-field-folder` / `search-field-sort` /
  `search-submit` — 条件フォーム。送信で URL クエリに同期 (AC-S935867-1-2)。既定 sort (updated) と空値は URL から省略。
- `search-results` / `search-result-item` (`data-path`, 閲覧中は `active`) — 結果一覧。クリックで
  右カラムのプレビューに開き、一覧は保持される (AC-S935867-1-1)。
- `search-history` / `search-history-item` (`data-query`) — localStorage 履歴。クリックで再実行 (AC-S935867-1-3)。
- 契約どおり全 testid を実装。additive な追加:
  - `search-empty` — 0 件 / 条件未指定時の表示。
  - `search-error` — GET /api/notes・/api/search 失敗時のページ内エラー (app-error には漏らさない)。
  - `search-preview-pane` (`data-path`) / `search-preview-open-editor` / `search-preview-close`
    — 結果を開いたまま順に閲覧するための read-only プレビュー (mini-md 再利用)。エディタ (/n/…) へも遷移可。
  - `search-open-advanced` — Cmd+K パレット footer の「詳細検索を開く」導線 (2 モード共存)。
- サーバー無改修: 全文は GET /api/search?q=、タグ (空白区切り AND) / フォルダ絞り込みは GET /api/notes の
  メタ (tags/folder/mtime) でクライアント側フィルタ。並び順は updated / score / name。

### アセット/ファイル一覧ページ (Seac77a-1)

| data-testid | 画面 | 役割 |
|---|---|---|
| `files-filter` | files-page | 名前絞り込み入力 |
| `files-count` | files-page | ファイル件数・合計サイズ表示 |
| `files-list` | files-page | ファイル一覧テーブル(名前・種別・サイズ・更新日時) |
| `file-row` | files-page | ファイル行。`data-path` で特定、選択中は `active` |
| `file-preview-btn` | files-page | プレビューを開く(右のプレビューペイン) |
| `file-copy-path` | files-page | vault 相対パス(`![[...]]` 用)をコピー |
| `file-delete-btn` | files-page | 削除確認ダイアログを開く |
| `files-preview-pane` | files-page | 選択ファイルのプレビューペイン(メタ情報 + 中身。`file-embed` / `embed-image` を再利用) |
| `files-preview-close` | files-page | プレビューペインを閉じる |

- 削除確認は既存 `delete-dialog` / `delete-confirm` / `delete-cancel` を共用(見出しは「ファイルを削除」)。削除は監査ログ記録。
- GET /api/files に size/mtime/種別を含める (Seac77a-1-1)。

### / スラッシュコマンドメニュー (S763a98-1)

| data-testid | 画面 | 役割 |
|---|---|---|
| `slash-menu` | slash-menu | `/` トリガーのコマンドメニュー popup(絞り込み・↑↓ナビ・Esc で閉じる) |
| `slash-item` | slash-menu | コマンド項目(クリック / Enter で挿入)。`data-command` で特定、選択中は `selected` |
| `slash-menu-empty` | slash-menu | 一致 0 件時の empty state |

- `data-command` の値: `table` / `callout` / `code` / `mermaid` / `dataview` / `checkbox` / `heading` / `date`。
- 挿入結果はすべて標準 Markdown(ブロック ID・独自記法なし)。カーソルは編集開始位置に置く (AC-S763a98-1-2)。
- コードフェンス内・インラインコード内では `slash-menu` は開かない (AC-S763a98-1-3)。

### Sf1a90a で実装済 (2026-07-04) — UI シェル刷新 (ルーティング / 右サイドバー / 直近ファイル)

- `nav-back` / `nav-forward` / `route-display` — Sf1a90a-1(History API ルーティング。ノート=`/n/{path}`、
  アセット=`/files`。戻れない/進めないとき `disabled`。URL から `.md` は除く)
- `sidebar-show-all` — Sf1a90a-3(「すべてのファイルを表示」→ `/files` ルート。ページ本体は Seac77a)
- `right-sidebar` / `right-tab-backlinks` / `right-tab-claude` / `right-sidebar-toggle` / `claude-panel`
  — Sf1a90a-2(バックリンク ⇄ Claude トグル。`claude-panel` は `data-terminal-status`。折りたたみは
  `right-sidebar` に `collapsed` クラス)
- `files-page-placeholder` — 実装時 additive。`/files` ルートのプレースホルダ(本体は Seac77a)
- 旧 `workspace-tabs` / `tab-editor` / `tab-terminal`(Sb7f458)は撤去。`backlink-panel` /
  `backlink-count` / `backlink-item` / `backlink-empty` / `backlink-error` は `right-sidebar` 内で存続
  (`backlink-panel-toggle` は `right-sidebar-toggle` に置換)。`terminal` / `terminal-disabled` /
  `terminal-reconnect-bar` / `terminal-reconnect` は `claude-panel` 内へ移設して再利用。
- サイドバーは mtime 順の直近 N=10 件フラット一覧(`file-tree` / `tree-item` / `tree-file` を流用)。
  開いているノート/添付は直近から漏れても必ず表示。フォルダツリー閲覧・`sidebar-new-folder` は
  ファイル一覧ページ (Seac77a) へ移設のため撤去(フォルダ内新規は `context-new-note` で存続)。

## Sprint S79c210 (レビュー修正・第2ラウンド) 追加分 (2026-07-04)

Sprint S79c210 は Sf1a90a-3 の直近フラット一覧を**ノートのフォルダツリーへ戻す**修正。
既存表の変更はなし(契約は additive にのみ拡張)。

### サイドバー: ノート フォルダツリーへ復帰 (S79c210-1)

- `file-tree` / `tree-folder`(`data-path` + `aria-expanded`)/ `tree-item`(`data-path`)/
  `tree-empty` / `tree-error` — Sa704c3 のフォルダツリーへ復帰。ノート(.md)のみを階層表示し、
  展開/折りたたみでフォルダ横断に全ノートへ辿れる(直近フラット一覧ではない)。
  非ノート asset(画像・PDF 等)はツリーに出さず `sidebar-show-all` → `/files` に集約。
- `sidebar-new-folder` — ルートに新規フォルダ(ダイアログは既存 `new-folder-dialog` /
  `new-folder-input` / `new-folder-confirm` / `new-folder-cancel`)。空フォルダは vault に
  ファイルを書かず UI 状態として表示し、最初のノート作成で実体化(ピュア Markdown 維持)。
- `tree-context-menu` はフォルダ対象時に `context-new-note`(このフォルダに新規ノート)と
  **`context-new-folder`**(このフォルダに新規フォルダ — 本 Sprint の additive 追加)を表示。
  ノート対象時は従来どおり `context-open` / `context-rename` / `context-delete`。
- 旧 `sidebar-recent.e2e`([AC-Sf1a90a-3-1] 直近フラット)は本 Story で置換され、
  `sidebar-tree.e2e` / `sidebar-tree.mock` に移行。
- `file-rename-btn` — /files ページの行操作に additive 追加。添付のリネーム UI は
  サイドバー撤去に伴いここへ集約(既存 `rename-dialog` / `rename-input` /
  `rename-confirm` を共用、![[リンク]] 追従つき)。preview=`file-preview-btn` /
  copy=`file-copy-path` / delete=`file-delete-btn` は従来どおり。

### テーブルのライブプレビュー (S79c210-2)

- `table-widget` — GFM テーブル(ヘッダ + 区切り + データ行)の HTML `<table>` 描画。
  lezer-markdown の Table ノードを block 装飾で置換。カーソル行(テーブル内)はソース表示。

### ターミナル Origin 拒否メッセージ (S79c210-3)

- `terminal-origin-denied` — WS close code 1008(Origin 拒否)時の案内バー
  (「このオリジンは許可されていません。localhost で開くか LOAMIUM_TERMINAL_ALLOWED_ORIGINS
  に追加してください」)。`claude-panel` の `data-terminal-status` に `origin-denied` を additive 追加。
  正常 exit(1000)は従来どおり `terminal-reconnect-bar`(「セッションが終了しました」)。

### パンくずの /n/ 除去 (S79c210-4)

- `route-display` のノート表示は内部ルート接頭辞 `/n/` を露出せず、ノートアイコン
  (`.route-crumb-icon`)+ フォルダ階層 + ノート名で構成(URL の `/n/{path}` 自体は維持)。

## Sprint Sd40b63 (レビュー修正・第3ラウンド) 追加分 (2026-07-05)

Sprint Sd40b63 は S79c210-2 のテーブル描画を **WYSIWYG 編集** へ発展させ、S763a98 の
スラッシュメニューに **テーブルサイズ グリッドピッカー** と **キーボード選択のスクロール追従** を足す。
既存表の変更はなし(契約は additive にのみ拡張)。挿入・編集結果は常にピュア Markdown(priority 1)。

### テーブル WYSIWYG 編集 (Sd40b63-1)

| data-testid | 画面 | 役割 |
|---|---|---|
| `table-widget` | editor | 既存。編集可能テーブルは `data-editable="true"` を additive 付与 |
| `table-cell-input` | editor | セルクリックで開くインライン編集 input(フォーカスを外すと表へ再描画) |
| `table-add-row` | editor | 末尾に行を追加 |
| `table-add-col` | editor | 末尾に列を追加 |
| `table-del-row` | editor | 行を削除。`data-row` で行特定(ホバーで前面化、常時クリック可) |
| `table-del-col` | editor | 列を削除。`data-col` で列特定 |

- セル本文は `.cell-body`(通常はレンダリング表示、クリックで生ソースの `table-cell-input` に切替)。
- 編集は CodeMirror トランザクションで元の Markdown 行へ書き戻す。パイプは `\|` エスケープ、
  改行はセル内で空白へ。区切り行(`---`)を維持し、標準 Markdown テーブルとして保存。

### スラッシュメニュー テーブルサイズ グリッドピッカー (Sd40b63-2)

| data-testid | 画面 | 役割 |
|---|---|---|
| `slash-table-picker` | slash-menu | テーブル項目選択で開くサイズ選択グリッド(既定 3×3、最大 8×8) |
| `slash-table-picker-cell` | slash-menu | グリッドのセル。`data-cols` × `data-rows`。ホバー/キーで選択、クリック/Enter で挿入 |
| `slash-table-picker-label` | slash-menu | 現在サイズ表示(例「4 列 × 2 行」) |

- テーブルは即挿入ではなくピッカーを経由する。↑↓←→ でサイズ変更、Enter で挿入、Esc でリストへ戻る。
- 選んだサイズの標準 Markdown テーブルを挿入し、カーソルは先頭セル。
- スラッシュメニューの ↑↓ 選択は `scrollIntoView({block:'nearest'})` でアクティブ項目へ追従する
  (下端項目が画面外に隠れるバグの修正)。

## Sprint Sa629e2 (レビュー修正・第4ラウンド) 追加分 (2026-07-05)

Sprint Sa629e2 は Sd40b63-1 テーブル WYSIWYG の UX 仕上げ・機能サンプル集・検索ページの
スリム化。既存表の変更はなし(契約は additive にのみ拡張)。

### テーブル WYSIWYG UX 仕上げ (Sa629e2-1)

| data-testid | 画面 | 役割 |
|---|---|---|
| `table-edit-source` | editor | 『ソースを編集』ボタン(ホバー表示)。クリックでカーソルがテーブル先頭行へ移りソース表示に切替 |

- `table-add-row` / `table-add-col` は存続。レイアウトが CSS grid になり、行追加バーは
  テーブル幅・列追加バーはテーブル高さに収まるホバー表示のスリムバーへ変更(エディタ幅に伸びない)。
- セル編集の mousedown は `.cell-body` ではなく td/th 全体で受ける(1 クリック編集の信頼性修正)。
  既存の `.cell-body` クリックも従来どおり動く。
- セル編集 input (`table-cell-input`) 内: Tab=右(行末は次行先頭)/ Shift+Tab=左 / Enter=下 /
  最終セル Tab=行追加して新行先頭。移動は「コミットしてから」(ファイルは常に標準 Markdown テーブル)。

### 検索ページのスリム化 (Sa629e2-3)

- `search-form` は 1 行のインラインバーに変更(キーワード `search-field-fulltext`・タグ
  `search-field-tag`・フォルダ `search-field-folder`・並び順 `search-field-sort`・
  `search-submit`。Enter=submit)。「Cmd+K は…」の説明ボックスは削除。
- `search-history` / `search-history-item`(`data-query`)はバー直下のチップ列へ移動
  (履歴 0 件時は行ごと非表示)。testid・data-query 形式は従来契約のまま。
- `search-result-item` は 1〜2 行の密な行(1 行目: タイトル + タグ + パス + 更新日時、
  2 行目: スニペット 1 行 ellipsis)。`search-preview-*` は従来どおり。
- `/search` ルートでは `right-sidebar` が非表示(display:none。DOM には残り、`claude-panel` /
  `terminal` の xterm セッションは維持される)。ノートルートに戻ると再表示。
