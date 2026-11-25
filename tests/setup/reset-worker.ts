import { vi } from 'vitest'

/**
 * The `packages` and `node` projects reuse one worker for many test files
 * instead of starting a fresh one per file, which keeps loaded packages warm.
 * This runs before each file and returns the worker to a clean start, so a
 * file behaves the same whether it runs alone or after others: source
 * modules load again (so `vi.mock` reaches them and module state starts
 * over), and timers, stubbed globals, stubbed environment variables and
 * spies on shared objects are put back.
 */
vi.resetModules()
vi.useRealTimers()
vi.unstubAllGlobals()
vi.unstubAllEnvs()
vi.restoreAllMocks()
