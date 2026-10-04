/** Browser-safe drawing vocabulary; arbitrary upstream props never cross this port. */
export type ModsBandColor =
  'yellow' | 'red' | 'green' | 'cyan' | 'blue' | 'magenta' | 'gray' | 'white' | 'black'
export type ModsBandNode =
  | string
  | {
      readonly kind: 'box'
      readonly direction: 'row' | 'column'
      readonly bordered: boolean
      readonly color?: ModsBandColor | undefined
      readonly paddingX: number
      readonly paddingY: number
      readonly gap: number
      readonly children: readonly ModsBandNode[]
    }
  | {
      readonly kind: 'text'
      readonly color?: ModsBandColor | undefined
      readonly bold: boolean
      readonly dim: boolean
      readonly italic: boolean
      readonly underline: boolean
      readonly children: readonly ModsBandNode[]
    }
  | {
      readonly kind: 'button'
      readonly label: string
      readonly hotkey?: string | undefined
      readonly disabled: boolean
      readonly actionId?: string | undefined
    }

export interface ModsBandSnapshot {
  readonly generation: number
  readonly tree: readonly ModsBandNode[] | null
}
export interface ModsBandReadResult {
  readonly available: boolean
  /** Null means no newer generation during the bounded wait. */
  readonly snapshot: ModsBandSnapshot | null
}
export interface ModsBandRepository {
  read(sessionId: string, afterGeneration?: number, signal?: AbortSignal): Promise<ModsBandReadResult>
  press(
    sessionId: string,
    generation: number,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<ModsBandSnapshot>
  close(): Promise<void>
}

/** Check bounds before recursive mapping/schema parsing, including untrusted inputs. */
export function isBoundedModsBandTree(tree: unknown): boolean {
  if (tree === null) return true
  if (!Array.isArray(tree) || tree.length > 512) return false
  const pending: { node: unknown; depth: number }[] = tree.map((node: unknown) => ({ node, depth: 1 }))
  let count = 0
  let characters = 0
  while (pending.length > 0) {
    const entry = pending.pop()!
    if (++count > 512 || entry.depth > 12) return false
    if (typeof entry.node === 'string') characters += entry.node.length
    else if (typeof entry.node === 'object' && entry.node !== null && !Array.isArray(entry.node)) {
      const node = entry.node as Record<string, unknown>
      const strings = [node.label, node.hotkey]
      const props = node.props
      if (typeof props === 'object' && props !== null && !Array.isArray(props)) {
        const values = Object.values(props as Record<string, unknown>)
        if (values.length > 32) return false
        strings.push(...values)
      }
      for (const value of strings) if (typeof value === 'string') characters += value.length
      if (Array.isArray(node.children)) {
        if (node.children.length > 512) return false
        for (const child of node.children as unknown[]) pending.push({ node: child, depth: entry.depth + 1 })
      }
    } else return false
    if (characters > 32_768) return false
  }
  return true
}
