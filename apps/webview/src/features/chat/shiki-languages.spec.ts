// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { getWebviewHighlighter, resolveBundledLanguage, SHIKI_THEMES } from './shiki.js'

/**
 * The Webview CSP refuses WebAssembly, so the JavaScript regex engine has to
 * convert every bundled grammar. A grammar the engine cannot convert would
 * silently render as plaintext, so each whitelisted language is highlighted
 * here for real.
 */
const SAMPLES: Readonly<Record<string, string>> = {
  cpp: 'int main() { return 0; }',
  csharp: 'public class A { public int B = 1; }',
  go: 'package main\nfunc main() {}',
  html: '<a href="#x">y</a>',
  java: 'class A { int b = 1; }',
  javascript: 'const a = 1',
  json: '{"a": 1}',
  jsx: 'const a = <div className="x">y</div>',
  markdown: '# Title\n\n- item',
  powershell: 'Get-ChildItem -Path C: | Select-Object Name',
  python: 'def f(x):\n    return x + 1',
  shell: 'echo hi | grep h',
  sql: 'SELECT a FROM t WHERE b = 1',
  swift: 'let a: Int = 1',
  tsx: 'const a = <div>{1}</div>',
  typescript: 'const a: number = 1',
  xml: '<a b="c">d</a>',
  yaml: 'a: 1\nb:\n  - c',
}

describe('bundled language coverage', () => {
  it('verifies every bundled grammar and highlights it on the wasm-free engine', async () => {
    const highlighter = await getWebviewHighlighter()

    expect(Object.keys(highlighter.getBundledLanguages()).sort()).toEqual(Object.keys(SAMPLES).sort())

    for (const [id, source] of Object.entries(SAMPLES)) {
      const language = resolveBundledLanguage(id)
      if (language === undefined) throw new Error(`${id} is not in the bundled language set`)

      await highlighter.loadLanguage(language)
      const html = highlighter.codeToHtml(source, {
        lang: language,
        themes: SHIKI_THEMES,
        defaultColor: 'light-dark()',
        rootStyle: false,
      })
      expect(html, `${id} must produce highlighted output`).toMatch(/style="color:(light-dark\()?#/u)
    }
  }, 60_000)
})
