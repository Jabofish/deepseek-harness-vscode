// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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

it('joins selected chat records to authoritative event facts without exposing bodies', async () => {
  const count = 12
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
  const toolbar = within(dialog)
  const filters = within(dialog)
  const rows = within(dialog)
  fireEvent.click(filters.getByRole('button', { name: 'Source: Session events' }))
  fireEvent.click(screen.getByRole('option', { name: 'Chat nodes' }))
  fireEvent.click(rows.getByRole('button', { name: '#4 assistant-message' }))
  expect(screen.getByText('textCharacters')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect matching unknown' }))
  expect(filters.getByRole('button', { name: 'Source: Session events' })).toBeDefined()
  const selectedRow = rows.getByRole('button', { name: '#4 unknown' })
  expect(selectedRow.getAttribute('aria-pressed')).toBe('true')
  expect(document.body.textContent).not.toMatch(/PRIVATE_/)
  const loadOlderButton = toolbar.getByRole('button', { name: 'Load older history' })
  fireEvent.click(loadOlderButton)
  fireEvent.click(loadOlderButton)
  await waitFor(() => expect(loadOlder).toHaveBeenCalled())
  expect(JSON.stringify(inspectChatNode(node, 0))).not.toContain('PRIVATE_PROMPT')
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
