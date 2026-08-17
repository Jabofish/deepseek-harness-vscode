import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SubagentRepository } from '../src/repositories/subagent-repository.js'

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
      },
    })
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
    await expect(repository.history('continuable-child')).resolves.toEqual({
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
        },
      },
      {
        method: 'subagent.history',
        params: {
          parentSessionId: 'parent',
          childSessionId: 'continuable-child',
          mode: 'continuable',
          maxMessages: 200,
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
