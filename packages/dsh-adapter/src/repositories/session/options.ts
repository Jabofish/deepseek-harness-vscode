import type { CommandAttachmentWire } from '../command-repository.js'

export interface Rc6SessionRepositoryOptions {
  readonly supportsFileUploads?: boolean
  readonly supportsSessionRestore?: boolean
  readonly readPermissionPresets?: ((signal?: AbortSignal) => Promise<readonly string[]>) | undefined
  /** rc.2 accepts an idempotency/preallocated sessionId without rc.1's reuse flag. */
  readonly preallocatedSessionId?: boolean
  readonly reuseWorkspaceBlank?: boolean
  /** rc.2 raises the DSH image envelope to 20 MiB per image / 200 MiB per message. */
  readonly maxPromptAttachmentBytes?: number
  readonly maxPromptAttachmentTotalBytes?: number
  /** The commands/execute attachment parameter audited for this host version. */
  readonly commandAttachmentWire?: CommandAttachmentWire
  /** rc.1 predates the browser-local time-zone field on prompt requests. */
  readonly includeClientTimeZone?: boolean
  /** Legacy rc.1/rc.2 execute session configuration through command.*. */
  readonly executeSessionConfigCommand?: (
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ) => Promise<void>
  /** Exact version adapters may select a Session preset through their Remote contract. */
  readonly selectAgentPreset?: (sessionId: string, presetId: string, signal?: AbortSignal) => Promise<void>
  /** Version adapters may attach a logical per-session event stream lazily. */
  readonly onSessionAccess?: (sessionId: string) => void
  /** Version adapters may re-baseline a process-local stream on session.open. */
  readonly onSessionOpen?: (sessionId: string) => void | Promise<void>
  /** Alpha's list projection derives a display title from cwd when no title exists. */
  readonly deriveTitleFromCwd?: boolean
  /**
   * Where a Session's queue baseline comes from.
   *
   * `subscription` (rc.6-family mux): the session stream re-baselines the queue
   * on every subscription, so a subscription seeds the empty queue and a read
   * that arrives first is a timing state to wait out.
   *
   * `control` (alpha/rc line): the host-wide control stream owns the queue. Its
   * baseline lists every Session the host knows, and the host broadcasts a queue
   * frame only when a Session's pending input changes — a Session created after
   * the baseline commits none until its first enqueue. The reference client
   * replaces a Session's queue from that baseline with `?? []`, so an entry that
   * is absent from both is the empty queue, never an unreadable one. A
   * subscription must also not wipe that state.
   *
   * `control-follow` (alpha171+): the host-wide baseline remains useful for
   * existing sessions, but a fork child can inherit Inbox state without a
   * control event. For an unknown queue, open its durable follow stream and
   * wait for the adapter to publish the queue derived from its opening
   * projection; a missing Inbox value is an authoritative empty queue.
   */
  readonly queueBaseline?: 'subscription' | 'control' | 'control-follow'
}
