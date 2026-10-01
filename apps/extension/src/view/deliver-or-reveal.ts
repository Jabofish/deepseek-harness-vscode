import { VIEW_ID } from '../constants.js'

interface RevealDependencies {
  readonly post: (name: string, payload: unknown) => Thenable<boolean>
  readonly executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>
  /** Wait for a validated client handshake; stop on timeout or disposal. */
  readonly settle: () => Thenable<boolean>
}

/**
 * Title-bar and command-palette actions are reachable before the Webview has
 * been rendered once. `contributes.menus` gates them only on
 * `view == VIEW_ID`, and the command ids are activation events, so VS Code
 * activates the extension and invokes the handler while the view is collapsed
 * and has never been resolved. `postMessage` then resolves `false` because the
 * provider holds no `WebviewView`, and a fire-and-forget post is dropped: the
 * button looks enabled and does nothing at all.
 *
 * Focus the view itself, including when it is collapsed or has been moved to
 * another container. Its provider's `reveal()` only shows an existing view.
 * A resolved view may still be loading, so delivery waits for the client's
 * validated ready handshake rather than a fixed delay.
 */
export async function deliverOrRevealView(
  { post, executeCommand, settle }: RevealDependencies,
  name: string,
  payload: unknown,
): Promise<boolean> {
  if (await post(name, payload)) return true
  await executeCommand(`${VIEW_ID}.focus`)
  if (!(await settle())) return false
  return await post(name, payload)
}
