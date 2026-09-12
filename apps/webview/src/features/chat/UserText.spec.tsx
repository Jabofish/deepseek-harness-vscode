// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { containsUserTextReferences, projectUserText } from './UserText.js'

describe('UserText', () => {
  afterEach(() => cleanup())

  it('renders file mentions as Host-backed actions and keeps sentence punctuation out of the path', () => {
    const openFile = vi.fn()
    render(<div>{projectUserText('请检查 @src/index.ts, 然后继续。', [], { openFile })}</div>)

    const reference = screen.getByRole('button', { name: 'src/index.ts' })
    expect(reference.textContent).toContain('index.ts')
    expect(reference.getAttribute('href')).toBeNull()

    fireEvent.click(reference)
    expect(openFile).toHaveBeenCalledOnce()
    expect(openFile).toHaveBeenCalledWith('src/index.ts')
  })

  it('supports quoted paths and renders folders and sessions without unsafe open actions', () => {
    const openFile = vi.fn()
    render(
      <div>
        {projectUserText(
          '查看 @"src/components/Button.tsx" @docs/ 和 @Earlier debugging。',
          ['Earlier debugging'],
          { openFile },
        )}
      </div>,
    )

    const file = screen.getByRole('button', { name: 'src/components/Button.tsx' })
    fireEvent.click(file)
    expect(openFile).toHaveBeenCalledWith('src/components/Button.tsx')
    expect(screen.queryByRole('button', { name: /docs/u })).toBeNull()
    expect(screen.getByText('Earlier debugging')).toBeDefined()
    expect(screen.getByText('docs')).toBeDefined()
  })

  it('projects DSH wire-form session references and detects only reference-shaped text', () => {
    render(<div>{projectUserText('回看 @[Earlier debugging](dsh-session:session-1)。', [], undefined)}</div>)

    expect(screen.getByText('Earlier debugging')).toBeDefined()
    expect(containsUserTextReferences('ordinary prose')).toBe(false)
    expect(containsUserTextReferences('ordinary @file.txt')).toBe(true)
    expect(containsUserTextReferences('ordinary prose', ['Earlier debugging'])).toBe(true)
  })
})
