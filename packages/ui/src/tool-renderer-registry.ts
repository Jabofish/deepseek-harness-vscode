import { createElement, type ReactElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { ToolCard } from './components/ToolCard.js'
import { isSpecializedTool, ToolRow } from './components/ToolRow.js'
import type { PresentationTranslate } from './tool-presentation.js'

export interface ToolRendererProps {
  readonly tool: ToolCallView
  readonly expanded?: boolean
  readonly onToggle?: () => void
  readonly onOpenLink?: (href: string) => void
  readonly translate?: PresentationTranslate
}

export type ToolRenderer = (props: ToolRendererProps) => ReactElement

export class ToolRendererRegistry {
  private readonly renderers = new Map<string, ToolRenderer>()

  public register(toolName: string, renderer: ToolRenderer): () => void {
    const key = normalize(toolName)
    if (key.length === 0) throw new Error('A tool renderer name is required.')
    if (typeof renderer !== 'function') throw new TypeError('A tool renderer must be a function.')
    if (this.renderers.has(key)) throw new Error(`A renderer is already registered for ${toolName}.`)
    this.renderers.set(key, renderer)
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      if (this.renderers.get(key) === renderer) this.renderers.delete(key)
    }
  }

  public render(tool: ToolCallView, options: Omit<ToolRendererProps, 'tool'> = {}): ReactElement {
    const renderer = this.renderers.get(normalize(tool.name))
    if (renderer === undefined) {
      // The generic card is the compatibility path. A built-in row is only
      // safe when the adapter supplied the corresponding structured view.
      // `skill` is the one legacy exception: its row only exposes the
      // explicitly known skill name and visible result text, so it remains
      // safe for rc.6/rc.7 payloads that predate presentation metadata.
      const legacySkill = tool.name.trim().toLocaleLowerCase() === 'skill'
      if ((tool.presentation !== undefined || legacySkill) && isSpecializedTool(tool))
        return createElement(ToolRow, { tool, ...options })
      return createElement(ToolCard, {
        tool,
        expanded: options.expanded ?? false,
        onToggle: options.onToggle ?? (() => undefined),
        ...(options.translate === undefined ? {} : { translate: options.translate }),
      })
    }
    try {
      return renderer({ tool, ...options })
    } catch {
      return createElement(ToolCard, {
        tool,
        expanded: options.expanded ?? false,
        onToggle: options.onToggle ?? (() => undefined),
        ...(options.translate === undefined ? {} : { translate: options.translate }),
      })
    }
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}
