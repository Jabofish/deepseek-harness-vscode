import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // markdown-it-texmath is CommonJS and reaches KaTeX through
      // require('katex') (dist/katex.js) while MarkdownContent imports the ESM
      // build. Without one target the entry chunk carries two copies.
      { find: /^katex$/, replacement: 'katex/dist/katex.mjs' },
    ],
  },
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
