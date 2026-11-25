import { vi } from 'vitest'

/**
 * The webview project keeps one jsdom environment for every file a worker runs
 * (that is what keeps it fast). This file runs before each test file and puts
 * back what an earlier file may have left behind, so a file sees the same
 * starting state whether it runs alone or after others:
 * - a fresh module registry, so `vi.mock` also reaches modules that an earlier
 *   file already loaded and module state such as the active locale starts
 *   over (installed packages stay loaded);
 * - real timers, no stubbed globals or environment variables;
 * - empty storage, document and root attributes.
 */
vi.resetModules()
vi.useRealTimers()
vi.unstubAllGlobals()
vi.unstubAllEnvs()

if (typeof document !== 'undefined') {
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      storage.clear()
    } catch {
      // A replaced storage that throws belongs to the file that replaced it.
    }
  }
  const root = document.documentElement
  for (const name of root.getAttributeNames()) root.removeAttribute(name)
  document.head.replaceChildren()
  document.body.replaceChildren()
  for (const name of document.body.getAttributeNames()) document.body.removeAttribute(name)
}
