import { isImageMediaType, type ImageAttachmentLimits } from '@dsh-vscode/domain'
import { isSupportedImageMimeType } from '../../attachment-codec.js'
import { recordOrUndefined } from '../shared/guards.js'

export function parseImageAttachmentLimits(value: unknown): ImageAttachmentLimits | undefined {
  const record = recordOrUndefined(value)
  if (record === undefined) return undefined
  const maxImageBytes = positiveSafeInteger(record.maxImageBytes)
  const maxImagesPerMessage = positiveSafeInteger(record.maxImagesPerMessage)
  const maxMessageImageBytes = positiveSafeInteger(record.maxMessageImageBytes)
  const maxImagePixels = positiveSafeInteger(record.maxImagePixels)
  const maxImageDimension =
    record.maxImageDimension === undefined ? undefined : positiveSafeInteger(record.maxImageDimension)
  const mediaTypes = Array.isArray(record.mediaTypes)
    ? [
        ...new Set(
          record.mediaTypes.map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : '')),
        ),
      ]
    : []
  if (
    maxImageBytes === undefined ||
    maxImagesPerMessage === undefined ||
    maxMessageImageBytes === undefined ||
    maxImagePixels === undefined ||
    mediaTypes.length === 0 ||
    mediaTypes.some((mediaType) => !isImageMediaType(mediaType)) ||
    (record.maxImageDimension !== undefined && maxImageDimension === undefined)
  )
    return undefined
  return {
    maxImageBytes,
    maxImagesPerMessage,
    maxMessageImageBytes,
    maxImagePixels,
    ...(maxImageDimension === undefined ? {} : { maxImageDimension }),
    // A Host type this client cannot encode (image/avif) narrows what may be
    // sent instead of discarding the byte and count limits beside it.
    mediaTypes: mediaTypes.filter(isSupportedImageMimeType),
  }
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
