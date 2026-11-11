import { AppError } from '@dsh-vscode/domain'
import { z } from 'zod'
import { AlphaLoopbackApiClient, type AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { AlphaRemoteMux, isJsonLike } from '../alpha/remote-mux.js'
import { validAlpha171ProjectionBaseline } from '../alpha171/session-wire.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { unwrapOptionalRpcResultValue, unwrapRpcResultValue } from '../rc6/rpc.js'
import { clientTimeZoneField } from '../../client-time-zone.js'
import { cancelled } from '../../transport-errors.js'
import { closedConnectionError } from '../../transport-internal.js'
import { assertMasterFcc0adCommit } from './identity.js'
import {
  masterIdentifier,
  masterSequence,
  masterTeamProjectionSchema,
  masterWebProvidersSchema,
  masterMcpServersSchema,
  masterMcpProbeSchema,
  parseMasterContract,
  parseMasterContinuation,
} from './contracts.js'

const continuationRequest = z
  .object({
    sessionId: masterIdentifier,
    requestId: masterIdentifier,
    observedEnding: masterSequence,
  })
  .strict()

/**
 * Host-only preparation for fcc0ad. The caller authorises each session/server
 * action before dispatch. Team scopes and MCP diagnostics stay in this layer.
 * Every write is sent once, including when its receipt is lost.
 */
export class MasterFcc0adClient {
  private readonly transport: AlphaLoopbackApiClient
  private readonly mux: AlphaRemoteMux
  private readonly closed = new AbortController()
  private readonly continuing = new Set<string>()
  private closePromise: Promise<void> | undefined

  public constructor(
    private readonly options: AlphaLoopbackApiClientOptions,
    sourceCommit: string,
  ) {
    assertMasterFcc0adCommit(sourceCommit)
    this.transport = new AlphaLoopbackApiClient({
      ...options,
      retryPolicy: { ...options.retryPolicy, maximumAttempts: 1 },
    })
    this.mux = new AlphaRemoteMux(options)
  }

  public async readContinuation(sessionId: string, signal?: AbortSignal): Promise<number | null> {
    const projection = await this.projections(sessionId, signal)
    if (!Object.hasOwn(projection.values, 'conversationContinuation'))
      throw unavailable('conversation continuation')
    return parseMasterContinuation(projection.values.conversationContinuation, projection.asOfSeq)
  }

  /**
   * Check the caller's observed failure, then ask native admission to continue
   * its currently eligible turn. Other clients can change eligibility between
   * this preflight read and the prompt request.
   */
  public async continueFailedTurn(
    input: z.infer<typeof continuationRequest>,
    signal?: AbortSignal,
  ): Promise<void> {
    const parsed = continuationRequest.safeParse(input)
    if (!parsed.success) throw invalidInput('Invalid continuation request.')
    const request = parsed.data
    if (this.continuing.has(request.sessionId))
      throw invalidInput('A continuation request is already in progress for this session.')
    this.continuing.add(request.sessionId)
    try {
      if ((await this.readContinuation(request.sessionId, signal)) !== request.observedEnding)
        throw invalidInput('The failed turn changed. Refresh the session before continuing.')
      const receipt = recordOrUndefined(
        await this.invoke(
          'session/prompt',
          {
            request: {
              sessionId: request.sessionId,
              requestId: request.requestId,
              mode: 'queue',
              content: [],
              ...clientTimeZoneField(),
            },
          },
          signal,
        ),
      )
      if (receipt?.accepted !== true || Object.keys(receipt).length !== 1) throw malformed('session/prompt')
    } finally {
      this.continuing.delete(request.sessionId)
    }
  }

  public async readTeam(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof masterTeamProjectionSchema>> {
    const projection = await this.projections(sessionId, signal)
    if (!Object.hasOwn(projection.values, 'agentTeam')) throw unavailable('Agent Teams')
    return parseMasterContract(masterTeamProjectionSchema, projection.values.agentTeam, 'session/projections')
  }

  public async setTeamEnabled(sessionId: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
    const agentId = this.identifier(sessionId)
    if (typeof enabled !== 'boolean') throw invalidInput('Invalid Team selection.')
    await this.invokeVoid('agentTeams/setEnabled', { agentId, enabled }, signal)
  }

  public async listWebProviders(signal?: AbortSignal): Promise<z.infer<typeof masterWebProvidersSchema>> {
    return parseMasterContract(
      masterWebProvidersSchema,
      await this.invoke('web/listProviders', {}, signal),
      'web/listProviders',
    )
  }

  public async probeMcp(name: string, signal?: AbortSignal): Promise<z.infer<typeof masterMcpProbeSchema>> {
    return parseMasterContract(
      masterMcpProbeSchema,
      await this.invoke('mcpManager/probe', { name: this.identifier(name) }, signal),
      'mcpManager/probe',
    )
  }

  public async restartMcp(name: string, signal?: AbortSignal): Promise<void> {
    await this.invokeVoid('mcpManager/restart', { name: this.identifier(name) }, signal)
  }

  public async *watchMcp(signal?: AbortSignal): AsyncGenerator<z.infer<typeof masterMcpServersSchema>> {
    const lifetime = this.signal(signal)
    const initial = new AbortController()
    let timedOut = false
    let received = false
    const timer = setTimeout(() => {
      timedOut = true
      initial.abort()
    }, this.options.requestTimeoutMs)
    try {
      for await (const value of this.mux.open(
        'mcpManager/watch',
        {},
        AbortSignal.any([lifetime, initial.signal]),
      )) {
        clearTimeout(timer)
        lifetime.throwIfAborted()
        received = true
        yield parseMasterContract(masterMcpServersSchema, value, 'mcpManager/watch')
      }
      if (timedOut)
        throw new AppError({
          code: 'BACKEND_UNREACHABLE',
          message: 'DSH did not send the MCP baseline before the deadline.',
          retryable: true,
          context: { rpcMethod: 'mcpManager/watch', timedOut: true },
        })
      if (!received && !lifetime.aborted) throw malformed('mcpManager/watch')
    } finally {
      clearTimeout(timer)
    }
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closed.abort()
    this.closePromise = this.closeResources()
    return this.closePromise
  }

  private async closeResources(): Promise<void> {
    try {
      await this.mux.close()
    } finally {
      await this.transport.close()
    }
  }

  private async projections(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly asOfSeq: number
    readonly values: Readonly<Record<string, unknown>>
  }> {
    const raw = await this.invoke(
      'session/projections',
      {
        request: { sessionId: this.identifier(sessionId) },
      },
      signal,
    )
    if (raw === null) throw unavailable('session projections')
    const value = recordOrUndefined(raw)
    if (value?.kind === 'migration-required') {
      if (
        Object.keys(value).length !== 2 ||
        recordOrUndefined(value.values) === undefined ||
        !isJsonLike(value.values)
      )
        throw malformed('session/projections')
      throw invalidInput('Open the session to migrate it before reading development features.')
    }
    if (value?.kind !== 'sequenced') throw malformed('session/projections')
    const { kind, ...baseline } = value
    void kind
    if (!validAlpha171ProjectionBaseline(baseline)) throw malformed('session/projections')
    return {
      asOfSeq: baseline.asOfSeq as number,
      values: baseline.values as Readonly<Record<string, unknown>>,
    }
  }

  private identifier(value: unknown): string {
    const parsed = masterIdentifier.safeParse(value)
    if (!parsed.success) throw invalidInput('Invalid development-feature identity.')
    return parsed.data
  }

  private signal(signal?: AbortSignal): AbortSignal {
    if (this.closed.signal.aborted) throw closedConnectionError()
    if (signal?.aborted === true) throw cancelled(signal.reason)
    return signal === undefined ? this.closed.signal : AbortSignal.any([this.closed.signal, signal])
  }

  private async invoke(
    method: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return unwrapRpcResultValue(await this.transport.remoteRequest(method, args, this.signal(signal)), method)
  }

  private async invokeVoid(
    method: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const value = unwrapOptionalRpcResultValue(
      await this.transport.remoteRequest(method, args, this.signal(signal)),
      method,
    )
    if (value !== undefined) throw malformed(method)
  }
}

function invalidInput(message: string): AppError {
  return new AppError({ code: 'INVALID_CONFIGURATION', message, retryable: false })
}

function unavailable(feature: string): AppError {
  return new AppError({
    code: 'CAPABILITY_UNAVAILABLE',
    message: `This session does not expose ${feature}.`,
    retryable: false,
  })
}

function malformed(method: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed development-contract response.',
    retryable: false,
    context: { rpcMethod: method },
  })
}
