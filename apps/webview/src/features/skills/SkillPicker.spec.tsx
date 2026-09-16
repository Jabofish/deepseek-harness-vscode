// @vitest-environment jsdom

import type { SkillDescriptor } from '@dsh-vscode/domain'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillPicker } from './SkillPicker.js'

const noop = (): void => undefined

describe('SkillPicker', () => {
  afterEach(() => cleanup())

  it('keeps a user-only skill runnable instead of disabling its action', () => {
    // `modelInvocable: false` marks the skill only a human may run, so it is the
    // row this picker exists for; a disabled action would make it unreachable.
    const userOnly: SkillDescriptor = {
      id: 'private-note',
      name: 'private-note',
      description: 'A user-only skill.',
      enabled: false,
    }
    render(<SkillPicker skills={[userOnly]} onExecute={noop} onRefresh={noop} />)

    expect(screen.getByText('User-only skill')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Use skill' }).hasAttribute('disabled')).toBe(false)
  })

  it('shows a host-reported origin and omits the separator when the host sent none', () => {
    const withOrigin: SkillDescriptor = {
      id: 'code-review',
      name: 'code-review',
      description: 'Review changes.',
      source: 'user',
      enabled: true,
    }
    const withoutOrigin: SkillDescriptor = {
      id: 'commit-helper',
      name: 'commit-helper',
      description: 'Commit messages.',
      enabled: true,
    }
    const { container } = render(
      <SkillPicker skills={[withOrigin, withoutOrigin]} onExecute={noop} onRefresh={noop} />,
    )

    const rows = [...container.querySelectorAll('.dsh-skills li')].map((row) => row.textContent)
    expect(rows[0]).toContain('user · model and user invocable')
    expect(rows[1]).toContain('commit-helper')
    expect(rows[1]).toContain('model and user invocable')
    expect(rows[1]).not.toContain('·')
  })
})
