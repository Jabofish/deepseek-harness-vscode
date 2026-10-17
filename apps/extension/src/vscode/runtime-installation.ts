/** npm owns fetching, retries and caching; this bounds the complete package mutation. */
export const RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60_000
export const RUNTIME_INSTALL_MAX_BUFFER = 1024 * 1024

/** Classify known failures without sending npm output or filesystem paths to the Webview. */
export function runtimeInstallationFailureMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as Readonly<Record<string, unknown>>
  const npmCode =
    typeof record.stderr === 'string'
      ? /(?:^|\r?\n)npm\s+(?:error|ERR!)\s+code\s+([A-Z_]+)\b/u.exec(record.stderr)?.[1]
      : undefined
  const code = npmCode ?? record.code
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY')
    return 'DSH files are in use or not writable. Close apps using this installation and retry.'
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return 'DSH installation stopped because npm produced too much output. Check the npm install log before retrying.'
  if (record.killed === true)
    return 'DSH installation exceeded the ten-minute limit. Check the npm install log before retrying.'
  return undefined
}
