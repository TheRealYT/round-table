import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web APIs only (spec: Electron-ready). The hub serves the built files; dev uses Vite's server.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1' },
});
