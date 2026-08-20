# Comprehension Report — Milestone: インフォパネル + エクスポート

**Batch:** S11493d (インフォパネル Tier 1) → Sa8ee62 (エクスポート PDF/HTML, milestone)
**Date:** 2026-07-10 · **Branch merged into:** main

## What changed (meaning, not just files)

### S11493d — 右サイドバーを「情報ハブ」化
- 右サイドバーの「バックリンク」タブを **「インフォ」** に格上げし、折りたたみセクションの積み重ねに再構成した。
- **新 API `GET /api/notes/{path}/meta`**(+ CLI `loamium note-meta`)が、見出しツリー・アウトゴーイングリンク(解決/未解決)・タグ・frontmatter・更新日時・単語数/文字数を **1 リクエストで** 返す。UI 各セクションはこれを購読する。
- セクション: **Outline**(クリックで該当行へジャンプ)/ **Properties**(frontmatter。ただし `tags` キーは除外)/ **Tags** / **メタ情報** / **Outgoing links**(未解決は破線+「未解決」バッジ・非クリック)/ **Backlinks**(既存表示を統合)。
- **タグクリック → `/search?tag=` を全表示箇所で統一**(共有ハンドラ `makeTagClickHandler`)。インフォ Tags・プロパティ描画・dataview・エディタ内 #tag に配線。

### Sa8ee62 — サーバー側エクスポート(ADR-0006)
- **`GET /api/notes/{path}/export?format=pdf|html`**(+ CLI `loamium export`)。サーバーの **単一パイプライン**(marked で MD→HTML、playwright/headless Chromium で HTML→PDF)を REST と CLI が共有。
- 右パネルの **⋯ メニューの「PDF エクスポート」** がこの API を叩き、ブラウザダウンロードする。
- エクスポートは **派生物**。vault へは一切書き戻さない。実行は `note.export` として監査ログに記録。

## Why this way
- **API ファースト**: メタ/エクスポートのロジックをサーバー(+shared)に置き、UI は薄く載せた。CLI と 1:1(REST/CLI 原則)。
- **タグ重複解消**(ユーザーレビュー): タグは frontmatter+本文 #tag の集約なので、Properties から `tags` を外し Tags セクションに一本化。
- **ADR-0006**: 見た目制御と CLI 一貫性のため PDF はサーバー生成(headless Chromium)。ブラウザ印刷を却下。

## What to verify (あなたに見てほしい点)
1. **インフォパネルの操作感**: Outline ジャンプ、未解決リンクの見せ方、Tags/各所タグのクリック→検索遷移。
2. **PDF エクスポート**: ⋯ →「PDF エクスポート」で実際に PDF が落ちるか、体裁(A4・テーマ)は許容範囲か。
3. **エクスポートの描画範囲**: 現状 mermaid/KaTeX/Shiki/callout/`![[embed]]`/`==highlight==` は **素の HTML/テキスト** になる(下記 compromise)。この範囲で MVP として良いか。

## What was assumed / deferred (compromises.json 参照)
- エクスポートのリッチ描画(mermaid/KaTeX/Shiki/embed/callout/highlight)は **将来のパイプライン拡張** に後回し。
- `S11493d-4` の「テーブルセルのタグ」は **dataview の dv-tag に限定**(GFM 表の素 #tag は pure-Markdown 原則で除外)。

## Notable during the run
- **回帰を検出・修正**: S11493d-2 で ⋯ メニューの CSS がアプリ側に未移植だったため、閉じたメニューがパネルヘッダを 479px に膨張させ、Claude ターミナルのリサイズ追従(AC-Sf1a90a-2-1)が壊れていた。**ベースラインと比較して回帰と確定 → CSS 移植で修正**(header 47px 復帰、3/3 pass)。
- **独立 verifier が監査整合性の欠陥を検出**: `note.export` の監査が PDF 生成前に `ok` で書かれていた → **成果物生成後に移動**して修正。PDF レンダに明示 20s 上限も追加。
- **テストインフラの既知 flake**: 実サーバー acceptance(terminal/health)が並列 vitest 下でポート競合し非決定的に flake。`--no-file-parallelism` で **674/674 green**。backlog に直列化を計上。

## ⚠️ レビュー開始前に、この comprehension-report.md を読んでください。
