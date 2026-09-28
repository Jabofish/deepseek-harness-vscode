import { randomUUID } from 'node:crypto'

import { AppError } from '@dsh-vscode/domain'

import { projectedModelSelection } from '../../projection/agent.js'
import { validAlpha151ProjectionBaseline } from '../alpha151/session-wire.js'
import { validAlpha171ProjectionBaseline } from '../alpha171/session-wire.js'
import {
  type AlphaLoopbackApiClientOptions,
  isNonEmptyString,
  isNonEmptyStringArray,
  isPlainRecord,
  malformedResponse,
  recordOrUndefined,
} from './remote-mux.js'
import {
  validAlphaModelCatalog,
  validAlphaModelSelectionProjection,
  type AlphaCatalogSelection,
  presetRoster,
} from './model-catalog.js'
import { expandHistoryRecords, validAlphaProjectionBaseline, validAlphaWireSnapshot } from './session-wire.js'
import {
  type AlphaConfigurableProvider,
  type AlphaResponse,
  type LegacyResponse,
  alphaConfigurableProviderList,
  alphaProviderInfoList,
  stringValue,
} from './transport-support.js'

export interface AlphaLegacyRpcDependencies {
  readonly options: AlphaLoopbackApiClientOptions
  readonly post: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<AlphaResponse>
  readonly unary: (
    endpoint: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>
  readonly openRemoteStream: (
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => AsyncGenerator<unknown>
  readonly sessionAddress: (sessionId: string) => Record<string, unknown>
  readonly isClosed: () => boolean
}

export interface AlphaLegacyRpc {
  legacy(
    this: void,
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    transform?: (value: unknown) => unknown,
  ): Promise<LegacyResponse>
  presetList(this: void, signal?: AbortSignal): Promise<LegacyResponse>
  prompt(this: void, value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse>
  history(this: void, value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse>
  subagentHistory(this: void, value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse>
  sessionModels(this: void, value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse>
  providers(this: void, signal?: AbortSignal): Promise<LegacyResponse>
  workspaceList(this: void, signal?: AbortSignal): Promise<LegacyResponse>
  historyWindowOptions(this: void, value: Record<string, unknown>): Record<string, unknown>
}

/**
 * The alpha client's logical methods projected onto this version's `/api`
 * Remote calls, together with the compatibility projection the existing
 * repositories consume (history windows, model catalogs, provider joins).
 */
export function createAlphaLegacyRpc(dependencies: AlphaLegacyRpcDependencies): AlphaLegacyRpc {
  const { options, post, unary, openRemoteStream, sessionAddress, isClosed } = dependencies

  async function legacy(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    transform?: (value: unknown) => unknown,
  ): Promise<LegacyResponse> {
    const response = await post(endpoint, { args }, signal)
    if (!response.result.ok || transform === undefined) return response
    try {
      return { ...response, result: { ok: true, value: transform(response.result.value) } }
    } catch (cause) {
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `The alpha DSH response for ${endpoint} could not be projected.`,
        retryable: false,
        cause,
      })
    }
  }

  async function presetList(signal?: AbortSignal): Promise<LegacyResponse> {
    if (options.presetWireVersion === 'registry-v2')
      return legacy('agentPresets/list', {}, signal, presetRoster)
    // Alpha keeps the roster and native-opener capability on separate Remote
    // methods. Joining them here prevents `authorable` (a write capability)
    // from being mistaken for the unrelated ability to open a directory.
    const rosterPromise = legacy('agentPresets/list', {}, signal, presetRoster)
    const openerPromise = legacy('settings/canOpenAgentPresetDirectory', {}, signal).catch(
      (error: unknown) => {
        // The roster is still useful when an optional native opener is not
        // composed or temporarily unavailable. Preserve cancellation and a
        // client close so an in-flight request cannot resolve after teardown.
        if (
          isClosed() ||
          signal?.aborted === true ||
          (error instanceof AppError && error.code === 'REQUEST_CANCELLED')
        )
          throw error
        return undefined
      },
    )
    const [roster, opener] = await Promise.all([rosterPromise, openerPromise])
    if (!roster.result.ok) return roster
    const value = recordOrUndefined(roster.result.value)
    if (value === undefined) throw malformedResponse('agentPresets/list')
    // An opener probe that did not answer states nothing: return the roster
    // without the capability instead of claiming the host cannot open a
    // directory, so the surface can word the action as unknown rather than
    // offering a native open the deployment may not have.
    if (opener === undefined || !opener.result.ok)
      return { ...roster, result: { ok: true, value: { ...value } } }
    if (typeof opener.result.value !== 'boolean')
      throw malformedResponse('settings/canOpenAgentPresetDirectory')
    return {
      ...roster,
      result: { ok: true, value: { ...value, hasDocument: opener.result.value } },
    }
  }

  /**
   * Alpha publishes the prompt's request id in the queue projection. The
   * legacy repository uses the transport response id for that correlation,
   * so expose the same logical id while keeping the physical Connection
   * envelope id private to `post`.
   */
  async function prompt(value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse> {
    const requestId = isNonEmptyString(value.requestId) ? value.requestId : randomUUID()
    const content: unknown[] = []
    for (const part of Array.isArray(value.content) ? value.content : []) {
      const file = recordOrUndefined(part)
      if (file?.type !== 'file-upload') {
        content.push(part)
        continue
      }
      if (options.fileUploads !== true)
        throw new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'This DSH version does not support binary file uploads.',
          retryable: false,
        })
      const receipt = recordOrUndefined(
        await unary(
          'fileUploads/upload',
          {
            agentId: stringValue(value.sessionId, 'file upload sessionId'),
            request: {
              data: stringValue(file.data, 'file upload data'),
              name: stringValue(file.name, 'file upload name'),
            },
          },
          signal,
        ),
      )
      const storedFile = recordOrUndefined(receipt?.file)
      if (
        !isNonEmptyString(receipt?.receiptId) ||
        !isNonEmptyString(storedFile?.attachmentId) ||
        typeof storedFile?.name !== 'string' ||
        !Number.isSafeInteger(storedFile.bytes) ||
        (storedFile.bytes as number) < 0
      )
        throw malformedResponse('fileUploads/upload')
      content.push({ type: 'file', receiptId: receipt.receiptId })
    }
    const response = await legacy('session/prompt', { request: { ...value, content, requestId } }, signal)
    return { ...response, rpcId: requestId }
  }

  async function history(value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse> {
    const sessionId = stringValue(value.sessionId, 'session.history sessionId')
    const address = sessionAddress(sessionId)
    const historyWindow = historyWindowOptions(value)
    const snapshot = await followSnapshot({ address, ...historyWindow }, signal)
    if (value.beforeSeq !== undefined) {
      const page = await unary(
        'session/page',
        {
          request: {
            address,
            throughSeq: snapshot.cursor,
            beforeSeq: value.beforeSeq,
            ...historyWindow,
          },
        },
        signal,
      )
      return historyResponse(page, sessionId)
    }
    return historyResponse(
      { records: snapshot.records, hasMore: snapshot.hasMore, projections: snapshot.projections },
      sessionId,
    )
  }

  async function subagentHistory(
    value: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LegacyResponse> {
    const sessionId = stringValue(value.childSessionId, 'subagent.history childSessionId')
    const address = {
      kind: 'subagent',
      parentSessionId: stringValue(value.parentSessionId, 'subagent.history parentSessionId'),
      childSessionId: sessionId,
      mode: value.mode === 'one-shot' ? 'one-shot' : 'continuable',
    }
    const historyWindow = historyWindowOptions(value)
    const snapshot = await followSnapshot({ address, ...historyWindow }, signal)
    const page =
      value.beforeSeq === undefined
        ? { records: snapshot.records, hasMore: snapshot.hasMore, projections: snapshot.projections }
        : await unary(
            'session/page',
            {
              request: {
                address,
                throughSeq: snapshot.cursor,
                beforeSeq: value.beforeSeq,
                ...historyWindow,
              },
            },
            signal,
          )
    return historyResponse(page, sessionId)
  }

  function historyWindowOptions(value: Record<string, unknown>): Record<string, unknown> {
    const requested = recordOrUndefined(value.turnWindow)
    if (
      options.sessionHistoryTurnWindow === true &&
      requested !== undefined &&
      Number.isSafeInteger(requested.minMessages) &&
      (requested.minMessages as number) > 0 &&
      (requested.minMessages as number) <= 500 &&
      Number.isSafeInteger(requested.minTurns) &&
      (requested.minTurns as number) > 0
    ) {
      return {
        maxMessages: 500,
        turnWindow: {
          minMessages: requested.minMessages,
          minTurns: requested.minTurns,
        },
      }
    }
    return value.maxMessages === undefined ? {} : { maxMessages: value.maxMessages }
  }

  async function followSnapshot(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    for await (const item of openRemoteStream('session/follow', { request }, signal)) {
      const frame = recordOrUndefined(item)
      if (!validAlphaWireSnapshot(frame, options.sessionWireVersion ?? 'v0'))
        throw malformedResponse('session/follow snapshot')
      return frame
    }
    throw malformedResponse('session/follow snapshot')
  }

  function historyResponse(value: unknown, sessionId: string): LegacyResponse {
    const record = recordOrUndefined(value)
    const wireVersion = options.sessionWireVersion ?? 'v0'
    if (
      record === undefined ||
      !Array.isArray(record.records) ||
      typeof record.hasMore !== 'boolean' ||
      (record.projections !== undefined &&
        (wireVersion === 'v4'
          ? !validAlpha171ProjectionBaseline(record.projections)
          : wireVersion === 'v3'
            ? !validAlpha151ProjectionBaseline(record.projections)
            : !validAlphaProjectionBaseline(record.projections)))
    )
      throw malformedResponse('session history')
    const events = expandHistoryRecords(
      record.records,
      sessionId,
      wireVersion,
      options.autoReviewDenialContract === true,
    )
    return {
      rpcId: randomUUID(),
      result: {
        ok: true,
        value: {
          events: events.map((event) => ({ event })),
          hasMore: record.hasMore,
          ...(record.projections === undefined ? {} : { projections: record.projections }),
        },
      },
    }
  }

  async function sessionModels(
    value: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LegacyResponse> {
    const sessionId = stringValue(value.sessionId, 'session.models sessionId')
    const response = await post('session/modelCatalog', { args: {} }, signal)
    if (!response.result.ok) return response
    const catalog = response.result.value
    if (!validAlphaModelCatalog(catalog)) throw malformedResponse('session/modelCatalog')
    // The catalog names the deployment default and every routable provider; it
    // deliberately does not name which of them *this* session uses, because a
    // request's route is durable session state. Read that projection instead of
    // answering about the default: a surface that blocks input on `routable`
    // would otherwise block a session whose own model the host serves, and let
    // through one whose adapter is gone.
    const current = await sessionModelSelection(sessionId, catalog.default, signal)
    return {
      ...response,
      result: {
        ok: true,
        value: {
          current,
          routable: catalog.routableProviders.includes(current.provider),
          groups: catalog.groups,
          failures: catalog.failures,
        },
      },
    }
  }

  /**
   * The route this session's next request will take. A session that selected a
   * model (or already sent one) states it in the durable `modelSelection`
   * projection, which the open/history path reads from the same baseline; a
   * session that never did falls back to the deployment default the catalog
   * answered. The projection read is not optional: answering the default under
   * the name of the session's selection is exactly the misstatement above.
   */
  async function sessionModelSelection(
    sessionId: string,
    fallback: AlphaCatalogSelection,
    signal?: AbortSignal,
  ): Promise<AlphaCatalogSelection> {
    const snapshot = await followSnapshot({ address: sessionAddress(sessionId) }, signal)
    const projections = recordOrUndefined(snapshot.projections)
    const projectionValues = recordOrUndefined(projections?.values)
    if (
      options.requireModelSelectionProjection === true &&
      !validAlphaModelSelectionProjection(projectionValues?.modelSelection)
    )
      throw malformedResponse('session modelSelection projection')
    const selected = projectedModelSelection(projectionValues)
    if (selected.providerId === '' || selected.modelId === '') return fallback
    return {
      provider: selected.providerId,
      model: selected.modelId,
      ...(selected.reasoningLevel === undefined ? {} : { reasoningEffort: selected.reasoningLevel }),
    }
  }

  async function providers(signal?: AbortSignal): Promise<LegacyResponse> {
    const [providers, configurable] = await Promise.all([
      post('llm/listProviders', { args: {} }, signal),
      post('llm/listConfigurableProviders', { args: {} }, signal),
    ])
    if (!providers.result.ok) return providers
    if (!configurable.result.ok) return configurable
    const listed = alphaProviderInfoList(providers.result.value)
    const configs = alphaConfigurableProviderList(configurable.result.value)
    const byProvider = new Map<string, AlphaConfigurableProvider>()
    for (const entry of configs) {
      const row = entry
      if (isNonEmptyString(row.provider)) byProvider.set(row.provider, row)
    }
    const mapped = new Map<string, Record<string, unknown>>()
    for (const entry of listed) {
      const row = entry
      const config = byProvider.get(row.id)
      mapped.set(row.id, {
        provider: row.id,
        displayName: row.name,
        // A live route without a configurable-directory entry has no settings
        // address. Preserve the upstream join contract's empty marker rather
        // than inventing a namespace from the route id; the Webview uses this
        // distinction to avoid hiding a real registered provider.
        settingsNs: config === undefined ? '' : config.settingsNs,
        settingsPath: config?.settingsPath ?? [],
        active: true,
        ...(typeof config?.declared === 'boolean' ? { declared: config.declared } : {}),
      })
    }
    for (const entry of configs) {
      const row = entry
      if (mapped.has(row.provider)) continue
      mapped.set(row.provider, {
        provider: row.provider,
        displayName: row.displayName,
        settingsNs: row.settingsNs,
        settingsPath: row.settingsPath,
        active: false,
        ...(typeof row.declared === 'boolean' ? { declared: row.declared } : {}),
      })
    }
    return {
      rpcId: providers.rpcId,
      result: { ok: true, value: { providers: [...mapped.values()] } },
    }
  }

  async function workspaceList(signal?: AbortSignal): Promise<LegacyResponse> {
    const first = await firstStreamItem('workspace/follow', {}, signal)
    const value = recordOrUndefined(first)
    if (value?.type !== 'baseline') throw malformedResponse('workspace/follow baseline')
    const baseline = recordOrUndefined(value.value)
    if (
      baseline === undefined ||
      !Array.isArray(baseline.items) ||
      !baseline.items.every(isPlainRecord) ||
      !isNonEmptyStringArray(baseline.archivedSessionIds) ||
      (options.workspaceWireVersion === 'pinned-v2' && !isNonEmptyStringArray(baseline.pinnedSessionIds))
    )
      throw malformedResponse('workspace/follow baseline value')
    return { rpcId: randomUUID(), result: { ok: true, value: baseline } }
  }

  async function firstStreamItem(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for await (const item of openRemoteStream(endpoint, args, signal)) return item
    throw malformedResponse(`${endpoint} stream`)
  }

  return {
    legacy,
    presetList,
    prompt,
    history,
    subagentHistory,
    sessionModels,
    providers,
    workspaceList,
    historyWindowOptions,
  }
}
