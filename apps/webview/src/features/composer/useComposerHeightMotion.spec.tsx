// @vitest-environment jsdom
import { useRef, type CSSProperties, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, type RenderResult } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useComposerHeightMotion } from './useComposerHeightMotion.js'

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
afterEach(() => {
  cleanup()
  document.body.className = ''
  vi.unstubAllGlobals()
  if (originalAnimate === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  else Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
})

type FakeAnimation = { readonly cancel: Mock<() => void>; readonly finished: Promise<void> }
type MotionHarness = RenderResult & {
  readonly form: HTMLFormElement
  readonly animate: Mock<(keyframes: Keyframe[], options: KeyframeAnimationOptions) => FakeAnimation>
  readonly pending: Array<{ readonly cancel: Mock<() => void>; readonly finish: () => void }>
  readonly disconnect: Mock<() => void>
  readonly resize: () => void
  readonly height: (value: number) => void
  readonly width: (value: number) => void
  readonly visual: (value: number) => void
}

function harness(reduced = false): MotionHarness {
  let notify: ResizeObserverCallback = () => undefined
  const disconnect = vi.fn<() => void>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = callback
      }
      observe(): void {}
      unobserve(): void {}
      disconnect = disconnect
    },
  )
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }))
  const pending: MotionHarness['pending'] = []
  const animate = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => {
    let finish: () => void = () => undefined
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const animation = { cancel: vi.fn<() => void>(), finish }
    pending.push(animation)
    return { cancel: animation.cancel, finished }
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  function Form(): ReactElement {
    const ref = useRef<HTMLFormElement>(null)
    useComposerHeightMotion(ref)
    return (
      <form
        ref={ref}
        style={
          {
            padding: '8px',
            border: '1px solid',
            rowGap: '4px',
            boxSizing: 'border-box',
            '--dsh-motion-duration-standard': '180ms',
            '--dsh-motion-ease-standard': 'ease-out',
          } as CSSProperties
        }
      >
        <div />
        <button type="button">Action</button>
      </form>
    )
  }
  const view = render(<Form />)
  const form = view.container.querySelector('form')!
  let childHeight = 42
  let width = 400
  let visualHeight: number | undefined
  form.getBoundingClientRect = () =>
    new DOMRect(0, 0, width, visualHeight ?? (Number.parseFloat(form.style.height) || 92))
  form.children[0]!.getBoundingClientRect = () => new DOMRect(0, 0, width, childHeight)
  form.children[1]!.getBoundingClientRect = () => new DOMRect(0, 0, 28, 28)
  const resize = (): void => {
    act(() => notify([], {} as ResizeObserver))
  }
  resize()
  return {
    ...view,
    form,
    animate,
    pending,
    disconnect,
    resize,
    height(value: number) {
      childHeight = value
    },
    width(value: number) {
      width = value
    },
    visual(value: number) {
      visualHeight = value
    },
  }
}

describe('composer height motion', () => {
  it('honors the initial VS Code class and settles an active animation when it changes', async () => {
    document.body.classList.add('vscode-reduce-motion')
    const h = harness()
    h.height(72)
    h.resize()
    expect(h.animate).not.toHaveBeenCalled()
    await act(async () => {
      await Promise.resolve()
      document.body.classList.remove('vscode-reduce-motion')
    })
    h.height(90)
    h.resize()
    expect(h.animate).toHaveBeenCalledOnce()
    await act(async () => {
      await Promise.resolve()
      document.body.classList.add('vscode-reduce-motion')
    })
    expect(h.pending[0]!.cancel).toHaveBeenCalledOnce()
    expect(h.form.classList.contains('dsh-composer--resizing')).toBe(false)
    expect(h.form.style.height).toBe('140px')
    h.height(100)
    h.resize()
    expect(h.animate).toHaveBeenCalledOnce()
    expect(h.form.style.height).toBe('150px')
  })

  it('holds the prior height through content changes and keeps the final height after motion', async () => {
    const h = harness()
    expect(h.form.style.height).toBe('92px')
    h.height(72)
    expect(h.form.style.height).toBe('92px')
    h.resize()
    expect(h.animate).toHaveBeenCalledWith([{ height: '92px' }, { height: '122px' }], {
      duration: 180,
      easing: 'ease-out',
    })
    expect(h.form.style.height).toBe('122px')
    await act(async () => {
      h.pending[0]!.finish()
      await Promise.resolve()
    })
    expect(h.form.classList.contains('dsh-composer--resizing')).toBe(false)
    h.resize()
    expect(h.animate).toHaveBeenCalledOnce()
  })

  it('supersedes from the current visual height and releases observers and motion on unmount', async () => {
    const h = harness()
    h.height(72)
    h.resize()
    h.visual(105)
    h.height(90)
    h.resize()
    expect(h.pending[0]!.cancel).toHaveBeenCalledOnce()
    expect(h.animate.mock.calls[1]?.[0]).toEqual([{ height: '105px' }, { height: '140px' }])
    await act(async () => {
      h.pending[0]!.finish()
      await Promise.resolve()
    })
    expect(h.form.classList.contains('dsh-composer--resizing')).toBe(true)
    h.unmount()
    expect(h.disconnect).toHaveBeenCalledOnce()
    expect(h.pending[1]!.cancel).toHaveBeenCalledOnce()
    expect(h.form.style.height).toBe('')
  })

  it('settles for an explicit control action, viewport reflow, and reduced motion', () => {
    const h = harness()
    h.height(72)
    h.resize()
    fireEvent.pointerDown(h.form.querySelector('button')!)
    expect(h.pending[0]!.cancel).toHaveBeenCalledOnce()
    h.width(200)
    h.height(90)
    h.resize()
    expect(h.form.style.height).toBe('140px')
    expect(h.animate).toHaveBeenCalledOnce()
    h.unmount()
    const reduced = harness(true)
    reduced.height(72)
    reduced.resize()
    expect(reduced.form.style.height).toBe('122px')
    expect(reduced.animate).not.toHaveBeenCalled()
  })
})
