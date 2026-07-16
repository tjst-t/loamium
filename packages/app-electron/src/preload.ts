import { ipcRenderer } from 'electron';

window.addEventListener('DOMContentLoaded', () => {
  // Make sidebar header draggable (frameless window drag handle)
  // Buttons and vault-badge stay no-drag so click events fire normally
  const style = document.createElement('style');
  style.textContent = `
    .sidebar-header {
      -webkit-app-region: drag;
      user-select: none;
    }
    .sidebar-header button,
    .sidebar-header a,
    .sidebar-header .vault-badge {
      -webkit-app-region: no-drag;
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
