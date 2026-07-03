# Roadmap generation — 設計判断ログ

日時: 2026-07-03 / 生成: autopilot setup (autonomous)

## 構成: 6 Sprint、マイルストーン 2 箇所

1. `Sd63ad1` REST API コア(notes CRUD / journal / 監査ログ・権限モード)
2. `S31ba00` インデックス(検索 / バックリンク / ファイル監視)
3. `S0c9a48` CLI と Skill **[MILESTONE: エージェント統合 MVP]**
4. `Sa704c3` UI 基盤(ファイルツリー / エディタ / ジャーナル着地)
5. `S9ab6c3` エディタ体験(アウトライン操作 C 方式 / ライブプレビュー / 3 レジストリ)
6. `S6fbf45` リンク機構(オートコンプリート / バックリンクパネル / リネーム追従)**[MILESTONE: UI MVP 完成]**

## 主要判断と根拠

- **API-first の順序**: SPEC.md §7 の実装順序(API → CLI → Skill → UI)をそのまま採用。「API を先に作ると Claude Code でノートを書きながら開発できる」という SPEC の意図に一致。
- **監査ログ・権限モードを Sprint 1 に配置**: SPEC §9「最優先の 3 つ」+ DESIGN_PRINCIPLES priority 2(データ安全性 > 開発速度)。後付けは危険と明記されているため。
- **ファイル監視を Sprint 2 に配置**: SPEC §9 高-1/高-4(同期と競合制御・インデックス再構築はデータフローの最初から)。
- **リネーム追従を Sprint 6 に配置**: SPEC §9 高-2。リンク UI と同時に完成させる(バックリンク基盤が先に必要)。
- **マイルストーン配置**: Sprint 3 終了時(エージェント統合という独自価値が完成し、CLI で実際に触れる)と Sprint 6 終了時(MVP スコープ完了)。依存境界(S0c9a48 → Sa704c3 は独立トラック開始)とも一致。
- **スコープ外に送ったもの**: Cloudflare Tunnel(実アカウント必要)、Claude Code タブ・Tauri・グラフビュー(SPEC で将来/MVP 後と明記)、transclusion・server レンダラー(3 レジストリの上に後付け可能)→ すべて backlog に記録。
- **Tauri 化は MVP スコープ 5 項目に含まれるが roadmap から除外**: SPEC §3 で「デスクトップ化を急がず Cloudflare Tunnel 構成のままブラウザで運用する」選択肢が明記されており、VISION の成功基準にも含まれないため backlog へ。
