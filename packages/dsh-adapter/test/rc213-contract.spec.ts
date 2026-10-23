import { describe, expect, it } from 'vitest'
import { Rc213VersionAdapter } from '../src/versions/rc213/adapter.js'
import { Rc6ModelRepository } from '../src/repositories/model-repository.js'
import { Rc6SettingsRepository } from '../src/repositories/settings-repository.js'
import { callRpc } from '../src/versions/rc6/rpc.js'
import { bodyText, endpoint, transportOptions, wrappedResponse } from './support/contract-harness.js'
import { listingSettings, modelCatalog, namedBlank } from './fixtures/rc213-contract.js'

describe('rc.3 consumed wire increments', () => {
  it('names the blank and explicit preset using native create, without the retired reuse flag', async () => {
    let body: unknown
    const transport = new Rc213VersionAdapter(
      transportOptions((_input, init) => {
        body = JSON.parse(bodyText(init))
        return Promise.resolve(
          wrappedResponse(init, {
            sessionId: 'host-selected-session',
            agentPreset: namedBlank.agentPreset,
          }),
        )
      }),
    ).createTransport(endpoint)
    try {
      expect(await callRpc(transport, 'session.create', namedBlank)).toMatchObject({
        sessionId: 'host-selected-session',
      })
      expect(body).toMatchObject({ method: 'session/create', payload: { args: { request: namedBlank } } })
      expect(JSON.stringify(body)).not.toContain('reuseWorkspaceBlank')
    } finally {
      await transport.close()
    }
  })

  it('retains dynamic catalog names and reasoning without inventing context metadata', async () => {
    let value: unknown = modelCatalog
    const transport = new Rc213VersionAdapter(
      transportOptions((_input, init) => Promise.resolve(wrappedResponse(init, value))),
    ).createTransport(endpoint)
    try {
      const repository = new Rc6ModelRepository(transport)
      const models = await repository.listModels()
      expect(models).toMatchObject([
        {
          providerId: 'fixture-route',
          id: 'runtime-model',
          label: 'Runtime supplied model name',
          defaultReasoningLevel: 'runtime-effort',
        },
      ])
      expect(models[0]?.contextWindow).toBeUndefined()
      value = {
        ...modelCatalog,
        groups: [{ id: 'fixture-route', name: 'Runtime route', models: [{ id: 'bad', name: 7 }] }],
      }
      await expect(repository.listModels()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    } finally {
      await transport.close()
    }
  })

  it('describes new listing controls through the generic live settings schema', async () => {
    const transport = new Rc213VersionAdapter(
      transportOptions((_input, init) => Promise.resolve(wrappedResponse(init, listingSettings))),
    ).createTransport(endpoint)
    try {
      const snapshot = await new Rc6SettingsRepository(transport).readSnapshot()
      expect(snapshot.schema.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'llm-deepseek.modelsTimeoutMs',
            type: 'number',
            restartRequired: false,
          }),
          expect.objectContaining({
            path: 'llm-deepseek.modelsMaxAgeMs',
            type: 'number',
            restartRequired: false,
          }),
        ]),
      )
      expect(snapshot.values['llm-deepseek']).toEqual(listingSettings.namespaces[0]!.value)
    } finally {
      await transport.close()
    }
  })
})
