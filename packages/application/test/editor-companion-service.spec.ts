import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  type EditorCompanionPoll,
  type EditorCompanionRepository,
  type EditorCompanionRequest,
  type EditorCompanionValue,
} from '@dsh-vscode/domain'
import { EditorCompanionService } from '../src/services/editor-companion-service.js'

function fixture(): {
  repository: EditorCompanionRepository
  respond: Mock<EditorCompanionRepository['respond']>
  detach: Mock<EditorCompanionRepository['detach']>
  push: (event: EditorCompanionPoll) => void
} {
  const events: EditorCompanionPoll[] = []
  let deliver: ((event: EditorCompanionPoll) => void) | undefined
  const respond = vi.fn<EditorCompanionRepository['respond']>().mockResolvedValue(undefined)
  const detach = vi.fn<EditorCompanionRepository['detach']>().mockResolvedValue(undefined)
  const repository: EditorCompanionRepository = {
    describe: () =>
      Promise.resolve({
        protocolVersion: 2,
        packageVersion: '0.2.0',
        capabilities: ['navigation'],
        maxGrants: 16,
      }),
    verifyHost: () => Promise.resolve({ proof: 'a'.repeat(64) }),
    attach: vi.fn().mockResolvedValue({ bindingId: 'fixture_binding_1234', protocolVersion: 2 }),
    respond,
    detach,
    poll: (_binding, signal) => {
      const event = events.shift()
      if (event !== undefined) return Promise.resolve(event)
      return new Promise((resolve, reject) => {
        const abort = (): void => {
          deliver = undefined
          reject(new Error('cancelled'))
        }
        if (signal?.aborted) {
          abort()
          return
        }
        signal?.addEventListener('abort', abort, { once: true })
        deliver = (event) => {
          signal?.removeEventListener('abort', abort)
          deliver = undefined
          resolve(event)
        }
      })
    },
  }
  const push = (event: EditorCompanionPoll): void => {
    if (deliver !== undefined) deliver(event)
    else events.push(event)
  }
  return { repository, respond, detach, push }
}
const services: EditorCompanionService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  vi.useRealTimers()
})
describe('editor companion request lifetimes', () => {
  it('continues polling while a read is pending, cancels only that read and answers the next request', async () => {
    const { repository, respond, detach, push } = fixture()
    const service = new EditorCompanionService()
    services.push(service)
    let firstSignal: AbortSignal | undefined
    let resolve!: (value: EditorCompanionValue) => void
    const read = vi.fn(
      (_request: EditorCompanionRequest, signal: AbortSignal): Promise<EditorCompanionValue> => {
        if (firstSignal !== undefined) return Promise.resolve({ kind: 'opened', relativePath: 'next.ts' })
        firstSignal = signal
        return new Promise((settle) => {
          resolve = settle
        })
      },
    )
    await service.start(repository, 'session-a', 'fixture_owner_1234', ['navigation'], { execute: read })
    push({ kind: 'request', requestId: 'fixture_request_1234', request: { kind: 'open', path: 'first.ts' } })
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    push({ kind: 'cancel', requestId: 'fixture_request_1234' })
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true))
    push({ kind: 'request', requestId: 'fixture_request_5678', request: { kind: 'open', path: 'next.ts' } })
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    expect(respond.mock.calls[0]?.[1]).toBe('fixture_request_5678')
    resolve({ kind: 'opened', relativePath: 'late.ts' })
    await Promise.resolve()
    expect(respond).toHaveBeenCalledTimes(1)
    expect(service.active).toBe(true)
    expect(detach).not.toHaveBeenCalled()
  })

  it('ends with an explicit reason when polling keeps failing', async () => {
    vi.useFakeTimers()
    try {
      const { repository } = fixture()
      repository.poll = () => Promise.reject(new Error('connection down'))
      const ended = vi.fn()
      const service = new EditorCompanionService(ended)
      services.push(service)
      await service.start(repository, 'session-a', 'fixture_owner_1234', [], { execute: vi.fn() })
      await vi.advanceTimersByTimeAsync(8_000)
      expect(ended).toHaveBeenCalledWith('ended')
      expect(service.active).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
