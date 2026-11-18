import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/** Vite builds the UI that runs inside the Tauri window (dev server on :5173, output in dist/web). */
export default defineConfig({
  clearScreen: false,
  root: 'web',
  plugins: [react()],
  resolve: { alias: { 'monaco-esm': fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs', import.meta.url)) } },
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 5000 },
  server: {
    port: 5173,
    strictPort: true,
  },
});
