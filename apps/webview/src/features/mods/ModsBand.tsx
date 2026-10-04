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
  const [failed, setFailed] = useState(false)
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
        if (active.current === epoch) setFailed(true)
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
    if (snapshot === null || pressLock.current || active.current === undefined) return
    const epoch = active.current
    pressLock.current = true
    setPending(true)
    setFailed(false)
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
        if (active.current === epoch) setFailed(true)
      })
      .finally(() => {
        if (active.current !== epoch) return
        pressLock.current = false
        inFlight.current = undefined
        setPending(false)
      })
  }
  if (!failed && (snapshot === null || snapshot.tree === null)) return null
  return (
    <div className="dsh-mods-band" role="group" aria-label={t('mods.band')}>
      {snapshot?.tree?.map((node, index) => (
        <BandNode key={index} node={node} pending={pending || failed} press={press} />
      ))}
      {failed ? (
        <div role="status">
          {t('mods.failed')}{' '}
          <button
            type="button"
            className="dsh-button dsh-button--secondary dsh-button--compact"
            disabled={pending}
            onClick={() => {
              setSnapshot(null)
              setFailed(false)
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
