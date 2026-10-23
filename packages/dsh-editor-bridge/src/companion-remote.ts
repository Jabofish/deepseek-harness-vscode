import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  EDITOR_COMPANION_CAPABILITIES,
  isEditorCompanionBinding,
  isEditorCompanionCapabilities,
  isEditorCompanionDescription,
  isEditorCompanionPoll,
  isEditorCompanionReply,
  type EditorCompanionReply,
  type EditorCompanionResult,
  type EditorCompanionDescription,
  type EditorCompanionCapability,
  isEditorCompanionHostProof,
  type EditorCompanionHostProof,
} from '@dsh-vscode/domain'
import { EditorCompanionBroker } from './companion-broker.js'
import type { EditorBridgeBroker } from './broker.js'
import { editorDescriptor } from './remote-registration.js'
import { registerCompanionTools } from './companion-tools.js'
import { editorPeerId } from './peer.js'
import { COMPANION_BUILD_ID } from './build-identity.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    vscodeEditorCompanion: VscodeEditorCompanion
  }
}
const id = z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/u)
const attach = z.strictObject({
  protocolVersion: z.literal(2),
  sessionId: z.string().min(1).max(256),
  ownerId: id,
  capabilities: z.custom<readonly EditorCompanionCapability[]>(isEditorCompanionCapabilities),
})
const binding = z.strictObject({ bindingId: id })
const hostProbe = z.strictObject({ nonce: id })
const respond = z.strictObject({
  bindingId: id,
  requestId: id,
  reply: z.custom<EditorCompanionReply>(isEditorCompanionReply),
})
const isTrue = (value: unknown): value is true => value === true
const isBuildIdentity = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:source|[a-f0-9]{64})$/u.test(value)
const unavailable = (): EditorCompanionResult<never> => ({ status: 'error', reason: 'unavailable' })
export class VscodeEditorCompanion extends TypertRemoteService {
  public readonly broker = new EditorCompanionBroker()
  public readonly invocations: readonly InvocationDescriptor[]
  public constructor(
    ctx: Context,
    private readonly legacy: EditorBridgeBroker,
  ) {
    super(ctx, 'vscodeEditorCompanion')
    const namespace = 'vscodeEditorCompanion'
    this.invocations = [
      editorDescriptor(namespace, 'describe', z.strictObject({}), isEditorCompanionDescription),
      editorDescriptor(namespace, 'buildIdentity', z.strictObject({}), isBuildIdentity),
      editorDescriptor(namespace, 'verifyHost', hostProbe, isEditorCompanionHostProof),
      editorDescriptor(namespace, 'attach', attach, isEditorCompanionBinding),
      editorDescriptor(namespace, 'poll', binding, isEditorCompanionPoll),
      editorDescriptor(namespace, 'respond', respond, isTrue),
      editorDescriptor(namespace, 'detach', binding, isTrue),
    ]
    registerCompanionTools(ctx, this.broker)
    const broker = this.broker
    ctx.effect(function* () {
      yield () => broker.dispose()
    })
  }
  public describe(_request: Record<string, never>): EditorCompanionResult<EditorCompanionDescription> {
    if (this.peer() === undefined) return unavailable()
    return {
      status: 'ok',
      value: {
        protocolVersion: 2,
        packageVersion: '0.2.2',
        capabilities: [...EDITOR_COMPANION_CAPABILITIES],
        maxGrants: 16,
      },
    }
  }
  public buildIdentity(_request: Record<string, never>): EditorCompanionResult<string> {
    return this.peer() === undefined ? unavailable() : { status: 'ok', value: COMPANION_BUILD_ID }
  }
  public attach(request: z.infer<typeof attach>): ReturnType<EditorCompanionBroker['attach']> {
    const peer = this.peer()
    if (peer === undefined || !attach.safeParse(request).success) return unavailable()
    if (this.legacy.hasSession(request.sessionId)) return { status: 'error', reason: 'busy' }
    return this.broker.attach(request.sessionId, request.ownerId, peer, request.capabilities)
  }
  public async verifyHost(
    request: z.infer<typeof hostProbe>,
  ): Promise<EditorCompanionResult<EditorCompanionHostProof>> {
    if (this.peer() === undefined || !hostProbe.safeParse(request).success) return unavailable()
    const directory = path.join(os.tmpdir(), `dsh-editor-peer-${request.nonce}`)
    const file = path.join(directory, 'proof')
    try {
      const [folder, info] = await Promise.all([lstat(directory), lstat(file)])
      if (
        !folder.isDirectory() ||
        folder.isSymbolicLink() ||
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== 32
      )
        return { status: 'error', reason: 'workspace-mismatch' }
      const contents = await readFile(file)
      if (contents.length !== 32) return { status: 'error', reason: 'workspace-mismatch' }
      return { status: 'ok', value: { proof: createHash('sha256').update(contents).digest('hex') } }
    } catch {
      return { status: 'error', reason: 'workspace-mismatch' }
    }
  }
  public poll(
    request: z.infer<typeof binding>,
    signal: AbortSignal,
  ): ReturnType<EditorCompanionBroker['poll']> {
    const peer = this.peer()
    return peer === undefined
      ? Promise.resolve(unavailable())
      : this.broker.poll(request.bindingId, peer, signal)
  }
  public respond(request: z.infer<typeof respond>): ReturnType<EditorCompanionBroker['respond']> {
    const peer = this.peer()
    return peer === undefined
      ? unavailable()
      : this.broker.respond(request.bindingId, peer, request.requestId, request.reply)
  }
  public detach(request: z.infer<typeof binding>): ReturnType<EditorCompanionBroker['detach']> {
    const peer = this.peer()
    return peer === undefined ? unavailable() : this.broker.detach(request.bindingId, peer)
  }
  private peer(): string | undefined {
    const peer = this.ctx.invocation?.peer
    return editorPeerId(peer)
  }
}
