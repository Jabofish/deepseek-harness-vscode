import { z } from 'zod'
import { id, requestBase } from './request-common.js'

/**
 * Surface routes control where the chat is hosted. The chat UI can live in the
 * secondary-side-bar view or in an editor-area WebviewPanel; these requests let
 * the Webview ask the Host to move itself or to open a specific session in the
 * editor area. Surface identity itself is Host-owned and is delivered to the
 * Webview through the `ui.surface.assigned` event, never chosen by the client.
 */
export const surfaceRequestSchemas = [
  z
    .object({
      type: z.literal('surface.responseRendered'),
      ...requestBase,
      payload: z.object({ sessionId: id, turn: z.number().int().nonnegative().safe() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('surface.titlebarLayout'),
      ...requestBase,
      payload: z.object({ layout: z.enum(['compact', 'regular', 'wide']) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('surface.openInEditor'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          replaceCurrent: z.literal(true).optional(),
          // Bounded, Host-sanitized editor tab title. The Webview already holds
          // the session name; the Host never trusts it as more than a label.
          title: z.string().max(120).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('surface.moveToSidebar'), ...requestBase }).strict(),
] as const
