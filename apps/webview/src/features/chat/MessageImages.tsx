import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
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
export function MessageImages(props: MessageImagesProps): ReactElement | null {
  const [loaded, setLoaded] = useState<Readonly<Record<string, LoadedImage>>>({})
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const [lightbox, setLightbox] = useState<LoadedImage | undefined>(undefined)
  const requested = useRef(new Set<string>())
  const closeRef = useRef<HTMLButtonElement>(null)
  const imageKey = props.images.map((image) => image.attachmentId).join('\u0000')
  const images = props.images
  const loadImage = props.loadImage

  useEffect(() => {
    if (loadImage === undefined) return
    for (const image of images) {
      if (requested.current.has(image.attachmentId)) continue
      if (loaded[image.attachmentId] !== undefined) continue
      requested.current.add(image.attachmentId)
      // This is the async request-start marker for the image loader; the
      // completion callbacks below own the actual result state transitions.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading((current) => new Set(current).add(image.attachmentId))
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
  }, [imageKey, loaded, images, loadImage])

  useEffect(() => {
    if (lightbox === undefined) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setLightbox(undefined)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
                onClick={() => setLightbox(entry)}
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
