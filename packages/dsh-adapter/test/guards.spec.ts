import { describe, expect, it } from 'vitest'

import {
  validProjectionBlock,
  validProviderView,
  validSettingsNamespace,
  walkHistoryPages,
} from '../src/repositories/shared/guards.js'

describe('shared repository guards', () => {
  it('validates common projection, provider, and settings shapes', () => {
    expect(validProjectionBlock({ asOfSeq: 4, values: {} })).toBe(true)
    expect(validProjectionBlock({ asOfSeq: 4, values: [] })).toBe(false)
    expect(
      validProviderView({
        provider: 'openai',
        displayName: 'OpenAI',
        settingsNs: 'llm.openai',
        settingsPath: ['providers', 'openai'],
        active: true,
      }),
    ).toBe(true)
    expect(
      validSettingsNamespace({
        ns: 'llm.openai',
        schema: {},
        value: {},
        applies: 'live',
        revision: 1,
        secrets: [{ path: ['apiKey'], set: true }],
      }),
    ).toBe(true)
  })

  it('walks newest-first pages and stops on a projection or a non-progressing cursor', async () => {
    const requests: Array<number | undefined> = []
    const pages = await walkHistoryPages<{
      readonly events: readonly { readonly sequence: number }[]
      readonly hasMore: boolean
    }>(
      (beforeSequence) => {
        requests.push(beforeSequence)
        return Promise.resolve(
          beforeSequence === undefined
            ? { events: [{ sequence: 10 }, { sequence: 9 }], hasMore: true }
            : { events: [{ sequence: 8 }], hasMore: false },
        )
      },
      { stopWhen: (page) => page.events.some((event) => event.sequence === 8) },
    )

    expect(pages).toHaveLength(2)
    expect(requests).toEqual([undefined, 9])
  })
})
