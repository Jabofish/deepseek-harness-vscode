// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditorContextActions } from './EditorContextActions.js'

describe('EditorContextActions', () => {
  afterEach(() => cleanup())

  it('exposes the current-symbol action only when the Host reports it', async () => {
    const onCapture = vi.fn()
    render(<EditorContextActions disabled={false} availableKinds={['symbol']} onCapture={onCapture} />)

    const action = screen.getByRole('button', { name: 'Add current symbol to DSH context' })
    expect(action).toBeDefined()
    fireEvent.click(action)

    await waitFor(() => expect(onCapture).toHaveBeenCalledWith('symbol'))
  })

  it('does not infer symbol support when the Host reports another context kind', () => {
    render(<EditorContextActions disabled={false} availableKinds={['file']} onCapture={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Add current symbol to DSH context' })).toBeNull()
  })
})
