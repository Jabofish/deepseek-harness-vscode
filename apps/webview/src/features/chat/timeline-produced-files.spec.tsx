// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderProducedFiles } from './timeline-produced-files.js'

afterEach(() => cleanup())

describe('renderProducedFiles', () => {
  it('renders chips and a copy button for produced file paths', () => {
    const t = vi.fn((key: string) => key)
    const onOpenLink = vi.fn()
    const onShowInFolder = vi.fn()

    render(<>{renderProducedFiles(['src/index.ts', 'src/types.ts'], onOpenLink, onShowInFolder, t)}</>)

    expect(screen.getByText('index.ts')).toBeDefined()
    expect(screen.getByText('types.ts')).toBeDefined()
    expect(screen.getByRole('button', { name: 'message.copy' })).toBeDefined()
  })
})
