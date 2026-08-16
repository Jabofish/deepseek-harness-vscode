import type { z } from 'zod'

import type {
  hostEventSchema,
  hostMessageSchema,
  hostResponseSchema,
  webviewRequestSchema,
} from './schemas.js'

export type WebviewRequest = z.infer<typeof webviewRequestSchema>
export type HostResponse = z.infer<typeof hostResponseSchema>
export type HostEvent = z.infer<typeof hostEventSchema>
export type HostMessage = z.infer<typeof hostMessageSchema>

export const PROTOCOL_VERSION = 1 as const

export interface ProtocolEnvelope {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly message: WebviewRequest | HostMessage
}
