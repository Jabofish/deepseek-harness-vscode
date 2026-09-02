import { describe, expect, it } from 'vitest'

import { managedWebArguments } from '../src/launch-contract.js'

describe('managed Web Profile launch contract', () => {
  it.each([
    ['0.1.0-rc.6', false],
    ['0.1.0-rc.7', false],
    ['0.1.0-rc.8', true],
    ['0.1.1-rc.1', true],
    ['0.1.1-rc.2', true],
    ['0.1.2-alpha.1', true],
    ['0.1.2-alpha.2', true],
    ['0.1.2-alpha.3', true],
    ['0.1.2-alpha.4', true],
    ['0.1.2-alpha.5', true],
    ['0.1.0-rc.99', false],
  ])('selects the verified optional flags for %s', (version, noOpen) => {
    const args = managedWebArguments(version, 4317)

    expect(args).toContain('--profile')
    expect(args).toContain('--host')
    expect(args).toContain('--port')
    expect(args.includes('--no-open')).toBe(noOpen)
  })

  it('normalizes a version label before selecting a versioned flag', () => {
    expect(managedWebArguments('DeepSeek Harness 0.1.0-rc.8', 0)).toContain('--no-open')
    expect(managedWebArguments('future-development-build', 0)).not.toContain('--no-open')
  })
})
