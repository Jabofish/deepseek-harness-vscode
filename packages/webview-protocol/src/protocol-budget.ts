// Historical DSH transcripts contain many structured stream events. The
// adapter compacts visible deltas before they reach this boundary, while this
// larger node budget still permits genuinely long sessions without turning a
// valid response into a protocol error.
const MAX_PROTOCOL_NODES = 100_000
export const MAX_ATTACHMENT_BASE64_CHARS = Math.ceil((20 * 1024 * 1024) / 3) * 4
// One admitted attachment must survive the budget check in both directions:
// `attachment.ingest` carries the Base64 payload itself, and `attachment.preview`
// returns it inside a data URI. A per-string cap below this envelope rejected
// supported 12-20 MiB images before the schema was ever consulted.
const MAX_PROTOCOL_STRING_CHARS = MAX_ATTACHMENT_BASE64_CHARS + 1_024
// Two maximum-size strings: the attachment envelope plus the message around it,
// which is what a prompt body and one attachment can legitimately amount to.
const MAX_PROTOCOL_STRING_BYTES = MAX_PROTOCOL_STRING_CHARS * 2

export function protocolValueWithinBudget(value: unknown): boolean {
  return budgetFailure(value) === undefined
}

export function budgetFailure(value: unknown): string | undefined {
  const seen = new WeakSet<object>()
  let nodes = 0
  let stringBytes = 0
  const visit = (entry: unknown, depth: number): string | undefined => {
    nodes += 1
    if (nodes > MAX_PROTOCOL_NODES) return 'The protocol message contains too many values.'
    if (depth > 32) return 'The protocol message is too deeply nested.'
    if (typeof entry === 'string') {
      if (entry.length > MAX_PROTOCOL_STRING_CHARS) return 'A protocol string exceeds the size limit.'
      stringBytes += entry.length
      return stringBytes > MAX_PROTOCOL_STRING_BYTES
        ? 'The protocol message exceeds the size limit.'
        : undefined
    }
    if (typeof entry !== 'object' || entry === null) return undefined
    if (seen.has(entry)) return 'The protocol message contains a cyclic value.'
    seen.add(entry)
    if (Array.isArray(entry)) {
      for (const child of entry) {
        const failure = visit(child, depth + 1)
        if (failure !== undefined) return failure
      }
    } else {
      for (const [key, child] of Object.entries(entry)) {
        const keyFailure = visit(key, depth + 1)
        if (keyFailure !== undefined) return keyFailure
        const failure = visit(child, depth + 1)
        if (failure !== undefined) return failure
      }
    }
    return undefined
  }
  return visit(value, 0)
}
