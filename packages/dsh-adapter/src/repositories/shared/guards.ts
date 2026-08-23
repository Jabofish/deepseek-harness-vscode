/** Shared response guards used by version-neutral repositories and mappers. */
export type ProjectionBlock = {
  readonly asOfSeq: number
  readonly values: Record<string, unknown>
}

export function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function validProjectionBlock(value: unknown): value is ProjectionBlock {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    Number.isSafeInteger(record.asOfSeq) &&
    (record.asOfSeq as number) >= -1 &&
    recordOrUndefined(record.values) !== undefined
  )
}

export function validProviderView(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    nonEmptyString(record.provider) &&
    nonEmptyString(record.displayName) &&
    typeof record.settingsNs === 'string' &&
    Array.isArray(record.settingsPath) &&
    record.settingsPath.every((part): part is string => typeof part === 'string') &&
    typeof record.active === 'boolean' &&
    (record.declared === undefined || typeof record.declared === 'boolean')
  )
}

/** Validate both the credentials and model settings descriptor shapes. */
export function validSettingsNamespace(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    nonEmptyString(record.ns) &&
    Object.prototype.hasOwnProperty.call(record, 'schema') &&
    Object.prototype.hasOwnProperty.call(record, 'value') &&
    (record.applies === 'live' || record.applies === 'restart') &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) >= 0 &&
    Array.isArray(record.secrets) &&
    record.secrets.every((secret) => {
      const item = recordOrUndefined(secret)
      return (
        item !== undefined &&
        Array.isArray(item.path) &&
        item.path.length > 0 &&
        item.path.every((part): part is string => nonEmptyString(part)) &&
        typeof item.set === 'boolean'
      )
    })
  )
}

export interface HistoryPageLike {
  readonly events: readonly unknown[]
  readonly hasMore: boolean
}

export interface HistoryWalkerOptions<TPage extends HistoryPageLike> {
  readonly maxPages?: number
  readonly stopWhen?: (page: TPage) => boolean
  readonly sequenceOf?: (entry: unknown) => number | undefined
}

/**
 * Walk bounded, newest-first history pages without duplicating cursor and
 * non-progress handling in every repository. A malformed/non-progressing
 * page ends the walk; callers that require a hard failure can validate the
 * page before passing it to the walker.
 */
export async function walkHistoryPages<TPage extends HistoryPageLike>(
  readPage: (beforeSequence?: number) => Promise<TPage>,
  options: HistoryWalkerOptions<TPage> = {},
): Promise<readonly TPage[]> {
  const pages: TPage[] = []
  const maxPages = options.maxPages ?? 100
  const sequenceOf = options.sequenceOf ?? historySequence
  let beforeSequence: number | undefined

  for (let page = 0; page < maxPages; page += 1) {
    const current = await readPage(beforeSequence)
    pages.push(current)
    if (options.stopWhen?.(current) === true || !current.hasMore) return pages
    const sequences = current.events.map(sequenceOf).filter((value): value is number => value !== undefined)
    const oldest = sequences.length === 0 ? undefined : Math.min(...sequences)
    if (oldest === undefined || (beforeSequence !== undefined && oldest >= beforeSequence)) return pages
    beforeSequence = oldest
  }
  return pages
}

function historySequence(value: unknown): number | undefined {
  const record = recordOrUndefined(value)
  const direct = record?.sequence ?? record?.seq
  if (Number.isSafeInteger(direct) && (direct as number) >= 0) return direct as number
  const event = recordOrUndefined(record?.event)
  return Number.isSafeInteger(event?.seq) && (event?.seq as number) >= 0 ? (event?.seq as number) : undefined
}
