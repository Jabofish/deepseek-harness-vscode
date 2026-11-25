import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { ModsBandNode, ModsBandReadResult, ModsBandSnapshot } from '@dsh-vscode/domain'
import type { AppStore } from '../../app/store.js'
import { useStableCallback } from '../../app/useStableCallback.js'
import { useI18n } from '../../i18n.js'
import './mods-band.css'

/** A session-scoped long poll; leaving the session cancels its Host request. */
export function ModsBand(props: {
  readonly sessionId: string
  readonly featureRequest: AppStore['featureRequest']
}): ReactElement | null {
  return <SessionModsBand key={props.sessionId} {...props} />
}
function SessionModsBand(props: {
  readonly sessionId: string
  readonly featureRequest: AppStore['featureRequest']
}): ReactElement | null {
  const { t } = useI18n()
  const request = useStableCallback(props.featureRequest)
  const [snapshot, setSnapshot] = useState<ModsBandSnapshot | null>(null)
  // A failed poll stops updates until Retry restarts it; a failed press leaves
  // the band usable so the user can press again.
  const [failure, setFailure] = useState<'poll' | 'press' | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [retry, setRetry] = useState(0)
  const active = useRef<symbol | undefined>(undefined)
  const pressLock = useRef(false)
  const inFlight = useRef<string | undefined>(undefined)
  useEffect(() => {
    const epoch = Symbol()
    active.current = epoch
    let requestId: string | undefined
    let generation: number | undefined
    pressLock.current = false
    void (async () => {
      try {
        while (active.current === epoch) {
          requestId = `mods-read-${crypto.randomUUID()}`
          const result = await request<ModsBandReadResult>({
            type: 'mods.band.read',
            requestId,
            payload: {
              sessionId: props.sessionId,
              ...(generation === undefined ? {} : { afterGeneration: generation }),
            },
          })
          requestId = undefined
          if (active.current !== epoch) break
          if (!result.available) {
            setSnapshot(null)
            break
          }
          if (result.snapshot !== null) {
            generation = Math.max(generation ?? 0, result.snapshot.generation)
            const next = result.snapshot
            setSnapshot((previous) =>
              previous !== null && previous.generation > next.generation ? previous : next,
            )
          }
        }
      } catch {
        requestId = undefined
        if (active.current === epoch) setFailure('poll')
      }
    })()
    return () => {
      active.current = undefined
      for (const targetRequestId of [requestId, inFlight.current])
        if (targetRequestId !== undefined)
          void request({
            type: 'feature.request.cancel',
            requestId: `mods-cancel-${crypto.randomUUID()}`,
            payload: { targetRequestId },
          }).catch(() => {})
      inFlight.current = undefined
    }
  }, [props.sessionId, request, retry])
  const press = (actionId: string): void => {
    if (snapshot === null || pressLock.current || active.current === undefined || failure === 'poll') return
    const epoch = active.current
    pressLock.current = true
    setPending(true)
    setFailure(undefined)
    inFlight.current = `mods-press-${crypto.randomUUID()}`
    void request<ModsBandReadResult>({
      type: 'mods.band.press',
      requestId: inFlight.current,
      payload: { sessionId: props.sessionId, generation: snapshot.generation, actionId },
    })
      .then((result) => {
        if (active.current !== epoch || result.snapshot === null) return
        const next = result.snapshot
        setSnapshot((previous) =>
          previous !== null && previous.generation > next.generation ? previous : next,
        )
      })
      .catch(() => {
        if (active.current === epoch) setFailure((current) => current ?? 'press')
      })
      .finally(() => {
        if (active.current !== epoch) return
        pressLock.current = false
        inFlight.current = undefined
        setPending(false)
      })
  }
  const pressHotkey = useStableCallback(press)
  useEffect(() => {
    const tree = snapshot?.tree
    if (tree === null || tree === undefined || pending || failure === 'poll') return
    const hotkeys = collectHotkeys(tree)
    if (hotkeys.size === 0) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey)
        return
      // Shift+K is not the K hotkey; a symbol key typed with Shift (`?`) still is.
      if (event.shiftKey && event.key.toLowerCase() !== event.key.toUpperCase()) return
      if (!hotkeyTargetIsFree(event.target)) return
      const actionId = hotkeys.get(event.key.toLowerCase())
      if (actionId === undefined) return
      event.preventDefault()
      pressHotkey(actionId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [failure, pending, pressHotkey, snapshot])
  if (failure === undefined && (snapshot === null || snapshot.tree === null)) return null
  return (
    <div className="dsh-mods-band" role="group" aria-label={t('mods.band')}>
      {snapshot?.tree?.map((node, index) => (
        <BandNode key={index} node={node} pending={pending || failure === 'poll'} press={press} />
      ))}
      {failure !== undefined ? (
        <div role="status">
          {t('mods.failed')}{' '}
          <button
            type="button"
            className="dsh-button dsh-button--secondary dsh-button--compact"
            disabled={pending}
            onClick={() => {
              setFailure(undefined)
              setPending(false)
              setRetry((value) => value + 1)
            }}
          >
            {t('plugins.bundles.retry')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function BandNode({
  node,
  pending,
  press,
}: {
  readonly node: ModsBandNode
  readonly pending: boolean
  readonly press: (actionId: string) => void
}): ReactNode {
  if (typeof node === 'string') return node
  if (node.kind === 'button')
    return (
      <button
        type="button"
        className="dsh-button dsh-button--secondary dsh-button--compact"
        disabled={pending || node.disabled || node.actionId === undefined}
        aria-busy={pending}
        onClick={() => {
          if (node.actionId !== undefined) press(node.actionId)
        }}
      >
        {node.label}
        {node.hotkey === undefined ? null : ` [${node.hotkey}]`}
      </button>
    )
  const children = node.children.map((child, index) => (
    <BandNode key={index} node={child} pending={pending} press={press} />
  ))
  if (node.kind === 'text')
    return (
      <span
        data-color={node.color}
        data-bold={node.bold}
        data-dim={node.dim}
        data-italic={node.italic}
        data-underline={node.underline}
      >
        {children}
      </span>
    )
  const style: CSSProperties = {
    flexDirection: node.direction,
    padding: `${node.paddingY * 4}px ${node.paddingX * 4}px`,
    gap: node.gap * 4,
  }
  return (
    <div className="dsh-mods-band__box" style={style} data-border={node.bordered} data-color={node.color}>
      {children}
    </div>
  )
}

/** Keys typed into a field, list, menu or dialog belong to it, not to the band. */
const KEY_OWNER_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="tree"]',
  '[role="grid"]',
  '[role="slider"]',
  '[role="spinbutton"]',
].join(',')

function hotkeyTargetIsFree(target: EventTarget | null): boolean {
  if (document.querySelector('[aria-modal="true"], dialog[open]') !== null) return false
  if (!(target instanceof Element)) return true
  if (target instanceof HTMLElement && target.isContentEditable) return false
  return target.closest(KEY_OWNER_SELECTOR) === null
}

function collectHotkeys(
  nodes: readonly ModsBandNode[],
  out = new Map<string, string>(),
): Map<string, string> {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    if (node.kind === 'button') {
      if (
        !node.disabled &&
        node.actionId !== undefined &&
        node.hotkey !== undefined &&
        node.hotkey.trim() !== ''
      ) {
        const key = node.hotkey.trim().toLowerCase()
        if (!out.has(key)) out.set(key, node.actionId)
      }
      continue
    }
    collectHotkeys(node.children, out)
  }
  return out
}
