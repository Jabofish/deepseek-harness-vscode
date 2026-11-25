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

  it('ignores decorators, scoped packages, and code spans so Markdown stays intact', () => {
    expect(containsUserTextReferences('Use @Injectable() and @Override here')).toBe(false)
    expect(containsUserTextReferences('Install @types/node and @dsh-vscode/domain')).toBe(false)
    expect(containsUserTextReferences('Check `@src/index.ts` or ```ts\n@src/app.ts\n```')).toBe(false)
    expect(containsUserTextReferences('Check @src/index.ts please')).toBe(true)
    expect(containsUserTextReferences('Open @app/(marketing)/page.tsx')).toBe(true)
    expect(containsUserTextReferences('Use @Component(selector) here')).toBe(false)

    const openSession = vi.fn()
    render(<div>{projectUserText('See @[Past session](dsh-session:s-42)', [], { openSession })}</div>)
    fireEvent.click(screen.getByRole('button', { name: 'Past session' }))
    expect(openSession).toHaveBeenCalledWith('s-42')
  })

  it('treats composer mentions of well-known extensionless files as file references', () => {
    expect(containsUserTextReferences('Fix @Makefile and @docker/Dockerfile:3')).toBe(true)
    expect(containsUserTextReferences('Ping @maintainers about @Override')).toBe(false)
    const openFile = vi.fn()
    render(<div>{projectUserText('Update @LICENSE now', [], { openFile })}</div>)
    fireEvent.click(screen.getByRole('button', { name: /LICENSE/u }))
    expect(openFile).toHaveBeenCalledWith('LICENSE')
  })
})
