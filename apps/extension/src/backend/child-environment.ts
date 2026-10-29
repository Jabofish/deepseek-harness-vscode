import path from 'node:path'

/**
 * Variable names that carry credentials. A child process spawned for a
 * package-manager install (or a read-only system diagnostic) must never
 * receive these, because a compromised install binary — or any npm-spawned
 * descendant such as `git` or a lifecycle script — would otherwise inherit
 * every secret in the Extension Host environment.
 */
const SECRET_NAME_PATTERN =
  /token|secret|password|passwd|passphrase|credential|_auth|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|session[_-]?key/iu

/** Copy an environment, dropping variables whose names mark them as credentials. */
export function withoutSecrets(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (!SECRET_NAME_PATTERN.test(name)) sanitized[name] = value
  }
  return sanitized
}

/**
 * Minimal environment for read-only Windows system tools (PowerShell,
 * taskkill). They never need developer secrets, and a trimmed environment also
 * prevents a workspace-controlled `PSModulePath` or `PATH` from injecting code
 * when PowerShell starts.
 */
export function windowsSystemToolEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const windir = process.env.windir ?? systemRoot
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']
  const temp = process.env.TEMP ?? process.env.TMP
  const environment: NodeJS.ProcessEnv = { SystemRoot: systemRoot, windir }
  if (programFiles !== undefined) environment.ProgramFiles = programFiles
  if (programFilesX86 !== undefined) environment['ProgramFiles(x86)'] = programFilesX86
  if (temp !== undefined) environment.TEMP = temp
  // Add-Type resolves the C# compiler and framework reference assemblies; keep
  // the Windows PowerShell directory reachable without exposing the developer's
  // full PATH.
  environment.PATH = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  return environment
}
