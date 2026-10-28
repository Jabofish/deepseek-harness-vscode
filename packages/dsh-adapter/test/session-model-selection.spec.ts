import { describe, expect, it } from 'vitest'

import type { DshTransport } from '../src/contracts.js'
import { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'
import { Alpha212SessionRepository } from '../src/versions/alpha212/session-repository.js'

// Normalized session.history at dsh-v0.2.1-alpha.2 / d743267388641bc76f17c45ce8b4c231aed1d32c.
// api/session-controller/src/model-selection-projection.ts keeps pending intent
// when a request header uses a different route, and omitted effort means no override.
interface HistoryFact {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

function repository(
  facts: readonly HistoryFact[],
  modelSelection?: Readonly<Record<string, unknown>>,
): Alpha212SessionRepository {
  const transport: DshTransport = {
    request: <T>(method: string): Promise<T> => {
      if (method === 'workspace.list')
        return Promise.resolve({ result: { ok: true, value: { items: [] } } } as T)
      if (method !== 'session.history') throw new Error(`Unexpected fixture RPC: ${method}`)
      return Promise.resolve({
        result: {
          ok: true,
          value: {
            events: facts.map((fact, seq) => ({ event: { ...fact, seq, time: 1000 + seq } })),
            hasMore: false,
            ...(modelSelection === undefined
              ? {}
              : { projections: { asOfSeq: facts.length - 1, values: { modelSelection } } }),
          },
        },
      } as T)
    },
    remoteRequest: <T>(): Promise<T> => Promise.reject(new Error('Unexpected fixture Remote')),
    async *openEventStream() {},
    close: () => Promise.resolve(),
  }
  return new Alpha212SessionRepository(transport, new Rc6WorkspaceRepository(transport), undefined, {})
}

const oldSelection = { provider: 'old', model: 'old-model', reasoningEffort: 'high' }
const history: readonly HistoryFact[] = [
  { type: 'model/selection', data: { provider: 'pending', model: 'pending-model' } },
  { type: 'request/header', data: { header: { config: oldSelection } } },
]

describe('session model selection readback', () => {
  it.each([undefined, 'low'])(
    'keeps pending projection intent with effort %s over past request use',
    async (effort) => {
      const next = {
        provider: 'pending',
        model: 'pending-model',
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      }
      const detail = await repository(history, { next, lastUsed: oldSelection }).get('s1')
      expect(detail.configuration.model).toEqual({
        providerId: 'pending',
        modelId: 'pending-model',
        ...(effort === undefined ? {} : { reasoningLevel: effort }),
      })
    },
  )

  it('preserves an authoritative unselected projection instead of resurrecting old history', async () => {
    const detail = await repository(history, { next: null, lastUsed: null }).get('s1')
    expect(detail.configuration.model).toEqual({ providerId: '', modelId: '' })
  })

  it('does not interpret same-route context metadata as clearing a selected effort', async () => {
    const detail = await repository([
      { type: 'model/selection', data: oldSelection },
      { type: 'request/context', data: { provider: 'old', model: 'old-model', contextWindow: 8192 } },
    ]).get('s1')
    expect(detail.configuration.model).toEqual({
      providerId: 'old',
      modelId: 'old-model',
      reasoningLevel: 'high',
    })
  })
})
