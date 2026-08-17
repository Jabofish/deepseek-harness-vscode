import { describe, expect, it } from 'vitest'

import { webviewRequestSchema } from '../packages/webview-protocol/src/schemas.js'

describe('attachment ingest schema', () => {
  it('accepts the exact Base64 envelope size of an 8 MiB attachment', () => {
    const encodedLength = Math.ceil((8 * 1024 * 1024) / 3) * 4
    const request = {
      type: 'attachment.ingest',
      requestId: 'request-1',
      payload: {
        name: 'maximum.bin',
        dataBase64: 'A'.repeat(encodedLength),
      },
    }

    expect(webviewRequestSchema.safeParse(request).success).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, dataBase64: `${request.payload.dataBase64}A` },
      }).success,
    ).toBe(false)
  })
})
