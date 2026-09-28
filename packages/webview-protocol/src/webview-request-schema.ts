import { z } from 'zod'
import { connectionRequestSchemas } from './request-connection-schemas.js'
import { sessionRequestSchemas } from './request-session-schemas.js'
import { attachmentRequestSchemas } from './request-attachment-schemas.js'
import { settingsRequestSchemas } from './request-settings-schemas.js'
import { workflowRequestSchemas } from './request-workflow-schemas.js'
import { presetRequestSchemas } from './request-preset-schemas.js'

export const webviewRequestSchema = z.discriminatedUnion('type', [
  ...connectionRequestSchemas,
  ...sessionRequestSchemas,
  ...attachmentRequestSchemas,
  ...settingsRequestSchemas,
  ...workflowRequestSchemas,
  ...presetRequestSchemas,
])
