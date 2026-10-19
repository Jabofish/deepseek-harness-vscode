import { describe, expect, it } from 'vitest'
import { EDITOR_COMPANION_FAILURES } from '@dsh-vscode/domain'
import { explainFailure } from './failures.js'

describe('editor failure guidance', () => {
  it('distinguishes read/edit versions, missing receipts/files and uncertain mutation outcomes', () => {
    expect(explainFailure('stale-document', 'document')).not.toContain('written')
    expect(explainFailure('stale-document', 'propose')).toContain('Nothing was written')
    expect(explainFailure('not-found', 'proposal')).toContain('proposalId')
    expect(explainFailure('not-found', 'document')).toContain('file no longer exists')
    for (const reason of [
      'invalid-response',
      'timeout',
      'unavailable',
      'cancelled',
      'stale-request',
    ] as const) {
      expect(explainFailure(reason, 'propose')).toContain('Do not automatically resend')
      expect(explainFailure(reason, 'propose')).not.toContain('Retry once')
    }
  })
  it('names a next step for every failure reason', () => {
    for (const reason of EDITOR_COMPANION_FAILURES) {
      const message = explainFailure(reason)
      expect(message.length).toBeGreaterThan(20)
      expect(message).not.toContain('undefined')
    }
  })
  it('tells the model how the user can restore access', () => {
    expect(explainFailure('not-bound')).toContain('Check Settings')
    expect(explainFailure('not-bound')).not.toContain('recovering')
    for (const reason of EDITOR_COMPANION_FAILURES)
      expect(explainFailure(reason)).not.toContain('Turn On Editor Tools')
    expect(explainFailure('denied')).toContain('Settings → General → Editor integration')
  })
})
