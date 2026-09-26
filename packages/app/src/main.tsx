import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SECTIONS } from '@round-table/protocol';

// Placeholder shell. Slice S1 adds login, Pairing and Feed; S5 adds the full app (architecture §7).
function App() {
  return (
    <main>
      <h1>Round Table</h1>
      <p>Board sections: {SECTIONS.map((s) => s.name).join(', ')}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
