import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { HubProvider } from './hub.tsx';
import { applyStoredTheme, ToastProvider } from './ui.tsx';
import './styles.css';

applyStoredTheme();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <HubProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </HubProvider>
    </StrictMode>,
  );
}
