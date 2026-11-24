import { describe, expect, it } from 'vitest'
import { reconnectsAfterConfigurationChange, retriesWithNewRuntime } from './configuration-reconnect.js'

const changed =
  (...sections: readonly string[]) =>
  (section: string): boolean =>
    sections.some((changedSection) => changedSection === section || changedSection.startsWith(`${section}.`))

describe('reconnectsAfterConfigurationChange', () => {
  it('retries a missing or failed runtime when its executable or auto-start setting changes', () => {
    for (const state of ['runtime-missing', 'failed', 'port-conflict'] as const) {
      expect(reconnectsAfterConfigurationChange(changed('dsh.runtime.executablePath'), state)).toBe(true)
      expect(reconnectsAfterConfigurationChange(changed('dsh.runtime.autoStart'), state)).toBe(true)
    }
  })

  it('keeps a live or idle connection when only the runtime choice changes', () => {
    for (const state of ['connected', 'connecting', 'starting', 'idle'] as const)
      expect(reconnectsAfterConfigurationChange(changed('dsh.runtime.executablePath'), state)).toBe(false)
  })

  it('reconnects active connections on transport changes and ignores unrelated settings', () => {
    expect(reconnectsAfterConfigurationChange(changed('dsh.connection.serverUrl'), 'connected')).toBe(true)
    expect(reconnectsAfterConfigurationChange(changed('dsh.connection.mode'), 'runtime-missing')).toBe(true)
    expect(reconnectsAfterConfigurationChange(changed('dsh.connection.mode'), 'idle')).toBe(false)
    expect(reconnectsAfterConfigurationChange(changed('dsh.completionCue'), 'failed')).toBe(false)
  })

  it('tries a newly installed runtime only while no runtime is connected', () => {
    expect(retriesWithNewRuntime('runtime-missing')).toBe(true)
    expect(retriesWithNewRuntime('connected')).toBe(false)
  })
})
