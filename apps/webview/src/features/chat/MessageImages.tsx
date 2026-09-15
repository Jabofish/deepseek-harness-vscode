import { createPortal } from 'react-dom'
import { memo, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { MessageImageReference } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import type { Translate } from '../../i18n.js'

interface LoadedImage {
  readonly image: MessageImageReference
  readonly dataUri: string
}

export interface MessageImagesProps {
  readonly images: readonly MessageImageReference[]
  readonly loadImage?: (image: MessageImageReference) => Promise<string | undefined>
  readonly translate: Translate
}

/** Historical DSH images: bounded thumbnails with an explicit lightbox. */
export const MessageImages = memo(function MessageImages(props: MessageImagesProps): ReactElement | null {
  const [loaded, setLoaded] = useState<Readonly<Record<string, LoadedImage>>>({})
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const [lightbox, setLightbox] = useState<LoadedImage | undefined>(undefined)
  const requested = useRef(new Set<string>())
  const closeRef = useRef<HTMLButtonElement>(null)
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

  useEffect(() => {
    if (loadImage === undefined) return
    const pendingImages: MessageImageReference[] = []
    for (const image of imagesRef.current) {
      if (requested.current.has(image.attachmentId)) continue
      if (loadedRef.current[image.attachmentId] !== undefined) continue
      requested.current.add(image.attachmentId)
      pendingImages.push(image)
    }
    if (pendingImages.length === 0) return
    setLoading((current) => {
      const next = new Set(current)
      for (const image of pendingImages) next.add(image.attachmentId)
      return next
    })
    for (const image of pendingImages) {
      void loadImage(image).then(
        (dataUri) => {
          setLoading((current) => without(current, image.attachmentId))
          if (dataUri === undefined) {
            setFailed((current) => new Set(current).add(image.attachmentId))
            return
          }
          setFailed((current) => without(current, image.attachmentId))
          setLoaded((current) => ({ ...current, [image.attachmentId]: { image, dataUri } }))
        },
        () => {
          setLoading((current) => without(current, image.attachmentId))
          setFailed((current) => new Set(current).add(image.attachmentId))
        },
      )
    }
  }, [imageKey, loadImage])

  useEffect(() => {
    if (lightbox === undefined) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      // A layer that is already open consumes Escape first; acting regardless
      // would collapse both surfaces with one key press.
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setLightbox(undefined)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [lightbox])

  useEffect(() => {
    if (lightboxWasOpen.current && lightbox === undefined) {
      const target = lightboxTriggerRef.current
      lightboxTriggerRef.current = null
      // The window may scroll the thumbnail out of the rendered list; body
      // focus beats a detached node.
      if (target !== null && target.isConnected) target.focus()
    }
    lightboxWasOpen.current = lightbox !== undefined
  }, [lightbox])

  useEffect(() => {
    const activeIds = new Set(props.images.map((image) => image.attachmentId))
    for (const id of requested.current) if (!activeIds.has(id)) requested.current.delete(id)
  }, [imageKey, props.images])

  if (props.images.length === 0) return null
  const single = props.images.length === 1
  return (
    <>
      <div
        className={`dsh-message-images${single ? ' dsh-message-images--single' : ' dsh-message-images--grid'}`}
        aria-label={props.translate('timeline.attachedImages')}
      >
        {props.images.map((image) => {
          const entry = loaded[image.attachmentId]
          const name = image.name ?? props.translate('timeline.imageUnnamed')
          const busy = loading.has(image.attachmentId)
          const error = failed.has(image.attachmentId)
          if (entry !== undefined)
            return (
              <button
                key={image.attachmentId}
                type="button"
                className="dsh-message-images__thumb"
                style={single ? imageRatioStyle(image) : undefined}
                aria-label={props.translate('timeline.openImage', { name })}
                title={props.translate('timeline.openImage', { name })}
                onClick={(event) => {
                  lightboxTriggerRef.current = event.currentTarget
                  setLightbox(entry)
                }}
              >
                <img src={entry.dataUri} alt={name} loading="lazy" />
              </button>
            )
          return (
            <span
              key={image.attachmentId}
              className={`dsh-message-images__placeholder${error ? ' dsh-message-images__placeholder--error' : ''}`}
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
            </span>
          )
        })}
      </div>
      {lightbox === undefined
        ? null
        : createPortal(
            <div
              className="dsh-message-image-lightbox"
              role="presentation"
              onClick={(event) => {
                if (event.target === event.currentTarget) setLightbox(undefined)
              }}
            >
              <section
                className="dsh-message-image-lightbox__dialog"
                role="dialog"
                aria-modal="true"
                aria-label={props.translate('timeline.openImage', {
                  name: lightbox.image.name ?? props.translate('timeline.imageUnnamed'),
                })}
              >
                <button
                  ref={closeRef}
                  type="button"
                  className="dsh-message-image-lightbox__close"
                  aria-label={props.translate('timeline.closeImage')}
                  title={props.translate('timeline.closeImage')}
                  onClick={() => setLightbox(undefined)}
                >
                  <Icon name="close" />
                </button>
                <img
                  className="dsh-message-image-lightbox__image"
                  src={lightbox.dataUri}
                  alt={lightbox.image.name ?? props.translate('timeline.imageUnnamed')}
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
  if (previous.images === next.images) return true
  if (previous.images.length !== next.images.length) return false
  for (let index = 0; index < previous.images.length; index += 1) {
    if (previous.images[index] !== next.images[index]) return false
  }
  return true
}

function imageRatioStyle(image: MessageImageReference): CSSProperties {
  const ratio = Math.max(0.25, Math.min(4, image.width / image.height))
  return { aspectRatio: `${ratio}` }
}

function without(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (!values.has(value)) return values
  const next = new Set(values)
  next.delete(value)
  return next
}
