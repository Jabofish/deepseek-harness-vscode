import { describe, expect, it } from 'vitest'
import { unwrapRpcResult } from '../src/versions/rc6/rpc.js'

describe('RPC diagnostic credential boundary', () => {
  it.each([
    ['authorization: Bearer fixture-private-token', 'fixture-private-token'],
    ['Authorization: Basic fixture-private-basic', 'fixture-private-basic'],
    ['Bearer fixture-bare-token', 'fixture-bare-token'],
    [
      'https://fixture-user:fixture-password@example.invalid/route?key=fixture-query-token',
      'fixture-password',
    ],
    ['https://example.invalid/route?key=fixture-query-token', 'fixture-query-token'],
    ['failed to open "C:\\fixture-private\\profile data\\session.jsonl"', 'fixture-private'],
  ])('redacts %s before returning an application error', (detail, secret) => {
    try {
      unwrapRpcResult(
        { result: { ok: false, error: { code: 'model-unavailable', message: detail } } },
        'session.selectModel',
      )
      throw new Error('Expected a rejected model selection')
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_CONFIGURATION' })
      expect((error as Error).message).toContain('The selected DSH model is unavailable.')
      expect((error as Error).message).not.toContain(secret)
    }
  })
})
