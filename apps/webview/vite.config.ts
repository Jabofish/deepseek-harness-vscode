import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  // Extension assets live below a Webview resource URI, never at the origin root.
  base: './',
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
    // Native module imports inherit the entry's nonce. Generated preload links
    // have no nonce and cannot run under the Webview's strict script-src policy.
    modulePreload: false,
    // font-src only permits packaged resources, including very small KaTeX fonts.
    assetsInlineLimit: (filePath) => (/\.(?:woff2?|ttf)$/u.test(filePath) ? false : undefined),
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
