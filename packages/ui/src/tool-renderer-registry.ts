import type { ReactElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface ToolRendererProps {
  readonly tool: ToolCallView
}

export type ToolRenderer = (props: ToolRendererProps) => ReactElement

export class ToolRendererRegistry {
  private readonly renderers = new Map<string, ToolRenderer>()

  public register(toolName: string, renderer: ToolRenderer): () => void {
    return unimplemented<() => void>('register specialized tool renderer', [
      'reject duplicate names unless explicitly replaced by the owner',
      'return an idempotent unregister function',
      'keep renderer registration out of the timeline reducer',
      `tool ${toolName}; renderer type ${typeof renderer}; current count ${this.renderers.size}`,
    ])
  }

  public render(tool: ToolCallView): ReactElement {
    return unimplemented<ReactElement>('render specialized or generic tool card', [
      'look up an exact renderer by normalized DSH tool name',
      'fall back to the generic ToolCard for every unknown or newly added DSH tool',
      'catch renderer errors and preserve access to generic redacted metadata',
      `tool ${tool.name}; registered count ${this.renderers.size}`,
    ])
  }
}
