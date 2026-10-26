import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SubagentRepository } from '../src/repositories/subagent-repository.js'

interface Call {
  readonly method: string
  readonly params: unknown
}

type Handler = (method: string, params: unknown) => unknown

function transportFor(handler: Handler, calls: Call[] = [], sessionHistoryTurnWindow = false): DshTransport {
  return {
    sessionHistoryTurnWindow,
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
})

describe('Rc6SubagentRepository addressed operations', () => {
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

  it('uses version-gated turn windows for initial and older child transcript pages', async () => {
    const calls: Call[] = []
    const repository = new Rc6SubagentRepository(
      transportFor(
        (method) => {
          if (method === 'subagent.list') return healthyCatalog
          if (method === 'subagent.history') return { events: [], hasMore: false }
          throw new Error(`unexpected RPC ${method}`)
        },
        calls,
        true,
      ),
    )
    await repository.list('parent')

    await repository.history('continuable-child')
    await repository.history('continuable-child', { beforeSequence: 9, pageSize: 200 })

    expect(calls.filter((call) => call.method === 'subagent.history').map((call) => call.params)).toEqual([
      {
        parentSessionId: 'parent',
        childSessionId: 'continuable-child',
        mode: 'continuable',
        maxMessages: 500,
        turnWindow: { minMessages: 50, minTurns: 2 },
      },
      {
        parentSessionId: 'parent',
        childSessionId: 'continuable-child',
        mode: 'continuable',
        maxMessages: 500,
        turnWindow: { minMessages: 200, minTurns: 2 },
        beforeSeq: 9,
      },
    ])
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
