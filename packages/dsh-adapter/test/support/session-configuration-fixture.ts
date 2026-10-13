import { AppError, type AgentConfiguration } from '@dsh-vscode/domain'
import type { DshTransport } from '../../src/contracts.js'
import { Alpha212SessionRepository } from '../../src/versions/alpha212/session-repository.js'
import { Rc6WorkspaceRepository } from '../../src/repositories/workspace-repository.js'

// alpha212: d743267388641bc76f17c45ce8b4c231aed1d32c, interaction/commands/src/types.ts
// CommandExecution and api/session-controller/src/model-selection-projection.ts.
// This fixture answers at the normalized DshTransport boundary, after native Remote decoding.
const permissions = ['read-only', 'workspace-write', 'danger-full-access']

export function configuration(
  permissionPreset: string,
  providerId = 'old',
  planMode = false,
): AgentConfiguration {
  return {
    preset: 'standard',
    toolMode: 'native',
    permissionPreset,
    planMode,
    model: { providerId, modelId: `model-${providerId}` },
  }
}

export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

export interface ConfigurationCall {
  readonly method: string
  readonly sessionId: string
  readonly line?: string
  readonly provider?: string
}

interface RawEvent {
  readonly event: {
    readonly type: string
    readonly seq: number
    readonly time: number
    readonly data: Readonly<Record<string, unknown>>
  }
}

export interface MutableConfiguration {
  permission: string
  plan: boolean
  provider: string
  model: string
  readonly events: RawEvent[]
}

export interface ConfigurationFixtureOptions {
  readonly planExposed?: boolean
  readonly commandOutcome?: (call: ConfigurationCall) => 'success' | 'error' | 'unknown'
  readonly afterCommand?: (call: ConfigurationCall, signal?: AbortSignal) => Promise<void>
  readonly beforeModel?: (call: ConfigurationCall, signal?: AbortSignal) => Promise<void>
  readonly afterModel?: (call: ConfigurationCall, signal?: AbortSignal) => Promise<void>
}

export function configurationFixture(options: ConfigurationFixtureOptions = {}): {
  readonly repository: Alpha212SessionRepository
  readonly calls: ConfigurationCall[]
  readonly state: ReadonlyMap<string, MutableConfiguration>
} {
  const state = new Map<string, MutableConfiguration>(
    ['s1', 's2'].map((id) => [
      id,
      {
        permission: 'read-only',
        plan: false,
        provider: 'old',
        model: 'model-old',
        events: [
          { event: { type: 'permission/preset', seq: 1, time: 1000, data: { preset: 'read-only' } } },
          { event: { type: 'plan/mode', seq: 2, time: 1001, data: { active: false } } },
          {
            event: {
              type: 'model/selection',
              seq: 3,
              time: 1002,
              data: { provider: 'old', model: 'model-old' },
            },
          },
        ]
          .filter((entry) => options.planExposed !== false || entry.event.type !== 'plan/mode')
          .map((entry, index) => ({ event: { ...entry.event, seq: index + 1 } })),
      },
    ]),
  )
  const calls: ConfigurationCall[] = []
  const append = (
    session: MutableConfiguration,
    type: string,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const seq = session.events.length + 1
    session.events.push({ event: { type, seq, time: 1000 + seq, data } })
  }
  const assertActive = (signal?: AbortSignal): void => {
    if (signal?.aborted === true)
      throw new AppError({
        code: 'REQUEST_CANCELLED',
        message: 'Fixture request cancelled.',
        retryable: false,
      })
  }
  const transport: DshTransport = {
    request: async <T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
      assertActive(signal)
      const p = params as Readonly<Record<string, unknown>>
      if (method === 'workspace.list') return { result: { ok: true, value: { items: [] } } } as T
      const sessionId = String(p.sessionId)
      const session = state.get(sessionId)
      if (session === undefined) throw new Error('Unknown fixture session')
      const call = {
        method,
        sessionId,
        ...(method === 'session.selectModel' ? { provider: String(p.provider) } : {}),
      }
      calls.push(call)
      if (method === 'session.history') {
        const events = structuredClone(session.events)
        return {
          result: {
            ok: true,
            value: {
              events,
              hasMore: false,
              projections: {
                asOfSeq: events.length,
                values: {
                  ...(options.planExposed === false
                    ? {}
                    : { plan: { active: session.plan, pending: false } }),
                  permissions: { currentValue: session.permission },
                  modelSelection: {
                    lastUsed: null,
                    next:
                      session.provider === '' || session.model === ''
                        ? null
                        : { provider: session.provider, model: session.model },
                  },
                },
              },
            },
          },
        } as T
      }
      if (method === 'session.selectModel') {
        await options.beforeModel?.(call, signal)
        assertActive(signal)
        if (p.provider === 'unavailable')
          return {
            result: { ok: false, error: { code: 'model-unavailable', message: 'Model is unavailable.' } },
          } as T
        session.provider = String(p.provider)
        session.model = String(p.model)
        append(session, 'model/selection', { provider: session.provider, model: session.model })
        await options.afterModel?.(call, signal)
        assertActive(signal)
        return {
          result: { ok: true, value: { selected: { provider: session.provider, model: session.model } } },
        } as T
      }
      throw new Error(`Unexpected fixture RPC: ${method}`)
    },
    remoteRequest: async <T>(
      method: string,
      params: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<T> => {
      assertActive(signal)
      if (
        method !== 'commands/execute' ||
        !Array.isArray(params.submittedAttachments) ||
        params.submittedAttachments.length !== 0
      )
        throw new Error('Unexpected configuration command wire')
      const sessionId = String(params.agentId)
      const session = state.get(sessionId)
      if (session === undefined) throw new Error('Unknown fixture session')
      const call = { method, sessionId, line: String(params.line) }
      calls.push(call)
      const outcome = options.commandOutcome?.(call) ?? 'success'
      if (outcome === 'unknown') return { ok: true } as T
      const commandId = `command-${calls.length}`
      if (outcome === 'error')
        return {
          ok: true,
          value: {
            commandId,
            result: { kind: 'error', text: 'Permission admission rejected. api_key=fixture-secret' },
          },
        } as T
      if (call.line.startsWith('/permission ')) {
        session.permission = call.line.slice('/permission '.length)
        append(session, 'permission/preset', { preset: session.permission })
      } else if (call.line === '/plan' || call.line === '/plan off') {
        session.plan = call.line === '/plan'
        append(session, 'plan/mode', { active: session.plan })
      } else throw new Error('Unexpected fixture command')
      // Only response delivery is delayed, after the command has committed.
      await options.afterCommand?.(call, signal)
      assertActive(signal)
      return { ok: true, value: { commandId, result: { kind: 'success' } } } as T
    },
    async *openEventStream() {},
    close: () => Promise.resolve(),
  }
  return {
    repository: new Alpha212SessionRepository(transport, new Rc6WorkspaceRepository(transport), undefined, {
      commandAttachmentWire: 'submittedAttachments',
      readPermissionPresets: () => Promise.resolve(permissions),
    }),
    state,
    calls,
  }
}
