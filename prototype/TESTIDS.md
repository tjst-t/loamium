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
