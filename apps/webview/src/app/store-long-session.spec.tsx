// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'
import { LONG_SESSION_ID, longSessionMessages } from './long-session.fixture.js'
import { Timeline } from '../features/chat/Timeline.js'
import { TrajectoryView } from '../features/trajectory/TrajectoryView.js'

class LongSessionClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.response(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  public emit(message: HostMessage): void {
    for (const listener of this.listeners) listener(message)
  }

  private response(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'session.open':
        return {
          id: LONG_SESSION_ID,
          workspaceId: 'workspace-desensitized',
          title: 'Desensitized long session',
          blank: false,
          status: 'running',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          history: [],
          permissionPresets: ['workspace-write'],
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            planMode: false,
            model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          },
        }
      case 'models.session.list':
        return { models: [] }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      default:
        return []
    }
  }
}

interface RawEvent {
  readonly name: string
  readonly payload: Readonly<Record<string, unknown>>
}

function rawEvent(message: HostMessage): RawEvent | undefined {
  return message.type === 'event'
    ? { name: message.name, payload: message.payload as Readonly<Record<string, unknown>> }
    : undefined
}

function settle(milliseconds = 30): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

const TOOL_CALL_IDS = [
  'call_glob_0001',
  'call_read_0002',
  'call_read_0003',
  'call_edit_0004',
  'call_pwsh_0005',
  'call_grep_0006',
  'call_edit_0007',
  'call_search_0008',
  'call_subagent_0009',
  'call_todo_0010',
  'call_read_0011',
] as const

const TOOL_TITLES = [
  'Search',
  'Read',
  'Read',
  'Edit',
  'Pwsh',
  'Search',
  'Edit',
  'Search',
  'Subagent',
  'To-do',
  'Read',
] as const

describe('Desensitized long-session replay', () => {
  afterEach(() => cleanup())

  it('presents six turns, eight tool types, todos, deliverables, and the final answer', async () => {
    const client = new LongSessionClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(LONG_SESSION_ID)

    const application = (): ReactElement => (
      <>
        <Timeline
          sessionId={LONG_SESSION_ID}
          nodes={store.timeline.nodes}
          {...(store.timeline.nodeChangeStart === undefined
            ? {}
            : { nodeChangeStart: store.timeline.nodeChangeStart })}
          {...(store.timeline.nodeChangeBase === undefined
            ? {}
            : { nodeChangeBase: store.timeline.nodeChangeBase })}
          streaming={false}
          running={false}
        />
        <TrajectoryView
          sessionId={LONG_SESSION_ID}
          nodes={store.timeline.nodes}
          {...(store.timeline.nodeChangeStart === undefined
            ? {}
            : { nodeChangeStart: store.timeline.nodeChangeStart })}
          {...(store.timeline.nodeChangeBase === undefined
            ? {}
            : { nodeChangeBase: store.timeline.nodeChangeBase })}
          streaming={false}
        />
      </>
    )
    const view = render(application())
    const unsubscribe = store.subscribe(() => view.rerender(application()))

    const shell = (selector: string): HTMLElement => {
      const element = view.container.querySelector<HTMLElement>(selector)
      if (element === null) throw new Error(`${selector} is not rendered`)
      return element
    }
    const timeline = (): HTMLElement => shell('.dsh-timeline-shell')
    const timelineText = (): string => timeline().textContent ?? ''
    const trajectory = (): HTMLElement => shell('.dsh-trajectory-shell')
    const toolCard = (callId: string): HTMLElement => {
      const element = timeline().querySelector<HTMLElement>(`[data-tool-call-id="${callId}"]`)
      if (element === null) throw new Error(`tool call ${callId} is not rendered`)
      return element
    }
    const toolTitle = (callId: string): string =>
      toolCard(callId).querySelector('.dsh-tool-card__title')?.textContent?.trim() ?? ''
    const expandTool = (callId: string): string => {
      const summary = toolCard(callId).querySelector<HTMLButtonElement>('.dsh-tool-card__summary')
      if (summary === null) throw new Error(`tool call ${callId} has no summary button`)
      if (summary.disabled) throw new Error(`tool call ${callId} registered no details to expand`)
      fireEvent.click(summary)
      return toolCard(callId).querySelector('.dsh-tool-card__details')?.textContent ?? ''
    }
    const rowTexts = (root: HTMLElement): readonly string[] =>
      Array.from(root.querySelectorAll('.dsh-trajectory__row')).map((row) => row.textContent ?? '')
    const kinds = (root: HTMLElement): readonly string[] =>
      Array.from(root.querySelectorAll('.dsh-trajectory__kind')).map((kind) => kind.textContent ?? '')
    const countKind = (kind: string): number =>
      store.timeline.nodes.filter((node) => node.kind === kind).length

    let cursor = 0
    const pushUntil = async (stop: (event: RawEvent) => boolean): Promise<void> => {
      while (cursor < longSessionMessages.length) {
        const message = longSessionMessages[cursor]
        cursor += 1
        if (message === undefined) continue
        client.emit(message)
        await settle()
        const event = rawEvent(message)
        if (event !== undefined && stop(event)) return
      }
      throw new Error('the fixture ended before the expected event was reached')
    }

    try {
      // Turns 1-4: plain answers, search/read/edit/exec tools, and a failed edit.
      await pushUntil((event) => event.name === 'turn.ended' && event.payload.turn === 4)
      expect(store.timeline.lastSequence).toBe(163)
      expect(store.timeline.nodes.some((node) => node.kind === 'event')).toBe(false)
      expect(timeline().querySelectorAll('.dsh-timeline__card--user')).toHaveLength(4)
      expect(timelineText()).toContain('本地优先的笔记同步')
      expect(timelineText()).toContain('快速开始只需要')
      expect(timelineText()).toContain('12 个用例全部通过')
      expect(timelineText()).toContain('保持原样')
      expect(timeline().querySelectorAll('table')).toHaveLength(2)
      expect(toolCard('call_edit_0007').querySelector('.dsh-tool-card')?.className).toContain(
        'dsh-tool-card--failed',
      )

      // Turn 5: a control projection shares the cursor of the answer that follows.
      await pushUntil((event) => event.name === 'turn.ended' && event.payload.turn === 5)
      const turnFiveAnswer = store.timeline.nodes.find(
        (node) => node.id === 'aaaaaaaa-5555-4555-8555-000000000005',
      )
      expect(turnFiveAnswer).toEqual(
        expect.objectContaining({ kind: 'assistant-message', sequence: 177, streaming: false }),
      )
      expect(
        store.timeline.nodes.filter((node) => node.id === 'aaaaaaaa-5555-4555-8555-000000000005'),
      ).toHaveLength(1)
      expect(store.timeline.nodes.at(-1)?.id).toBe('aaaaaaaa-5555-4555-8555-000000000005')
      expect(store.timeline.nodes.some((node) => node.kind === 'event')).toBe(false)
      expect(timelineText()).toContain('Active LTS')
      expect(timelineText()).toContain('2028 年 4 月')

      // Turn 6: transient reasoning and deltas stream before the durable completion.
      await pushUntil(
        (event) => event.name === 'message.delta' && String(event.payload.delta).includes('rollup'),
      )
      const streamed = store.timeline.nodes.at(-1)
      expect(streamed?.kind).toBe('assistant-message')
      if (streamed?.kind === 'assistant-message') {
        expect(streamed.id).toBe('assistant:6:4')
        expect(streamed.streaming).toBe(true)
        expect(streamed.sequence).toBeUndefined()
      }
      expect(store.timeline.lastSequence).toBe(196)
      expect(timelineText()).toContain('子代理调研完成，结论如下：')
      expect(timelineText()).toContain('配置最少')
      expect(timelineText()).not.toContain('Background subagent')
      expect(timeline().querySelector('.dsh-status-pill--in-progress')?.textContent).toBe('In progress')
      expect(timelineText()).toContain('调研打包方案（子代理进行中）')

      // Turn 6 end: the durable completion replaces the transient node in place.
      await pushUntil((event) => event.name === 'turn.ended' && event.payload.turn === 6)
      expect(store.timeline.lastSequence).toBe(203)
      expect(store.timeline.nodes.some((node) => node.kind === 'event')).toBe(false)
      expect(countKind('assistant-message')).toBe(6)
      expect(countKind('tool')).toBe(11)
      expect(countKind('todo')).toBe(1)
      expect(countKind('deliverables')).toBe(1)
      expect(
        store.timeline.nodes.filter((node) => node.kind === 'assistant-message').map((node) => node.id),
      ).toEqual([
        'aaaaaaaa-1111-4111-8111-000000000001',
        'aaaaaaaa-2222-4222-8222-000000000002',
        'aaaaaaaa-3333-4333-8333-000000000003',
        'aaaaaaaa-4444-4444-8444-000000000004',
        'aaaaaaaa-5555-4555-8555-000000000005',
        'aaaaaaaa-6666-4666-8666-000000000006',
      ])
      expect(
        store.timeline.nodes
          .filter((node) => node.kind === 'assistant-message')
          .every((node) => !node.streaming),
      ).toBe(true)
      expect(
        store.timeline.nodes
          .filter((node) => node.kind === 'tool')
          .every((node) => node.tool.status !== 'running'),
      ).toBe(true)
      expect(store.timeline.nodes.at(-1)?.id).toBe('deliverables:call_read_0011')

      const authored = store.timeline.nodes.filter(
        (node) => node.kind === 'user-message' && node.source === 'user',
      )
      const injected = store.timeline.nodes.filter(
        (node) => node.kind === 'user-message' && node.source === 'subagent-report',
      )
      expect(authored).toHaveLength(6)
      expect(injected).toHaveLength(1)
      expect(injected[0]).toEqual(expect.objectContaining({ sourceForm: 'relay' }))

      expect(timeline().querySelectorAll('.dsh-timeline__card--user')).toHaveLength(6)
      expect(timelineText()).toContain('TODO 里的两项已经同步更新。')
      expect(timelineText()).toContain('打包目标')
      expect(timelineText()).not.toContain('Background subagent')

      const rows = Array.from(timeline().querySelectorAll<HTMLElement>('.dsh-timeline__row'))
      expect(rows.at(-1)?.querySelector('.dsh-timeline__presented-files')).not.toBeNull()
      expect(rows.at(-2)?.textContent).toContain('建议先用')
      expect(timeline().querySelector('.dsh-timeline__presented-file-description')?.textContent).toBe(
        '最终配置',
      )
      expect(timeline().querySelector('.dsh-timeline__presented-files')?.textContent).toContain(
        'notes.config.json',
      )

      expect(
        Array.from(timeline().querySelectorAll<HTMLElement>('[data-tool-call-id]')).map(
          (element) => element.dataset.toolCallId,
        ),
      ).toEqual([...TOOL_CALL_IDS])
      expect(TOOL_CALL_IDS.map((callId) => toolTitle(callId))).toEqual([...TOOL_TITLES])

      expect(expandTool('call_read_0002')).toContain('一个本地优先的笔记同步工具。')
      expect(expandTool('call_pwsh_0005')).toContain('12 passed (12)')
      expect(expandTool('call_grep_0006')).toContain('store.ts:87')
      expect(expandTool('call_search_0008')).toContain('2025 年 10 月进入 Active LTS')
      const subagentDetails = expandTool('call_subagent_0009')
      expect(subagentDetails).toContain('Subagent started successfully.')
      expect(subagentDetails).toContain('比较 tsup 与 rollup')
      expect(toolCard('call_subagent_0009').querySelector('.dsh-tool-card__subtitle')?.textContent).toBe(
        'Task · 调研打包方案',
      )
      expect(expandTool('call_todo_0010')).toContain('调研打包方案（子代理进行中）')
      expect(expandTool('call_edit_0007')).toContain('the old string was not found')
      expect(
        toolCard('call_edit_0007').querySelector('.dsh-tool-card__section--error')?.textContent,
      ).toContain('the old string was not found')

      // Thinking stays collapsed until the reader opens it.
      const reasoningContent = (): readonly string[] =>
        Array.from(timeline().querySelectorAll('.dsh-timeline__reasoning-preview-content')).map(
          (element) => element.textContent ?? '',
        )
      const toggles = Array.from(
        timeline().querySelectorAll<HTMLButtonElement>('.dsh-timeline__reasoning-toggle'),
      )
      expect(toggles).toHaveLength(3)
      expect(reasoningContent().every((content) => content === '')).toBe(true)
      for (const toggle of toggles) fireEvent.click(toggle)
      expect(
        reasoningContent().some((content) => content.includes('用途问题，直接回答即可，不需要调用工具。')),
      ).toBe(true)
      expect(
        reasoningContent().some((content) => content.includes('编辑和测试都完成了，汇总一下结果。')),
      ).toBe(true)
      expect(
        reasoningContent().some((content) => content.includes('结论来自子代理，最后核对了一遍配置文件。')),
      ).toBe(true)

      // The Trajectory ledger keeps the same six turns plus the injected report.
      expect(
        Array.from(trajectory().querySelectorAll('.dsh-trajectory__section-title')).map(
          (title) => title.textContent,
        ),
      ).toEqual(['Turn 1', 'Turn 2', 'Turn 3', 'Turn 4', 'Turn 5', 'Turn 6'])
      const trajectoryKinds = kinds(trajectory())
      expect(trajectoryKinds.filter((kind) => kind === 'user')).toHaveLength(6)
      expect(trajectoryKinds.filter((kind) => kind === 'context')).toHaveLength(1)
      expect(trajectoryKinds.filter((kind) => kind === 'tool')).toHaveLength(11)
      expect(trajectoryKinds.filter((kind) => kind === 'message')).toHaveLength(6)
      const trajectoryRows = rowTexts(trajectory())
      expect(trajectoryRows.some((row) => row.includes('Active LTS'))).toBe(true)
      expect(trajectoryRows.some((row) => row.includes('web_search'))).toBe(true)
      const contextRow = trajectoryRows.findIndex((row) => row.includes('打包方案调研完成'))
      expect(contextRow).toBeGreaterThan(trajectoryRows.findIndex((row) => row.includes('todo_write')))
    } finally {
      unsubscribe()
      store.dispose()
    }
  })

  it('keeps every answer in place across rerenders and a below-cursor redelivery', async () => {
    const client = new LongSessionClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(LONG_SESSION_ID)

    const application = (): ReactElement => (
      <>
        <Timeline
          sessionId={LONG_SESSION_ID}
          nodes={store.timeline.nodes}
          streaming={false}
          running={false}
        />
        <TrajectoryView sessionId={LONG_SESSION_ID} nodes={store.timeline.nodes} streaming={false} />
      </>
    )
    const view = render(application())
    const unsubscribe = store.subscribe(() => view.rerender(application()))
    const timeline = (): HTMLElement => {
      const element = view.container.querySelector<HTMLElement>('.dsh-timeline-shell')
      if (element === null) throw new Error('the timeline shell is not rendered')
      return element
    }

    try {
      for (const message of longSessionMessages) client.emit(message)
      await settle(120)

      expect(store.timeline.lastSequence).toBe(203)
      const ids = store.timeline.nodes.map((node) => node.id)
      const text = timeline().textContent ?? ''
      expect(text).toContain('建议先用')

      view.rerender(application())
      expect(store.timeline.nodes.map((node) => node.id)).toEqual(ids)
      expect(timeline().textContent).toBe(text)

      // A durable row below the cursor must stay dropped instead of rebuilding
      // the conversation around a stale projection.
      client.emit({
        type: 'event',
        name: 'step.started',
        sequence: 9_001,
        payload: {
          sessionId: LONG_SESSION_ID,
          turn: 5,
          step: 1,
          time: 1_786_500_040_001,
          sequence: 172,
        },
      })
      await settle(120)

      expect(store.timeline.lastSequence).toBe(203)
      expect(store.timeline.nodes.map((node) => node.id)).toEqual(ids)
      expect(timeline().textContent).toBe(text)
      expect(store.timeline.nodes.some((node) => node.kind === 'event')).toBe(false)
    } finally {
      unsubscribe()
      store.dispose()
    }
  })
})
