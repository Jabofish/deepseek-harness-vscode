/**
 * Sanitised, invented values pinned to dsh-v0.2.2-rc.5 /
 * 9c2670d3bce5275e0d1610272958121af87787bb.
 * packages/bundle/base/cordis.patch.yml: omits web.searchProvider so DSH
 * selects per model route.
 * packages/web/web-search-deepseek/src/provider.ts: web/deepseek-search-llm-request.
 * packages/session/session-format-v0-to-v1/src/payload-validation.ts:
 * deepSeekSearchBodyValue.
 */

export const rc225SearchRequestEvent = {
  type: 'web/deepseek-search-llm-request',
  seq: 5,
  time: 1_005,
  data: {
    endpoint: 'https://search-gateway.invalid/anthropic/v1/messages',
    apiVersion: '2023-06-01',
    body: {
      model: 'deepseek-v4-flash',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Private search fixture query' }],
        },
      ],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5,
        },
      ],
    },
  },
} as const

export const rc225SearchSessionSnapshot = {
  type: 'snapshot',
  header: { version: 4, id: 'rc225-search-session', createdAt: 1_000, isSeeded: false, delegationDepth: 0 },
  cursor: 8,
  hasMore: false,
  projections: { asOfSeq: 8, values: {} },
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
        time: 1_001,
        surfaceOp: 'append',
        data: {
          id: 'user-msg-1',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Search fixture user prompt' }],
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 3,
        time: 1_002,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-msg-1',
            role: 'assistant',
            source: {
              kind: 'model',
              provider: 'deepseek-official',
              model: 'deepseek-v4-flash',
            },
            content: [
              {
                type: 'tool-call',
                id: 'search-call-1',
                name: 'web_search',
                arguments: '{"queries":["fixture"]}',
              },
            ],
          },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'tool/call',
        seq: 4,
        time: 1_003,
        data: {
          turn: 1,
          step: 1,
          callId: 'search-call-1',
          name: 'web_search',
          arguments: '{"queries":["fixture"]}',
        },
      },
    },
    { type: 'event', event: rc225SearchRequestEvent },
    {
      type: 'event',
      event: {
        type: 'tool/result',
        seq: 6,
        time: 1_006,
        surfaceOp: 'append',
        sourceEventSeqs: [4],
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'tool-msg-1',
            role: 'tool',
            toolCallId: 'search-call-1',
            source: { kind: 'tool', callId: 'search-call-1' },
            content: [{ type: 'text', text: 'Search fixture answer' }],
          },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'step/end',
        seq: 7,
        time: 1_007,
        data: { turn: 1, step: 1 },
      },
    },
    {
      type: 'event',
      event: {
        type: 'turn/end',
        seq: 8,
        time: 1_008,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    },
  ],
} as const

export const rc225SettingsDescribe = {
  writable: true,
  hasDocument: true,
  namespaces: [
    {
      ns: 'web',
      schema: {
        uid: 3,
        refs: {
          1: { type: 'string' },
          2: { type: 'string' },
          3: { type: 'object', dict: { searchProvider: 1, fetchProvider: 2 } },
        },
      },
      value: { fetchProvider: 'http' },
      base: { fetchProvider: 'http' },
      applies: 'live',
      secrets: [],
      revision: 1,
    },
    {
      ns: 'web-search-deepseek',
      schema: {
        uid: 4,
        refs: {
          1: { type: 'string' },
          2: { type: 'string' },
          3: { type: 'number' },
          4: { type: 'object', dict: { apiKeyEnv: 1, baseURL: 2, maxUses: 3 } },
        },
      },
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', maxUses: 5 },
      applies: 'live',
      secrets: [{ path: ['apiKey'], set: false }],
      revision: 2,
    },
  ],
} as const
