// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolLinkErrorDialog } from './ToolLinkErrorDialog.js'
import { writeClipboard } from './clipboard.js'
import type { Translate } from '../../i18n.js'

vi.mock('./clipboard.js', () => ({ writeClipboard: vi.fn() }))

afterEach(() => cleanup())

describe('ToolLinkErrorDialog', () => {
  it('renders error message, target href, and copy button that copies the href', async () => {
    vi.mocked(writeClipboard).mockResolvedValue(true)

    const onClose = vi.fn()
    const onRetry = vi.fn()
    const t: Translate = (key) => {
      if (key === 'timeline.openErrorTitle') return 'Cannot open target'
      if (key === 'app.dismissError') return 'Dismiss'
      if (key === 'message.copy') return 'Copy'
      if (key === 'message.copied') return 'Copied'
      if (key === 'timeline.cancelOpen') return 'Cancel'
      if (key === 'timeline.retryOpen') return 'Retry'
      return key
    }

    render(
      <ToolLinkErrorDialog
        href="https://example.test/failed/path.ts"
        message="The editor refused this path."
        busy={false}
        onClose={onClose}
        onRetry={onRetry}
        t={t}
      />,
    )

    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByText('Cannot open target')).toBeDefined()
    expect(screen.getByText('The editor refused this path.')).toBeDefined()
    expect(screen.getByText('https://example.test/failed/path.ts')).toBeDefined()

    const copyBtn = screen.getByRole('button', { name: 'Copy' })
    expect(copyBtn).toBeDefined()

    fireEvent.click(copyBtn)
    expect(writeClipboard).toHaveBeenCalledWith('https://example.test/failed/path.ts')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined()
  })
})
