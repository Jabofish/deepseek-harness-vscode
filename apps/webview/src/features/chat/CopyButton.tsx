import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useI18n, type Translate } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { writeClipboard } from './clipboard.js'

export interface CopyButtonProps {
  readonly text: string
  readonly className: string
  readonly translate?: Translate | undefined
}

type CopyState = 'idle' | 'copied' | 'failed'

export function CopyButton(props: CopyButtonProps): ReactElement {
  const { t: defaultTranslate } = useI18n()
  const t = props.translate ?? defaultTranslate
  const [state, setState] = useState<CopyState>('idle')
  const copyPending = useRef(false)
  const copyTimer = useRef<number | undefined>(undefined)
  const copyEpoch = useRef(0)

  useEffect(
    () => () => {
      copyEpoch.current += 1
      copyPending.current = false
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const copy = useCallback((): void => {
    if (state !== 'idle' || copyPending.current) return
    const epoch = copyEpoch.current
    copyPending.current = true
    void writeClipboard(props.text)
      .then((success) => {
        if (epoch !== copyEpoch.current) return
        copyPending.current = false
        // A denied clipboard write used to disappear silently; both outcomes
        // now state themselves, on the button and to screen readers.
        setState(success ? 'copied' : 'failed')
        copyTimer.current = window.setTimeout(() => {
          copyTimer.current = undefined
          setState('idle')
        }, 1_000)
      })
      .catch(() => {
        if (epoch === copyEpoch.current) copyPending.current = false
      })
  }, [props.text, state])

  const label =
    state === 'copied'
      ? t('message.copied')
      : state === 'failed'
        ? t('message.copyFailed')
        : t('message.copy')
  return (
    <>
      <button className={props.className} type="button" aria-label={label} title={label} onClick={copy}>
        <Icon name={state === 'copied' ? 'check' : state === 'failed' ? 'alert' : 'copy'} />
      </button>
      {/* Mounted only while an outcome is up: a silent live region on every
      copy button would be constant timeline noise for assistive tech. */}
      {state === 'idle' ? null : (
        <span className="dsh-sr-only" role="status">
          {label}
        </span>
      )}
    </>
  )
}
