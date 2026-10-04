import {
  AppError,
  isBoundedModsBandTree,
  type ModsBandColor,
  type ModsBandNode,
  type ModsBandSnapshot,
  type ModsBandRepository,
  type ModsBandReadResult,
} from '@dsh-vscode/domain'
import { unwrapRpcResultValue } from '../rc6/rpc.js'
import { redactMultilineText } from '../../redaction.js'

const COLORS: ReadonlySet<string> = new Set([
  'yellow',
  'red',
  'green',
  'cyan',
  'blue',
  'magenta',
  'gray',
  'white',
  'black',
])
const ACTION = /^[A-Za-z0-9:_-]{1,128}$/u
interface ModsTransport {
  openRemoteStream(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<unknown>
  remoteRequest(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>
}
const failure = (
  code: 'PROTOCOL_ERROR' | 'REQUEST_CANCELLED' | 'STALE_INTERACTION' | 'BACKEND_UNREACHABLE',
  retryable = false,
): AppError => new AppError({ code, message: 'The optional DSH mod drawing could not be used.', retryable })

/** Fixed alpha211 optional Remote, one bounded watch per read; presses are never retried. */
export class Alpha211ModsBandRepository implements ModsBandRepository {
  private readonly closed = new AbortController()
  private readonly snapshots = new Map<string, ModsBandSnapshot>()
  private readonly pressing = new Set<string>()
  public constructor(
    private readonly transport: ModsTransport,
    private readonly waitMs = 20_000,
  ) {}

  public async read(
    sessionId: string,
    afterGeneration?: number,
    signal?: AbortSignal,
  ): Promise<ModsBandReadResult> {
    const controller = new AbortController()
    const combined = AbortSignal.any([
      controller.signal,
      this.closed.signal,
      ...(signal === undefined ? [] : [signal]),
    ])
    if (combined.aborted) throw failure('REQUEST_CANCELLED')
    let timedOut = false
    let baseline = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.waitMs)
    let iterator: AsyncIterator<unknown> | undefined
    try {
      const stream = this.transport.openRemoteStream(
        'claudeCodeMods/watchBand',
        { agentId: sessionId },
        combined,
      )
      iterator = stream[Symbol.asyncIterator]()
      while (true) {
        const frame = await iterator.next()
        if (combined.aborted) break
        if (frame.done) throw failure('PROTOCOL_ERROR')
        const snapshot = mapModsBandSnapshot(frame.value)
        baseline = true
        const current = this.remember(sessionId, snapshot)
        if (afterGeneration === undefined || current.generation > afterGeneration)
          return { available: true, snapshot: current }
      }
    } catch (error) {
      if (!combined.aborted) {
        if (
          error instanceof AppError &&
          (error.code === 'CAPABILITY_UNAVAILABLE' ||
            (error.code === 'INVALID_CONFIGURATION' &&
              error.context?.rpcMethod === 'alpha stream' &&
              error.context.rpcCode === 'unknown-command'))
        ) {
          this.snapshots.delete(sessionId)
          return { available: false, snapshot: null }
        }
        throw error
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
      await iterator?.return?.()
    }
    if (signal?.aborted || this.closed.signal.aborted) throw failure('REQUEST_CANCELLED')
    if (timedOut && baseline) return { available: true, snapshot: null }
    throw failure('BACKEND_UNREACHABLE', true)
  }

  public async press(
    sessionId: string,
    generation: number,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<ModsBandSnapshot> {
    const combined = AbortSignal.any([this.closed.signal, ...(signal === undefined ? [] : [signal])])
    if (combined.aborted) throw failure('REQUEST_CANCELLED')
    const current = this.snapshots.get(sessionId)
    if (
      current?.generation !== generation ||
      !hasAction(current.tree, actionId) ||
      this.pressing.has(sessionId)
    )
      throw failure('STALE_INTERACTION')
    this.pressing.add(sessionId)
    try {
      const result = await this.transport.remoteRequest(
        'claudeCodeMods/pressBand',
        { agentId: sessionId, generation, actionId },
        combined,
      )
      if (combined.aborted) throw failure('REQUEST_CANCELLED')
      return this.remember(
        sessionId,
        mapModsBandSnapshot(unwrapRpcResultValue(result, 'claudeCodeMods/pressBand')),
      )
    } finally {
      this.pressing.delete(sessionId)
    }
  }

  public close(): Promise<void> {
    this.closed.abort()
    this.snapshots.clear()
    return Promise.resolve()
  }
  private remember(sessionId: string, snapshot: ModsBandSnapshot): ModsBandSnapshot {
    const previous = this.snapshots.get(sessionId)
    if (previous !== undefined && previous.generation > snapshot.generation) return previous
    this.snapshots.delete(sessionId)
    this.snapshots.set(sessionId, snapshot)
    if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!)
    return snapshot
  }
}

function hasAction(tree: readonly ModsBandNode[] | null, actionId: string): boolean {
  return (
    tree?.some(
      (node) =>
        typeof node !== 'string' &&
        (node.kind === 'button'
          ? node.actionId === actionId && !node.disabled
          : hasAction(node.children, actionId)),
    ) === true
  )
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure('PROTOCOL_ERROR')
  return value as Record<string, unknown>
}
function safeText(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > 4096) throw failure('PROTOCOL_ERROR')
  return redactMultilineText(value, 4096)
    .replace(/\b(?:set-cookie|cookie)\s*[:=][^\r\n]*/giu, '[redacted]')
    .replace(/\b(?:pid|process[_ -]?id)\s*[:=]\s*["']?\d+["']?/giu, '[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, '[address]')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .slice(0, limit)
}
function color(value: unknown): ModsBandColor | undefined {
  if (value === 'grey') return 'gray'
  return typeof value === 'string' && COLORS.has(value) ? (value as ModsBandColor) : undefined
}
function spacing(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(8, value)) : 0
}

/** Source: experimental/claude-code-mods/types.ts and client Band.tsx at pinned 5badb150. */
export function mapModsBandSnapshot(value: unknown): ModsBandSnapshot {
  const snapshot = object(value)
  if (
    Object.keys(snapshot).some((key) => key !== 'generation' && key !== 'tree') ||
    !Number.isSafeInteger(snapshot.generation) ||
    (snapshot.generation as number) < 0 ||
    !isBoundedModsBandTree(snapshot.tree)
  )
    throw failure('PROTOCOL_ERROR')
  return {
    generation: snapshot.generation as number,
    tree: snapshot.tree === null ? null : (snapshot.tree as unknown[]).map(mapNode),
  }
}
function mapNode(value: unknown): ModsBandNode {
  if (typeof value === 'string') return safeText(value, 4096)
  const node = object(value)
  if (
    !['Box', 'Text', 'Button'].includes(node.type as string) ||
    Object.keys(node).some((key) => !['type', 'props', 'children', 'actionId'].includes(key)) ||
    !Array.isArray(node.children)
  )
    throw failure('PROTOCOL_ERROR')
  const props = object(node.props)
  if (
    !Object.values(props).every(
      (prop) =>
        typeof prop === 'string' ||
        typeof prop === 'boolean' ||
        (typeof prop === 'number' && Number.isFinite(prop)),
    )
  )
    throw failure('PROTOCOL_ERROR')
  const children = (node.children as unknown[]).map(mapNode)
  const textColor = color(node.type === 'Box' ? props.borderColor : props.color)
  const colored = textColor === undefined ? {} : { color: textColor }
  if (node.type === 'Box')
    return {
      kind: 'box',
      direction: props.flexDirection === 'row' ? 'row' : 'column',
      bordered: props.border !== undefined && props.border !== false,
      ...colored,
      paddingX: spacing(props.paddingX ?? props.padding),
      paddingY: spacing(props.paddingY ?? props.padding),
      gap: spacing(props.gap),
      children,
    }
  if (node.type === 'Text')
    return {
      kind: 'text',
      ...colored,
      bold: props.bold === true,
      dim: props.dimColor === true,
      italic: props.italic === true,
      underline: props.underline === true,
      children,
    }
  if (node.actionId !== undefined && (typeof node.actionId !== 'string' || !ACTION.test(node.actionId)))
    throw failure('PROTOCOL_ERROR')
  return {
    kind: 'button',
    label: safeText(props.label ?? '', 512),
    disabled: props.disabled === true || node.actionId === undefined,
    ...(node.actionId === undefined ? {} : { actionId: node.actionId }),
    ...(props.hotkey === undefined ? {} : { hotkey: safeText(props.hotkey, 64) }),
  }
}
