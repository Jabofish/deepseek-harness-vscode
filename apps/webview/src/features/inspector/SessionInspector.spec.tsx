// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { FeatureRequest, TranscriptEventFact } from '@dsh-vscode/webview-protocol'
import { SessionInspector } from './SessionInspector.js'
import { inspectChatNode } from './inspector-model.js'
import { InspectorDevtoolsActions } from './InspectorDevtoolsActions.js'
import { Timeline } from '../chat/Timeline.js'
afterEach(cleanup)
const unavailable = <T,>(): Promise<T> =>
  Promise.resolve({ kind: 'inspector.devtools', available: false, outcome: 'unavailable' } as T)
const node: TimelineNode = {
  kind: 'assistant-message',
  id: 'node-1',
  sequence: 4,
  markdown: 'PRIVATE_PROMPT',
  streaming: false,
  turn: 1,
  step: 2,
}

for (const count of [300, 10_000])
  it(
    `paginates ${count} facts and joins authoritative sequences without displaying bodies`,
    { tags: count > 300 ? ['stress'] : [], timeout: 15_000 },
    async () => {
      const eventFacts: TranscriptEventFact[] = Array.from({ length: count }, (_, sequence) => ({
        id: `event:${sequence}`,
        sequence,
        type: 'unknown',
        representedSequences: 1,
      }))
      const loadOlder = vi.fn(() => Promise.resolve())
      render(
        <SessionInspector
          eventFacts={eventFacts}
          nodes={[node]}
          hasMore
          loading={false}
          loadOlder={loadOlder}
          featureRequest={unavailable}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Session Inspector' }))
      const dialog = screen.getByRole('dialog', { name: 'Session Inspector' })
      const toolbar = within(dialog.querySelector<HTMLElement>('.dsh-session-inspector__toolbar')!)
      const filters = within(dialog.querySelector<HTMLElement>('.dsh-session-inspector__filters')!)
      const rows = within(dialog.querySelector<HTMLElement>('.dsh-session-inspector__rows')!)
      expect(rows.getAllByRole('listitem')).toHaveLength(100)
      fireEvent.click(toolbar.getByRole('button', { name: 'Earlier rows' }))
      expect(screen.getByText(`${count} rows; showing ${count - 199}–${count - 100}`)).toBeDefined()
      fireEvent.click(filters.getByRole('button', { name: 'Source: Session events' }))
      fireEvent.click(screen.getByRole('option', { name: 'Chat nodes' }))
      fireEvent.click(rows.getByRole('button', { name: '#4 assistant-message' }))
      expect(screen.getByText('textCharacters')).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Inspect matching unknown' }))
      expect(filters.getByRole('button', { name: 'Source: Session events' })).toBeDefined()
      expect(screen.getByText(`${count} rows; showing 1–100`)).toBeDefined()
      const selectedRow = rows.getByRole('button', { name: '#4 unknown' })
      expect(selectedRow.getAttribute('aria-pressed')).toBe('true')
      expect(selectedRow.closest('li')?.querySelector('.dsh-session-inspector__detail')).not.toBeNull()
      expect(document.body.textContent).not.toMatch(/PRIVATE_/)
      const loadOlderButton = toolbar.getByRole('button', { name: 'Load older history' })
      fireEvent.click(loadOlderButton)
      fireEvent.click(loadOlderButton)
      await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1))
      expect(JSON.stringify(inspectChatNode(node, 0))).not.toContain('PRIVATE_PROMPT')
    },
  )

it('keeps focus on inspected rows and lets Escape dismiss a filter before the drawer', () => {
  render(
    <SessionInspector
      eventFacts={[]}
      nodes={[node]}
      hasMore={false}
      loading={false}
      loadOlder={() => {}}
      featureRequest={unavailable}
    />,
  )
  const trigger = screen.getByRole('button', { name: 'Session Inspector' })
  trigger.focus()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: 'Source: Session events' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('listbox', { name: 'Source' })).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Session Inspector' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Source: Session events' }))
  fireEvent.click(screen.getByRole('option', { name: 'Chat nodes' }))
  const row = screen.getByRole('button', { name: '#4 assistant-message' })
  row.focus()
  fireEvent.click(row)
  expect(document.activeElement).toBe(row)
  expect(screen.getByRole('region', { name: 'Structured details' }).closest('li')).toBe(row.closest('li'))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Session Inspector' })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('picks an existing visible chat row without activating its content action', async () => {
  const action = vi.fn()
  render(
    <>
      <SessionInspector
        nodes={[node]}
        hasMore={false}
        loading={false}
        loadOlder={() => {}}
        featureRequest={unavailable}
      />
      <div className="dsh-timeline__row" data-node-id="node-1">
        <button type="button" onClick={action}>
          Chat action
        </button>
      </div>
    </>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Session Inspector' }))
  fireEvent.click(screen.getByRole('button', { name: 'Pick a chat row' }))
  fireEvent.click(screen.getByRole('button', { name: 'Chat action' }))
  expect(action).not.toHaveBeenCalled()
  expect(await screen.findByText('textCharacters')).toBeDefined()
  expect(screen.queryByText('PRIVATE_PROMPT')).toBeNull()
})

it('picks the actual projected conversation row and reveals its source identity', async () => {
  const reveal = vi.fn()
  const nodes: readonly TimelineNode[] = [{ ...node, markdown: 'Visible answer' }]
  const view = render(
    <>
      <SessionInspector
        nodes={nodes}
        hasMore={false}
        loading={false}
        loadOlder={() => {}}
        featureRequest={unavailable}
        onRevealNode={reveal}
      />
      <Timeline sessionId="inspector-pick" nodes={nodes} streaming={false} />
    </>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Session Inspector' }))
  fireEvent.click(screen.getByRole('button', { name: 'Pick a chat row' }))
  const row = view.container.querySelector('.dsh-timeline__row')
  if (row === null) throw new Error('No projected row was mounted')
  fireEvent.click(row)
  expect(await screen.findByText('textCharacters')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Reveal in conversation' }))
  expect(reveal).toHaveBeenCalledWith('node-1')
})

it('routes DevTools actions to Host, prevents duplicate clicks and offers copy after open failure', async () => {
  const calls: FeatureRequest[] = []
  let reject!: (reason: unknown) => void
  const request = <T,>(message: FeatureRequest): Promise<T> => {
    calls.push(message)
    if (message.type === 'inspector.devtools.open')
      return new Promise((_resolve, fail) => {
        reject = fail
      })
    return Promise.resolve({
      kind: 'inspector.devtools',
      available: true,
      outcome: message.type === 'inspector.devtools.copy' ? 'copied' : 'status',
    } as T)
  }
  render(<InspectorDevtoolsActions featureRequest={request} />)
  fireEvent.click(screen.getByText('Chrome DevTools'))
  const open = screen.getByRole('button', { name: 'Open DevTools' })
  await waitFor(() => expect(open.hasAttribute('disabled')).toBe(false))
  fireEvent.click(open)
  fireEvent.click(open)
  expect(calls.filter((call) => call.type === 'inspector.devtools.open')).toHaveLength(1)
  await act(async () => {
    reject(new Error('PRIVATE_EXCEPTION'))
    await Promise.resolve()
  })
  fireEvent.click(screen.getByRole('button', { name: 'Copy DevTools link' }))
  expect(await screen.findByText('Inspector link copied. Paste it into Chrome.')).toBeDefined()
  expect(document.body.textContent).not.toContain('PRIVATE_EXCEPTION')
  expect(calls.filter((call) => call.type === 'inspector.devtools.copy')).toHaveLength(1)
})

it('handles menu open requests while preserving picking and discarding stale requests on session remount', async () => {
  const reveal = vi.fn()
  const renderSession = (sessionKey: string, openRequestId: string): ReactElement => (
    <>
      <SessionInspector
        key={sessionKey}
        nodes={[node]}
        hasMore={false}
        loading={false}
        loadOlder={() => {}}
        featureRequest={unavailable}
        onRevealNode={reveal}
        openRequestId={openRequestId}
        showTrigger={false}
      />
      <Timeline sessionId={sessionKey} nodes={[node]} streaming={false} />
    </>
  )
  const view = render(renderSession('first-session', 'old-request'))
  expect(screen.queryByRole('button', { name: 'Session Inspector' })).toBeNull()
  expect(screen.queryByRole('dialog', { name: 'Session Inspector' })).toBeNull()

  view.rerender(renderSession('first-session', 'open-request'))
  fireEvent.click(screen.getByRole('button', { name: 'Pick a chat row' }))
  const row = view.container.querySelector('.dsh-timeline__row')
  if (!(row instanceof HTMLElement)) throw new Error('No projected row was mounted')
  fireEvent.pointerDown(row)
  fireEvent.click(row)
  expect(await screen.findByText('textCharacters')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Reveal in conversation' }))
  expect(reveal).toHaveBeenCalledWith('node-1')

  view.rerender(renderSession('first-session', 'pick-request'))
  fireEvent.click(screen.getByRole('button', { name: 'Pick a chat row' }))
  expect(screen.getByRole('button', { name: 'Cancel picking' })).toBeDefined()
  view.rerender(renderSession('second-session', 'pick-request'))
  expect(screen.queryByRole('button', { name: 'Cancel picking' })).toBeNull()
  expect(screen.queryByRole('dialog', { name: 'Session Inspector' })).toBeNull()
  const nextRow = view.container.querySelector('.dsh-timeline__row')
  if (!(nextRow instanceof HTMLElement)) throw new Error('No next-session row was mounted')
  fireEvent.click(nextRow)
  expect(screen.queryByRole('dialog', { name: 'Session Inspector' })).toBeNull()

  view.rerender(renderSession('second-session', 'fresh-request'))
  expect(screen.getByRole('dialog', { name: 'Session Inspector' })).toBeDefined()
  expect(screen.queryByText('textCharacters')).toBeNull()
})
