import { describe, expect, it } from 'vitest'
import type { QueuedInput } from '@dsh-vscode/domain'
import {
  confirmPendingPrompts,
  matchesQueuedPrompt,
  withoutDirectPromptRows,
  type PendingPromptReceipt,
} from './pending-prompts.js'

function receipt(overrides: Partial<PendingPromptReceipt> = {}): PendingPromptReceipt {
  return {
    id: 'pending:one',
    sessionId: 's1',
    text: 'Hello',
    attachments: [],
    textOnly: true,
    mode: 'queue',
    createdAt: '2026-01-01T00:00:00.000Z',
    rpcId: 'request-one',
    queueIdsBefore: [],
    ...overrides,
  }
}

function row(overrides: Partial<QueuedInput> = {}): QueuedInput {
  return {
    id: 'row-one',
    sessionId: 's1',
    text: 'Hello',
    attachments: [],
    textOnly: true,
    mode: 'queue',
    createdAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  }
}

describe('pending prompt receipts', () => {
  it('keeps an idle direct-send projection out of the queue while retaining other queued input', () => {
    const other = row({ id: 'other', rpcId: 'other-request' })
    expect(withoutDirectPromptRows([other, row({ rpcId: 'request-one' })], [receipt()])).toEqual([other])
  })

  it('reserves an exact request match before matching identical id-less content', () => {
    const other = row({ id: 'other' })
    expect(withoutDirectPromptRows([other, row({ rpcId: 'request-one' })], [receipt()])).toEqual([other])
  })

  it('does not hide another session or another identified request with the same text', () => {
    const rows = [row({ sessionId: 'other', rpcId: 'request-one' }), row({ rpcId: 'other-request' })]
    expect(withoutDirectPromptRows(rows, [receipt()])).toBe(rows)
  })

  it('does not treat a row that predated the send as its projection', () => {
    const older = row({ id: 'older' })
    const current = receipt({ queueIdsBefore: ['older'] })
    expect(confirmPendingPrompts([current], [older])).toBeUndefined()
    expect(confirmPendingPrompts([current], [older, row({ id: 'new' })])).toEqual([])
  })

  it('distinguishes projected files and images from text-only rows', () => {
    const image = { name: 'shot.png', mimeType: 'image/png', uri: 'dsh-attachment:one' }
    const file = { name: 'notes.md', mimeType: 'text/markdown', uri: 'dsh-attachment:two' }
    expect(
      matchesQueuedPrompt(
        row({
          text: 'Look',
          textOnly: false,
          images: [{ attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 }],
        }),
        'Look',
        'queue',
        [image],
      ),
    ).toBe(true)
    expect(
      matchesQueuedPrompt(row({ text: 'Read', textOnly: false, files: ['notes.md'] }), 'Read', 'queue', [
        file,
      ]),
    ).toBe(true)
    expect(matchesQueuedPrompt(row({ text: 'Look' }), 'Look', 'queue', [image])).toBe(false)
    expect(
      matchesQueuedPrompt(row({ text: 'Read', textOnly: false, files: ['other.md'] }), 'Read', 'queue', [
        file,
      ]),
    ).toBe(false)
  })
})
