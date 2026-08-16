import { describe, it } from 'vitest'

describe('DshConnectionCoordinator', () => {
  it.todo('coalesces simultaneous connect calls into a single discovery/start operation')
  it.todo('attaches to the highest-ranked healthy existing DSH before locating a runtime')
  it.todo('falls through unhealthy candidates without starting early')
  it.todo('never starts DSH in attach-only mode')
  it.todo('always starts an isolated managed DSH in new-isolated mode')
  it.todo('publishes runtime-missing with safe searched paths when no binary exists')
  it.todo('marks attached instances external and spawned instances managed')
  it.todo('disconnects streams but does not stop an external DSH process')
  it.todo('stops only the exact managed child on disconnect')
  it.todo('cancels discovery, probing, startup, and connection without leaked work')
})
