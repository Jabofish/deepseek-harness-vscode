import type { SessionDetail, SessionHistoryEvent, SessionHistoryPage } from '@dsh-vscode/domain'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import { TranscriptWindowService } from '../../../extension/src/view/transcript-window.js'
import { createAppStore } from '../app/store.js'
import type { ProtocolClient } from '../app/protocol-client.js'
import { domainEvent } from './domain-fixture/index.js'
import { parseHostDomainEvent } from '../app/store/event-parser.js'
import { isSessionOpenDetail } from '../app/store/session-guards.js'

/** Backend fixture reads are deliberately outside the retired Webview protocol. */
export type FixtureRequest =
  | Exclude<WebviewRequest, { type: 'subagent.history' }>
  | {
      type: 'session.history' | 'subagent.history'
      requestId: string
      payload: {
        sessionId: string
        beforeSeq?: number
        maxMessages?: number
        pagePurpose?: 'transcript' | 'gap-recovery'
      }
    }

/** Existing synthetic Domain fixtures now enter through the real Host projector.
 * No journal/reorder/replay implementation lives in this test bridge. Publication
 * is synchronous here; real coalescing/ACK/visibility are tested at the Host seam.
 */
export function createHostBackedAppStore(
  client: ProtocolClient,
  options: {
    read?: ConstructorParameters<typeof TranscriptWindowService>[0]['read']
    onContent?: (content: string) => void
  } = {},
): ReturnType<typeof createAppStore> {
  const backend = client as unknown as { request<T>(request: FixtureRequest): Promise<T> }
  const listeners = new Set<(message: HostMessage) => void>()
  const emit = (message: HostMessage): void => {
    for (const listener of listeners) listener(message)
  }
  const entries = (value: unknown): readonly SessionHistoryEvent[] => {
    if (!Array.isArray(value)) return []
    return value.map((entry: SessionHistoryEvent) => {
      if (
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence < 0 ||
        (entry.time !== undefined && typeof entry.time !== 'string')
      )
        throw new Error('Malformed subagent history page fixture')
      const event = domainEvent(entry.event.type, entry.event)
      if (event === undefined) throw new Error('Invalid Domain fixture')
      return { ...entry, event: { ...event, sequence: entry.sequence } }
    })
  }
  const page = (raw: unknown): SessionHistoryPage => {
    const value = raw as Record<string, unknown>
    if (
      value.beforeSeq !== undefined &&
      (!Number.isSafeInteger(value.beforeSeq) || (value.beforeSeq as number) < 0)
    )
      throw new Error('Invalid fixture history cursor')
    return {
      events: entries(value.events),
      hasMore: value.hasMore === true,
      ...(value.beforeSeq === undefined ? {} : { beforeSequence: value.beforeSeq as number }),
      ...(value.projection === undefined
        ? {}
        : { projection: value.projection as NonNullable<SessionHistoryPage['projection']> }),
    }
  }
  const host = new TranscriptWindowService({
    read:
      options.read ??
      (async (sessionId, beforeSeq, _signal, child) =>
        page(
          await backend.request({
            type: child ? 'subagent.history' : 'session.history',
            requestId: 'fixture-host-read',
            payload: { sessionId, ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: 200 },
          }),
        )),
    publicValue: (value) => value,
    post: () => Promise.resolve(true),
    invalidate: (sessionId) =>
      emit({ type: 'event', name: 'session.transcript.invalidated', sequence: 0, payload: { sessionId } }),
  })
  host.setVisible(false)
  const unsubscribe = client.subscribe((message) => {
    if (message.type !== 'event' || message.name === 'session.transcript' || message.name.startsWith('ui.')) {
      emit(message)
      return
    }
    if (
      [
        'connection.snapshot',
        'connection.output',
        'runtime.update.progress',
        'ui.sessions.toggle',
        'ui.settings.toggle',
        'session.created',
      ].includes(message.name)
    ) {
      emit(message)
      return
    }
    let event = domainEvent(message.name, message.payload)
    if (event === undefined || event === null) {
      emit(message)
      return
    }
    // Older synthetic fixtures put their durable position on the envelope.
    // Real wire/transport identities are exercised separately in Adapter tests.
    const transient =
      ((event.type === 'message.delta' || event.type === 'reasoning.delta') &&
        event.transientSequence !== undefined) ||
      (event.type === 'message.completed' && event.interrupted === true)
    if (
      event.sequence === undefined &&
      !transient &&
      !['notice', 'tool.preparing', 'session.gap', 'unknown'].includes(event.type)
    )
      event = { ...event, sequence: message.sequence }
    const control = parseHostDomainEvent(message)
    const consumed =
      control !== undefined && (control === null || control.type === 'unknown') ? false : host.accept(event)
    if (!consumed || control !== undefined) emit(message)
    try {
      // Flush the actual bounded Host view without a timer in this synchronous fixture DSL.
      const window = host['snapshot']()
      emit({ type: 'event', name: 'session.transcript', sequence: window.revision, payload: window })
    } catch {
      /* No view is installed while the first open is still pending. */
    }
  })
  const bridge = {
    request: async <T>(request: WebviewRequest): Promise<T> => {
      if (request.type === 'session.open') {
        const generation = host.begin(request.payload.sessionId)
        try {
          const raw = await client.request<unknown>(request)
          if (!isSessionOpenDetail(raw, request.payload.sessionId)) return raw as T
          const detail = raw as unknown as SessionDetail
          const transcript = host.install({ ...detail, history: entries(detail.history) }, generation)
          return { ...detail, history: [], transcript } as T
        } finally {
          host.cancel(generation)
        }
      }
      if (request.type === 'subagent.history') {
        const generation = host.begin(request.payload.sessionId, true)
        try {
          const raw = await client.request<unknown>(request)
          const transcript = host.installPage(request.payload.sessionId, page(raw), generation)
          return { ...(raw as object), events: [], transcript } as T
        } finally {
          host.cancel(generation)
        }
      }
      if (request.type === 'session.transcript.navigate')
        return (await host.navigate(
          request.payload.sessionId,
          request.payload.direction,
          request.payload.revision,
          new AbortController().signal,
        )) as T
      if (request.type === 'session.transcript.ack') {
        host.acknowledge(request.payload.sessionId, request.payload.revision)
        return {} as T
      }
      if (request.type === 'session.transcript.openContent') {
        const content = await host.content(
          request.payload.sessionId,
          request.payload.nodeId,
          request.payload.revision,
          new AbortController().signal,
        )
        options.onContent?.(content)
        return { opened: true } as T
      }
      return client.request<T>(request)
    },
    featureRequest: client.featureRequest?.bind(client),
    subscribeFeature: client.subscribeFeature?.bind(client),
    subscribe: (listener: (message: HostMessage) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      unsubscribe()
      host.dispose()
      listeners.clear()
      client.dispose()
    },
  }
  return createAppStore(bridge as unknown as ProtocolClient)
}
