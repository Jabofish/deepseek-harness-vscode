import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  EDITOR_BRIDGE_PROTOCOL,
  EDITOR_BRIDGE_TOOL,
  EditorBridgeError,
  EditorCompanionError,
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
import { VscodeEditorCompanion } from './companion-remote.js'
import { explainFailure } from './failures.js'
import { registerEditorRemote } from './remote-registration.js'
import { editorPeerId } from './peer.js'

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
  private readonly companion: VscodeEditorCompanion

  public constructor(ctx: Context) {
    super(ctx, 'vscodeEditorBridge')
    this.companion = new VscodeEditorCompanion(ctx, this.broker)
    const methods = [
      descriptor('attach', attach, isEditorBridgeBinding),
      descriptor('poll', binding, isEditorBridgePoll),
      descriptor('respond', respond, isTrue),
      descriptor('detach', binding, isTrue),
    ]
    // Public manual registration is supported for hand-written third-party wire schemas.
    registerEditorRemote(ctx, [...methods, ...this.companion.invocations])
    const broker = this.broker
    ctx.effect(function* () {
      yield () => broker.dispose()
    })
    ctx.tools.register({
      name: EDITOR_BRIDGE_TOOL,
      description:
        'Read the active file path, language, version, unsaved flag, selection and cached diagnostic counts. Coordinates are 1-based UTF-16. Use read_document for text and get_diagnostics for error details. Access connects automatically.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: snapshotSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        if (!z.strictObject({}).safeParse(args).success) throw new Error('Editor state takes no arguments.')
        const sessionId = exec.agent?.session.id
        try {
          if (
            sessionId !== undefined &&
            !this.broker.hasSession(sessionId) &&
            !this.companion.broker.hasSession(sessionId)
          )
            await this.companion.broker.waitForSession(sessionId, exec.signal)
          const value =
            sessionId !== undefined && this.companion.broker.hasSession(sessionId)
              ? await this.companion.broker.read(sessionId, { kind: 'state' }, exec.signal)
              : undefined
          const snapshot =
            value?.kind === 'state' ? value.state : await this.broker.read(sessionId, exec.signal)
          if (!isEditorStateSnapshot(snapshot)) throw new Error('Invalid editor snapshot.')
          return snapshot
        } catch (error) {
          if (error instanceof EditorCompanionError || error instanceof EditorBridgeError)
            throw new Error(explainFailure(error.reason), { cause: error })
          throw error
        }
      },
    })
  }

  public attach(request: z.infer<typeof attach>): EditorBridgeResult<EditorBridgeBinding> {
    const peer = this.peer()
    if (peer === undefined || !attach.safeParse(request).success)
      return { status: 'error', reason: 'unavailable' }
    if (this.companion.broker.hasSession(request.sessionId)) return { status: 'error', reason: 'busy' }
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
    return editorPeerId(peer)
  }
}

export const name = 'vscode-editor-bridge'
export const inject = ['typert', 'tools']
export function apply(ctx: Context): void {
  new VscodeEditorBridge(ctx)
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
