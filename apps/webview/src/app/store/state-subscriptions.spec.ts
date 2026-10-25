import { expect, it, vi } from 'vitest'
import { StateSubscriptions } from './state-subscriptions.js'

it('indexes field subscribers, preserves synchronous delivery and releases subscriptions', () => {
  let state = { text: '', models: [] as string[], error: undefined as string | undefined }
  const subscriptions = new StateSubscriptions<typeof state>()
  const models = Array.from({ length: 100 }, () => vi.fn())
  for (const listener of models) subscriptions.subscribe(listener, state, ['models'])
  const text = vi.fn(),
    all = vi.fn(),
    shell = vi.fn()
  const remove = subscriptions.subscribe(text, state, ['text', 'error'])
  subscriptions.subscribe(all, state)
  subscriptions.subscribe(shell, state, { exclude: ['models'] })
  for (let index = 0; index < 1000; index++) {
    const previous = state
    state = { ...state, text: `${index}` }
    subscriptions.publish(previous, state)
    expect(text).toHaveBeenCalledTimes(index + 1)
  }
  expect(models.every((listener) => listener.mock.calls.length === 0)).toBe(true)
  const previous = state
  state = { ...state, models: ['available'] }
  subscriptions.publish(previous, state)
  expect(models.every((listener) => listener.mock.calls.length === 1)).toBe(true)
  expect(shell).toHaveBeenCalledTimes(1000)
  expect(all).toHaveBeenCalledTimes(1001)
  remove()
  subscriptions.publish(state, { ...state, text: 'next', error: 'failed' })
  expect(text).toHaveBeenCalledTimes(1000)
  subscriptions.clear()
  subscriptions.publish(state, { ...state, models: [] })
  expect(models.every((listener) => listener.mock.calls.length === 1)).toBe(true)
})
