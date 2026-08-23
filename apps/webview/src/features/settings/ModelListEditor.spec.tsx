// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelListEditor } from './ModelListEditor.js'

describe('ModelListEditor state notifications', () => {
  afterEach(() => cleanup())

  it('does not notify the parent during render and reports edits from the event handler', () => {
    const onChange = vi.fn()
    render(
      <ModelListEditor
        models={[{ id: 'model-a' }]}
        writable
        saving={false}
        discoveryInput={{ settingsNamespace: 'llm-deepseek', providerId: 'deepseek' }}
        onChange={onChange}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onDiscover={vi.fn().mockResolvedValue([])}
      />,
    )

    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'model-b' } })

    expect(onChange).toHaveBeenCalledWith([{ id: 'model-b' }])
  })
})
