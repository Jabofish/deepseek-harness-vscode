// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { ModelDescriptor } from '@dsh-vscode/domain'
import { createInitialState } from '../../app/store/initial-state.js'
import type { AppState } from '../../app/store.js'
import { selectAppViewState } from '../../app/store/view-state.js'
import { sameShallowSelection, useAppStoreSelector } from '../../app/useAppStoreSelector.js'
import { resetDraft } from '../../app/draft-store.js'
import { Composer, type ComposerProps } from './Composer.js'
import { ConnectedComposer } from './ConnectedComposer.js'

vi.mock('./Composer.js', () => ({
  Composer: vi.fn(() => <div>Composer</div>),
}))

const globalModel: ModelDescriptor = {
  id: 'global',
  providerId: 'provider',
  label: 'Global model',
  supportsReasoning: false,
}
const sessionModel: ModelDescriptor = { ...globalModel, id: 'session', label: 'Session model' }

function source(): {
  readonly store: {
    readonly getState: () => AppState
    readonly subscribe: (listener: () => void) => () => void
    readonly refreshSessionModels: ReturnType<typeof vi.fn<() => Promise<void>>>
  }
  readonly update: (patch: Partial<AppState>) => void
  readonly subscriberCount: () => number
} {
  let state: AppState = { ...createInitialState({}), models: [globalModel] }
  const listeners = new Set<() => void>()
  return {
    store: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      refreshSessionModels: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    update: (patch) => {
      state = { ...state, ...patch }
      for (const listener of listeners) listener()
    },
    subscriberCount: () => listeners.size,
  }
}

function composerProps(): Omit<ComposerProps, 'draft' | 'onDraftChange'> {
  return {
    disabled: false,
    running: false,
    attachments: [],
    queue: [],
    openFileCandidates: [],
    openFilePickerOpen: false,
    openFilePickerLoading: false,
    attachedOpenFileIds: [],
    onPickAttachment: vi.fn(),
    onIngestFiles: vi.fn(),
    onToggleOpenFilePicker: vi.fn(),
    onSelectOpenFile: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onSteerQueue: vi.fn(),
  }
}

function renderedProps(): ComposerProps {
  const props = vi.mocked(Composer).mock.calls.at(-1)?.[0]
  if (props === undefined) throw new Error('Composer was not rendered.')
  return props
}

afterEach(() => {
  cleanup()
  resetDraft()
  vi.clearAllMocks()
})

describe('composer model directory subscriptions', () => {
  it('keeps loading, failed reads and host route facts inside the picker subscription', () => {
    const state = source()
    const shellRendered = vi.fn()
    function Shell(): ReactElement {
      const view = useAppStoreSelector(state.store, selectAppViewState, sameShallowSelection)
      shellRendered()
      return <div>{view.backend.kind}</div>
    }
    render(
      <>
        <Shell />
        <ConnectedComposer {...composerProps()} store={state.store} modelScope="session" />
      </>,
    )
    expect(renderedProps().models).toEqual([globalModel])
    act(() => state.update({ sessionModelDirectoryLoading: true }))
    expect(renderedProps().modelLoading).toBe(true)
    expect(shellRendered).toHaveBeenCalledTimes(1)

    const failures = [{ providerId: 'unavailable', providerName: 'Unavailable', message: 'Read refused' }]
    act(() =>
      state.update({
        sessionModels: [sessionModel],
        sessionModelFailures: failures,
        sessionModelCurrent: { providerId: 'provider', modelId: 'unlisted' },
        sessionModelRoutable: false,
        sessionModelDirectoryLoading: false,
        sessionModelDirectoryError: 'Temporary read failure',
      }),
    )
    expect(renderedProps()).toMatchObject({
      models: [sessionModel],
      modelFailures: failures,
      modelCurrent: { providerId: 'provider', modelId: 'unlisted' },
      modelRoutable: false,
      modelLoading: false,
      modelError: 'Temporary read failure',
      disabled: false,
    })
    expect(shellRendered).toHaveBeenCalledTimes(1)
    renderedProps().onModelRetry?.()
    expect(state.store.refreshSessionModels).toHaveBeenCalledOnce()
  })

  it('ignores timeline traffic and session-only directory changes in a new-session composer', () => {
    const state = source()
    render(<ConnectedComposer {...composerProps()} store={state.store} modelScope="global" />)
    expect(Composer).toHaveBeenCalledOnce()
    act(() =>
      state.update({
        timeline: { ...state.store.getState().timeline, lastSequence: 1 },
        sessionModels: [sessionModel],
        sessionModelDirectoryLoading: true,
      }),
    )
    expect(Composer).toHaveBeenCalledOnce()
    expect(renderedProps().models).toEqual([globalModel])
    expect(renderedProps().onModelRetry).toBeUndefined()
    act(() => state.update({ models: [sessionModel] }))
    expect(renderedProps().models).toEqual([sessionModel])
    expect(Composer).toHaveBeenCalledTimes(2)
  })

  it('reselects the directory when the composer changes from a local draft to a session', () => {
    const state = source()
    state.update({ sessionModels: [sessionModel], sessionModelDirectoryError: 'Retry this session' })
    const props = composerProps()
    const view = render(<ConnectedComposer {...props} store={state.store} modelScope="global" />)
    expect(renderedProps().models).toEqual([globalModel])
    view.rerender(<ConnectedComposer {...props} store={state.store} modelScope="session" />)
    expect(renderedProps().models).toEqual([sessionModel])
    expect(renderedProps().modelError).toBe('Retry this session')
    expect(state.subscriberCount()).toBe(1)
    view.unmount()
    expect(state.subscriberCount()).toBe(0)
  })

  it('releases the old source on replacement and ignores its later notifications', () => {
    const first = source()
    const second = source()
    second.update({ sessionModels: [sessionModel] })
    const props = composerProps()
    const view = render(<ConnectedComposer {...props} store={first.store} modelScope="session" />)
    view.rerender(<ConnectedComposer {...props} store={second.store} modelScope="session" />)
    expect(first.subscriberCount()).toBe(0)
    expect(second.subscriberCount()).toBe(1)
    const renders = vi.mocked(Composer).mock.calls.length
    act(() => first.update({ sessionModelDirectoryError: 'Old source' }))
    expect(Composer).toHaveBeenCalledTimes(renders)
    expect(renderedProps().models).toEqual([sessionModel])
  })
})
