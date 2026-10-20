import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './components/theme';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';

// Apply the saved light/dark/system choice before the first render.
initTheme();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element missing');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
