import { describe, expect, it, vi } from 'vitest'
import type {
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
  DshBackend,
  GoalView,
  SubagentHistoryPage,
} from '@dsh-vscode/domain'
import { BackendService } from '../src/services/backend-service.js'
import { AdvancedAgentUseCases } from '../src/use-cases/advanced-agent-use-cases.js'

function harness(): {
  useCases: AdvancedAgentUseCases
  document: AgentPresetDocument
  location: AgentPresetLocation
  history: SubagentHistoryPage
  send: ReturnType<typeof vi.fn>
} {
  const document: AgentPresetDocument = { id: 'standard', trust: 'system', content: 'preset' }
  const roster: AgentPresetRoster = { presets: [], authorable: false, hasDocument: false }
  const location: AgentPresetLocation = { opened: true }
  const history = { events: [], hasMore: false } as unknown as SubagentHistoryPage
  const goal: GoalView = { id: 'goal', title: 'Goal', status: 'in-progress' }
  const repository = {
    marker: true,
    list: (): Promise<AgentPresetRoster> => Promise.resolve(roster),
    select: (): Promise<void> => Promise.resolve(),
    read(this: { marker: boolean }, _id: string, _signal?: AbortSignal): Promise<AgentPresetDocument> {
      if (!this.marker) throw new Error('preset repository receiver was lost')
      return Promise.resolve(document)
    },
    copy(
      this: { marker: boolean },
      _from: string,
      _id: string,
      _name?: string,
      _signal?: AbortSignal,
    ): Promise<string> {
      if (!this.marker) throw new Error('preset repository receiver was lost')
      return Promise.resolve('copy')
    },
    openDocument(
      this: { marker: boolean },
      _id: string,
      _signal?: AbortSignal,
    ): Promise<AgentPresetLocation> {
      if (!this.marker) throw new Error('preset repository receiver was lost')
      return Promise.resolve(location)
    },
    remove(this: { marker: boolean }, _id: string, _signal?: AbortSignal): Promise<void> {
      if (!this.marker) throw new Error('preset repository receiver was lost')
      return Promise.resolve()
    },
  }
  const goals = {
    marker: true,
    clear(this: { marker: boolean }, _id: string, _signal?: AbortSignal): Promise<void> {
      if (!this.marker) throw new Error('goal repository receiver was lost')
      return Promise.resolve()
    },
    list: (): Promise<readonly GoalView[]> => Promise.resolve([goal]),
    create: (): Promise<GoalView> => Promise.resolve(goal),
    update: (): Promise<void> => Promise.resolve(),
  }
  const subagents = {
    marker: true,
    history(
      this: { marker: boolean },
      _sessionId: string,
      _query?: { readonly beforeSequence?: number },
      _signal?: AbortSignal,
    ): Promise<SubagentHistoryPage> {
      if (!this.marker) throw new Error('subagent repository receiver was lost')
      return Promise.resolve(history)
    },
    list: (): Promise<never> => Promise.reject(new Error('unused')),
    send: vi.fn(() => Promise.resolve()),
    interrupt: (): Promise<void> => Promise.resolve(),
  }
  const backend = {
    presets: repository,
    goals,
    subagents,
    events: { subscribe: vi.fn(() => () => undefined) },
  } as unknown as DshBackend
  const service = new BackendService()
  service.attach(backend, () => undefined)
  return { useCases: new AdvancedAgentUseCases(service), document, location, history, send: subagents.send }
}

describe('AdvancedAgentUseCases preset authoring', () => {
  it('keeps the preset repository receiver for every optional authoring method', async () => {
    const { useCases, document, location, history } = harness()

    await expect(useCases.readPreset('standard')).resolves.toEqual(document)
    await expect(useCases.copyPreset('standard', 'copy')).resolves.toBe('copy')
    await expect(useCases.openPresetDocument('copy')).resolves.toEqual(location)
    await expect(useCases.removePreset('copy')).resolves.toBeUndefined()
    await expect(useCases.clearGoal('goal')).resolves.toBeUndefined()
    await expect(useCases.listSubagentHistory('session', { beforeSequence: 10 })).resolves.toBe(history)
  })
})

describe('AdvancedAgentUseCases subagent delivery', () => {
  it('defaults legacy requests to queue and forwards an explicit steer mode', async () => {
    const { useCases, send } = harness()

    await useCases.execute('subagent.send', { sessionId: 'child', message: 'queued' })
    await useCases.execute('subagent.send', { sessionId: 'child', message: 'steer now', mode: 'steer' })

    expect(send).toHaveBeenNthCalledWith(1, 'child', 'queued', [], 'queue', undefined)
    expect(send).toHaveBeenNthCalledWith(2, 'child', 'steer now', [], 'steer', undefined)
  })

  it('rejects an invalid delivery mode before touching the repository', async () => {
    const { useCases, send } = harness()

    await expect(
      useCases.execute('subagent.send', { sessionId: 'child', message: 'invalid', mode: 'later' }),
    ).rejects.toThrow('mode must be queue or steer')
    expect(send).not.toHaveBeenCalled()
  })
})
