import { describe, expect, it } from 'vitest'
import { hostMessageSchema } from './schemas.js'

describe('approval display reason protocol payload', () => {
  it('preserves DSH localized display copy in the generic domain event envelope', () => {
    const message = {
      type: 'event',
      name: 'permission.requested',
      sequence: 4,
      payload: {
        request: {
          id: 'approval-1',
          sessionId: 'session-1',
          title: 'bash',
          description: 'The command needs approval.',
          displayReason: {
            en: 'Allow this command to change files?',
            zh: '允许此命令修改文件吗？',
          },
          risk: 'unknown',
          options: [{ id: 'allowed-once', label: 'Allow once', kind: 'allow-once' }],
        },
      },
    } as const

    expect(hostMessageSchema.parse(message)).toEqual(message)
  })
})
