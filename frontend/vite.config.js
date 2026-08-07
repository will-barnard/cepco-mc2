import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 5173,
    // Local dev only. In production nginx proxies /api to the backend service.
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // heic2any is ~1.3 MB and lands in its own lazy chunk on purpose — it is
    // only fetched the first time someone uploads a HEIC, and never at all on
    // a desktop browser. The warning would be about a chunk we deliberately
    // split out, so it isn't useful here.
    chunkSizeWarningLimit: 1500,
  },
});
