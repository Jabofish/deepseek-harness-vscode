import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'

import { ToolCard } from './components/ToolCard.js'
import { ToolRow } from './components/ToolRow.js'
import { ToolRendererRegistry } from './tool-renderer-registry.js'

function tool(name: string): ToolCallView {
  return {
    id: `call-${name}`,
    name,
    category: 'tool',
    title: name,
    status: 'completed',
    metadata: {},
  }
}

describe('ToolRendererRegistry', () => {
  it('keeps legacy payloads on the generic path except for the safe skill view', () => {
    const registry = new ToolRendererRegistry()
    expect(registry.render(tool('read')).type).toBe(ToolCard)
    expect(registry.render(tool('skill')).type).toBe(ToolRow)
    expect(registry.render(tool('future_tool')).type).toBe(ToolCard)

    const dispose = registry.register('future_tool', ({ tool: value }) =>
      createElement('span', { 'data-tool': value.name }, 'custom'),
    )
    expect(registry.render(tool('FUTURE_TOOL')).type).not.toBe(ToolCard)
    dispose()
    expect(registry.render(tool('future_tool')).type).toBe(ToolCard)
  })

  it('isolates a broken custom renderer and preserves generic recovery', () => {
    const registry = new ToolRendererRegistry()
    registry.register('broken_tool', () => {
      throw new Error('renderer failure')
    })
    expect(registry.render(tool('broken_tool')).type).toBe(ToolCard)
  })
})
