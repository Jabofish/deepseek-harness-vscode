/**
 * Sanitised, invented values pinned to dsh-v0.2.2-rc.4 /
 * 3f321d32bfe382212a8ed8785c1d47a5a300aa23.
 * packages/llm/llm/src/error.ts: CONTENT_REFUSED.
 * packages/llm/llm-deepseek/src/translate.ts: refusal stop yields usage and throws CONTENT_REFUSED.
 * snapshots/session/deepseek-content-refusal/session.v4.jsonl: assistant/attempt + turn/end.
 */

const refusalUsage = {
  inputTokens: 12,
  outputTokens: 5,
  totalTokens: 17,
} as const

export const rc224RefusalMessage =
  'DeepSeek refused to answer under its content safety review: blocked: messages.1.content.0'

export const rc224RefusalAttemptEvent = {
  type: 'assistant/attempt',
  seq: 5,
  time: 1_005,
  data: {
    turn: 1,
    step: 1,
    stream: [
      { type: 'chunk', time: 1_001, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'text-chunks', time0: 1_002, index: 0, dt: [], texts: ['Draft before refusal.'] },
      {
        type: 'chunk',
        time: 1_003,
        chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Draft before refusal.' } },
      },
      { type: 'chunk', time: 1_004, chunk: { type: 'usage', usage: refusalUsage } },
      {
        type: 'chunk',
        time: 1_005,
        chunk: {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: rc224RefusalMessage, code: 'CONTENT_REFUSED' },
          },
        },
      },
    ],
  },
} as const

export const rc224RefusalTurnEndEvent = {
  type: 'turn/end',
  seq: 7,
  time: 1_007,
  data: {
    turn: 1,
    reason: {
      kind: 'error',
      error: { message: rc224RefusalMessage, code: 'CONTENT_REFUSED' },
    },
  },
} as const

export const rc224RefusalSnapshot = {
  type: 'snapshot',
  header: { version: 4, id: 'rc224-refusal-session', createdAt: 1_000, isSeeded: false, delegationDepth: 0 },
  cursor: 7,
  hasMore: false,
  projections: { asOfSeq: 7, values: {} },
  records: [
    {
      type: 'event',
      event: {
        type: 'turn/start',
        seq: 0,
        time: 1_000,
        data: { turn: 1 },
      },
    },
    {
      type: 'event',
      event: {
        type: 'step/start',
        seq: 1,
        time: 1_000,
        data: { turn: 1, step: 1 },
      },
    },
    {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 2,
        time: 1_000,
        surfaceOp: 'append',
        data: {
          id: 'user-msg-1',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Fixture request.' }],
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'request/header',
        seq: 3,
        time: 1_000,
        data: {
          header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
          reason: 'initial',
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'request/context',
        seq: 4,
        time: 1_000,
        data: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      },
    },
    { type: 'event', event: rc224RefusalAttemptEvent },
    {
      type: 'event',
      event: {
        type: 'step/end',
        seq: 6,
        time: 1_006,
        data: { turn: 1, step: 1 },
      },
    },
    { type: 'event', event: rc224RefusalTurnEndEvent },
  ],
} as const
