import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  ImageAttachmentLimits,
  PromptAttachment,
  SessionSummary,
  SubagentCatalog,
} from '@dsh-vscode/domain'
import type { AppStore, OpenFileCandidate, ReferenceCandidate } from './store.js'
import { publicProtocolErrorMessage } from './protocol-client.js'
import { useStableCallback } from './useStableCallback.js'
import { readFileAsBase64, formatByteSize } from './attachment-reader.js'
import {
  attachmentDraftKey,
  browserFileOrigin,
  type AttachmentDraftOrigin,
} from '../features/composer/attachmentDrafts.js'
import type { Translate } from '../i18n.js'

const EMPTY_OPEN_FILE_CANDIDATES: readonly OpenFileCandidate[] = []
const EMPTY_REFERENCE_CANDIDATES: readonly ReferenceCandidate[] = []

/**
 * The composer draft and its attachments: pasted or picked files, the open-file
 * picker snapshot, `@` reference candidates, and the previews the Host renders
 * for image handles. Everything here is client-owned scratch state that the
 * Host only ever sees through an attachment handle, so it lives apart from the
 * conversation projection.
 */
export interface ComposerAttachmentDependencies {
  readonly store: AppStore
  readonly t: Translate
  readonly setError: (message: string | undefined) => void
  readonly active: SessionSummary | undefined
  readonly activeSessionId: string | undefined
  readonly imageLimits: ImageAttachmentLimits | undefined
  readonly hasPendingSession: boolean
  readonly subagentEntries: SubagentCatalog['entries']
  readonly mountedRef: { readonly current: boolean }
  /**
   * The shared composer draft lives in the draft provider above App, so typing
   * re-renders only the composer binding. The hook never reads the draft at
   * render time; submit reads it once at event time through `readDraft`.
   */
  readonly setDraft: Dispatch<SetStateAction<string>>
  readonly readDraft: () => string
}

export interface ComposerAttachments {
  readonly attachments: readonly PromptAttachment[]
  readonly attachmentPreviews: Readonly<Record<string, string>>
  readonly attachmentPreviewFailures: readonly string[]
  readonly visibleOpenFileCandidates: readonly OpenFileCandidate[]
  readonly visibleOpenFilePickerOpen: boolean
  readonly visibleOpenFilePickerLoading: boolean
  readonly attachedOpenFileIds: readonly string[]
  readonly attachingOpenFileId: string | undefined
  readonly visibleReferenceCandidates: readonly ReferenceCandidate[]
  readonly visibleReferenceLoading: boolean
  readonly discardAttachmentDrafts: () => void
  readonly removeAttachmentDrafts: (uris: readonly string[], release: boolean) => void
  readonly composerOnReferenceQueryChange: (query: string | undefined, quoted: boolean) => void
  readonly composerOnPickAttachment: () => void
  readonly composerOnIngestFiles: (files: readonly File[]) => void
  readonly composerOnToggleOpenFilePicker: () => void
  readonly composerOnExtrasOpenChange: (open: boolean) => void
  readonly composerOnSelectOpenFile: (candidateId: string) => void
  readonly composerOnRemoveAttachment: (uri: string) => void
  readonly composerOnSubmit: (mode: 'queue' | 'steer') => Promise<void>
}

export function useComposerAttachments(deps: ComposerAttachmentDependencies): ComposerAttachments {
  const { store, t, setError, active, activeSessionId, imageLimits, hasPendingSession, subagentEntries } =
    deps
  const mountedRef = deps.mountedRef
  const setDraft = deps.setDraft
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({})
  const [attachmentPreviewFailures, setAttachmentPreviewFailures] = useState<readonly string[]>([])
  const [openFileCandidates, setOpenFileCandidates] = useState<readonly OpenFileCandidate[]>([])
  const [openFileCandidatesSessionId, setOpenFileCandidatesSessionId] = useState<string | undefined>()
  const [openFilePickerOpen, setOpenFilePickerOpen] = useState(false)
  const [openFilePickerSessionId, setOpenFilePickerSessionId] = useState<string | undefined>()
  const [openFilePickerLoading, setOpenFilePickerLoading] = useState(false)
  const [referenceCandidates, setReferenceCandidates] = useState<readonly ReferenceCandidate[]>([])
  const [referenceLoading, setReferenceLoading] = useState(false)
  const [referenceSessionId, setReferenceSessionId] = useState<string | undefined>()
  const [referenceQuery, setReferenceQuery] = useState('')
  const [referenceQuoted, setReferenceQuoted] = useState(false)
  const [attachingOpenFileId, setAttachingOpenFileId] = useState<string | undefined>()
  const [openFileAttachmentIds, setOpenFileAttachmentIds] = useState<Record<string, string>>({})
  const attachmentDraftKeysRef = useRef<Map<string, string>>(new Map())
  /** Decoded bytes of pasted image drafts still tracked in the composer, by uri. */
  const imageBytesByUriRef = useRef<Map<string, number>>(new Map())
  /** Image count/bytes of pastes whose read or ingest has not settled yet. */
  const pendingImageStatsRef = useRef<{ count: number; bytes: number }>({ count: 0, bytes: 0 })
  const attachingOpenFileRef = useRef<string | undefined>(undefined)
  const referenceRequestRef = useRef(0)
  const openFileRequestRef = useRef(0)
  const openFilePickerRequestRef = useRef(0)
  const attachmentGenerationRef = useRef(0)

  useEffect(() => {
    const missing = attachments.filter(
      (attachment) =>
        attachment.mimeType?.startsWith('image/') === true &&
        attachmentPreviews[attachment.uri] === undefined &&
        !attachmentPreviewFailures.includes(attachment.uri),
    )
    if (missing.length === 0) return
    let cancelled = false
    const recordFailure = (uri: string): void => {
      setAttachmentPreviewFailures((current) => (current.includes(uri) ? current : [...current, uri]))
    }
    for (const attachment of missing) {
      void store
        .previewAttachment(attachment.uri)
        .then((dataUri) => {
          if (cancelled) return
          // `undefined` is the Host's flattened refusal (an expired or dead
          // draft handle); recording it keeps the lightbox from claiming the
          // image is merely still loading.
          if (dataUri === undefined) recordFailure(attachment.uri)
          else setAttachmentPreviews((current) => ({ ...current, [attachment.uri]: dataUri }))
        })
        .catch(() => {
          if (!cancelled) recordFailure(attachment.uri)
        })
    }
    return () => {
      cancelled = true
    }
  }, [attachments, attachmentPreviewFailures, attachmentPreviews, store])

  const visibleOpenFilePickerOpen =
    openFilePickerOpen && openFilePickerSessionId !== undefined && openFilePickerSessionId === activeSessionId
  const visibleOpenFileCandidates = useMemo(
    () => (openFileCandidatesSessionId === activeSessionId ? openFileCandidates : EMPTY_OPEN_FILE_CANDIDATES),
    [activeSessionId, openFileCandidates, openFileCandidatesSessionId],
  )
  const visibleOpenFilePickerLoading =
    openFilePickerLoading &&
    openFilePickerSessionId !== undefined &&
    openFilePickerSessionId === activeSessionId
  const attachedOpenFileIds = useMemo(() => Object.values(openFileAttachmentIds), [openFileAttachmentIds])
  const updateReferenceQuery = (query: string | undefined, quoted: boolean): void => {
    const sessionId = active?.id
    const request = ++referenceRequestRef.current
    if (sessionId === undefined || query === undefined) {
      setReferenceCandidates([])
      setReferenceLoading(false)
      setReferenceSessionId(undefined)
      setReferenceQuery('')
      setReferenceQuoted(false)
      return
    }
    setReferenceSessionId(sessionId)
    setReferenceQuery(query)
    setReferenceQuoted(quoted)
    setReferenceLoading(true)
    void store
      .listReferences(sessionId, query, quoted)
      .then((candidates) => {
        if (request === referenceRequestRef.current && store.getState().activeSessionId === sessionId)
          setReferenceCandidates(candidates)
      })
      .catch(() => {
        if (request === referenceRequestRef.current && store.getState().activeSessionId === sessionId)
          setReferenceCandidates([])
      })
      .finally(() => {
        if (request === referenceRequestRef.current && store.getState().activeSessionId === sessionId)
          setReferenceLoading(false)
      })
  }
  const localSubagentReferences = useMemo<readonly ReferenceCandidate[]>(() => {
    if (referenceQuoted || activeSessionId === undefined) return EMPTY_REFERENCE_CANDIDATES
    const needle = referenceQuery.trim().toLocaleLowerCase()
    const candidates: ReferenceCandidate[] = []
    for (const entry of subagentEntries) {
      if (entry.kind !== 'child') continue
      const label = entry.label?.trim() || t('subagents.unnamed')
      if (!label.toLocaleLowerCase().includes(needle)) continue
      candidates.push({
        id: `subagent:${entry.id}`,
        kind: 'session',
        sessionId: entry.id,
        label,
        description: t('composer.referenceSubagent'),
        mention: `@[${label}](dsh-session:${entry.id})`,
      })
    }
    return candidates
  }, [activeSessionId, referenceQuery, referenceQuoted, subagentEntries, t])
  const visibleReferenceCandidates = useMemo(() => {
    if (referenceSessionId !== activeSessionId) return EMPTY_REFERENCE_CANDIDATES
    if (referenceCandidates.length === 0) return localSubagentReferences
    if (localSubagentReferences.length === 0) return referenceCandidates
    return [...referenceCandidates, ...localSubagentReferences]
  }, [activeSessionId, localSubagentReferences, referenceCandidates, referenceSessionId])
  const visibleReferenceLoading = referenceSessionId === active?.id && referenceLoading
  const appendAttachment = (
    attachment: PromptAttachment,
    openFileId?: string,
    generation = attachmentGenerationRef.current,
    origin?: AttachmentDraftOrigin,
  ): void => {
    if (generation !== attachmentGenerationRef.current) {
      void store.releaseAttachments([attachment.uri]).catch(() => undefined)
      return
    }
    if (attachmentDraftKeysRef.current.has(attachment.uri)) return
    const draftKey = attachmentDraftKey(attachment, origin)
    const existingUri = [...attachmentDraftKeysRef.current.entries()].find(([, key]) => key === draftKey)?.[0]
    if (existingUri !== undefined) {
      if (existingUri !== attachment.uri)
        void store
          .releaseAttachments([attachment.uri])
          .catch((reason: unknown) =>
            setError(reason instanceof Error ? reason.message : t('app.error.releaseAttachment')),
          )
      return
    }
    attachmentDraftKeysRef.current.set(attachment.uri, draftKey)
    setAttachments((current) =>
      current.some((item) => item.uri === attachment.uri) ? current : [...current, attachment],
    )
    if (openFileId !== undefined)
      setOpenFileAttachmentIds((current) => ({ ...current, [attachment.uri]: openFileId }))
  }
  const removeAttachmentDrafts = (uris: readonly string[], release: boolean): void => {
    if (uris.length === 0) return
    const removed = new Set(uris)
    for (const uri of removed) {
      attachmentDraftKeysRef.current.delete(uri)
      imageBytesByUriRef.current.delete(uri)
    }
    setAttachments((current) => current.filter((attachment) => !removed.has(attachment.uri)))
    setAttachmentPreviews((current) =>
      Object.fromEntries(Object.entries(current).filter(([uri]) => !removed.has(uri))),
    )
    setAttachmentPreviewFailures((current) => current.filter((uri) => !removed.has(uri)))
    setOpenFileAttachmentIds((current) =>
      Object.fromEntries(Object.entries(current).filter(([uri]) => !removed.has(uri))),
    )
    if (release)
      void store
        .releaseAttachments(uris)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : t('app.error.releaseAttachment')),
        )
  }
  const discardAttachmentDrafts = useStableCallback((): void => {
    attachmentGenerationRef.current += 1
    removeAttachmentDrafts(
      attachments.map((attachment) => attachment.uri),
      true,
    )
    setOpenFilePickerOpen(false)
  })
  const ingestFiles = (files: readonly File[]): void => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (imageLimits !== undefined && imageFiles.length > 0) {
      const existingImages = attachments.filter((attachment) =>
        attachment.mimeType?.startsWith('image/'),
      ).length
      const existingImageBytes = [...imageBytesByUriRef.current.values()].reduce(
        (sum, bytes) => sum + bytes,
        0,
      )
      const pendingImages = pendingImageStatsRef.current
      // Checks run before any read starts, so a batch can never push the
      // composer past what DSH will admit for the message.
      if (existingImages + pendingImages.count + imageFiles.length > imageLimits.maxImagesPerMessage) {
        setError(t('app.error.imageCount', { count: imageLimits.maxImagesPerMessage }))
        return
      }
      const batchImageBytes = imageFiles.reduce((sum, file) => sum + file.size, 0)
      if (existingImageBytes + pendingImages.bytes + batchImageBytes > imageLimits.maxMessageImageBytes) {
        setError(t('app.error.imageTotalSize', { size: formatByteSize(imageLimits.maxMessageImageBytes) }))
        return
      }
      const unsupported = imageFiles.find((file) => !imageLimits.mediaTypes.includes(file.type))
      if (unsupported !== undefined) {
        setError(t('app.error.imageType', { name: unsupported.name }))
        return
      }
      const oversized = imageFiles.find((file) => file.size > imageLimits.maxImageBytes)
      if (oversized !== undefined) {
        setError(
          t('app.error.imageTooLarge', {
            name: oversized.name,
            size: formatByteSize(imageLimits.maxImageBytes),
          }),
        )
        return
      }
    }
    const generation = attachmentGenerationRef.current
    for (const file of files) {
      const origin = browserFileOrigin(file)
      const isImage = file.type.startsWith('image/')
      if (isImage) {
        pendingImageStatsRef.current.count += 1
        pendingImageStatsRef.current.bytes += file.size
      }
      void readFileAsBase64(file, t, imageLimits)
        .then((payload) => store.ingestAttachment(payload))
        .then((attachment) => {
          if (attachment === undefined) return
          appendAttachment(attachment, undefined, generation, origin)
          // Only a draft actually tracked by appendAttachment contributes bytes:
          // duplicates resolve to the earlier uri and released handles never do.
          if (
            isImage &&
            attachmentDraftKeysRef.current.has(attachment.uri) &&
            !imageBytesByUriRef.current.has(attachment.uri)
          )
            imageBytesByUriRef.current.set(attachment.uri, file.size)
        })
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : t('app.error.attachPasted')),
        )
        .finally(() => {
          if (isImage) {
            pendingImageStatsRef.current.count -= 1
            pendingImageStatsRef.current.bytes -= file.size
          }
        })
    }
  }
  const submitPrompt = (mode: 'queue' | 'steer'): Promise<void> => {
    if (active === undefined && !hasPendingSession) return Promise.resolve()
    const text = deps.readDraft()
    const attachmentSnapshot = attachments
    let submission: Promise<void>
    try {
      submission =
        active === undefined
          ? store.sendPendingPrompt(text, attachmentSnapshot, mode)
          : store.sendPrompt(active.id, text, attachmentSnapshot, mode)
    } catch (reason) {
      submission = Promise.reject(reason instanceof Error ? reason : new Error(t('app.error.prompt')))
    }
    return submission
      .then(() => {
        if (!mountedRef.current) return
        setDraft((current) => (current === text ? '' : current))
        // The Extension Host consumes only the handles admitted by this send;
        // keep any draft attachments the user added while it was in flight.
        removeAttachmentDrafts(
          attachmentSnapshot.map((attachment) => attachment.uri),
          false,
        )
        setOpenFilePickerOpen(false)
      })
      .catch((reason: unknown) => {
        if (mountedRef.current) setError(publicProtocolErrorMessage(reason) ?? t('app.error.prompt'))
      })
  }
  /**
   * Loads the open-file snapshot that both the composer menu row and the
   * picker render. The row is only offered when the list names an attachable
   * file, so it has to be requested while that menu is being built.
   */
  const loadOpenFileCandidates = (sessionId: string, awaitingPicker: boolean): void => {
    const request = ++openFileRequestRef.current
    if (awaitingPicker) {
      openFilePickerRequestRef.current = request
      setOpenFilePickerLoading(true)
    }
    void store
      .listOpenFiles()
      .then((candidates) => {
        if (request !== openFileRequestRef.current) return
        setOpenFileCandidatesSessionId(sessionId)
        setOpenFileCandidates(candidates)
      })
      .catch((reason: unknown) => {
        if (request !== openFileRequestRef.current) return
        setOpenFileCandidatesSessionId(sessionId)
        setOpenFileCandidates([])
        if (awaitingPicker) setError(reason instanceof Error ? reason.message : t('app.error.listOpenFiles'))
      })
      .finally(() => {
        // Only the newest picker-awaiting request may clear the flag: a fast
        // close and reopen leaves the older request settling last, and clearing
        // unconditionally would end the newer request's loading state. Requests
        // that do not await the picker never touch the flag.
        if (awaitingPicker && request === openFilePickerRequestRef.current) setOpenFilePickerLoading(false)
      })
  }
  const toggleOpenFilePicker = (): void => {
    if (visibleOpenFilePickerOpen) {
      setOpenFilePickerOpen(false)
      return
    }
    if (activeSessionId === undefined) return
    setOpenFilePickerSessionId(activeSessionId)
    setOpenFilePickerOpen(true)
    loadOpenFileCandidates(activeSessionId, true)
  }
  const selectOpenFile = (candidateId: string): void => {
    if (
      attachingOpenFileRef.current !== undefined ||
      attachingOpenFileId !== undefined ||
      Object.values(openFileAttachmentIds).some((id) => id === candidateId)
    )
      return
    attachingOpenFileRef.current = candidateId
    setAttachingOpenFileId(candidateId)
    const generation = attachmentGenerationRef.current
    void store
      .attachOpenFile(candidateId)
      .then((attachment) => {
        if (attachment === undefined) {
          setError(t('app.error.openFileGone'))
          return
        }
        store.rememberOpenFile(candidateId)
        appendAttachment(attachment, candidateId, generation, { kind: 'open-file', id: candidateId })
        setOpenFilePickerOpen(false)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.attachSelectedFile')),
      )
      .finally(() => {
        attachingOpenFileRef.current = undefined
        setAttachingOpenFileId(undefined)
      })
  }
  const composerOnReferenceQueryChange = useStableCallback(
    (query: string | undefined, quoted: boolean): void => updateReferenceQuery(query, quoted),
  )
  const composerOnPickAttachment = useStableCallback((): void => {
    const generation = attachmentGenerationRef.current
    void store
      .pickAttachment()
      .then((attachment) => {
        if (attachment !== undefined) appendAttachment(attachment, undefined, generation)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.attachmentSelection')),
      )
  })
  const composerOnIngestFiles = useStableCallback((files: readonly File[]): void => ingestFiles(files))
  const composerOnToggleOpenFilePicker = useStableCallback((): void => toggleOpenFilePicker())
  const composerOnExtrasOpenChange = useStableCallback((open: boolean): void => {
    if (!open) {
      // The picker is rendered inside that menu; leaving it "open" would make
      // the next menu opening start with a stale popover already expanded.
      setOpenFilePickerOpen(false)
      return
    }
    if (activeSessionId === undefined) return
    loadOpenFileCandidates(activeSessionId, false)
  })
  const composerOnSelectOpenFile = useStableCallback((candidateId: string): void =>
    selectOpenFile(candidateId),
  )
  const composerOnRemoveAttachment = useStableCallback((uri: string): void => {
    removeAttachmentDrafts([uri], true)
  })
  const composerOnSubmit = useStableCallback((mode: 'queue' | 'steer'): Promise<void> => submitPrompt(mode))

  return {
    attachments,
    attachmentPreviews,
    attachmentPreviewFailures,
    visibleOpenFileCandidates,
    visibleOpenFilePickerOpen,
    visibleOpenFilePickerLoading,
    attachedOpenFileIds,
    attachingOpenFileId,
    visibleReferenceCandidates,
    visibleReferenceLoading,
    discardAttachmentDrafts,
    removeAttachmentDrafts,
    composerOnReferenceQueryChange,
    composerOnPickAttachment,
    composerOnIngestFiles,
    composerOnToggleOpenFilePicker,
    composerOnExtrasOpenChange,
    composerOnSelectOpenFile,
    composerOnRemoveAttachment,
    composerOnSubmit,
  }
}
