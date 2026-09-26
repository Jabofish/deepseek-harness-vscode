import { isImageMediaType, type ImageAttachmentLimits } from '@dsh-vscode/domain'
import type { Translate } from '../i18n.js'
import { object } from './session-metrics.js'

const DEFAULT_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_PROMPT_IMAGE_BYTES = 200 * 1024 * 1024

export function readFileAsBase64(
  file: File,
  t: Translate,
  imageLimits?: ImageAttachmentLimits,
): Promise<{ name: string; mimeType?: string; dataBase64: string }> {
  if (file.size === 0) return Promise.reject(new Error(t('app.error.fileEmpty', { name: file.name })))
  const isImage = file.type.startsWith('image/')
  const imageLimit = isImage
    ? Math.min(MAX_IMAGE_ATTACHMENT_BYTES, imageLimits?.maxImageBytes ?? DEFAULT_ATTACHMENT_BYTES)
    : DEFAULT_ATTACHMENT_BYTES
  if (file.size > imageLimit)
    return Promise.reject(
      new Error(
        isImage && imageLimits !== undefined
          ? t('app.error.imageTooLarge', { name: file.name, size: formatByteSize(imageLimit) })
          : t('app.error.fileTooLarge', { name: file.name }),
      ),
    )
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(t('app.error.readFile', { name: file.name })))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(result)
      const dataBase64 = match?.[2]
      if (match === null || dataBase64 === undefined || dataBase64 === '') {
        reject(new Error(t('app.error.readFile', { name: file.name })))
        return
      }
      const mimeType = file.type === '' ? (match[1] ?? 'application/octet-stream') : file.type
      resolve({ name: file.name, mimeType, dataBase64 })
    }
    reader.readAsDataURL(file)
  })
}

export function readImageAttachmentLimits(value: unknown): ImageAttachmentLimits | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const maxImageBytes = positiveInteger(record.maxImageBytes)
  const maxImagesPerMessage = positiveInteger(record.maxImagesPerMessage)
  const maxMessageImageBytes = positiveInteger(record.maxMessageImageBytes)
  const maxImagePixels = positiveInteger(record.maxImagePixels)
  const maxImageDimension = positiveInteger(record.maxImageDimension)
  const hasMaxImageDimension = Object.prototype.hasOwnProperty.call(record, 'maxImageDimension')
  if (
    maxImageBytes === undefined ||
    maxImagesPerMessage === undefined ||
    maxMessageImageBytes === undefined ||
    maxImagePixels === undefined ||
    (hasMaxImageDimension && maxImageDimension === undefined) ||
    !Array.isArray(record.mediaTypes) ||
    record.mediaTypes.length === 0 ||
    !record.mediaTypes.every(
      (entry) => typeof entry === 'string' && isImageMediaType(entry.trim().toLowerCase()),
    )
  )
    return undefined
  const mediaTypes = record.mediaTypes.filter(
    (entry): entry is ImageAttachmentLimits['mediaTypes'][number] =>
      typeof entry === 'string' && isSupportedImageMediaType(entry.trim().toLowerCase()),
  )
  return {
    // Keep future hosts from advertising a limit beyond the opaque attachment
    // store and prompt boundary implemented by this extension.
    maxImageBytes: Math.min(maxImageBytes, MAX_IMAGE_ATTACHMENT_BYTES),
    maxImagesPerMessage: Math.min(maxImagesPerMessage, 20),
    maxMessageImageBytes: Math.min(maxMessageImageBytes, MAX_PROMPT_IMAGE_BYTES),
    maxImagePixels,
    ...(maxImageDimension === undefined ? {} : { maxImageDimension }),
    mediaTypes,
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function isSupportedImageMediaType(value: unknown): value is ImageAttachmentLimits['mediaTypes'][number] {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

export function formatByteSize(value: number): string {
  if (value >= 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(value % (1024 * 1024) === 0 ? 0 : 1)} MiB`
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`
  return `${value} B`
}
