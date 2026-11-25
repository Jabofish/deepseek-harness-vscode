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

it('keeps the band disabled after its update poll fails until Retry restarts the poll', async () => {
  const calls: FeatureRequest[] = []
  let failNextPoll = true
  const request: AppStore['featureRequest'] = <T,>(message: FeatureRequest) => {
    calls.push(message)
    if (message.type === 'mods.band.read') {
      if (message.payload.afterGeneration === undefined) return Promise.resolve(drawing(1) as T)
      if (failNextPoll) {
        failNextPoll = false
        return Promise.reject(new Error('poll lost'))
      }
      return new Promise<T>(() => undefined)
    }
    return Promise.resolve(drawing(2) as T)
  }
  render(<ModsBand sessionId="s1" featureRequest={request} />)
  const retry = await screen.findByRole('button', { name: 'Retry' })
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Generation 1' })
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(calls.filter((call) => call.type === 'mods.band.press')).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Retry' })).toBe(retry)
  const reads = calls.filter((call) => call.type === 'mods.band.read').length
  fireEvent.click(retry)
  await waitFor(() =>
    expect(calls.filter((call) => call.type === 'mods.band.read').length).toBeGreaterThan(reads),
  )
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull())
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Generation 1' }).disabled).toBe(false)
})

it('reports a failed press and lets the user press again', async () => {
  const calls: FeatureRequest[] = []
  let rejectPress = true
  const request: AppStore['featureRequest'] = <T,>(message: FeatureRequest) => {
    calls.push(message)
    if (message.type === 'mods.band.read') {
      if (message.payload.afterGeneration === undefined) return Promise.resolve(drawing(1) as T)
      return new Promise<T>(() => undefined)
    }
    if (message.type === 'mods.band.press') {
      if (rejectPress) {
        rejectPress = false
        return Promise.reject(new Error('press failed'))
      }
      return Promise.resolve(drawing(2) as T)
    }
    return Promise.resolve({ kind: 'empty' } as T)
  }
  render(<ModsBand sessionId="s1" featureRequest={request} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Generation 1' }))
  await screen.findByRole('button', { name: 'Retry' })
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Generation 1' })
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await screen.findByRole('button', { name: 'Generation 2' })
  expect(calls.filter((call) => call.type === 'mods.band.press')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('fires a hotkey only while no field, list, menu or dialog owns the key', async () => {
  const presses: string[] = []
  const request: AppStore['featureRequest'] = <T,>(message: FeatureRequest) => {
    if (message.type === 'mods.band.press') {
      presses.push(message.payload.actionId)
      return Promise.resolve({
        kind: 'mods.band',
        available: true,
        snapshot: {
          generation: 1 + presses.length,
          tree: [{ kind: 'button', label: 'Kick', disabled: false, actionId: 'kick', hotkey: 'k' }],
        },
      } as T)
    }
    if (message.type === 'mods.band.read' && message.payload.afterGeneration === undefined)
      return Promise.resolve({
        kind: 'mods.band',
        available: true,
        snapshot: {
          generation: 1,
          tree: [{ kind: 'button', label: 'Kick', disabled: false, actionId: 'kick', hotkey: 'k' }],
        },
      } as T)
    return new Promise<T>(() => undefined)
  }
  render(
    <div>
      <ModsBand sessionId="s1" featureRequest={request} />
      <ul role="listbox" tabIndex={0} aria-label="Choices">
        <li role="option" aria-selected="false">
          Kiwi
        </li>
      </ul>
    </div>,
  )
  await screen.findByRole('button', { name: /Kick/u })
  fireEvent.keyDown(screen.getByRole('listbox', { name: 'Choices' }), { key: 'k' })
  fireEvent.keyDown(document.body, { key: 'K', shiftKey: true })
  expect(presses).toEqual([])

  const modal = document.createElement('div')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
  fireEvent.keyDown(document.body, { key: 'k' })
  expect(presses).toEqual([])
  modal.remove()

  fireEvent.keyDown(document.body, { key: 'k' })
  await waitFor(() => expect(presses).toEqual(['kick']))
})
