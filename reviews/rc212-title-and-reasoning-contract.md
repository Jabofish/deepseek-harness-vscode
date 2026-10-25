# rc212 (0.2.1-rc.2) title / reasoning-event contract audit

Pinned source: `deepseek-ai/deepseek-harness` @ `687f282e8625c6b8d11ff58211a90524be2e4317`
(`rc212` per `docs/dsh-contract.md`). Objective: ground the UI-jitter root-cause
analysis (title oscillation + `reasoning.delta` flood) in the real wire, not
inference. Scope: the `session/title` flow and the `reasoning.delta` stream; the
`session/activity → unknown` mapper gap is an extension-side item and is only
noted here for completeness.

## 1. `session/title` wire shape (verified)

`packages/session/session-title/src/types.ts`:

- `SessionTitleEventData { title, messageSeqs, source }`.
- `SessionTitleSource = fallback | provider | user`. The `user` kind documents
  that "explicit user rename pins the title — automatic generation stops
  scheduling".
- `TitleProjection = SessionTitleSnapshot` carries `eventSeq` (the event's
  durable seq) and `updatedAt`.

`packages/session/session-log-deepseek/src/types.ts`:

- `DeepSeekSessionLogWireEvent` is `{ seq: number, time: number, type, data }`.
  Every log event, including `session/title`, carries a durable `seq`.

`packages/session/session-title/src/index.ts` (the `SessionTitleService`):

- `'session/title'` is declared "Latest-wins session title snapshot. Log-only".
- Projection `apply`: `event.type === 'session/title' ? event.data.title : state`
  — i.e. **last event wins**; the projection folds the newest `session/title`.
- `rename()` (user) appends `session/title` with `source: {kind:'user'}` and
  supersedes automatic generation.
- `onUserMessage()` schedules automatic generation:
  `provider.automatic === 'all-prompts' || (parentSession === undefined && count === 1 && get(session) === undefined)`.
- `ensureFallback()` appends a **deterministic fallback** `session/title`
  (`fallbackSessionTitle(first.text, …)`, source `fallback`) when the session
  has no title yet.
- `runProvider()` calls `ensureFallback()` **then** the provider, appending a
  second `session/title` (source `provider`, LLM text).

`packages/session/session-title-first-prompt-llm/src/index.ts`:

- The shipped provider is `automatic: 'first-prompt'` — it runs **once** on the
  first eligible human message. There is no repeated LLM re-titling.

### Conclusion A — the "title oscillation" is NOT DSH re-titling

DSH appends **two** durable `session/title` events per session: a deterministic
fallback (first-message prefix) then the LLM provider title. Both survive in the
log, both carry a `seq`, and DSH's own fold is latest-wins by `seq`. The
oscillation the client sees is the client re-applying **both** events on every
log re-read (re-subscription), because it does not apply latest-wins.

## 2. The extension drops latest-wins, not the sequence

`packages/dsh-adapter/src/stream-envelopes.ts`:

- `normalizeEnvelope` → `case 'session/event'` maps the nested event and attaches
  the durable seq via `withSequence(mapStreamEvent(...), event.seq)` (L30–52).
- `withSequence` (L210–214) sets `{ ...event, sequence: value }`.
- `packages/domain/src/events.ts` L496: `BackendEvent = BackendEventPayload & { sequence?: number }` —
  the sequence rides on **every** backend event, including `session.title`.

`apps/extension/src/composition/session-navigation.ts` `syncSessionTitles()`:

- Applies each `session.title` / title projection as a live change, deduping only
  on **same value** (`titleState`), and never reads `sequence`.
- `acceptEvent()` calls `invalidate()` (full directory re-read + tree refresh)
  whenever a title value differs.

### Conclusion B — extension bug, not upstream

The adapter preserves `sequence`; the title handler ignores it. Applying
latest-wins by `sequence` (skip a title whose seq ≤ the last applied seq) makes
the fallback→provider pair settle on the provider title instead of oscillating,
and removes the per-flip directory refresh. This is a jabofish-side fix.

## 3. `reasoning.delta` flood (the genuine upstream item)

The assistant stream (`session/assistant-stream` → `reasoning-delta` chunks,
`stream-envelopes.ts` L124–167) is emitted per token with no client flow control.
Empirically ~2,000 events/sec for a _hidden_ session (issue #2 trace). This is
the input that triggers the adapter's transient-gap `restart()` and hence the
re-subscription loop that re-reads the log and re-applies the title pair.

- Adapter-side mitigation: throttle/backoff the transient-gap `restart()`
  (`stream-controller.ts`).
- Upstream question (`deepseek-ai/deepseek-harness`): can `reasoning-delta`
  emission coalesce or provide backpressure — especially for sessions the client
  is not displaying?

## 4. Verified upstream-vs-extension split

| Item                                                                               | Owner                            |
| ---------------------------------------------------------------------------------- | -------------------------------- |
| `reasoning.delta` ~2,000/s, no flow control (root enabler)                         | **deepseek-ai/deepseek-harness** |
| Title handler ignores `sequence` (no latest-wins) → oscillation + directory churn  | jabofish (extension)             |
| Transient-gap `restart()` no throttle/backoff → re-subscription loop               | jabofish (extension)             |
| `session/activity` / `host/session-activity` → `unknown` (unparseable `updatedAt`) | jabofish (extension)             |

No `session/title-llm-request` oscillation loop exists: that event is a
"log-only pre-dispatch record" of the **one** first-prompt LLM title call.
