import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { TypertRemoteService, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  EDITOR_BRIDGE_PROTOCOL,
  EDITOR_BRIDGE_TOOL,
  isEditorBridgeBinding,
  isEditorBridgePoll,
  isEditorBridgeReply,
  isEditorBridgeResult,
  isEditorStateSnapshot,
  type EditorBridgeBinding,
  type EditorBridgePoll,
  type EditorBridgeReply,
  type EditorBridgeResult,
} from '@dsh-vscode/domain'
import { EditorBridgeBroker } from './broker.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    vscodeEditorBridge: VscodeEditorBridge
  }
}
const id = z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/u)
const attach = z.strictObject({
  sessionId: z.string().min(1).max(256),
  ownerId: id,
  protocolVersion: z.literal(EDITOR_BRIDGE_PROTOCOL),
})
const binding = z.strictObject({ bindingId: id })
const respond = z.strictObject({
  bindingId: id,
  requestId: id,
  reply: z.custom<EditorBridgeReply>(isEditorBridgeReply),
})
const isTrue = (value: unknown): value is true => value === true

/** Independently installable, optional companion. All Remote boundaries use strict schemas. */
export class VscodeEditorBridge extends TypertRemoteService {
  private readonly broker = new EditorBridgeBroker()

  public constructor(ctx: Context) {
    super(ctx, 'vscodeEditorBridge')
    const methods = [
      descriptor('attach', attach, isEditorBridgeBinding),
      descriptor('poll', binding, isEditorBridgePoll),
      descriptor('respond', respond, isTrue),
      descriptor('detach', binding, isTrue),
    ]
    // Public manual registration is supported for hand-written third-party wire schemas.
    const registry = ctx.typert
    if (!hasRegistration(registry)) throw new Error('The DSH reflection registry is unavailable.')
    registry.register({
      package: '@dsh-vscode/editor-bridge',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: methods,
    })
    const broker = this.broker
    ctx.effect(function* () {
      yield () => broker.dispose()
    })
    ctx.tools.register({
      name: EDITOR_BRIDGE_TOOL,
      description:
        'Read the explicitly shared VS Code editor metadata for this session: workspace-relative file, language, document version, unsaved state, one-based UTF-16 selection, and cached error/warning counts. No source text. Counts do not prove language-service or compilation completion. Unavailable until the user enables sharing in VS Code.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: snapshotSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        if (!z.strictObject({}).safeParse(args).success) throw new Error('Editor state takes no arguments.')
        const snapshot = await this.broker.read(exec.agent?.session.id, exec.signal)
        if (!isEditorStateSnapshot(snapshot)) throw new Error('Invalid editor snapshot.')
        return snapshot
      },
    })
  }

  public attach(request: z.infer<typeof attach>): EditorBridgeResult<EditorBridgeBinding> {
    const peer = this.peer()
    if (peer === undefined || !attach.safeParse(request).success)
      return { status: 'error', reason: 'unavailable' }
    return this.broker.attach(request.sessionId, request.ownerId, peer)
  }
  public poll(
    request: z.infer<typeof binding>,
    signal: AbortSignal,
  ): Promise<EditorBridgeResult<EditorBridgePoll>> {
    const peer = this.peer()
    if (peer === undefined) return Promise.resolve({ status: 'error', reason: 'unavailable' })
    return this.broker.poll(request.bindingId, peer, signal)
  }
  public respond(request: z.infer<typeof respond>): EditorBridgeResult<true> {
    const peer = this.peer()
    return peer === undefined
      ? { status: 'error', reason: 'unavailable' }
      : this.broker.respond(request.bindingId, peer, request.requestId, request.reply)
  }
  public detach(request: z.infer<typeof binding>): EditorBridgeResult<true> {
    const peer = this.peer()
    return peer === undefined
      ? { status: 'error', reason: 'unavailable' }
      : this.broker.detach(request.bindingId, peer)
  }
  private peer(): string | undefined {
    const peer = this.ctx.invocation?.peer
    return peer?.principal.kind === 'owner' ? peer.id : undefined
  }
}

export const name = 'vscode-editor-bridge'
export const inject = ['typert', 'tools']
export function apply(ctx: Context): void {
  new VscodeEditorBridge(ctx)
}

function hasRegistration(value: object): value is { register(contribution: TypertContribution): () => void } {
  return 'register' in value && typeof value.register === 'function'
}

function descriptor<T>(
  method: string,
  input: z.ZodType,
  accepts: (value: unknown) => value is T,
): InvocationDescriptor {
  return {
    id: `@dsh-vscode/editor-bridge#vscodeEditorBridge/${method}`,
    namespace: 'vscodeEditorBridge',
    service: 'vscodeEditorBridge',
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: method, create: () => input },
      },
    ],
    ...(method === 'poll' ? { cancellation: { parameter: 'signal' as const } } : {}),
    result: {
      mode: 'strict',
      typeSymbol: `${method}Result`,
      create: () => z.custom<EditorBridgeResult<T>>((value) => isEditorBridgeResult(value, accepts)),
    },
  }
}
const positionSchema = {
  type: 'object',
  properties: { line: { type: 'integer' }, column: { type: 'integer' } },
  required: ['line', 'column'],
  additionalProperties: false,
} satisfies ToolDefinition['output']['schema']
const snapshotSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'relativePath',
    'languageId',
    'documentVersion',
    'dirty',
    'selection',
    'diagnostics',
    'capturedAt',
  ],
  properties: {
    relativePath: { type: 'string' },
    languageId: { type: 'string' },
    documentVersion: { type: 'integer' },
    dirty: { type: 'boolean' },
    capturedAt: { type: 'string' },
    selection: {
      type: 'object',
      properties: { start: positionSchema, end: positionSchema },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    diagnostics: {
      type: 'object',
      properties: { errors: { type: 'integer' }, warnings: { type: 'integer' } },
      required: ['errors', 'warnings'],
      additionalProperties: false,
    },
  },
} satisfies ToolDefinition['output']['schema']
