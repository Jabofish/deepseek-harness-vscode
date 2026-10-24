/** npm owns fetching, retries and caching; this bounds the complete package mutation. */
export const RUNTIME_INSTALL_TIMEOUT_MS = 20 * 60_000
export const RUNTIME_INSTALL_MAX_BUFFER = 1024 * 1024

/** npm environment names are case insensitive; retain explicit user values. */
export function withNpmFetchDefaults(environment: NodeJS.ProcessEnv, checking = false): NodeJS.ProcessEnv {
  const result = { ...environment }
  const defaults = {
    npm_config_fetch_timeout: checking ? '20000' : '300000',
    npm_config_fetch_retries: checking ? '1' : '2',
    npm_config_fetch_retry_mintimeout: '1000',
    npm_config_fetch_retry_maxtimeout: '5000',
  }
  for (const [name, value] of Object.entries(defaults)) {
    if (!Object.keys(result).some((key) => key.toLowerCase() === name && result[key] !== undefined))
      result[name] = value
  }
  return result
}

export const RUNTIME_INSTALL_FAILURE_MESSAGES = {
  engine:
    'A DSH dependency requires a different Node.js version. Update the Node.js installation used by npm and reload VS Code.',
  proxyAuthentication:
    'The proxy requires authentication. Configure npm proxy credentials in the Extension Host environment and retry.',
  certificate:
    'The npm TLS certificate could not be verified. Check your proxy certificate and npm cafile configuration.',
  network:
    'The npm connection failed or timed out. Check network access, npm proxy settings and NO_PROXY, then retry; cached downloads will be reused.',
  diskSpace:
    'There is not enough disk space to install DSH. Free space in the npm cache and installation locations, then retry.',
  integrity: 'npm could not verify a downloaded package. Check the registry or proxy and retry.',
  permissions: 'DSH files are in use or not writable. Close apps using this installation and retry.',
  outputLimit:
    'DSH installation stopped because npm produced too much output. Check the npm install log before retrying.',
  timeout:
    'DSH installation exceeded the twenty-minute limit. Check the live installation output before retrying.',
} as const

/** Classify known failures without sending npm output or filesystem paths to the Webview. */
export function runtimeInstallationFailureMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as Readonly<Record<string, unknown>>
  const npmCode =
    typeof record.stderr === 'string'
      ? /(?:^|\r?\n)npm\s+(?:error|ERR!)\s+code\s+([A-Z0-9_]+)\b/u.exec(record.stderr)?.[1]
      : undefined
  const code = npmCode ?? record.code
  if (code === 'EBADENGINE') return RUNTIME_INSTALL_FAILURE_MESSAGES.engine
  const text = [record.stderr, record.stdout, record.message]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  if (code === 'E407' || /\b407\b.*(?:proxy|authentication)|proxy.*\b407\b/iu.test(text))
    return RUNTIME_INSTALL_FAILURE_MESSAGES.proxyAuthentication
  if (
    /CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|unable to verify.*certificate|certificate.*(?:expired|self.signed)/iu.test(
      String(code) + text,
    )
  )
    return RUNTIME_INSTALL_FAILURE_MESSAGES.certificate
  if (
    record.killed !== true &&
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT/iu.test(
      String(code) + text,
    )
  )
    return RUNTIME_INSTALL_FAILURE_MESSAGES.network
  if (code === 'ENOSPC') return RUNTIME_INSTALL_FAILURE_MESSAGES.diskSpace
  if (code === 'EINTEGRITY') return RUNTIME_INSTALL_FAILURE_MESSAGES.integrity
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY')
    return RUNTIME_INSTALL_FAILURE_MESSAGES.permissions
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return RUNTIME_INSTALL_FAILURE_MESSAGES.outputLimit
  if (record.killed === true) return RUNTIME_INSTALL_FAILURE_MESSAGES.timeout
  return undefined
}
