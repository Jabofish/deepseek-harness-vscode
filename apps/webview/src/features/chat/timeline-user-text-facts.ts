import { isInjectedUserMessage, type TimelineNode } from '@dsh-vscode/timeline'
import type { UserTextFacts } from './timeline-shared.js'

interface FactRow {
  readonly index: number
  readonly id: string
  readonly labels: readonly string[]
}

interface Projection {
  readonly source: readonly TimelineNode[]
  readonly rows: readonly FactRow[]
  readonly facts: ReadonlyMap<string, UserTextFacts>
}

export function isInjectedUserTimelineNode(
  node: Extract<TimelineNode, { readonly kind: 'user-message' }>,
): boolean {
  return isInjectedUserMessage({
    type: 'message.user',
    sessionId: '',
    messageId: node.id,
    markdown: node.markdown,
    ...(node.source === undefined ? {} : { source: node.source }),
  })
}

/** Context rows enrich only the immediately preceding authored user group. */
export function createUserTextFactsProjector(): (
  nodes: readonly TimelineNode[],
  nodeChangeStart?: number,
  nodeChangeBase?: readonly TimelineNode[],
) => ReadonlyMap<string, UserTextFacts> {
  let previous: Projection | undefined
  return (nodes, nodeChangeStart, nodeChangeBase) => {
    if (previous?.source === nodes) return previous.facts
    let start = 0
    if (previous !== undefined) {
      if (
        nodeChangeStart !== undefined &&
        Number.isSafeInteger(nodeChangeStart) &&
        nodeChangeStart >= 0 &&
        nodeChangeBase === previous.source
      ) {
        start = Math.min(nodeChangeStart, nodes.length, previous.source.length)
      } else {
        const length = Math.min(nodes.length, previous.source.length)
        while (start < length && nodes[start] === previous.source[start]) start += 1
      }
      // An appended/removed context row changes the owner immediately before it.
      while (start > 0) {
        const preceding = nodes[start - 1]
        if (preceding?.kind !== 'user-message') break
        start -= 1
        if (!isInjectedUserTimelineNode(preceding)) break
      }
    }
    const oldRows = previous?.rows ?? []
    const cut = firstRowAtOrAfter(oldRows, start)
    const suffix = collectRows(nodes, start)
    let facts = previous?.facts ?? new Map<string, UserTextFacts>()
    let rows = oldRows
    if (!sameRows(oldRows, cut, suffix)) {
      rows = [...oldRows.slice(0, cut), ...suffix]
      const next = new Map(rows.map((row) => [row.id, { sessionReferenceLabels: row.labels }]))
      if (!sameFacts(facts, next)) facts = next
    }
    previous = { source: nodes, rows, facts }
    return facts
  }
}

function collectRows(nodes: readonly TimelineNode[], start: number): readonly FactRow[] {
  const rows: FactRow[] = []
  for (let index = start; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node?.kind !== 'user-message' || isInjectedUserTimelineNode(node)) continue
    const labels = new Set<string>()
    let nextIndex = index + 1
    for (; nextIndex < nodes.length; nextIndex += 1) {
      const context = nodes[nextIndex]
      if (context?.kind !== 'user-message' || !isInjectedUserTimelineNode(context)) break
      if (context.source === 'session-reference') {
        for (const label of context.sessionReferenceLabels ?? []) {
          if (labels.size < 32) labels.add(label)
        }
      }
    }
    if (labels.size > 0) rows.push({ index, id: node.id, labels: [...labels] })
    index = nextIndex - 1
  }
  return rows
}

function firstRowAtOrAfter(rows: readonly FactRow[], index: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((rows[middle]?.index ?? Infinity) < index) low = middle + 1
    else high = middle
  }
  return low
}

function sameRows(previous: readonly FactRow[], cut: number, next: readonly FactRow[]): boolean {
  return (
    previous.length - cut === next.length &&
    next.every((row, index) => {
      const old = previous[cut + index]
      return old?.index === row.index && old.id === row.id && sameLabels(old.labels, row.labels)
    })
  )
}

function sameFacts(
  left: ReadonlyMap<string, UserTextFacts>,
  right: ReadonlyMap<string, UserTextFacts>,
): boolean {
  if (left.size !== right.size) return false
  for (const [id, facts] of right) {
    const known = left.get(id)
    if (known === undefined || !sameLabels(known.sessionReferenceLabels, facts.sessionReferenceLabels))
      return false
  }
  return true
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((label, index) => label === right[index])
}
