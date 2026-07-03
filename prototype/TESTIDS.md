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
