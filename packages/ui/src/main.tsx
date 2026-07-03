import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerBuiltinRenderers } from './renderers/index.js';
import './styles.css';

// レンダラー登録はエディタ生成より先に (fence/inline/block の 3 レジストリ)
registerBuiltinRenderers();

const rootEl = document.getElementById('root');
if (rootEl === null) {
  throw new Error('#root element not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
