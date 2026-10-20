import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ImageAttachmentLimits,
  EditorContextItem,
  PromptAttachment,
  SessionSummary,
  SubagentCatalog,
} from '@dsh-vscode/domain'
import type { AppStore, OpenFileCandidate, ReferenceCandidate } from './store.js'
import { publicProtocolErrorMessage } from './protocol-client.js'
import { matchesQueuedPrompt } from './store/pending-prompts.js'
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
  readonly editorContext: readonly EditorContextItem[]
  readonly mountedRef: { readonly current: boolean }
  /**
   * The shared composer draft lives in the draft provider above App, so typing
   * re-renders only the composer binding. The hook never reads the draft at
   * render time; submit reads it once at event time through `readDraft`.
   */
  readonly draftOwner: string | undefined
  readonly clearDraftIf: (owner: string | undefined, text: string) => void
  readonly readDraft: () => string
}

interface PendingAttachmentIngest {
  readonly generation: number
  readonly promise: Promise<boolean>
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
  readonly composerOnSubmit: (mode: 'queue' | 'steer', signal?: AbortSignal) => Promise<void>
}

function contextOpenFileIds(items: readonly EditorContextItem[]): string[] {
  return items.flatMap((item) =>
    item.ref.kind === 'file' && item.ref.sourceCandidateId !== undefined ? [item.ref.sourceCandidateId] : [],
  )
}

export function useComposerAttachments(deps: ComposerAttachmentDependencies): ComposerAttachments {
  const { store, t, setError, active, activeSessionId, imageLimits, hasPendingSession, subagentEntries } =
    deps
  const mountedRef = deps.mountedRef
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
  /** Latest attachments, readable synchronously by submit before React commits. */
  const attachmentsRef = useRef<readonly PromptAttachment[]>([])
  const pendingIngestsRef = useRef<Set<PendingAttachmentIngest>>(new Set())
  /** Handles named by a submission the Host may still be resolving. */
  const inFlightAttachmentUrisRef = useRef<Set<string>>(new Set())
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
  const admissionWaitsRef = useRef(new Set<() => void>())

  useEffect(() => {
    const waits = admissionWaitsRef.current
    return () => {
      for (const cancel of waits) cancel()
    }
  }, [])

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
  const attachedOpenFileIds = useMemo(
    // Domain editor context refs are data handles, not React refs.
    // eslint-disable-next-line react-hooks/refs
    () => [...Object.values(openFileAttachmentIds), ...contextOpenFileIds(deps.editorContext)],
    [deps.editorContext, openFileAttachmentIds],
  )
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
    const current = attachmentsRef.current
    if (!current.some((item) => item.uri === attachment.uri)) {
      const next = [...current, attachment]
      attachmentsRef.current = next
      setAttachments(next)
    }
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
    const next = attachmentsRef.current.filter((attachment) => !removed.has(attachment.uri))
    attachmentsRef.current = next
    setAttachments(next)
    setAttachmentPreviews((current) =>
      Object.fromEntries(Object.entries(current).filter(([uri]) => !removed.has(uri))),
    )
    setAttachmentPreviewFailures((current) => current.filter((uri) => !removed.has(uri)))
    setOpenFileAttachmentIds((current) =>
      Object.fromEntries(Object.entries(current).filter(([uri]) => !removed.has(uri))),
    )
    const releasable = uris.filter((uri) => !inFlightAttachmentUrisRef.current.has(uri))
    if (release && releasable.length > 0)
      void store
        .releaseAttachments(releasable)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : t('app.error.releaseAttachment')),
        )
  }
  const discardAttachmentDrafts = useStableCallback((): void => {
    attachmentGenerationRef.current += 1
    const inFlight = inFlightAttachmentUrisRef.current
    const uris = attachmentsRef.current.map((attachment) => attachment.uri)
    // A submission in flight may already have handed these handles to the
    // Host; releasing them now would make the Host reject the prompt. Remove
    // them from the composer but keep the handles alive until it settles.
    removeAttachmentDrafts(
      uris.filter((uri) => !inFlight.has(uri)),
      true,
    )
    removeAttachmentDrafts(
      uris.filter((uri) => inFlight.has(uri)),
      false,
    )
    setOpenFilePickerOpen(false)
  })
  const ingestFiles = (files: readonly File[]): void => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (imageLimits !== undefined && imageFiles.length > 0) {
      const existingImages = attachmentsRef.current.filter((attachment) =>
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
      const ingest = readFileAsBase64(file, t, imageLimits)
        .then((payload) => store.ingestAttachment(payload))
        .then((attachment) => {
          if (attachment === undefined) return true
          appendAttachment(attachment, undefined, generation, origin)
          // Only a draft actually tracked by appendAttachment contributes bytes:
          // duplicates resolve to the earlier uri and released handles never do.
          if (
            isImage &&
            attachmentDraftKeysRef.current.has(attachment.uri) &&
            !imageBytesByUriRef.current.has(attachment.uri)
          )
            imageBytesByUriRef.current.set(attachment.uri, file.size)
          return true
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : t('app.error.attachPasted'))
          return false
        })
        .finally(() => {
          if (isImage) {
            pendingImageStatsRef.current.count -= 1
            pendingImageStatsRef.current.bytes -= file.size
          }
        })
      const pending: PendingAttachmentIngest = { generation, promise: ingest }
      pendingIngestsRef.current.add(pending)
      void ingest.then(() => pendingIngestsRef.current.delete(pending))
    }
  }
  const deliverPrompt = (
    mode: 'queue' | 'steer',
    signal: AbortSignal | undefined,
    text: string,
    submissionOwner: string | undefined,
    expectedSessionId: string | undefined,
    attachmentSnapshot: readonly PromptAttachment[],
  ): Promise<void> => {
    const before = store.getState()
    const beforeIds = new Set(before.timeline.nodes.map((node) => node.id))
    const beforeRequests = new Set(before.directPromptRequestIds)
    // A content fallback must not claim a row that was already queued before
    // this submission: rc.6 rows carry no request identity.
    const queueBeforeIds = new Set(expectedSessionId === undefined ? [] : before.queue.map((item) => item.id))
    const admissionReads = new WeakMap<object, Promise<boolean>>()
    const confirmClippedAdmission = (sessionId: string, observed: () => void): boolean => {
      const current = store.getState()
      if (current.activeSessionId !== sessionId || current.backend.kind !== 'connected') return false
      const omitted = new Set(current.transcript?.omittedNodeIds)
      let pending = false
      for (const node of current.timeline.nodes) {
        if (
          node.kind !== 'user-message' ||
          beforeIds.has(node.id) ||
          !omitted.has(node.id) ||
          node.markdown.length >= text.length ||
          !text.startsWith(node.markdown)
        )
          continue
        pending = true
        let read = admissionReads.get(node)
        if (read === undefined) {
          read = Promise.resolve()
            .then(() =>
              store.getState().activeSessionId === sessionId &&
              store.getState().connectionEpoch === before.connectionEpoch
                ? store.loadTranscriptContent(node.id)
                : undefined,
            )
            .then(
              (full) => full === text,
              () => {
                // A failed read is not evidence that the accepted message
                // differs. Allow the admission wait to retry this same node.
                admissionReads.delete(node)
                return false
              },
            )
          admissionReads.set(node, read)
        }
        void read.then((matches) => {
          const latest = store.getState()
          if (
            matches &&
            latest.connectionEpoch === before.connectionEpoch &&
            latest.activeSessionId === sessionId &&
            latest.backend.kind === 'connected' &&
            latest.timeline.nodes.some((candidate) => candidate.id === node.id)
          )
            observed()
        })
      }
      return pending
    }
    const snapshotUris = attachmentSnapshot.map((attachment) => attachment.uri)
    for (const uri of snapshotUris) inFlightAttachmentUrisRef.current.add(uri)
    let delivered = false
    let uncertain = false
    let awaitingVisibility = false
    let admissionStarted = false
    let deliveredSessionId: string | undefined
    let submission: Promise<void>
    try {
      submission =
        expectedSessionId === undefined
          ? store.sendPendingPrompt(text, attachmentSnapshot, mode, signal)
          : store.sendPrompt(expectedSessionId, text, attachmentSnapshot, mode, signal)
    } catch (reason) {
      submission = Promise.reject(reason instanceof Error ? reason : new Error(t('app.error.prompt')))
    }
    return submission
      .then(() => {
        delivered = true
        if (!mountedRef.current || Boolean(signal?.aborted)) return
        const admitted = store.getState()
        deliveredSessionId = admitted.activeSessionId
        const directRequests = admitted.directPromptRequestIds?.filter((id) => !beforeRequests.has(id)) ?? []
        try {
          if (
            directRequests.length > 0 &&
            !signal?.aborted &&
            admitted.activeSessionId !== undefined &&
            (expectedSessionId === undefined || admitted.activeSessionId === expectedSessionId)
          ) {
            awaitingVisibility = true
            admissionStarted = true
            // Reconcile the temporary Inbox projection in the background.
            // The accepted RPC releases the composer immediately; waiting for
            // the transcript here would add an entire return trip to Send.
            const sessionId = admitted.activeSessionId
            void new Promise<void>((resolve, reject) => {
              let unsubscribe = (): void => undefined
              let settled = false
              let retryRead: ReturnType<typeof setTimeout> | undefined
              const finish = (error?: Error): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                if (retryRead !== undefined) clearTimeout(retryRead)
                unsubscribe()
                admissionWaitsRef.current.delete(cancelled)
                signal?.removeEventListener('abort', cancelled)
                if (error === undefined) resolve()
                else reject(error)
              }
              const cancelled = (): void => finish(new DOMException('Cancelled', 'AbortError'))
              const check = (): void => {
                const current = store.getState()
                if (current.activeSessionId !== sessionId || current.backend.kind !== 'connected') {
                  cancelled()
                  return
                }
                if (
                  current.timeline.nodes.some(
                    (node) =>
                      node.kind === 'user-message' &&
                      ((node.rpcId !== undefined && directRequests.includes(node.rpcId)) ||
                        (!beforeIds.has(node.id) && node.markdown === text)),
                  )
                )
                  finish()
                else if (
                  confirmClippedAdmission(sessionId, () => {
                    if (!settled) finish()
                  }) &&
                  retryRead === undefined
                )
                  retryRead = setTimeout(() => {
                    retryRead = undefined
                    check()
                  }, 500)
              }
              const timer = setTimeout(() => {
                // A false direct classification used to surface as a hard
                // failure while the prompt sat in DSH's queue. Read the queue
                // before reporting a timeout.
                void store.refreshQueue(sessionId).then(
                  (queue) => {
                    if (
                      queue?.some(
                        (item) =>
                          (item.rpcId !== undefined && directRequests.includes(item.rpcId)) ||
                          (!queueBeforeIds.has(item.id) &&
                            matchesQueuedPrompt(item, text, mode, attachmentSnapshot)),
                      )
                    )
                      finish()
                    else finish(new Error(t('app.error.promptTimeout')))
                  },
                  () => finish(new Error(t('app.error.promptTimeout'))),
                )
              }, 30_000)
              unsubscribe = store.subscribe(check)
              admissionWaitsRef.current.add(cancelled)
              signal?.addEventListener('abort', cancelled, { once: true })
              if (signal?.aborted) cancelled()
              else check()
            })
              .finally(() => store.forgetDirectPromptRequests(directRequests))
              .catch(() => undefined)
          }
        } finally {
          // An explicit abort still needs these identities in the late-admission
          // watcher below, including when the RPC already returned acceptance.
          if (directRequests.length > 0 && signal?.aborted !== true && !awaitingVisibility)
            store.forgetDirectPromptRequests(directRequests)
        }
        if (!mountedRef.current || Boolean(signal?.aborted)) return
        // The submitted text belongs to the conversation it was typed in. A
        // switch while the RPC settled must not leave it in the new composer.
        deps.clearDraftIf(submissionOwner, text)
        // The Extension Host consumes only the handles admitted by this send;
        // keep any draft attachments the user added while it was in flight.
        removeAttachmentDrafts(
          attachmentSnapshot.map((attachment) => attachment.uri),
          false,
        )
        setOpenFilePickerOpen(false)
      })
      .catch((reason: unknown) => {
        // A local timeout or retryable transport error can arrive before the
        // Host finishes resolving the handles. It is not a definite refusal.
        uncertain =
          typeof reason === 'object' && reason !== null && 'retryable' in reason && reason.retryable === true
        const aborted =
          Boolean(signal?.aborted) || (reason instanceof DOMException && reason.name === 'AbortError')
        if (aborted) {
          // The request may already have reached the Host; its handles must
          // stay resolvable until the late-acceptance check settles.
          uncertain = true
          if (!signal?.aborted && admissionStarted) {
            // The RPC was accepted and the session left the panel (or the
            // backend) while we waited for its durable row. Clear the text
            // from the conversation that owned it instead of watching a
            // different session.
            deps.clearDraftIf(submissionOwner, text)
            removeAttachmentDrafts(
              attachmentSnapshot.map((attachment) => attachment.uri),
              false,
            )
            return
          }
          // Cancelling only stopped the local wait; the Host may already have
          // admitted the turn. Watch briefly for the durable row so a late
          // acceptance does not leave the sent text looking unsent.
          const directRequests = (store.getState().directPromptRequestIds ?? []).filter(
            (id) => !beforeRequests.has(id),
          )
          if (directRequests.length === 0) return
          const sessionId = deliveredSessionId ?? store.getState().activeSessionId
          if (sessionId === undefined) {
            store.forgetDirectPromptRequests(directRequests)
            return
          }
          let settled = false
          let unsubscribe = (): void => undefined
          let retryRead: ReturnType<typeof setTimeout> | undefined
          const finish = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (retryRead !== undefined) clearTimeout(retryRead)
            unsubscribe()
            admissionWaitsRef.current.delete(cancel)
            store.forgetDirectPromptRequests(directRequests)
          }
          const cancel = (): void => finish()
          const observed = (): void => {
            if (settled) return
            if (mountedRef.current) {
              deps.clearDraftIf(submissionOwner, text)
              removeAttachmentDrafts(
                attachmentSnapshot.map((attachment) => attachment.uri),
                false,
              )
              setOpenFilePickerOpen(false)
            }
            finish()
          }
          const check = (): void => {
            const current = store.getState()
            if (current.activeSessionId !== sessionId) return
            if (
              !current.timeline.nodes.some(
                (node) =>
                  node.kind === 'user-message' &&
                  ((node.rpcId !== undefined && directRequests.includes(node.rpcId)) ||
                    (!beforeIds.has(node.id) && node.markdown === text)),
              )
            ) {
              if (confirmClippedAdmission(sessionId, observed) && retryRead === undefined)
                retryRead = setTimeout(() => {
                  retryRead = undefined
                  check()
                }, 500)
              return
            }
            observed()
          }
          const timer = setTimeout(finish, 5_000)
          unsubscribe = store.subscribe(check)
          admissionWaitsRef.current.add(cancel)
          check()
          return
        }
        if (mountedRef.current)
          setError(
            awaitingVisibility
              ? t('app.error.promptTimeout')
              : (publicProtocolErrorMessage(reason) ?? t('app.error.prompt')),
          )
      })
      .finally(() => {
        for (const uri of snapshotUris) inFlightAttachmentUrisRef.current.delete(uri)
        if (delivered || uncertain) return
        // The send definitively failed. If a conversation switch already took
        // the chips away, their handles have no future consumer.
        const displayed = new Set(attachmentsRef.current.map((attachment) => attachment.uri))
        const detached = snapshotUris.filter((uri) => !displayed.has(uri))
        if (detached.length > 0) void store.releaseAttachments(detached).catch(() => undefined)
      })
  }

  const submitPrompt = (mode: 'queue' | 'steer', signal?: AbortSignal): Promise<void> => {
    if (active === undefined && !hasPendingSession) return Promise.resolve()
    // Navigation can resolve between the keystroke and this handler. The
    // composer still reads as the old conversation for one render, but the
    // store already moved; sending here would target a panel the user left.
    const expectedSessionId = active?.id
    const expectedPendingRevision =
      active === undefined ? store.getState().pendingSession?.revision : undefined
    const targetIsCurrent = (): boolean =>
      active === undefined
        ? store.getState().pendingSession?.revision === expectedPendingRevision
        : store.getState().activeSessionId === expectedSessionId
    if (!targetIsCurrent()) return Promise.resolve()
    const text = deps.readDraft()
    const submissionOwner = deps.draftOwner
    const generation = attachmentGenerationRef.current
    const pending = [...pendingIngestsRef.current]
      .filter((entry) => entry.generation === generation)
      .map((entry) => entry.promise)
    // Keep the ordinary path synchronous: admission and optimistic rendering
    // must not wait on an extra microtask when no file is being read.
    if (pending.length === 0) {
      if (signal?.aborted || !targetIsCurrent()) return Promise.resolve()
      return deliverPrompt(mode, signal, text, submissionOwner, expectedSessionId, attachmentsRef.current)
    }
    return Promise.all(pending).then((results) => {
      // A failed read already surfaced its error; keep the draft so the user
      // can retry instead of sending text without the attachment they picked.
      if (!results.every(Boolean) || signal?.aborted) return
      // Reading and navigation can both settle during the wait; only send the
      // conversation's own handles to the conversation still on screen.
      if (!targetIsCurrent() || generation !== attachmentGenerationRef.current) return
      return deliverPrompt(mode, signal, text, submissionOwner, expectedSessionId, attachmentsRef.current)
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
      attachedOpenFileIds.includes(candidateId)
    )
      return
    attachingOpenFileRef.current = candidateId
    setAttachingOpenFileId(candidateId)
    const generation = attachmentGenerationRef.current
    void store
      .attachOpenFile(candidateId, () => generation === attachmentGenerationRef.current)
      .then((attachment) => {
        if (attachment === undefined) {
          if (generation === attachmentGenerationRef.current) setError(t('app.error.openFileGone'))
          return
        }
        if (generation !== attachmentGenerationRef.current) {
          if (!('kind' in attachment)) void store.releaseAttachments([attachment.uri]).catch(() => undefined)
          return
        }
        store.rememberOpenFile(candidateId)
        if (!('kind' in attachment))
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
  const composerOnSubmit = useStableCallback((mode: 'queue' | 'steer', signal?: AbortSignal): Promise<void> =>
    submitPrompt(mode, signal),
  )

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
