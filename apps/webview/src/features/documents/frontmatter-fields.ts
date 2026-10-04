import { isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
export interface FrontmatterField {
  readonly key: string
  readonly value: string
  readonly block: boolean
}
/** Pinned upstream frontmatter semantics; AST ranges preserve numeric spelling and aliases. */
export function parseFrontmatterFields(source: string): readonly FrontmatterField[] | undefined {
  if (source.length > 32_768) return undefined
  try {
    const document = parseDocument(source, { uniqueKeys: true, strict: true })
    if (document.errors.length > 0) return undefined
    if (document.contents === null) return []
    if (!isMap(document.contents) || document.contents.items.length > 64) return undefined
    const pending: { readonly node: unknown; readonly depth: number }[] = [
      { node: document.contents, depth: 0 },
    ]
    let count = 0
    while (pending.length > 0) {
      const { node, depth } = pending.pop()!
      if (++count > 2048 || depth > 32) return undefined
      if (isMap(node))
        for (const pair of node.items)
          pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 })
      else if (isSeq(node)) for (const child of node.items) pending.push({ node: child, depth: depth + 1 })
    }
    return document.contents.items.map(({ key, value }) => ({
      key: nodeText(source, key),
      value: nodeText(source, value),
      block: isNode(value) && !isScalar(value),
    }))
  } catch {
    return undefined
  }
}
function nodeText(source: string, node: unknown): string {
  if (isScalar(node) && typeof node.value === 'string') return node.value.trimEnd()
  if (!isNode(node)) return ''
  const [start, end] = node.range ?? [0, 0]
  const indent = start - source.lastIndexOf('\n', start - 1) - 1
  return source
    .slice(start, end)
    .replace(new RegExp(`\\n {0,${indent}}`, 'gu'), '\n')
    .trimEnd()
}
