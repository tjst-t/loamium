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
