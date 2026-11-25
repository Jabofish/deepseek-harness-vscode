import { describe, expect, it, vi } from 'vitest'
import type { ChangeDetail, SessionDetail } from '@dsh-vscode/domain'
import type { ChangeUseCases } from '@dsh-vscode/application'
import { handleChangeFeatureRequest } from './change-feature-handler.js'
import type { ChangeSetTracker } from './change-set-tracker.js'

const detail = {
  changeId: 'change-1',
  sessionId: 'session-1',
  workspaceFolderId: 'folder-1',
  relativePath: 'src/a.ts',
  status: 'modified',
  diffs: [{ oldText: 'a', newText: 'b' }],
  diffAvailable: true,
  locations: [],
  sourceIds: [],
} as unknown as ChangeDetail

function dependencies(overrides: { readonly owned?: boolean; readonly diffs?: ChangeDetail['diffs'] } = {}): {
  readonly openChangeDiff: ReturnType<typeof vi.fn>
  readonly deps: Parameters<typeof handleChangeFeatureRequest>[2]
} {
  const openChangeDiff = vi.fn(() => Promise.resolve())
  return {
    openChangeDiff,
    deps: {
      changeUseCases: {
        get: vi.fn(() =>
          Promise.resolve({
            ...detail,
            ...(overrides.diffs === undefined ? {} : { diffs: overrides.diffs }),
          }),
        ),
      } as unknown as ChangeUseCases,
      changeTracker: {} as ChangeSetTracker,
      requireBackend: vi.fn(),
      requireCurrentWorkspaceSession: vi.fn(() => Promise.resolve({ id: 'session-1' } as SessionDetail)),
      featureWorkspaceFolderId: vi.fn(() => 'folder-1'),
      isOpenWorkspaceFolderId: () => overrides.owned !== false,
      openChangeDiff,
    },
  }
}

const request = {
  type: 'changes.openDiff' as const,
  requestId: 'r1',
  payload: { changeId: 'change-1' },
}

describe('changes.openDiff', () => {
  it('opens the recorded change after checking ownership', async () => {
    const { deps, openChangeDiff } = dependencies()
    await expect(handleChangeFeatureRequest(request, new AbortController().signal, deps)).resolves.toEqual({
      kind: 'operation',
      operationId: 'r1',
      state: 'completed',
    })
    expect(openChangeDiff).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'src/a.ts' }),
      expect.any(AbortSignal),
    )
  })

  it('refuses a change from another workspace or without a recorded diff', async () => {
    const foreign = dependencies({ owned: false })
    await expect(
      handleChangeFeatureRequest(request, new AbortController().signal, foreign.deps),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_OWNED' })
    const empty = dependencies({ diffs: [] })
    await expect(
      handleChangeFeatureRequest(request, new AbortController().signal, empty.deps),
    ).rejects.toMatchObject({ code: 'CHANGE_INCOMPLETE' })
    expect(foreign.openChangeDiff).not.toHaveBeenCalled()
    expect(empty.openChangeDiff).not.toHaveBeenCalled()
  })
})

it('keeps the authoritative preview and reports whether the editor can reconstruct a baseline', async () => {
  const detailRequest = { ...request, type: 'changes.detail' as const }
  const signal = new AbortController().signal
  const structured = dependencies()
  await expect(handleChangeFeatureRequest(detailRequest, signal, structured.deps)).resolves.toMatchObject({
    comparisonAvailable: true,
  })

  const authoritative = dependencies()
  const { diffs: _diffs, ...summary } = detail
  void _diffs
  vi.spyOn(authoritative.deps.changeUseCases, 'get').mockResolvedValueOnce({
    ...summary,
    redactedDiff: '@@ -1 +1 @@\n-a\n+b',
  })
  await expect(handleChangeFeatureRequest(detailRequest, signal, authoritative.deps)).resolves.toMatchObject({
    comparisonAvailable: false,
    redactedDiff: '@@ -1 +1 @@\n-a\n+b',
  })
})
