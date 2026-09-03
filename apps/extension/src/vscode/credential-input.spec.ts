import { describe, expect, it } from 'vitest'
import { normalizeOptionalProviderApiKey } from './credential-input.js'

describe('optional provider API-key input', () => {
  it('treats cancellation and blank input as native-auth selection', () => {
    expect(normalizeOptionalProviderApiKey(undefined)).toBeUndefined()
    expect(normalizeOptionalProviderApiKey('   ')).toBeUndefined()
    expect(normalizeOptionalProviderApiKey('  sk-provider  ')).toBe('sk-provider')
  })

  it('rejects pasted environment assignments, quote wrappers, and whitespace-bearing values', () => {
    for (const value of [
      'DSH_API_KEY=sk-value',
      '"sk-value"',
      "'sk-value'",
      '`sk-value`',
      'sk value',
      'sk\nvalue',
    ]) {
      expect(() => normalizeOptionalProviderApiKey(value)).toThrow(/printable value/i)
    }
  })
})
