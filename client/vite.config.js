import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Proxy API calls to backend in dev
    proxy: {
      '/api': 'http://localhost:3000',
      '/storefront': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/load': 'http://localhost:3000',
    },
  },
});
