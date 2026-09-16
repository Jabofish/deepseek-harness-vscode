import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SubagentRepository } from '../src/repositories/subagent-repository.js'
import { SubagentAddressRegistry } from '../src/repositories/shared/subagent-addresses.js'

interface Call {
  readonly method: string
  readonly params: unknown
}

type Handler = (method: string, params: unknown) => unknown

function transportFor(handler: Handler, calls: Call[] = []): DshTransport {
  return {
    request: <TResponse>(method: string, params: unknown) => {
      calls.push({ method, params })
      return Promise.resolve({ result: { ok: true, value: handler(method, params) } } as TResponse)
    },
    remoteRequest: <TResponse>() =>
      Promise.reject<TResponse>(new Error('remote transport is not part of this contract')),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

const healthyCatalog = {
  entries: [
    {
      kind: 'child',
      id: 'one-shot-child',
      activity: 'inactive',
      hasChildren: false,
      mode: 'one-shot',
    },
    {
      kind: 'child',
      id: 'continuable-child',
      label: 'researcher',
      activity: 'running',
      hasChildren: true,
      mode: 'continuable',
    },
    { kind: 'diagnostic', id: 'corrupt-child', reason: 'corrupt' },
    { kind: 'diagnostic', id: 'unsupported-child', reason: 'unsupported' },
    { kind: 'diagnostic', id: 'unavailable-child', reason: 'unavailable' },
  ],
  parentAvailable: true,
} as const

describe('Rc6SubagentRepository catalog', () => {
  it('preserves healthy modes, activity, nesting and every diagnostic reason', async () => {
    const calls: Call[] = []
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        throw new Error(`unexpected RPC ${method}`)
      }, calls),
    )

    await expect(repository.list('parent')).resolves.toEqual({
      entries: [
        {
          kind: 'child',
          id: 'one-shot-child',
          activity: 'inactive',
          hasChildren: false,
          mode: 'one-shot',
          parentSessionId: 'parent',
        },
        {
          kind: 'child',
          id: 'continuable-child',
          label: 'researcher',
          activity: 'running',
          hasChildren: true,
          mode: 'continuable',
          parentSessionId: 'parent',
        },
        { kind: 'diagnostic', id: 'corrupt-child', parentSessionId: 'parent', reason: 'corrupt' },
        {
          kind: 'diagnostic',
          id: 'unsupported-child',
          parentSessionId: 'parent',
          reason: 'unsupported',
        },
        {
          kind: 'diagnostic',
          id: 'unavailable-child',
          parentSessionId: 'parent',
          reason: 'unavailable',
        },
      ],
      parentAvailable: true,
    })
    expect(calls).toEqual([{ method: 'subagent.list', params: { parentSessionId: 'parent' } }])
  })

  it('rejects a catalog that omits parentAvailable', async () => {
    const repository = new Rc6SubagentRepository(transportFor(() => ({ entries: healthyCatalog.entries })))
    await expect(repository.list('parent')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it.each([
    ['activity', { activity: 'waiting' }],
    ['mode', { mode: 'resumable' }],
    ['hasChildren', { hasChildren: 'yes' }],
    ['optional label', { label: 42 }],
    ['continuable label', { mode: 'continuable', label: undefined }],
  ])('rejects a child with malformed %s', async (_label, override) => {
    const repository = new Rc6SubagentRepository(
      transportFor(() => ({
        entries: [
          {
            kind: 'child',
            id: 'child',
            activity: 'inactive',
            hasChildren: false,
            mode: 'one-shot',
            ...override,
          },
        ],
        parentAvailable: true,
      })),
    )
    await expect(repository.list('parent')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('does not pollute a previously valid address cache when a refresh is malformed', async () => {
    let listCount = 0
    const calls: Call[] = []
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') {
          listCount += 1
          return listCount === 1
            ? {
                entries: [
                  {
                    kind: 'child',
                    id: 'child',
                    label: 'worker',
                    activity: 'inactive',
                    hasChildren: false,
                    mode: 'continuable',
                  },
                ],
                parentAvailable: true,
              }
            : {
                entries: [
                  {
                    kind: 'child',
                    id: 'child',
                    label: 'worker',
                    activity: 'broken',
                    hasChildren: false,
                    mode: 'continuable',
                  },
                ],
                parentAvailable: true,
              }
        }
        if (method === 'subagent.prompt') return { messageId: 'message-1' }
        throw new Error(`unexpected RPC ${method}`)
      }, calls),
    )

    await repository.list('parent')
    await expect(repository.list('parent')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(repository.send('child', 'still routed')).resolves.toBeUndefined()
    expect(calls.at(-1)).toEqual({
      method: 'subagent.prompt',
      params: {
        parentSessionId: 'parent',
        childSessionId: 'child',
        mode: 'continuable',
        content: [{ type: 'text', text: 'still routed' }],
        clientTimeZone: expect.stringMatching(
          /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$|^UTC$/u,
        ) as unknown,
      },
    })
  })
})

describe('Rc6SubagentRepository addressed operations', () => {
  it('forwards text attachments on every alpha generation without treating them as images', async () => {
    const calls: Call[] = []
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.prompt') return { messageId: 'message-text-file' }
        throw new Error(`unexpected RPC ${method}`)
      }, calls),
    )
    await repository.list('parent')

    await expect(
      repository.send('continuable-child', '请阅读附件', [
        { uri: 'data:text/plain;base64,aGk=', name: 'note.txt', mimeType: 'text/plain' },
      ]),
    ).resolves.toBeUndefined()
    expect(calls.at(-1)).toEqual({
      method: 'subagent.prompt',
      params: {
        parentSessionId: 'parent',
        childSessionId: 'continuable-child',
        mode: 'continuable',
        content: [
          { type: 'text', text: '请阅读附件' },
          { type: 'text', text: '\n\nAttached file: note.txt\n\nhi\n\nEnd of attached file: note.txt' },
        ],
        clientTimeZone: expect.stringMatching(
          /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$|^UTC$/u,
        ) as unknown,
      },
    })
  })

  it('preserves the legacy signal-only follow-up overload', async () => {
    const calls: Call[] = []
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.prompt') return { messageId: 'message-legacy' }
        throw new Error(`unexpected RPC ${method}`)
      }, calls),
    )
    await repository.list('parent')

    await expect(
      repository.send('continuable-child', 'legacy follow-up', new AbortController().signal),
    ).resolves.toBeUndefined()
    expect(calls.at(-1)).toMatchObject({
      method: 'subagent.prompt',
      params: { parentSessionId: 'parent', childSessionId: 'continuable-child', mode: 'continuable' },
    })
  })

  it('forwards queue and steer delivery only when the alpha.2 wire requires it', async () => {
    const calls: Call[] = []
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.prompt') return { messageId: 'message-delivery' }
        throw new Error(`unexpected RPC ${method}`)
      }, calls),
      { subagentPromptDelivery: true },
    )
    await repository.list('parent')

    await repository.send('continuable-child', 'queue follow-up', [], 'queue')
    expect(calls.at(-1)).toEqual({
      method: 'subagent.prompt',
      params: {
        parentSessionId: 'parent',
        childSessionId: 'continuable-child',
        mode: 'continuable',
        delivery: 'queue',
        content: [{ type: 'text', text: 'queue follow-up' }],
        clientTimeZone: expect.stringMatching(
          /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$|^UTC$/u,
        ) as unknown,
      },
    })

    await repository.send('continuable-child', 'steer follow-up', [], 'steer')
    expect(calls.at(-1)).toMatchObject({
      method: 'subagent.prompt',
      params: { delivery: 'steer' },
    })
  })

  it('preserves alpha inline image parts when the adapter explicitly enables them', async () => {
    const calls: Call[] = []
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.prompt') return { messageId: 'message-image' }
        throw new Error(`unexpected RPC ${method}`)
      }, calls),
      { inlineImagePrompts: true },
    )
    await repository.list('parent')

    await expect(
      repository.send('continuable-child', '看这张图', [
        { uri: 'data:image/png;base64,iVBORw0KGgo=', name: 'screen.png', mimeType: 'image/png' },
      ]),
    ).resolves.toBeUndefined()
    expect(calls.at(-1)).toEqual({
      method: 'subagent.prompt',
      params: {
        parentSessionId: 'parent',
        childSessionId: 'continuable-child',
        mode: 'continuable',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'screen.png' },
        ],
        clientTimeZone: expect.stringMatching(
          /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$|^UTC$/u,
        ) as unknown,
      },
    })
  })

  it('rejects inline images on the rc.6 contract before sending a fabricated durable block', async () => {
    const calls: Call[] = []
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        throw new Error(`unexpected RPC ${method}`)
      }, calls),
    )
    await repository.list('parent')

    await expect(
      repository.send('continuable-child', '看这张图', [
        { uri: 'data:image/png;base64,iVBORw0KGgo=', name: 'screen.png', mimeType: 'image/png' },
      ]),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    expect(calls).toHaveLength(1)
  })

  it('routes follow-up, history and interrupt through the exact catalog address', async () => {
    const calls: Call[] = []
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.prompt') return { messageId: 'message-1' }
        if (method === 'subagent.history')
          return {
            events: [],
            hasMore: false,
            projections: { asOfSeq: 8, values: { title: 'Child title' } },
          }
        if (method === 'subagent.interrupt') return { accepted: true }
        throw new Error(`unexpected RPC ${method}`)
      }, calls),
    )
    await repository.list('parent')

    await repository.send('continuable-child', 'follow up')
    await expect(repository.history('continuable-child', { beforeSequence: 3 })).resolves.toEqual({
      events: [],
      hasMore: false,
      projection: { asOfSequence: 8, values: { title: 'Child title' } },
    })
    await repository.interrupt('continuable-child')

    expect(calls.slice(1)).toEqual([
      {
        method: 'subagent.prompt',
        params: {
          parentSessionId: 'parent',
          childSessionId: 'continuable-child',
          mode: 'continuable',
          content: [{ type: 'text', text: 'follow up' }],
          clientTimeZone: expect.stringMatching(
            /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$|^UTC$/u,
          ) as unknown,
        },
      },
      {
        method: 'subagent.history',
        params: {
          parentSessionId: 'parent',
          childSessionId: 'continuable-child',
          mode: 'continuable',
          maxMessages: 50,
          beforeSeq: 3,
        },
      },
      {
        method: 'subagent.interrupt',
        params: {
          parentSessionId: 'parent',
          childSessionId: 'continuable-child',
          mode: 'continuable',
        },
      },
    ])
  })

  it('reports the oldest durable sequence as the paging cursor of a child transcript', async () => {
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.history')
          return {
            events: [
              { event: { type: 'system/message', seq: 40, time: 1_000 } },
              { event: { type: 'turn/start', seq: 42, time: 2_000, data: { turn: 1 } } },
            ],
            hasMore: true,
          }
        throw new Error(`unexpected RPC ${method}`)
      }),
    )
    await repository.list('parent')

    const page = await repository.history('continuable-child')

    // The hidden prompt marker still holds the oldest durable sequence: a
    // cursor taken from the visible rows alone would leave the page after it
    // unreachable whenever a page opens with the marker.
    expect(page).toMatchObject({ hasMore: true, beforeSequence: 40 })
    expect(page.events.map((entry) => entry.sequence)).toEqual([42])
  })

  it('keeps the page cursor absent when the page holds no durable record', async () => {
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.history') return { events: [], hasMore: false }
        throw new Error(`unexpected RPC ${method}`)
      }),
    )
    await repository.list('parent')

    await expect(repository.history('continuable-child')).resolves.toEqual({ events: [], hasMore: false })
  })

  it('rejects malformed prompt and interrupt receipts', async () => {
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.prompt') return { messageId: '' }
        if (method === 'subagent.interrupt') return { accepted: false }
        throw new Error(`unexpected RPC ${method}`)
      }),
    )
    await repository.list('parent')
    await expect(repository.send('continuable-child', 'follow up')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await expect(repository.interrupt('continuable-child')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it('rejects a malformed history page', async () => {
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.history') return { events: [], hasMore: 'later' }
        throw new Error(`unexpected RPC ${method}`)
      }),
    )
    await repository.list('parent')
    await expect(repository.history('continuable-child')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it('keeps one-shot history readable while refusing follow-up and interrupt', async () => {
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method === 'subagent.list') return healthyCatalog
        if (method === 'subagent.history') return { events: [], hasMore: false }
        throw new Error(`unexpected RPC ${method}`)
      }),
    )
    await repository.list('parent')

    await expect(repository.history('one-shot-child')).resolves.toEqual({ events: [], hasMore: false })
    await expect(repository.send('one-shot-child', 'no')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    await expect(repository.interrupt('one-shot-child')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })
})

describe('Rc6SubagentRepository parent routing', () => {
  const child = (id: string, mode: 'one-shot' | 'continuable'): unknown => ({
    kind: 'child',
    id,
    ...(mode === 'continuable' ? { label: id } : {}),
    activity: 'inactive',
    hasChildren: false,
    mode,
  })

  it('publishes every catalog child to the registry the transport reads', async () => {
    const addresses = new SubagentAddressRegistry()
    const repository = new Rc6SubagentRepository(
      transportFor(() => ({
        entries: [child('child-a', 'continuable'), child('child-b', 'one-shot')],
        parentAvailable: true,
      })),
      { addresses },
    )

    await repository.list('parent')

    expect(repository.parentOf('child-a')).toBe('parent')
    expect(repository.parentOf('child-b')).toBe('parent')
    expect(repository.parentOf('never-listed')).toBeUndefined()
    expect(addresses.resolve('child-a')).toEqual({ parentSessionId: 'parent', mode: 'continuable' })
    expect(addresses.resolve('child-b')).toEqual({ parentSessionId: 'parent', mode: 'one-shot' })
  })

  it('drops routing for a child the newest catalog no longer lists as a child', async () => {
    const calls: Call[] = []
    let catalog = 0
    const repository = new Rc6SubagentRepository(
      transportFor((method) => {
        if (method !== 'subagent.list') throw new Error(`unexpected RPC ${method}`)
        catalog += 1
        // The second refresh turns the dropped child into a diagnostic: the
        // host keeps the row but no longer describes it as resumable, so an
        // ownership walk must not keep authorizing it from a stale catalog.
        return catalog === 1
          ? {
              entries: [child('child-a', 'continuable'), child('child-b', 'continuable')],
              parentAvailable: true,
            }
          : {
              entries: [
                child('child-a', 'continuable'),
                { kind: 'diagnostic', id: 'child-b', reason: 'corrupt' },
              ],
              parentAvailable: true,
            }
      }, calls),
    )

    await repository.list('parent')
    expect(repository.parentOf('child-b')).toBe('parent')

    await repository.list('parent')
    expect(repository.parentOf('child-a')).toBe('parent')
    expect(repository.parentOf('child-b')).toBeUndefined()
    await expect(repository.send('child-b', 'hello')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })
})

describe('Rc6SubagentRepository concurrent refreshes', () => {
  it('does not let an older catalog response commit after a newer one', async () => {
    const releases: Array<(value: unknown) => void> = []
    const repository = new Rc6SubagentRepository({
      request: <TResponse>(method: string) => {
        if (method === 'subagent.prompt')
          return Promise.resolve({ result: { ok: true, value: { messageId: 'message-1' } } } as TResponse)
        if (method !== 'subagent.list') return Promise.reject(new Error('unexpected RPC'))
        return new Promise<TResponse>((resolve) => {
          releases.push((value) => resolve({ result: { ok: true, value } } as TResponse))
        })
      },
      remoteRequest: () => Promise.reject(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    })

    // The refresh started first describes the parent BEFORE a child appeared;
    // the refresh started second is the newer catalog.
    const older = repository.list('parent')
    const newer = repository.list('parent')
    releases[1]?.({
      entries: [
        {
          kind: 'child',
          id: 'child-new',
          label: 'new',
          activity: 'running',
          hasChildren: false,
          mode: 'continuable',
        },
      ],
      parentAvailable: true,
    })
    await newer
    releases[0]?.({ entries: [], parentAvailable: true })
    await older

    // The older response committed last and deleted the child the newer
    // catalog had just routed, breaking follow-ups until another refresh.
    await expect(repository.send('child-new', 'follow-up')).resolves.toBeUndefined()
  })
})
