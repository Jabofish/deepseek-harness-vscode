import { createElement, type ReactElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { ToolCard } from './components/ToolCard.js'

export interface ToolRendererProps {
  readonly tool: ToolCallView
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

  public render(tool: ToolCallView): ReactElement {
    const renderer = this.renderers.get(normalize(tool.name))
    if (renderer === undefined)
      return createElement(ToolCard, { tool, expanded: false, onToggle: () => undefined })
    try {
      return renderer({ tool })
    } catch {
      return createElement(ToolCard, { tool, expanded: false, onToggle: () => undefined })
    }
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}
