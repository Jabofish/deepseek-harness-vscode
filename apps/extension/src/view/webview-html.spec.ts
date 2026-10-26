import { describe, expect, it, vi } from 'vitest'

const vscodeEnv = vi.hoisted(() => ({ language: 'en' }))

vi.mock('vscode', () => ({
  env: vscodeEnv,
  Uri: {
    joinPath: (base: { readonly toString: () => string }, ...parts: readonly string[]) => ({
      toString: () => [base.toString(), ...parts].join('/'),
    }),
  },
}))

import { createWebviewHtml } from './webview-html.js'
import { DshWebviewViewProvider } from './dsh-webview-view-provider.js'

describe('createWebviewHtml', () => {
  it('loads the Vite ES module bundle as a module', () => {
    const html = createWebviewHtml(
      {
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: unknown): unknown => uri,
      } as never,
      { toString: () => 'extension-root' } as never,
      'en',
    )

    expect(html).toMatch(
      /<script type="module" nonce="[^"]+" src="extension-root\/media\/webview\.js"><\/script>/,
    )
    expect(html).toMatch(/script-src 'nonce-[^']+'/)
    expect(html).toContain('style-src vscode-resource:')
    expect(html).toContain('style-src-elem vscode-resource:')
    expect(html).toContain("style-src-attr 'unsafe-inline'")
    expect(html).not.toMatch(/script-src[^;]*unsafe-inline/u)
    expect(html).not.toMatch(/style-src-elem[^;]*unsafe-inline/u)
    expect(html).not.toMatch(/unsafe-eval|wasm-unsafe-eval/u)
  })

  it('bootstraps the actual Webview from VS Code env.language', () => {
    vscodeEnv.language = 'zh-Hans'
    const webview = {
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown): unknown => uri,
      html: '',
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    }
    const provider = new DshWebviewViewProvider({
      extensionUri: { toString: () => 'extension-root' } as never,
      onMessage: vi.fn().mockResolvedValue(undefined),
    })

    provider.resolveWebviewView({
      webview,
      visible: true,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    } as never)

    expect(webview.html).toContain('<html lang="zh-CN">')
    provider.dispose()
    vscodeEnv.language = 'en'
  })
})
