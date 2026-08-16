import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, '../extension/media'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith('.css')) ? 'webview.css' : '[name][extname]',
      },
    },
  },
})
