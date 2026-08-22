# @loamium/features

**1 機能 = 1 フォルダ。フロントとバックにまたがる機能を 1 か所にまとめる。**

```
src/<機能名>/
  contract.ts   両側で共有する型と REST のパス (React も Node も含めない)
  server.ts     defineFeature: REST ルート / エージェントツール / help
  ui.tsx        defineUiFeature: エディタ拡張 / パネル / 画面 / コマンド
```

- サーバーは `packages/server/src/app.ts` が `<機能名>/server` を静的に登録する
- UI は `packages/ui/src/features.ts` が `<機能名>/ui` を静的に登録する (**並び順 = サイドバーの並び順**)
- **機能を捨てるならフォルダごと消して、登録行 2 本を消すだけ**
- UI 機能の `requires` にサーバー機能名を書くと、`GET /api/features` に無いときリロードで UI 側も消える

## 現在の機能

| 機能 | server | ui | 中身 |
|---|---|---|---|
| `notes` | ○ | ○ | ノートの CRUD / ツリー |
| `journal` | ○ | ○ | デイリージャーナル |
| `search` | ○ | ○ | 全文検索 / パレット / 詳細検索ページ |
| `links` | ○ | ○ | WikiLink `[[ ]]` / バックリンク / リネーム追従 |
| `tags` | ○ | ○ | `#tag` の表示・補完・絞り込み |
| `outline` | — | ○ | リストの Tab インデント・折りたたみ (エディタ内で完結) |
| `fmt` | ○ | — | vault の正規化 |
| `agent` | ○ | — | ツール・help の自己記述 API |

シェル (`packages/ui/src/App.tsx`) に残るのは、エディタの器・情報パネルの枠・ESC の blur・
ルーティングだけ。**機能固有の分岐はシェルに書かない。**

⚠️ **`server.ts` と `ui.tsx` を同じ barrel から再エクスポートしないこと。**
UI のバンドルに Node 依存 (hono / node:fs) を引き込むと壊れる。入口はファイル単位で分ける。

⚠️ **プラグインは静的に import して静的に登録する** (CLAUDE.md)。
`bun --compile` の単一実行ファイルは動的 `import()` を静的解決できない。
