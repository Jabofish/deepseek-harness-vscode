import type {
  AgentConfiguration,
  SessionSummary,
  PermissionRequest,
  UserQuestion,
  QueuedInput,
} from '@dsh-vscode/domain'
import type { TimelineNode } from '@dsh-vscode/timeline'
import {
  PROTOCOL_VERSION,
  hostEnvelopeSchema,
  featureHostEnvelopeSchema,
  webviewEnvelopeSchema,
  featureWebviewEnvelopeSchema,
  transcriptWindowSchema,
  type ProtocolEnvelope,
  type WebviewRequest,
  type FeatureRequest,
} from '@dsh-vscode/webview-protocol'
import type { VsCodeApi } from '../vscode-api.js'
import { translate } from '../i18n.js'

// Only the external Host boundary is controlled here. The entrypoint below
// starts the production App, Store, protocol client, providers and styles.
const params = new URLSearchParams(location.search)
const owner = params.get('case') ?? 'explore'
if (sessionStorage.getItem('daily-fixture-owner') !== owner) {
  localStorage.clear()
  sessionStorage.clear()
  sessionStorage.setItem('daily-fixture-owner', owner)
}
document.documentElement.lang = params.get('locale') ?? 'en'
localStorage.setItem('dsh-webview-conversation-layout', params.get('layout') ?? 'classic')
document.documentElement.style.setProperty('--vscode-font-family', 'Arial, sans-serif')
document.documentElement.style.setProperty('--vscode-font-size', '13px')
document.documentElement.style.setProperty('--vscode-editor-background', '#1e1e1e')
document.documentElement.style.setProperty('--vscode-foreground', '#cccccc')
document.body.classList.add('vscode-dark')

const configuration: AgentConfiguration = {
  preset: 'standard',
  toolMode: 'native',
  permissionPreset: 'workspace-write',
  permissionPresetKnown: true,
  planMode: false,
  planModeKnown: true,
  model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
}
const clock = '2026-10-28T00:00:00Z'
let sessions: SessionSummary[] = ['daily-a', 'daily-b', 'daily-c'].map((id, i) => ({
  id,
  title: ['Alpha conversation', 'Beta conversation', 'Gamma conversation'][i] ?? 'Conversation',
  workspaceId: 'daily-workspace',
  blank: false,
  status: 'idle',
  createdAt: clock,
  updatedAt: clock,
}))
const nodes = new Map<string, readonly TimelineNode[]>(
  sessions.map((session) => [
    session.id,
    [
      { kind: 'user-message', id: `${session.id}-question`, markdown: `Question owned by ${session.title}` },
      {
        kind: 'assistant-message',
        id: `${session.id}-answer`,
        markdown: `Answer owned by ${session.title}`,
        streaming: false,
        turn: 0,
        turnCompleted: true,
      },
    ],
  ]),
)
const revisions = new Map<string, number>()
type WireConfiguration = Extract<WebviewRequest, { type: 'session.configure' }>['payload']['configuration']
const configurations = new Map<string, WireConfiguration>()
const models = [
  { id: 'fixture-model', providerId: 'fixture-provider', label: 'Fixture model', supportsReasoning: false },
  { id: 'other-model', providerId: 'fixture-provider', label: 'Alternative model', supportsReasoning: false },
]
const requests: (WebviewRequest | FeatureRequest)[] = []
const receipts: { sessionId: string; text: string; mode: string; attachments: unknown }[] = []
const answers: unknown[] = []
const decisions: unknown[] = []
const failures = new Set<string>()
const holds = new Set<string>()
const waiting = new Map<string, WebviewRequest>()
let sequence = 0
let queue: QueuedInput[] = []
let lastOpened = 'daily-a'
let pickedAttachment = false
let cancelAttachment = false
const transcript = (sessionId: string): unknown =>
  transcriptWindowSchema.parse({
    sessionId,
    revision: revisions.get(sessionId) ?? 1,
    nodes: nodes.get(sessionId) ?? [],
    lastSequence: sequence,
    hasMore: false,
    historical: false,
    omittedNodeIds: [],
    eventFacts: [],
  })
function event(name: string, payload: unknown): void {
  const envelope = hostEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    message: { type: 'event', name, sequence: ++sequence, payload },
  })
  window.dispatchEvent(new MessageEvent('message', { data: envelope }))
}
function status(sessionId: string, value: SessionSummary['status']): void {
  sessions = sessions.map((session) => (session.id === sessionId ? { ...session, status: value } : session))
  event('session.status', { sessionId, status: value })
}
function publish(sessionId: string, next: readonly TimelineNode[]): void {
  nodes.set(sessionId, next)
  revisions.set(sessionId, (revisions.get(sessionId) ?? 1) + 1)
  event('session.transcript', transcript(sessionId))
}
const settings = {
  schema: { version: 'daily-ui-fixture', writable: true, hasDocument: false, fields: [], namespaces: [] },
  values: {},
}
function reply(request: WebviewRequest, payload: unknown, error = false): void {
  const envelope = hostEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    message: error
      ? {
          type: 'response',
          requestId: request.requestId,
          ok: false,
          error: { code: 'BACKEND_UNREACHABLE', message: 'Fixture delivery refused', retryable: true },
        }
      : { type: 'response', requestId: request.requestId, ok: true, payload },
  })
  window.dispatchEvent(new MessageEvent('message', { data: envelope }))
}
function route(request: WebviewRequest): unknown {
  switch (request.type) {
    case 'app.ready':
      event('connection.snapshot', {
        kind: 'connected',
        backendInstanceId: 'daily-fixture',
        connectionGeneration: 1,
      })
      return {}
    case 'surface.titlebarLayout':
    case 'ui.events.ack':
    case 'session.transcript.ack':
      return {}
    case 'connection.retry':
      event('connection.snapshot', { kind: 'connected' })
      return {}
    case 'workspace.list':
      return [
        {
          id: 'daily-workspace',
          name: 'Daily workspace',
          createdAt: clock,
          updatedAt: clock,
          sessionIds: sessions.map((session) => session.id),
          sessionCount: sessions.length,
        },
      ]
    case 'session.list':
      return {
        items: request.payload.archived
          ? []
          : request.payload.search === undefined
            ? sessions
            : sessions.filter((session) =>
                session.title.toLowerCase().includes(request.payload.search?.toLowerCase() ?? ''),
              ),
      }
    case 'session.rename':
      sessions = sessions.map((session) =>
        session.id === request.payload.sessionId ? { ...session, title: request.payload.title } : session,
      )
      return {}
    case 'session.open': {
      lastOpened = request.payload.sessionId
      const summary = sessions.find((session) => session.id === lastOpened)
      if (summary === undefined) throw new Error('Unknown fixture session')
      return {
        ...summary,
        configuration: configurations.get(summary.id) ?? configuration,
        permissionPresets: ['workspace-write', 'read-only'],
        transcript: transcript(summary.id),
      }
    }
    case 'providers.list':
      return [
        { id: 'fixture-provider', name: 'Fixture provider', kind: 'custom', configurable: false, fields: [] },
      ]
    case 'models.list':
      return models
    case 'models.session.list':
      return {
        models,
        failures: [],
        current: (configurations.get(request.payload.sessionId) ?? configuration).model,
        routable: true,
      }
    case 'session.configure':
      configurations.set(request.payload.sessionId, request.payload.configuration)
      return {}
    case 'session.create': {
      const summary: SessionSummary = {
        id: request.payload.sessionId ?? `created-${sessions.length}`,
        title: 'New fixture conversation',
        workspaceId: request.payload.workspaceId ?? 'daily-workspace',
        blank: true,
        status: 'idle',
        createdAt: clock,
        updatedAt: clock,
      }
      sessions.push(summary)
      configurations.set(summary.id, request.payload.configuration)
      return { ...summary, configuration: request.payload.configuration, transcript: transcript(summary.id) }
    }
    case 'preset.list':
      return {
        presets: [{ id: 'standard', name: 'Standard', trust: 'system', isDefault: true }],
        authorable: false,
        modeSelectionEnabled: true,
      }
    case 'permissions.presets.list':
      return { items: ['workspace-write', 'read-only'], defaultPreset: 'workspace-write' }
    case 'settings.read':
      return settings
    case 'command.list':
      return []
    case 'session.queue.list':
      return queue
    case 'session.queue.update':
      queue = queue.map((item) =>
        item.id === request.payload.inputId ? { ...item, text: request.payload.text } : item,
      )
      event('queue.updated', { sessionId: lastOpened, items: queue })
      return {}
    case 'session.queue.remove':
      queue = queue.filter((item) => item.id !== request.payload.inputId)
      event('queue.updated', { sessionId: lastOpened, items: queue })
      return {}
    case 'session.queue.steer':
      queue = queue.map((item) => (item.id === request.payload.inputId ? { ...item, mode: 'steer' } : item))
      event('queue.updated', { sessionId: lastOpened, items: queue })
      return {}
    case 'goal.list':
    case 'job.list':
    case 'feedback.list':
    case 'attachment.open.list':
      return []
    case 'subagent.list':
      return { entries: [], parentAvailable: true }
    case 'runtime.update.check':
      return {
        currentVersion: '0.2.1-rc.2',
        globalVersion: '0.2.1-rc.2',
        latestVersion: '0.2.1-rc.2',
        updateAvailable: false,
        restartRequired: false,
      }
    case 'session.sendPrompt': {
      const { sessionId, text, mode, attachments } = request.payload
      receipts.push({ sessionId, text, mode, attachments })
      if (sessions.find((session) => session.id === sessionId)?.status === 'running' && mode === 'queue') {
        queue = [
          ...queue,
          {
            id: request.requestId,
            sessionId,
            text,
            mode,
            textOnly: attachments.length === 0,
            createdAt: clock,
            attachments: attachments.map((item) => ({
              uri: item.uri,
              name: item.name,
              ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
            })),
            rpcId: request.requestId,
          },
        ]
        event('queue.updated', { sessionId, items: queue })
      } else {
        publish(sessionId, [
          ...(nodes.get(sessionId) ?? []),
          { kind: 'user-message', id: request.requestId, markdown: text },
        ])
      }
      return {}
    }
    case 'session.cancel':
      status(request.payload.sessionId, 'idle')
      return {}
    case 'interaction.permission.respond':
      decisions.push(request.payload)
      return {}
    case 'interaction.question.respond':
      answers.push(request.payload)
      return {}
    case 'interaction.question.cancel':
      answers.push({ cancelled: true, ...request.payload })
      return {}
    case 'attachment.pick':
      pickedAttachment = true
      if (cancelAttachment) return { cancelled: true }
      return {
        attachment: {
          uri: 'dsh-attachment:1234567890abcdef1234567890abcdef',
          name: 'fixture-note.txt',
          mimeType: 'text/plain',
        },
      }
    case 'attachment.release':
      pickedAttachment = false
      return {}
    case 'view.openLink':
    case 'view.showInFolder':
      return { opened: true }
    case 'reference.list':
      return []
    default:
      throw new Error(`Unsupported fixture route: ${request.type}`)
  }
}
function postMessage(envelope: ProtocolEnvelope): void {
  queueMicrotask(() => {
    const legacy = webviewEnvelopeSchema.safeParse(envelope)
    if (legacy.success) {
      const request = legacy.data.message
      requests.push(request)
      if (
        holds.has(request.type) ||
        (request.type === 'session.open' && holds.has(`session.open:${request.payload.sessionId}`))
      ) {
        waiting.set(request.requestId, request)
        return
      }
      if (failures.delete(request.type)) {
        reply(request, undefined, true)
        return
      }
      try {
        reply(request, route(request))
      } catch {
        reply(request, undefined, true)
      }
      return
    }
    const feature = featureWebviewEnvelopeSchema.parse(envelope).message
    requests.push(feature)
    const payload =
      feature.type === 'editor.context.list'
        ? { kind: 'editor.context', items: [], availableKinds: [] }
        : undefined
    const response = featureHostEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      message:
        payload === undefined
          ? {
              type: 'feature.response',
              requestId: feature.requestId,
              ok: false,
              error: {
                code: 'CAPABILITY_UNAVAILABLE',
                message: 'Optional fixture service unavailable',
                retryable: false,
              },
            }
          : { type: 'feature.response', requestId: feature.requestId, ok: true, payload },
    })
    window.dispatchEvent(new MessageEvent('message', { data: response }))
  })
}
let persisted: unknown = JSON.parse(
  sessionStorage.getItem('daily-webview-state') ?? '{"version":1,"activeSessionId":"daily-a"}',
) as unknown
const api: VsCodeApi = {
  postMessage,
  getState: () => persisted,
  setState: (next) => {
    persisted = next
    sessionStorage.setItem('daily-webview-state', JSON.stringify(next))
  },
}
Object.defineProperty(globalThis, 'acquireVsCodeApi', { value: () => api })

interface Target {
  readonly role: 'button' | 'textbox' | 'tab' | 'radio' | 'checkbox' | 'menuitem' | 'option'
  readonly key?: string
  readonly name?: string
  readonly contains?: boolean
  readonly params?: Readonly<Record<string, string | number>>
}
function accessibleName(element: HTMLElement): string {
  const labelled = element.getAttribute('aria-labelledby')
  if (element.hasAttribute('aria-label')) return element.getAttribute('aria-label') ?? ''
  if (labelled !== null)
    return labelled
      .split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
  if (element instanceof HTMLInputElement)
    return [...(element.labels ?? [])]
      .map((label) => label.textContent)
      .join(' ')
      .trim()
  return element.textContent?.trim() ?? ''
}
function visible(element: HTMLElement): boolean {
  return element.getBoundingClientRect().height > 0 && !element.closest('[inert], [aria-hidden="true"]')
}
function target(value: Target): HTMLElement {
  const selectors = {
    button: 'button,[role="button"]',
    textbox: 'textarea,input:not([type]),input[type="text"],input[type="search"],[role="textbox"]',
    tab: '[role="tab"]',
    radio: 'input[type="radio"],[role="radio"]',
    checkbox: 'input[type="checkbox"],[role="checkbox"]',
    menuitem: '[role="menuitem"],[role="menuitemradio"]',
    option: '[role="option"]',
  }
  const name = value.key === undefined ? value.name : translate(value.key, value.params)
  const candidates = [...document.querySelectorAll<HTMLElement>(selectors[value.role])].filter(visible)
  const element = candidates.find(
    (node) =>
      name === undefined ||
      (value.contains ? accessibleName(node).includes(name) : accessibleName(node) === name),
  )
  if (element === undefined)
    throw new Error(
      `Missing ${value.role} ${name ?? ''}; available: ${candidates.map(accessibleName).join(' | ')}`,
    )
  return element
}
const scenario = {
  label: (key: string): string => translate(key),
  async point(value: Target): Promise<{ x: number; y: number }> {
    let element = target(value)
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const ancestors: HTMLElement[] = []
    for (let node: HTMLElement | null = element; node !== null; node = node.parentElement)
      ancestors.push(node)
    const animations = ancestors
      .flatMap((node) => node.getAnimations())
      .filter(
        (animation) =>
          animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity,
      )
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
    // Other surfaces can finish loading beside the target after its own entry
    // animation ends. Choose a native click point only after its observed box
    // is quiet; no product coordinate or expected frame count is assumed.
    const deadline = performance.now() + 8000
    let quietSince = performance.now()
    let rect = element.getBoundingClientRect()
    for (;;) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      element = target(value)
      const next = element.getBoundingClientRect()
      if (next.x !== rect.x || next.y !== rect.y || next.width !== rect.width || next.height !== rect.height)
        quietSince = performance.now()
      rect = next
      if (performance.now() - quietSince >= 200) break
      if (performance.now() >= deadline) throw new Error(`Control ${accessibleName(element)} never settled`)
    }
    const x = rect.left + rect.width / 2,
      y = rect.top + rect.height / 2
    if (x < 0 || x > innerWidth || y < 0 || y > innerHeight)
      throw new Error('Control is outside the viewport')
    const hit = document.elementFromPoint(x, y)
    if (hit === null || (!element.contains(hit) && !hit.contains(element)))
      throw new Error(`Control ${accessibleName(element)} is obscured by ${hit?.tagName ?? 'nothing'}`)
    return { x, y }
  },
  snapshot(): unknown {
    const prompt = [...document.querySelectorAll('textarea')].find(
      (node) => node.getAttribute('aria-label') === translate('composer.prompt'),
    )
    return {
      text: document.body.innerText,
      prompt: prompt?.value,
      timeline: document.querySelector(`[aria-label="${translate('timeline.aria')}"]`)?.textContent,
      focus: document.activeElement instanceof HTMLElement ? accessibleName(document.activeElement) : '',
      controls: [...document.querySelectorAll<HTMLElement>('button,textarea,input,[role="tab"]')]
        .filter(visible)
        .map((node) => ({
          name: accessibleName(node),
          role: node.getAttribute('role') ?? node.tagName,
          disabled: node.hasAttribute('disabled'),
        })),
      receipts,
      answers,
      decisions,
      pending: [...waiting.values()].map((request) => request.type),
      opened: lastOpened,
      pickedAttachment,
      queue,
      configuration: configurations.get(lastOpened) ?? configuration,
      fields: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')]
        .filter(visible)
        .map((node) => ({ name: accessibleName(node), value: node.value })),
      dialogs: [...document.querySelectorAll<HTMLElement>('[role="dialog"],[role="alertdialog"]')]
        .filter(visible)
        .map((node) => ({ name: accessibleName(node), ownsFocus: node.contains(document.activeElement) })),
      requests: requests.map((request) => ({
        type: request.type,
        requestId: request.requestId,
        ...('payload' in request ? { payload: request.payload } : {}),
      })),
    }
  },
  failNext(type: string): void {
    failures.add(type)
  },
  admitQueue(): void {
    const accepted = queue
    queue = []
    event('queue.updated', { sessionId: lastOpened, items: queue })
    publish(lastOpened, [
      ...(nodes.get(lastOpened) ?? []),
      ...accepted.map((item) => ({
        kind: 'user-message' as const,
        id: item.rpcId ?? item.id,
        markdown: item.text,
      })),
    ])
  },
  hold(type: string): void {
    holds.add(type)
  },
  holdSession(sessionId: string): void {
    holds.add(`session.open:${sessionId}`)
  },
  cancelPicker(): void {
    cancelAttachment = true
  },
  release(): void {
    holds.clear()
    for (const request of waiting.values()) {
      waiting.delete(request.requestId)
      reply(request, route(request))
    }
  },
  status(value: SessionSummary['status']): void {
    status(lastOpened, value)
  },
  disconnect(): void {
    event('connection.snapshot', { kind: 'failed', message: 'Fixture connection lost', retryable: true })
  },
  permission(): void {
    const request: PermissionRequest = {
      id: 'daily-approval',
      sessionId: lastOpened,
      title: 'Fixture approval',
      description: 'Allow the controlled operation?',
      risk: 'low',
      options: [
        { id: 'allow', label: 'Allow fixture', kind: 'allow-once' },
        { id: 'deny', label: 'Deny fixture', kind: 'deny' },
      ],
    }
    event('permission.requested', { request })
  },
  question(multi = false): void {
    const question: UserQuestion = {
      id: 'daily-question',
      sessionId: lastOpened,
      prompt: 'Choose fixture options',
      allowFreeText: true,
      multiSelect: multi,
      choices: [
        { id: 'first', label: 'First fixture option' },
        { id: 'second', label: 'Second fixture option' },
      ],
    }
    event('question.requested', { question })
  },
  countText(text: string): number {
    const root = document.querySelector(`[aria-label="${translate('timeline.aria')}"]`)
    if (root === null) return 0
    // Count content as rendered rather than depending on how React or the
    // Markdown renderer divides it across text nodes and elements.
    return (root.textContent ?? '').split(text).length - 1
  },
}
declare global {
  interface Window {
    dailyUi: typeof scenario
  }
}
window.dailyUi = scenario
await import('../main.js')
