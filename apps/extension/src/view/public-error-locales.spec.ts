import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONNECTION_ERROR_MESSAGES, PUBLIC_ERROR_FALLBACKS } from './message-router.js'

const locale = (name: string): Readonly<Record<string, string>> =>
  JSON.parse(
    readFileSync(new URL(`../../../webview/src/locales/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, string>

describe('public error sentences', () => {
  it('match the English Webview keys the UI translates them from', () => {
    const en = locale('en')
    const zh = locale('zh')
    for (const [code, sentence] of Object.entries(PUBLIC_ERROR_FALLBACKS)) {
      expect(en[`hostError.${code}`], code).toBe(sentence)
      expect(zh[`hostError.${code}`], code).toBeTypeOf('string')
    }
    for (const [code, sentence] of Object.entries(CONNECTION_ERROR_MESSAGES)) {
      expect(en[`hostError.connection.${code}`], code).toBe(sentence)
      expect(zh[`hostError.connection.${code}`], code).toBeTypeOf('string')
    }
    const webviewKeys = Object.keys(en).filter((key) => key.startsWith('hostError.'))
    expect(webviewKeys.length).toBe(
      Object.keys(PUBLIC_ERROR_FALLBACKS).length + Object.keys(CONNECTION_ERROR_MESSAGES).length,
    )
  })
})
