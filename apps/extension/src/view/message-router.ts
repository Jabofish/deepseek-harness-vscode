import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import { unimplemented } from '@dsh-vscode/domain'

export interface MessageRouterDependencies {
  readonly postMessage: (message: HostMessage) => Thenable<boolean>
}

export class WebviewMessageRouter {
  private readonly inFlight = new Map<string, AbortController>()

  public constructor(private readonly dependencies: MessageRouterDependencies) {}

  public handle(rawMessage: unknown): Promise<void> {
    return unimplemented<Promise<void>>('Webview request validation and routing', [
      'parse raw values with webviewRequestSchema and reject malformed input without side effects',
      'require unique requestId and attach one AbortController per request',
      'route to narrow application use cases, never directly to DSH transport',
      'return one success or redacted error response with the same requestId',
      'bound concurrent requests and prioritize interaction responses over background refreshes',
      `raw type ${typeof rawMessage}; in-flight ${this.inFlight.size}; post function ${typeof this.dependencies.postMessage}`,
    ])
  }

  public cancelAll(): void {
    unimplemented<void>('cancel all Webview requests', [
      'abort every in-flight controller',
      'clear the map after cancellation',
      'allow subsequent requests after a new view is initialized',
    ])
  }

  private complete(_request: WebviewRequest, _message: HostMessage): void {
    unimplemented<void>('complete a Webview protocol request', [
      'remove the matching request from in-flight state exactly once',
      'post a schema-valid response',
      'ignore late completions after cancellation',
    ])
  }
}
