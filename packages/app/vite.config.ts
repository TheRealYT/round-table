import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web APIs only (spec: Electron-ready). The hub serves the built files; in dev, Vite proxies the
// hub's endpoints so the app runs from http://127.0.0.1:5173 with the same cookie and WebSocket paths.
const hub = process.env.RT_HUB_HTTP ?? 'http://127.0.0.1:7777';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/login': hub,
      '/app': { target: hub.replace(/^http/, 'ws'), ws: true },
    },
  },
});
