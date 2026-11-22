import { spawn, type ChildProcess } from 'node:child_process'

export interface NativeNotificationDependencies {
  readonly platform?: NodeJS.Platform
  readonly spawn?: typeof spawn
  readonly timeoutMs?: number
}

/** A desktop notifier that never settles must not hold the cue open. */
const NOTIFIER_TIMEOUT_MS = 3_000

/** The title and body are fixed cue text, but escape them anyway. */
function appleScript(title: string, body: string): string {
  const quote = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
  return `display notification "${quote(body)}" with title "${quote(title)}"`
}

/**
 * Raise a desktop notification outside the VS Code window. Linux uses
 * `notify-send` (libnotify), macOS `osascript`; Windows has no dependency-free
 * notifier here, so the caller keeps VS Code's in-window fallback.
 *
 * Only fixed arguments are passed — never a prompt, answer or session title.
 * Resolves false when the notifier is unavailable or failed, so the caller can
 * fall back to `showInformationMessage`.
 */
export async function showNativeNotification(
  title: string,
  body: string,
  dependencies: NativeNotificationDependencies = {},
): Promise<boolean> {
  const platform = dependencies.platform ?? process.platform
  const command =
    platform === 'linux'
      ? {
          file: 'notify-send',
          args: [`--app-name=${title}`, '--urgency=normal', '--icon=dialog-information', title, body],
        }
      : platform === 'darwin'
        ? { file: 'osascript', args: ['-e', appleScript(title, body)] }
        : undefined
  if (command === undefined) return false

  const spawnFn = dependencies.spawn ?? spawn
  return await new Promise<boolean>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnFn(command.file, command.args, { stdio: 'ignore' })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    function finish(shown: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(shown)
    }
    const timer = setTimeout(() => {
      finish(false)
      child.kill('SIGKILL')
    }, dependencies.timeoutMs ?? NOTIFIER_TIMEOUT_MS)
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
  })
}
