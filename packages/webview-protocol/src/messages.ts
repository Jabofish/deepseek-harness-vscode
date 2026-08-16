import type { z } from 'zod'

import type {
  hostEnvelopeSchema,
  hostEventSchema,
  hostMessageSchema,
  hostResponseSchema,
  webviewEnvelopeSchema,
  webviewRequestSchema,
} from './schemas.js'

export type WebviewRequest = z.infer<typeof webviewRequestSchema>
export type HostResponse = z.infer<typeof hostResponseSchema>
export type HostEvent = z.infer<typeof hostEventSchema>
export type HostMessage = z.infer<typeof hostMessageSchema>
export type WebviewEnvelope = z.infer<typeof webviewEnvelopeSchema>
export type HostEnvelope = z.infer<typeof hostEnvelopeSchema>

export const PROTOCOL_VERSION = 1 as const

export type ProtocolEnvelope = WebviewEnvelope | HostEnvelope
