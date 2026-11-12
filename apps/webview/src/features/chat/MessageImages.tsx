import { createPortal } from 'react-dom'
import { memo, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { MessageImageReference } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import type { Translate } from '../../i18n.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'

/**
 * A read can fail for reasons that outlive nothing: the connection dropped, the
 * host was still writing the image, or the session was reopened underneath the
 * timeline. The store republishes every row after a reconnect, so a failure is
 * retried when the row comes back — but only this many times, because a truly
 * unavailable attachment must not turn a transcript into a request loop.
 */
const MAX_LOAD_ATTEMPTS = 3

export interface MessageImagesProps {
  readonly images: readonly MessageImageReference[]
  readonly loadImage?: (image: MessageImageReference) => Promise<string | undefined>
  readonly translate: Translate
  readonly showNames?: boolean
}

/** Historical DSH images: bounded thumbnails with an explicit lightbox. */
export const MessageImages = memo(function MessageImages(props: MessageImagesProps): ReactElement | null {
  const [loaded, setLoaded] = useState<Readonly<Record<string, string>>>({})
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const [retry, setRetry] = useState(0)
  const [lightboxId, setLightboxId] = useState<string | undefined>(undefined)
  const requested = useRef(new Map<string, { readonly reader: MessageImagesProps['loadImage'] }>())
  const attempts = useRef(new Map<string, number>())
  const mounted = useRef(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const lightboxDialogRef = useRef<HTMLElement>(null)
  /**
   * The lightbox is `aria-modal`, so the keyboard belongs inside while it is up
   * and returns to the thumbnail that opened it. The opener is captured at the
   * click site rather than from the effect, because the lightbox mounts with
   * its own focus call.
   */
  const lightboxTriggerRef = useRef<HTMLButtonElement | null>(null)
  const lightboxWasOpen = useRef(false)
  const images = props.images
  const loadImage = props.loadImage
  const imageKey = images.map((image) => image.attachmentId).join('\u0000')
  const imagesRef = useRef(images)
  imagesRef.current = images
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const readerRef = useRef(loadImage)
  readerRef.current = loadImage
  const lightboxImage = images.find((image) => image.attachmentId === lightboxId)
  const lightboxData = lightboxId === undefined ? undefined : loaded[lightboxId]
  const lightboxOpen = lightboxImage !== undefined && lightboxData !== undefined

  useEffect(() => {
    mounted.current = true
    const pending = requested.current
    const reads = attempts.current
    return () => {
      mounted.current = false
      pending.clear()
      reads.clear()
    }
  }, [])

  useEffect(() => {
    const activeIds = new Set(imagesRef.current.map((image) => image.attachmentId))
    for (const id of requested.current.keys()) if (!activeIds.has(id)) requested.current.delete(id)
    for (const id of attempts.current.keys()) if (!activeIds.has(id)) attempts.current.delete(id)
    setLoaded((current) => retainImages(current, activeIds))
    setLoading((current) => retainImageIds(current, activeIds))
    setFailed((current) => retainImageIds(current, activeIds))
  }, [imageKey])

  if (lightboxId !== undefined && lightboxImage === undefined) setLightboxId(undefined)

  useEffect(() => {
    if (loadImage === undefined) {
      for (const id of requested.current.keys()) {
        attempts.current.set(id, Math.max(0, (attempts.current.get(id) ?? 1) - 1))
      }
      requested.current.clear()
      setLoading((current) => (current.size === 0 ? current : new Set()))
      return
    }
    for (const image of imagesRef.current) {
      const id = image.attachmentId
      const pending = requested.current.get(id)
      if (pending?.reader === loadImage) continue
      if (pending !== undefined) {
        requested.current.delete(id)
        attempts.current.set(id, Math.max(0, (attempts.current.get(id) ?? 1) - 1))
      }
      if (loadedRef.current[id] !== undefined) continue
      const attempt = attempts.current.get(id) ?? 0
      if (attempt >= MAX_LOAD_ATTEMPTS) continue
      attempts.current.set(id, attempt + 1)
      const request = { reader: loadImage }
      requested.current.set(id, request)
      setLoading((current) => new Set(current).add(id))
      const isCurrent = (): boolean =>
        mounted.current &&
        requested.current.get(id) === request &&
        readerRef.current === loadImage &&
        imagesRef.current.some((current) => current.attachmentId === id)
      const settle = (dataUri: string | undefined): void => {
        if (!isCurrent()) return
        requested.current.delete(id)
        setLoading((current) => without(current, id))
        if (dataUri === undefined) setFailed((current) => new Set(current).add(id))
        else {
          setFailed((current) => without(current, id))
          setLoaded((current) => ({ ...current, [id]: dataUri }))
        }
      }
      try {
        void loadImage(image).then(settle, () => settle(undefined))
      } catch {
        settle(undefined)
      }
    }
  }, [imageKey, loadImage, images, retry])

  useEffect(() => {
    if (!lightboxOpen) return
    closeRef.current?.focus()
  }, [lightboxOpen])

  // The lightbox is `aria-modal`: Tab cycles inside it, the rest of the page
  // goes inert, and Escape dismisses it through the shared layer.
  useDismissibleLayer({
    open: lightboxOpen,
    refs: [lightboxDialogRef],
    trapFocus: true,
    onDismiss: () => setLightboxId(undefined),
  })

  useEffect(() => {
    if (lightboxWasOpen.current && !lightboxOpen) {
      const target = lightboxTriggerRef.current
      lightboxTriggerRef.current = null
      // The window may scroll the thumbnail out of the rendered list; body
      // focus beats a detached node.
      if (target !== null && target.isConnected) target.focus()
    }
    lightboxWasOpen.current = lightboxOpen
  }, [lightboxOpen])

  const imageDecodeFailed = (id: string, dataUri: string): void => {
    if (!mounted.current || loadedRef.current[id] !== dataUri) return
    setLoaded((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setFailed((current) => new Set(current).add(id))
    if (lightboxId === id) setLightboxId(undefined)
  }

  if (props.images.length === 0) return null
  const single = props.images.length === 1
  return (
    <>
      <div
        role="group"
        className={`dsh-message-images${single ? ' dsh-message-images--single' : ' dsh-message-images--grid'}${props.showNames === true ? ' dsh-message-images--named' : ''}`}
        aria-label={props.translate('timeline.attachedImages')}
      >
        {props.images.map((image) => {
          const entry = loaded[image.attachmentId]
          const name = image.name?.trim() || props.translate('timeline.imageUnnamed')
          const busy = loading.has(image.attachmentId)
          const error = failed.has(image.attachmentId)
          if (entry !== undefined)
            return (
              <button
                key={image.attachmentId}
                type="button"
                className="dsh-message-images__thumb"
                style={single && props.showNames !== true ? imageRatioStyle(image) : undefined}
                aria-label={props.translate('timeline.openImage', { name })}
                title={props.translate('timeline.openImage', { name })}
                onClick={(event) => {
                  lightboxTriggerRef.current = event.currentTarget
                  setLightboxId(image.attachmentId)
                }}
              >
                {props.showNames === true ? (
                  <>
                    <span className="dsh-message-images__preview">
                      <img
                        src={entry}
                        alt=""
                        loading="lazy"
                        onError={() => imageDecodeFailed(image.attachmentId, entry)}
                      />
                    </span>
                    <span className="dsh-message-images__name" title={name}>
                      {name}
                    </span>
                  </>
                ) : (
                  <>
                    <img
                      src={entry}
                      alt={name}
                      loading="lazy"
                      onError={() => imageDecodeFailed(image.attachmentId, entry)}
                    />
                    <span className="dsh-message-images__caption" title={name}>
                      {name}
                    </span>
                  </>
                )}
              </button>
            )
          return (
            <span
              key={image.attachmentId}
              className={`dsh-message-images__placeholder${error ? ' dsh-message-images__placeholder--error' : ''}`}
              style={single && !error ? placeholderRatioStyle(image) : undefined}
              role={error ? 'alert' : undefined}
            >
              <Icon name={error ? 'alert' : 'image'} />
              <span>
                {busy
                  ? props.translate('timeline.imageLoading')
                  : error
                    ? props.translate('timeline.imageUnavailable')
                    : props.translate('timeline.imagePending')}
              </span>
              <span className="dsh-message-images__name" title={name}>
                {name}
              </span>
              {error && loadImage !== undefined ? (
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary dsh-button--compact"
                  disabled={busy}
                  onClick={() => {
                    if (requested.current.has(image.attachmentId)) return
                    attempts.current.delete(image.attachmentId)
                    setRetry((value) => value + 1)
                  }}
                >
                  {props.translate('timeline.imageRetry')}
                </button>
              ) : null}
            </span>
          )
        })}
      </div>
      {!lightboxOpen
        ? null
        : createPortal(
            <div
              className="dsh-message-image-lightbox"
              role="presentation"
              onClick={(event) => {
                if (event.target === event.currentTarget) setLightboxId(undefined)
              }}
            >
              <section
                ref={lightboxDialogRef}
                className="dsh-message-image-lightbox__dialog"
                role="dialog"
                aria-modal="true"
                aria-label={props.translate('timeline.openImage', {
                  name: lightboxImage.name?.trim() || props.translate('timeline.imageUnnamed'),
                })}
              >
                <div className="dsh-message-image-lightbox__header">
                  <span className="dsh-message-image-lightbox__name" title={lightboxImage.name}>
                    {lightboxImage.name?.trim() || props.translate('timeline.imageUnnamed')}
                  </span>
                  <button
                    ref={closeRef}
                    type="button"
                    className="dsh-message-image-lightbox__close"
                    aria-label={props.translate('timeline.closeImage')}
                    title={props.translate('timeline.closeImage')}
                    onClick={() => setLightboxId(undefined)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <img
                  className="dsh-message-image-lightbox__image"
                  src={lightboxData}
                  alt={lightboxImage.name?.trim() || props.translate('timeline.imageUnnamed')}
                  onError={() => imageDecodeFailed(lightboxImage.attachmentId, lightboxData)}
                />
              </section>
            </div>,
            document.body,
          )}
    </>
  )
}, areMessageImagesEqual)

function areMessageImagesEqual(previous: MessageImagesProps, next: MessageImagesProps): boolean {
  if (previous.loadImage !== next.loadImage || previous.translate !== next.translate) return false
  if (previous.showNames !== next.showNames) return false
  if (previous.images === next.images) return true
  if (previous.images.length !== next.images.length) return false
  for (let index = 0; index < previous.images.length; index += 1) {
    if (previous.images[index] !== next.images[index]) return false
  }
  return true
}

function clampedImageRatio(image: MessageImageReference): number {
  if (!(image.width > 0) || !(image.height > 0)) return 4 / 3
  return Math.max(0.25, Math.min(4, image.width / image.height))
}

function imageRatioStyle(image: MessageImageReference): CSSProperties {
  const ratio = clampedImageRatio(image)
  const style: CSSProperties & { readonly '--dsh-image-ratio': number } = {
    aspectRatio: `${ratio}`,
    '--dsh-image-ratio': ratio,
  }
  return style
}

function placeholderRatioStyle(image: MessageImageReference): CSSProperties {
  const style: CSSProperties & { readonly '--dsh-image-ratio': number } = {
    '--dsh-image-ratio': clampedImageRatio(image),
  }
  return style
}

function without(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (!values.has(value)) return values
  const next = new Set(values)
  next.delete(value)
  return next
}

function retainImages(
  values: Readonly<Record<string, string>>,
  active: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (Object.keys(values).every((id) => active.has(id))) return values
  return Object.fromEntries(Object.entries(values).filter(([id]) => active.has(id)))
}

function retainImageIds(values: ReadonlySet<string>, active: ReadonlySet<string>): ReadonlySet<string> {
  return [...values].every((id) => active.has(id))
    ? values
    : new Set([...values].filter((id) => active.has(id)))
}
