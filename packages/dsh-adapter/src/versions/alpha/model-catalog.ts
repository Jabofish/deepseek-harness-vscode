import { isNonEmptyString, isNonEmptyStringArray, recordOrUndefined } from './remote-mux.js'

export function presetRoster(value: unknown): unknown {
  const record = recordOrUndefined(value)
  if (record === undefined) throw new Error('preset roster is not an object')
  if (Object.hasOwn(record, 'hasDocument') && typeof record.hasDocument !== 'boolean')
    throw new Error('preset roster has malformed hasDocument capability')
  // A roster that never stated the native-opener capability must not be
  // coerced into `false`: downstream only claims it when the host stated it.
  return record
}

export function presetDocument(value: unknown): unknown {
  const record = recordOrUndefined(value)
  if (record === undefined) throw new Error('preset document is not an object')
  return { ...record, agentPreset: record.agentPreset ?? record.id }
}

/** Alpha's `agentPresets/copy` Remote resolves void; the requested id is its receipt. */
export function presetCopyReceipt(result: unknown, requestedId: unknown): { agentPreset: string } {
  const record = recordOrUndefined(result)
  const returnedId =
    typeof result === 'string'
      ? result
      : typeof record?.agentPreset === 'string'
        ? record.agentPreset
        : requestedId
  if (typeof returnedId !== 'string' || returnedId.trim() === '')
    throw new Error('preset copy did not identify the new preset')
  return { agentPreset: returnedId }
}

export function goalReceipt(value: unknown): unknown {
  const record = recordOrUndefined(value)
  const refValue = record !== undefined && Object.hasOwn(record, 'ref') ? record.ref : value
  const ref = recordOrUndefined(refValue)
  if (
    ref === undefined ||
    typeof ref.id !== 'string' ||
    ref.id.trim() === '' ||
    !Number.isSafeInteger(ref.revision) ||
    (ref.revision as number) <= 0
  )
    throw new Error('goal receipt is malformed')
  return { ref: { id: ref.id, revision: ref.revision } }
}

export type AlphaModelCatalog = Record<string, unknown> & {
  readonly default: AlphaCatalogSelection & Record<string, unknown>
  readonly routableProviders: readonly string[]
}

/** One model selection as the alpha catalog states it (`reasoningEffort` optional). */
export type AlphaCatalogSelection = {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export function validAlphaModelSelectionProjection(value: unknown): boolean {
  const projection = recordOrUndefined(value)
  if (
    projection === undefined ||
    !Object.hasOwn(projection, 'lastUsed') ||
    !Object.hasOwn(projection, 'next')
  )
    return false
  return validAlphaCatalogSelection(projection.lastUsed) && validAlphaCatalogSelection(projection.next)
}

function validAlphaCatalogSelection(value: unknown): boolean {
  if (value === null) return true
  const selection = recordOrUndefined(value)
  return (
    selection !== undefined &&
    isNonEmptyString(selection.provider) &&
    isNonEmptyString(selection.model) &&
    (selection.reasoningEffort === undefined || isNonEmptyString(selection.reasoningEffort))
  )
}

export function validAlphaModelCatalog(value: unknown): value is AlphaModelCatalog {
  const record = recordOrUndefined(value)
  const selected = recordOrUndefined(record?.default)
  return (
    record !== undefined &&
    selected !== undefined &&
    isNonEmptyString(selected.provider) &&
    isNonEmptyString(selected.model) &&
    isNonEmptyStringArray(record.routableProviders)
  )
}

/**
 * The global catalog read only needs the enumeration halves; the session's own
 * directory composes `current`/`routable` from the durable projection instead
 * (`sessionModels`), because the catalog cannot state them.
 */
export function modelCatalog(value: unknown): unknown {
  if (!validAlphaModelCatalog(value)) throw new Error('model catalog is malformed')
  return value
}

export function credentialDescribe(value: unknown): unknown {
  const credentials = recordOrUndefined(value)
  if (credentials === undefined) throw new Error('credential describe is not an object')
  return { credentials }
}
