import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: 'web',
  base: '/',
  build: {
    outDir: path.resolve('public'),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: 'assets'
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/v1': 'http://127.0.0.1:3000',
      '/v1beta': 'http://127.0.0.1:3000'
    }
  }
});
