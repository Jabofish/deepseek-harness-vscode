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

  it('matches an id-less transient row once without hiding older or repeated queued input', () => {
    const old = row({ id: 'old' })
    const extra = row({ id: 'extra' })
    expect(withoutDirectPromptRows([old, row(), extra], [receipt({ queueIdsBefore: ['old'] })])).toEqual([
      old,
      extra,
    ])
  })

  it('reserves an exact request match before matching identical id-less content', () => {
    const other = row({ id: 'other' })
    expect(withoutDirectPromptRows([other, row({ rpcId: 'request-one' })], [receipt()])).toEqual([other])
  })

  it('reveals a genuinely parked queue row after the direct admission wait ends', () => {
    const rows = [row({ rpcId: 'request-one' })]
    expect(withoutDirectPromptRows(rows, [receipt()])).toEqual([])
    expect(withoutDirectPromptRows(rows, [])).toBe(rows)
  })

  it('does not hide another session or another identified request with the same text', () => {
    const rows = [row({ sessionId: 'other', rpcId: 'request-one' }), row({ rpcId: 'other-request' })]
    expect(withoutDirectPromptRows(rows, [receipt()])).toBe(rows)
  })

  it('confirms a receipt by content when the queue row carries no request id', () => {
    const projected = row()
    expect(confirmPendingPrompts([receipt()], [projected])).toEqual([])
    expect(confirmPendingPrompts([receipt()], [row({ text: 'Other' })])).toBeUndefined()
  })

  it('matches identical sends one row at a time in submission order', () => {
    const first = receipt()
    const second = receipt({ id: 'pending:two', rpcId: 'request-two' })
    const oneRow = row()
    const remaining = confirmPendingPrompts([first, second], [oneRow])!
    expect(remaining).toEqual([{ ...second, queueIdsBefore: [oneRow.id] }])
    expect(confirmPendingPrompts(remaining, [oneRow])).toBeUndefined()
    expect(second.queueIdsBefore).toEqual([])
    expect(confirmPendingPrompts(remaining, [oneRow, row({ id: 'row-two' })])).toEqual([])

    const twoRows = [row({ id: 'row-one' }), row({ id: 'row-two', rpcId: 'request-two' })]
    // Identity wins: the second receipt must not consume the first row.
    expect(confirmPendingPrompts([first, second], twoRows)).toEqual([])
  })

  it('never substitutes a different known request identity or another conversation', () => {
    expect(confirmPendingPrompts([receipt()], [row({ rpcId: 'other-request' })])).toBeUndefined()
    expect(
      confirmPendingPrompts([receipt()], [row({ rpcId: 'request-one', sessionId: 'other' })]),
    ).toBeUndefined()
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

  it('compares opaque attachment handles by name when the row still carries them', () => {
    const attachment = { name: 'notes.md', mimeType: 'text/markdown', uri: 'dsh-attachment:two' }
    expect(
      matchesQueuedPrompt(
        row({
          text: 'Read',
          textOnly: false,
          attachments: [{ ...attachment, uri: 'dsh-attachment:opaque' }],
        }),
        'Read',
        'queue',
        [attachment],
      ),
    ).toBe(true)
  })
})
