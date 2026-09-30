import { VIEW_CONTAINER_ID } from '../constants.js'

interface RevealDependencies {
  readonly post: (name: string, payload: unknown) => Thenable<boolean>
  readonly executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>
  /** Lets the revealed Webview finish resolving before the retry is posted. */
  readonly settle: () => Thenable<void>
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
 * Focusing the view container is what makes VS Code call `resolveWebviewView`.
 * The provider's own `reveal()` cannot do it, because it only calls `show()` on
 * a view that already exists. So the message is retried after the container is
 * focused, on a later turn, once the new Webview is listening.
 */
export async function deliverOrRevealView(
  { post, executeCommand, settle }: RevealDependencies,
  name: string,
  payload: unknown,
): Promise<boolean> {
  if (await post(name, payload)) return true
  await executeCommand(`workbench.view.extension.${VIEW_CONTAINER_ID}`)
  await settle()
  return await post(name, payload)
}
