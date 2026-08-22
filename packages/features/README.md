# @loamium/features

**1 機能 = 1 フォルダ。フロントとバックにまたがる機能を 1 か所にまとめる。**

```
src/<機能名>/
  contract.ts   両側で共有する型と REST のパス (React も Node も含めない)
  server.ts     defineFeature: REST ルート / エージェントツール / help
  ui.tsx        defineUiFeature: エディタ拡張 / パネル / 画面 / コマンド
```

- サーバーは `packages/server/src/app.ts` が `<機能名>/server` を静的に登録する
- UI は `packages/ui/src/features.ts` が `<機能名>/ui` を静的に登録する
- **機能を捨てるならフォルダごと消して、登録行 2 本を消すだけ**

⚠️ **`server.ts` と `ui.tsx` を同じ barrel から再エクスポートしないこと。**
UI のバンドルに Node 依存 (hono / node:fs) を引き込むと壊れる。入口はファイル単位で分ける。

⚠️ **プラグインは静的に import して静的に登録する** (CLAUDE.md)。
`bun --compile` の単一実行ファイルは動的 `import()` を静的解決できない。
