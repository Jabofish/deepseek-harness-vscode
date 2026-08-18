import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useI18n, type Translate } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { writeClipboard } from './clipboard.js'

export interface CopyButtonProps {
  readonly text: string
  readonly className: string
  readonly translate?: Translate | undefined
}

export function CopyButton(props: CopyButtonProps): ReactElement {
  const { t: defaultTranslate } = useI18n()
  const t = props.translate ?? defaultTranslate
  const [copied, setCopied] = useState(false)
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
    if (copied || copyPending.current) return
    const epoch = copyEpoch.current
    copyPending.current = true
    void writeClipboard(props.text)
      .then((success) => {
        if (epoch !== copyEpoch.current) return
        copyPending.current = false
        if (!success) return
        setCopied(true)
        copyTimer.current = window.setTimeout(() => {
          copyTimer.current = undefined
          setCopied(false)
        }, 1_000)
      })
      .catch(() => {
        if (epoch === copyEpoch.current) copyPending.current = false
      })
  }, [copied, props.text])

  return (
    <button
      className={props.className}
      type="button"
      aria-label={copied ? t('message.copied') : t('message.copy')}
      title={copied ? t('message.copied') : t('message.copy')}
      onClick={copy}
    >
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  )
}
