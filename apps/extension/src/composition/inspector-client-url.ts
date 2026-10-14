import * as vscode from 'vscode'
import { AppError, isLoopbackEndpoint, parseServerOrigin } from '@dsh-vscode/domain'
import { waitForSignal } from '../backend/endpoint-network.js'

/** Forward the validated Worker on the Host side, then embed its client address in DevTools. */
export async function inspectorClientUrl(frontendUrl: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (vscode.env.remoteName === undefined) return frontendUrl
  const frontend = new URL(frontendUrl)
  const worker = new URL(`http://${frontend.searchParams.get('ws') ?? ''}`)
  const endpoint = parseServerOrigin(worker.origin)
  if (endpoint === undefined || !isLoopbackEndpoint(endpoint)) throw forwardingFailed()
  let forwarded: URL
  try {
    forwarded = new URL(
      (
        await waitForSignal(
          Promise.resolve(vscode.env.asExternalUri(vscode.Uri.parse(worker.toString()))),
          signal,
        )
      ).toString(),
    )
  } catch {
    if (signal.aborted)
      throw new AppError({
        code: 'REQUEST_CANCELLED',
        message: 'Inspector forwarding was cancelled.',
        retryable: false,
      })
    throw forwardingFailed()
  }
  const clientEndpoint = parseServerOrigin(forwarded.origin)
  if (
    clientEndpoint === undefined ||
    !isLoopbackEndpoint(clientEndpoint) ||
    forwarded.username !== '' ||
    forwarded.password !== '' ||
    forwarded.pathname !== worker.pathname ||
    forwarded.search !== '' ||
    forwarded.hash !== ''
  )
    throw forwardingFailed()
  frontend.searchParams.delete('ws')
  frontend.searchParams.set(
    forwarded.protocol === 'https:' ? 'wss' : 'ws',
    `${forwarded.host}${forwarded.pathname}`,
  )
  return frontend.toString()
}

function forwardingFailed(): AppError {
  return new AppError({
    code: 'PROCESS_FAILED',
    message: 'Chrome DevTools requires a client-accessible loopback tunnel for this remote workspace.',
    retryable: true,
  })
}
