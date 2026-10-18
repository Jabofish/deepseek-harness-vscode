import { describe, expect, it } from 'vitest'
import { CONNECTION_PHASES } from '@dsh-vscode/domain'
import { publicState } from './public-projection.js'

describe('public connection progress', () => {
  it.each(CONNECTION_PHASES)('projects only the safe phase for %s', (phase) => {
    expect(
      publicState({
        kind: 'connecting',
        phase,
        candidate: {
          endpoint: { host: '127.0.0.1', port: 3939, baseUrl: 'http://127.0.0.1:3939' },
          source: 'process-scan',
          confidence: 100,
          pid: 1234,
          commandLine: 'private-runtime --token=fixture-private',
        },
      }),
    ).toEqual({ kind: 'connecting', phase })
    expect(publicState({ kind: 'discovering', attempt: 3, phase })).toEqual({ kind: 'discovering', phase })
  })

  it('keeps old snapshots compatible and local runtime details private', () => {
    expect(publicState({ kind: 'discovering', attempt: 1 })).toEqual({ kind: 'discovering' })
    expect(
      publicState({
        kind: 'starting',
        runtime: {
          executable: '/private/runtime',
          version: '0.2.1-rc.2',
          supported: true,
          source: 'configured',
        },
      }),
    ).toEqual({ kind: 'starting' })
  })
})
