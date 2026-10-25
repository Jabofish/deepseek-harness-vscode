import { useLayoutEffect, type RefObject } from 'react'
import { getAccessibilitySignals, subscribeAccessibilitySignals } from '../../app/accessibility-signals.js'

const POPUP =
  '.dsh-select-menu--open, .dsh-model-picker__menu, .dsh-composer__extras-panel, .dsh-composer__context-preview-dialog'

/** Animate intrinsic height changes; loading indicators never own layout space. */
export function useComposerHeightMotion(ref: RefObject<HTMLFormElement | null>): void {
  useLayoutEffect(() => {
    const form = ref.current
    if (form === null || typeof form.animate !== 'function' || typeof ResizeObserver === 'undefined') return
    const originalHeight = form.style.height
    let animation: Animation | undefined
    let previousHeight: number | undefined
    let previousWidth: number | undefined
    const observed = new Set<Element>()
    const cancel = (): void => {
      const pending = animation
      animation = undefined
      pending?.cancel()
      form.classList.remove('dsh-composer--resizing')
    }
    const reconcile = (): void => {
      const style = getComputedStyle(form)
      const px = (value: string): number => Number.parseFloat(value) || 0
      const insets =
        px(style.paddingTop) +
        px(style.paddingBottom) +
        px(style.borderTopWidth) +
        px(style.borderBottomWidth)
      let count = 0
      let naturalHeight = insets
      for (const child of form.children) {
        const childStyle = getComputedStyle(child)
        if (
          childStyle.display === 'none' ||
          childStyle.position === 'absolute' ||
          childStyle.position === 'fixed'
        )
          continue
        naturalHeight +=
          child.getBoundingClientRect().height + px(childStyle.marginTop) + px(childStyle.marginBottom)
        count++
      }
      naturalHeight += Math.max(0, count - 1) * px(style.rowGap)
      const width = form.getBoundingClientRect().width
      const from = animation === undefined ? previousHeight : form.getBoundingClientRect().height
      const widthChanged = previousWidth !== undefined && Math.abs(width - previousWidth) > 0.5
      previousWidth = width
      const changed = previousHeight === undefined || Math.abs(naturalHeight - previousHeight) > 0.5
      previousHeight = naturalHeight
      const insetAdjustment = style.boxSizing === 'border-box' ? 0 : insets
      const targetHeight = `${Math.max(0, naturalHeight - insetAdjustment)}px`
      if (
        from === undefined ||
        widthChanged ||
        getAccessibilitySignals().reducedMotion ||
        form.querySelector(POPUP) !== null
      ) {
        cancel()
        form.style.height = targetHeight
        return
      }
      if (!changed) return
      if (Math.abs(from - naturalHeight) <= 0.5) {
        cancel()
        form.style.height = targetHeight
        return
      }
      const durationToken = style.getPropertyValue('--dsh-motion-duration-standard').trim()
      const duration = px(durationToken) * (durationToken.endsWith('ms') ? 1 : 1000)
      const easing = style.getPropertyValue('--dsh-motion-ease-standard').trim() || 'ease-out'
      if (duration <= 0) {
        cancel()
        form.style.height = targetHeight
        return
      }
      cancel()
      form.classList.add('dsh-composer--resizing')
      const next = form.animate(
        [{ height: `${Math.max(0, from - insetAdjustment)}px` }, { height: targetHeight }],
        {
          duration,
          easing,
        },
      )
      animation = next
      form.style.height = targetHeight
      void next.finished.then(
        () => {
          if (animation !== next) return
          animation = undefined
          form.classList.remove('dsh-composer--resizing')
        },
        () => undefined,
      )
    }
    const resize = new ResizeObserver(reconcile)
    const observeChildren = (): void => {
      for (const child of observed)
        if (child !== form && child.parentElement !== form) {
          resize.unobserve(child)
          observed.delete(child)
        }
      for (const child of [form, ...form.children])
        if (!observed.has(child)) {
          observed.add(child)
          resize.observe(child)
        }
    }
    const mutations = new MutationObserver(() => {
      observeChildren()
      reconcile()
    })
    observeChildren()
    mutations.observe(form, { childList: true })
    // Explicit actions settle geometry before opening an overlay. Streaming
    // text inside controls is not observed and cannot add layout work per token.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLButtonElement) cancel()
    }
    form.addEventListener('pointerdown', cancel, true)
    form.addEventListener('keydown', onKeyDown, true)
    const unsubscribe = subscribeAccessibilitySignals(() => {
      if (getAccessibilitySignals().reducedMotion) reconcile()
    })
    return () => {
      resize.disconnect()
      mutations.disconnect()
      form.removeEventListener('pointerdown', cancel, true)
      form.removeEventListener('keydown', onKeyDown, true)
      unsubscribe()
      cancel()
      form.style.height = originalHeight
    }
  }, [ref])
}
