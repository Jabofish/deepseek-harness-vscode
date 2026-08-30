import type { z } from 'zod'

import type {
  hostEnvelopeSchema,
  hostEventSchema,
  hostMessageSchema,
  hostResponseSchema,
  webviewEnvelopeSchema,
  webviewRequestSchema,
} from './schemas.js'
import type {
  featureHostEnvelopeSchema,
  featureHostEventSchema,
  featureHostMessageSchema,
  featureRequestSchema,
  featureWebviewEnvelopeSchema,
  featureResponseSchema,
} from './feature-schemas.js'

export type WebviewRequest = z.infer<typeof webviewRequestSchema>
export type HostResponse = z.infer<typeof hostResponseSchema>
export type HostEvent = z.infer<typeof hostEventSchema>
export type HostMessage = z.infer<typeof hostMessageSchema>
export type WebviewEnvelope = z.infer<typeof webviewEnvelopeSchema>
export type HostEnvelope = z.infer<typeof hostEnvelopeSchema>
export type FeatureRequest = z.infer<typeof featureRequestSchema>
export type FeatureResponse = z.infer<typeof featureResponseSchema>
export type FeatureHostEvent = z.infer<typeof featureHostEventSchema>
export type FeatureHostMessage = z.infer<typeof featureHostMessageSchema>
export type FeatureHostEnvelope = z.infer<typeof featureHostEnvelopeSchema>
export type FeatureWebviewEnvelope = z.infer<typeof featureWebviewEnvelopeSchema>

export const PROTOCOL_VERSION = 1 as const

export type ProtocolEnvelope = WebviewEnvelope | HostEnvelope | FeatureWebviewEnvelope | FeatureHostEnvelope
