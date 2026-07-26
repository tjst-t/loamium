import { ipcRenderer } from 'electron';

window.addEventListener('DOMContentLoaded', () => {
  // フレームレスウィンドウのドラッグハンドル (Electron 限定 — この style は preload でのみ
  // 注入されるため Web ビルドは無影響)。上部ヘッダー帯 3 つ (左サイドバー / 中央エディタ /
  // 右サイドバー) を丸ごとドラッグ可能にし、アプリのアクション (ボタン・リンク・入力・
  // タブ・メニュー・vault バッジ) だけを no-drag で carve-out する。これで「アクションが
  // 無い余白はどこでも掴んで移動できる」を満たす。
  const style = document.createElement('style');
  style.textContent = `
    :is(.sidebar-header, .editor-header, .panel-header) {
      -webkit-app-region: drag;
      user-select: none;
    }
    :is(.sidebar-header, .editor-header, .panel-header)
      :is(button, a, input, select, textarea,
          [role="button"], [role="tab"], [role="menu"], [contenteditable="true"],
          .vault-badge) {
      -webkit-app-region: no-drag;
    }

    /* Window Controls Overlay 対策。titleBarStyle:'hidden' + titleBarOverlay により、
       ネイティブの最小化/最大化/閉じるボタンが右上に重なって描画される。右サイドバーの
       タブヘッダ (インフォ / Agent) がその真下に来るため、タイトルバー高さ
       (env(titlebar-area-height)=46px) 分だけ下げてボタンとの衝突を避ける。この余白部分は
       上の drag ルールでウィンドウ移動用の掴みしろにもなる。 */
    .panel-header,
    .panel.collapsed .panel-header {
      padding-top: calc(env(titlebar-area-height, 46px) + 6px);
    }

    /* 右パネルが折りたたみ (.panel.collapsed=40px) / 非表示 (≤960px で display:none) に
       なると、右パネルが担っていた「window controls を避ける余白」が消え、editor-header
       の右端がネイティブの最小化/最大化/閉じるボタンの真下に入り込む。最右の子である
       同期ボタン (SyncStatusIndicator) がその下に隠れて押せなくなるため、controls 幅ぶんの
       右余白を editor-header 側で確保する。controls 幅 = 100vw - env(titlebar-area-width)
       (WCO 未使用時は env=100vw にフォールバックし余白 0 = 無影響)。 */
    .app:has(.panel.collapsed) .editor-header {
      padding-right: max(20px, calc(100vw - env(titlebar-area-width, 100vw) + 8px));
    }
    @media (max-width: 960px) {
      .editor-header {
        padding-right: max(20px, calc(100vw - env(titlebar-area-width, 100vw) + 8px));
      }
    }
  `;
  document.head.appendChild(style);

  // vault-badge click → main process shows context menu at badge position
  document.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target) return;
    const badge = target.closest('.vault-badge');
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = badge.getBoundingClientRect();
    ipcRenderer.send('show-app-menu', Math.round(rect.left), Math.round(rect.bottom + 4));
  });
});
