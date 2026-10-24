import { useEffect, useRef } from 'react'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { requestId } from '../../app/store/ids.js'
import { useStableCallback } from '../../app/useStableCallback.js'

export type BillingClient = <T>(request: FeatureRequest) => Promise<T>

/** Closing a billing view cancels only its own requests, including long history reads. */
export function useBillingClient(request: BillingClient): {
  readonly send: BillingClient
  readonly isAlive: () => boolean
} {
  const pending = useRef(new Set<string>())
  const alive = useRef(false)
  const send = useStableCallback(async <T>(input: FeatureRequest): Promise<T> => {
    pending.current.add(input.requestId)
    try {
      return await request<T>(input)
    } finally {
      pending.current.delete(input.requestId)
    }
  })
  const isAlive = useStableCallback(() => alive.current)
  useEffect(() => {
    alive.current = true
    const requests = pending.current
    return () => {
      alive.current = false
      for (const targetRequestId of requests)
        void request({
          type: 'feature.request.cancel',
          requestId: requestId(),
          payload: { targetRequestId },
        }).catch(() => undefined)
      requests.clear()
    }
  }, [request])
  return { send, isAlive }
}
