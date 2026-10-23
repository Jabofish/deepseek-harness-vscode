/** Sanitized dsh-v0.2.1-rc.3 / 1f81c047fc48fa190a683e469daa699857e9afe8.
 * api/session-controller/src/types.ts: SessionCreateRequest, ModelCatalog,
 * ModelCatalogModel; llm-deepseek/src/listing-config.ts.
 * IDs, labels and failures are invented. ModelCatalogModel does not promise a
 * contextWindow: its absence must not become a hardcoded official model limit.
 */
export const namedBlank = {
  workspaceId: 'fixture-workspace',
  sessionId: 'fixture-blank',
  agentPreset: 'fixture-preset',
}
export const modelCatalog = {
  default: { provider: 'fixture-route', model: 'runtime-model', reasoningEffort: 'runtime-effort' },
  routableProviders: ['fixture-route'],
  groups: [
    {
      id: 'fixture-route',
      name: 'Runtime route',
      models: [
        {
          id: 'runtime-model',
          name: 'Runtime supplied model name',
          reasoning: {
            efforts: [{ id: 'runtime-effort', name: 'Runtime effort' }],
            defaultEffort: 'runtime-effort',
          },
        },
      ],
    },
  ],
  failures: [
    {
      id: 'unavailable-route',
      name: 'Unavailable route',
      message: 'Listing is temporarily unavailable; retain this failure.',
    },
  ],
}

export const listingSettings = {
  writable: true,
  hasDocument: true,
  namespaces: [
    {
      ns: 'llm-deepseek',
      applies: 'live',
      revision: 3,
      secrets: [],
      value: { modelsTimeoutMs: 5000, modelsMaxAgeMs: 600000 },
      base: { modelsTimeoutMs: 5000, modelsMaxAgeMs: 600000 },
      user: {},
      schema: {
        uid: 3,
        refs: {
          1: { type: 'number', meta: { min: Number.MIN_VALUE, max: 2147483647 } },
          2: { type: 'number', meta: { min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 } },
          3: { type: 'object', dict: { modelsTimeoutMs: 1, modelsMaxAgeMs: 2 } },
        },
      },
    },
  ],
}
