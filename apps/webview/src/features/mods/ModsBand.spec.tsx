// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import type { AppStore } from '../../app/store.js'
import { ModsBand } from './ModsBand.js'
afterEach(cleanup)
const drawing = (generation: number): unknown => ({
  kind: 'mods.band',
  available: true,
  snapshot: {
    generation,
    tree: [{ kind: 'button', label: `Generation ${generation}`, disabled: false, actionId: 'a0' }],
  },
})

it('presses once, ignores an older reply, and cancels both outstanding requests on session exit', async () => {
  const calls: FeatureRequest[] = []
  let finishRead!: (value: unknown) => void
  let finishPress!: (value: unknown) => void
  const request: AppStore['featureRequest'] = <T,>(message: FeatureRequest) => {
    calls.push(message)
    if (message.type === 'mods.band.press')
      return new Promise<T>((resolve) => {
        finishPress = resolve as (value: unknown) => void
      })
    if (message.type === 'mods.band.read') {
      if (message.payload.afterGeneration === undefined) return Promise.resolve(drawing(1) as T)
      return new Promise<T>((resolve) => {
        finishRead = resolve as (value: unknown) => void
      })
    }
    return Promise.resolve({ kind: 'empty' } as T)
  }
  const view = render(<ModsBand sessionId="s1" featureRequest={request} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Generation 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Generation 1' }))
  expect(calls.filter((call) => call.type === 'mods.band.press')).toHaveLength(1)
  await act(async () => {
    finishRead(drawing(3))
    await Promise.resolve()
  })
  await act(async () => {
    finishPress(drawing(2))
    await Promise.resolve()
  })
  expect(screen.getByRole('button', { name: 'Generation 3' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Generation 3' }))
  view.unmount()
  const cancelled = calls.filter((call) => call.type === 'feature.request.cancel')
  expect(cancelled).toHaveLength(2)
})

it('stops on an unavailable optional service and retries a safe failure', async () => {
  const request = vi
    .fn<AppStore['featureRequest']>()
    .mockRejectedValueOnce(new Error('PRIVATE diagnostic'))
    .mockResolvedValue({ kind: 'mods.band', available: false, snapshot: null })
  render(
    <ModsBand
      sessionId="s1"
      featureRequest={async <T,>(message: FeatureRequest) => (await request(message)) as T}
    />,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('group')).toBeNull()
  expect(screen.queryByText('PRIVATE diagnostic')).toBeNull()
})
