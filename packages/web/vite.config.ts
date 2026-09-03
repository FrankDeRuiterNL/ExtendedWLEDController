import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Share the core package as source so the browser preview and the server
    // renderer run identical effect code with no build step between them.
    alias: { '@ewc/core': coreSrc },
  },
  server: {
    port: 5173,
    proxy: {
      // ws:true also upgrades the /api/ws realtime channel.
      '/api': { target: 'http://localhost:8080', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
