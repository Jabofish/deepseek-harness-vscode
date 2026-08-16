// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimeMissingView } from './RuntimeMissingView.js'

describe('RuntimeMissingView', () => {
  afterEach(() => cleanup())

  it('explains the setup path and exposes install, selection, command, retry, and docs actions', () => {
    render(
      <RuntimeMissingView
        searchedLocations={['/usr/bin/dsh']}
        busyAction={undefined}
        onAction={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: "DeepSeek Harness isn't ready yet" })).toBeDefined()
    expect(screen.getByText(/DSH runs locally in the VS Code Extension Host/)).toBeDefined()
    expect(screen.getByText(/the extension reconnects automatically/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Install DSH / 安装 DSH' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Select DSH / 选择 DSH' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Copy command / 复制命令' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry / 重试' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Docs / 文档' })).toBeDefined()
  })
})
