import { describe, expect, it } from 'vitest'
import { projectPluginInstallProgress } from './plugin-manager-event-projection.js'

describe('RC2 Plugin Manager event projection', () => {
  it('keeps only request phase and bounded attempt positions', () => {
    expect(
      projectPluginInstallProgress([
        {
          requestId: 'plugin-manager-abc-1',
          phase: 'installing',
          attempt: { registry: 'https://private.example.test/', index: 2, total: 3 },
          cwd: 'C:\\Users\\private\\profile',
        },
      ]),
    ).toEqual({ requestId: 'plugin-manager-abc-1', phase: 'installing', attemptIndex: 2, attemptTotal: 3 })
    expect(projectPluginInstallProgress([{ requestId: 'plugin-manager-abc-1', phase: 'applying' }])).toEqual({
      requestId: 'plugin-manager-abc-1',
      phase: 'applying',
    })
    expect(
      JSON.stringify(
        projectPluginInstallProgress([
          {
            requestId: 'plugin-manager-abc-1',
            phase: 'installing',
            attempt: { registry: 'https://private.example.test/', index: 1, total: 1 },
          },
        ]),
      ),
    ).not.toContain('private.example')
  })

  it('drops malformed phases, ids and attempt ranges', () => {
    expect(projectPluginInstallProgress([{ requestId: ' bad id ', phase: 'installing' }])).toBeUndefined()
    expect(
      projectPluginInstallProgress([{ requestId: 'plugin-manager-1', phase: 'finished' }]),
    ).toBeUndefined()
    expect(
      projectPluginInstallProgress([
        { requestId: 'plugin-manager-1', phase: 'applying', attempt: { index: 1, total: 1 } },
      ]),
    ).toBeUndefined()
    expect(
      projectPluginInstallProgress([
        { requestId: 'plugin-manager-1', phase: 'installing', attempt: { index: 3, total: 2 } },
      ]),
    ).toBeUndefined()
  })
})
