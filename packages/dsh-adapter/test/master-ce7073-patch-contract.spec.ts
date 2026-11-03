import { describe, expect, it } from 'vitest'
import type { ToolCallView } from '@dsh-vscode/domain'
import { normalizeEnvelope } from '../src/stream-envelopes.js'
import { expandHistoryRecords } from '../src/versions/alpha/session-wire.js'
import { alpha222SessionProfile } from '../src/versions/alpha222/session-wire.js'
import { masterPatchResult } from './fixtures/master-ce7073-patch.js'

function map(event: unknown): ToolCallView {
  // Exercise the consumed V4 codec before event mapping, as on history replay.
  const [expanded] = expandHistoryRecords(
    [{ type: 'event', event }],
    's',
    'v4',
    false,
    alpha222SessionProfile,
  )
  const result = normalizeEnvelope({ type: 'session/event', sessionId: 's', event: expanded })
  if (result?.type !== 'tool.updated') throw new Error(`Unexpected ${result?.type}`)
  return result.tool
}

describe('master apply_patch consumed result contract', () => {
  it('keeps a stopped result and only the known effects including a partial move destination', () => {
    const tool = map(masterPatchResult)
    expect(tool.outputSummary).toContain('Patch stopped after 1 of 3 operations.')
    expect(tool.presentation).toMatchObject({
      phase: 'result',
      card: 'diff',
      diffs: masterPatchResult.data.meta.diffs,
    })
    expect(tool.locations).toEqual([{ path: 'src/first.ts' }, { path: 'src/moved.ts' }])
    expect(tool.locations).not.toContainEqual({ path: 'src/skipped.ts' })
  })

  it('does not turn preflight refusal metadata into applied changes', () => {
    const tool = map({
      ...masterPatchResult,
      data: {
        ...masterPatchResult.data,
        message: {
          ...masterPatchResult.data.message,
          isError: true,
          content: [{ type: 'text', text: 'Patch rejected before any change: PATCH_SYMLINK_SOURCE' }],
        },
      },
    })
    expect(tool.status).toBe('failed')
    expect(tool.presentation).toBeUndefined()
    expect(tool.locations).toBeUndefined()
    expect(tool.error).toContain('PATCH_SYMLINK_SOURCE')
  })

  it('retains the tool body without inventing diffs when creation has no baseline', () => {
    const tool = map({
      ...masterPatchResult,
      data: {
        ...masterPatchResult.data,
        meta: { stopped: false, diffs: [] },
        message: {
          ...masterPatchResult.data.message,
          content: [{ type: 'text', text: 'Success. Updated the following files:\nA src/new.ts' }],
        },
      },
    })
    expect(tool.outputSummary).toContain('A src/new.ts')
    expect(tool.presentation).toBeUndefined()
  })
})
