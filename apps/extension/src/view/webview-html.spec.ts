import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { readonly toString: () => string }, ...parts: readonly string[]) => ({
      toString: () => [base.toString(), ...parts].join('/'),
    }),
  },
}))

import { createWebviewHtml } from './webview-html.js'

describe('createWebviewHtml', () => {
  it('loads the Vite ES module bundle as a module', () => {
    const html = createWebviewHtml(
      {
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: unknown): unknown => uri,
      } as never,
      { toString: () => 'extension-root' } as never,
    )

    expect(html).toMatch(
      /<script type="module" nonce="[^"]+" src="extension-root\/media\/webview\.js"><\/script>/,
    )
    expect(html).toMatch(/script-src 'nonce-[^']+'/)
  })
})
