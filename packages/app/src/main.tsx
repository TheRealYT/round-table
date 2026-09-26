import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { HubProvider } from './hub.tsx';
import './styles.css';

// Slice S1: Pairing and project Feed. S5 adds Home, Inbox, Board, Logs and the rest (architecture §7).
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <HubProvider>
        <App />
      </HubProvider>
    </StrictMode>,
  );
}
