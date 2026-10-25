# Architecture

[English](architecture.en.md) | [简体中文](architecture.md)

This is the canonical English architecture document for the **DeepSeek Harness Client** VS Code extension. It describes how the system is structured, how its parts communicate, and why. The DSH version, wire types and RPC/event shapes are specified separately in the [upstream contract](dsh-contract.en.md); capability completion status lives in the [capability matrix](capability-matrix.en.md). Detailed lifecycle limits are in the [Chinese specification](architecture.md); validation steps are in the [testing guide](quality.md).

## Goals

The architecture is shaped by five goals:

1. **Keep the Webview untrusted and disposable.** Authoritative state, secrets and every privileged operation live only in the Extension Host; the Webview keeps bounded display state and can be rebuilt or reconnected from Host state.
2. **Isolate upstream change.** Differences between DSH versions are absorbed inside the versioned adapter, so Domain, Application and the Webview never depend on upstream types.
3. **Never take over a user's process.** Discovery precedes any start, and only a process this extension spawned — and still holds the handle for — may be stopped.
4. **Bound resident resources.** Every long-lived surface, stream and reply is bounded, so reconnection and rebuild have explicit resource limits.
5. **One structured channel.** All session, tool, approval and Agent state flows over DSH's Web Host API; the client never parses TUI/ANSI or model text.

## System context

```text
                 ┌──────────────────────────────────────┐
  Developer ───▶ │  VS Code                             │
  (user)         │  ┌─────────────────────────────────┐ │
                 │  │  DeepSeek Harness Client        │ │
                 │  │   · Extension Host              │ │
                 │  │   · Webview                     │ │
                 │  └────────────────┬────────────────┘ │
                 └───────────────────┼──────────────────┘
                                     │ Web Host API — structured RPC/Events (HTTP/WebSocket)
                                     ▼
                 ┌──────────────────────────────────────┐
                 │  DeepSeek Harness (DSH)              │
                 │  local or remote process             │
                 │  ┌─────────────────────────────────┐ │
                 │  │  editor companion (optional)    │ │
                 │  └─────────────────────────────────┘ │
                 └──────────────────────────────────────┘
```

The extension is a client for a DeepSeek Harness (DSH) agent. DSH is a separate process — one already running (locally or remotely), or one the extension starts and manages. All session, tool, approval and Agent state flows over DSH's **Web Host API**, a structured RPC/Event channel — never the TUI/ANSI terminal and never model text.

The Web Host API uses **HTTP for unary request/response RPC** and a **WebSocket mux for streaming events and tokens** (frames such as `open`/`cancel`/`item`/`error`/`end`). Authentication and the handshake belong to the DSH Web Host API itself and run against the validated origin; the exact wire shapes are in the [upstream contract](dsh-contract.en.md).

Optionally the user enables the **editor companion**, a DSH-side plugin bundle that lets the Agent read and edit the workspace. It runs inside DSH and talks back to the Host over DSH's existing authenticated Remote connection, so it adds no new listening port.

## Containers

| Container                                          | Runs in                                                                     | Owns                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Extension Host**                                 | VS Code extension host process                                              | The VS Code API, process lifecycle, file access, network, credentials (SecretStorage) and message routing. It is the trust boundary. |
| **Webview** (React)                                | VS Code webview iframe — a sidebar view plus one panel per editor-area chat | Presentation only. Untrusted: no direct DSH, network or file access.                                                                 |
| **DSH**                                            | A separate local or remote process                                          | Sessions, tools, approvals and Agent state, exposed via the Web Host API.                                                            |
| **Editor companion** (`@dsh-vscode/editor-bridge`) | Inside DSH (a Cordis bundle)                                                | The DSH-side half of editor integration: `vscode_*` tools and a typed remote for the Agent.                                          |

The Host and Webview are two processes of one extension; DSH is a third process; the companion is not a process but a bundle loaded into DSH.

## Components and interfaces

The code is a small set of packages with a strict dependency direction.

```text
apps/extension  -> application + dsh-adapter + webview-protocol + domain + timeline
application     -> domain
dsh-adapter     -> application ports + domain + pinned upstream contract
editor-bridge   -> domain + DSH runtime peers (cordis / tools / typert)
apps/webview    -> domain + timeline + ui + webview-protocol
webview-protocol -> domain + timeline
timeline        -> domain
ui              -> domain + React
domain          -> nothing platform-specific
```

| Layer                | Responsibility                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------- |
| **Domain**           | Stable types, errors, repository ports and pure rules. No platform dependency.           |
| **Application**      | Use cases and connection coordination; exposes ports.                                    |
| **DSH Adapter**      | Versioned detection, RPC/Event mapping, error normalisation and stream recovery.         |
| **Timeline**         | Pure, platform-free reduction of the conversation stream into immutable node snapshots.  |
| **Webview Protocol** | Strict typed schemas and safe DTOs for Host↔Webview messages.                            |
| **UI**               | React components and rendering only.                                                     |
| **Extension Host**   | Composition: VS Code API, process/file/network/credential ownership and message routing. |
| **Editor companion** | DSH-side bundle exposing editor tools and a typed remote to the Agent.                   |

`timeline` depends only on `domain` — it has no React, no VS Code and no platform API. Its output is `TimelineNode`, an immutable snapshot of one conversation node. That snapshot **is the wire payload**: the protocol's transcript window and patch DTOs carry `TimelineNode[]`, and the Host's `TranscriptWindowService` uses the same reduction to build and serve authoritative windows. This is why `webview-protocol` and `apps/extension` both reference `timeline` — it is a shared data-reduction layer whose node type crosses the boundary, **not** React/UI presentation. Presentation is confined to `ui`, which the protocol and the Host never reference.

The named interfaces:

| Interface            | Where                                                                | Direction                  | Carries                                                                                          |
| -------------------- | -------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| Application ports    | `packages/application/src/ports/` (`feature-ports`, `billing-ports`) | Adapter/Host → Application | Use-case boundaries (session, tool, approval, billing)                                           |
| Adapter entry points | `packages/dsh-adapter/src/versions/<version>/adapter.ts`             | Adapter                    | Per-DSH-version RPC/Event mapping                                                                |
| Host ↔ DSH           | `packages/dsh-adapter` (probe, RPC, events)                          | Host ↔ DSH                 | Sessions, tools, approvals, Agent state                                                          |
| Host ↔ Webview       | `packages/webview-protocol/src/schemas.ts`                           | Host ↔ Webview             | Typed request/response/event DTOs (a discriminated union, never `{ action, payload }`)           |
| Host ↔ companion     | `packages/dsh-editor-bridge` + `apps/extension/src/editor`           | Host ↔ companion           | Text, diagnostics, language services, navigation, edits (protocol 2, with a protocol 1 fallback) |

On the Host side the Webview interface is the message router (`WebviewMessageRouter`, wired by `createRequestGateway`); on the Webview side it is `ProtocolClient`. History windows are served by `TranscriptWindowService`, which reads DSH's own projections rather than re-deriving them.

## Key flows

### Connection lifecycle

```text
   target mode
     ├─ custom       ─▶ validate the one configured endpoint ─▶ attach (external)
     ├─ attach-only  ─▶ discover, never start ─▶ attach (external) or fail
     ├─ new-isolated ─▶ start a fresh instance (managed)
     └─ auto         ─▶ discover (bounded, loopback-only) ─▶ attach (external)
                        │ none found
                        └─▶ start a local instance (managed)
```

Discovery runs **before** any start. An explicit endpoint or attach-port list restricts the targets; otherwise `auto` validates the last-known local endpoint first, then completes bounded discovery before launch. Every candidate is validated by the adapter Probe (a real protocol handshake) before attach; a candidate is never trusted on sight. Discovery is loopback-only for automatic modes, never scans arbitrary port ranges, and a recorded PID is a lookup hint only — never evidence of identity or ownership. A default port must not override the last-known endpoint.

Two ownership classes decide what "disconnect" means:

| Ownership  | Meaning                                                     | On disconnect or deactivation                                              |
| ---------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `external` | An instance the extension did not start                     | Close the client and streams; never stop, restart or take over the process |
| `managed`  | An instance this extension started and holds the handle for | Stop gracefully, then terminate only that handle                           |

Ownership is the **explicit child handle** from spawn — never the PID. If the extension host is reloaded, the handle is gone, so a previously `managed` process is rediscovered through normal discovery and attached as `external`; the restarted host never adopts or kills a process it cannot prove it owns. This is also the orphan-safety rule: a severed `child_process` tree is simply never reclaimed by PID, so it cannot be mistaken for a user's process and stopped. Connections, subscriptions, sockets, timers and child processes are released on every path — success, failure, cancel, timeout and deactivation.

### Host ↔ Webview request/event flow

```text
  Webview                                        Host
     │  request (requestId, type)                  │
     │ ──────────────────────────────────────────▶ │  validate schema · route
     │  response (at most one terminal state)      │
     │ ◀────────────────────────────────────────── │
     │  event (sequence)                           │
     │ ◀────────────────────────────────────────── │  streamed, ordered, deduplicated
```

Every Webview request carries a unique `requestId` and receives at most one terminal response; long-lived events carry an increasing `sequence` so the client can ignore duplicates and stale deliveries. There is one authoritative backend stream per connection. The Host sends immediately when idle; under load, per-surface consumption acknowledgements advance bounded queues. Replaceable snapshots may coalesce while interactions retain order, without timer or paint-frame batching. Reconnection re-subscribes by server sequence, pages in the gap, deduplicates and commits through the reducer — never by re-sorting timestamps.

State reconciliation is bounded and replay-free:

- A transcript window is bounded in node count and character budget, derived from the `TRANSCRIPT_MAX_*` constants in `packages/webview-protocol/src/transcript.ts`. Explicit older-history loads can raise both ceilings within separate expanded-window limits, and the Webview keeps using a virtualised list. The live reply tail is bounded separately and rolls forward rather than freezing into history. Resident-window limits do not bound RPC decoding or native-editor peak memory.
- Host→Webview window sends are credit-bounded. When the credit or size budget is exhausted only the latest state is kept and coalesced after acknowledgement; no delta ledger is retained.
- Each surface — the sidebar and each editor-area chat panel — owns its own history window, navigation cursor, confirmations and visibility. Closing one frees only that window, and messages queued by a closed window can never be delivered to a same-id new window. A hidden Webview may pause expensive rendering but must never drop approvals, questions or connection state.

### Editor companion lifecycle

```text
  user enables in Settings
      └─▶ Host validates and installs the bundled companion .tgz
            via DSH's plugin-bundle manager (managed DSH + trusted workspace only)
                └─▶ negotiate protocol 2 (fallback: protocol 1)
                      └─▶ Agent calls vscode_* tools over the authenticated Remote
```

Sharing is scoped and explicit. Protocol 2 shares only the opened and trusted roots of the current window, gated by the persistent editor settings — not by per-edit prompts — and requires both a loopback target and a workspace-side random-file challenge to prove a shared filesystem. Requests are routed by the calling Agent's session and Remote peer; authorisation identity and communication parameters never reach the Webview. Edits are version-checked and written as one reversible edit group, auto-saving only buffers that were already saved and unchanged by the user; native Undo and an independent revert remain available.

### Error handling and resilience

Errors carry a stable **code**, a sanitised **message** and a **retryable** flag. Protocol negotiation is fail-closed: an unknown version runs a public handshake followed by a read-only compatibility probe, tries the next candidate on rejection/timeout/mismatch, and refuses to connect when nothing matches; a malformed version identity is rejected before any wire probe. Recovery is bounded and never re-sends non-idempotent work: stream re-subscription and poll recovery both retry on bounded backoff ladders, and transient transport failures back off before retrying — while writes, answers, uploads and installs are not silently replayed.

## Trust and security boundaries

The Host is the single trust boundary. The Webview is an untrusted rendering surface; the companion is a DSH-side bundle that reaches the workspace only through the Host.

| Boundary         | May cross                                              | Never crosses                                                                              |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| DSH ↔ Host       | Structured RPC/Events                                  | —                                                                                          |
| Host ↔ Webview   | Typed DTOs and redacted summaries                      | Endpoint, PID, command line, secrets, absolute paths, raw diagnostics, upstream wire types |
| Host ↔ companion | Editor capabilities, source text and diagnostic bodies | Provider credentials, connection secrets, data outside trusted roots                       |

- Secrets are handled only by the Host (VS Code password input or SecretStorage); the Webview sees only configured/missing.
- Discovery is loopback-only; a remote target requires an explicit, user-authorised `custom` endpoint with certificate verification, DNS pinning and no redirects. Remote HTTP requires an explicit plaintext confirmation.
- Workspace access (attachments, exports, file open) goes through VS Code APIs and user actions, with the Host validating trust and paths.
- The Webview **Content Security Policy** is nonce-based: no remote scripts, no `unsafe-eval`, no inline event handlers, no arbitrary frames and no WebAssembly. Model Markdown strips raw HTML, and links accept only safe schemes and are opened by the Host.
- Companion-initiated edits, reads and navigation are constrained to the trusted workspace roots; the Host validates URI trust, path traversal, symlinks, document versions and edit scope. A bounded number of session bindings is admitted, each with bounded in-flight work.

## Design rationale

Each decision below is the means by which the goals above are achieved.

- **Web Host API as the only channel** _(goal 5)_ — session, tool and approval state must be machine-readable; TUI/ANSI and model text are not contracts, so the client never parses them.
- **Discovery before start** _(goal 3)_ — preserves the user's existing process; only an instance this extension started may be stopped, and only by the handle it holds.
- **Versioned adapter** _(goal 2)_ — upstream changes are absorbed inside version boundaries so Domain, Application and Webview never depend on upstream types.
- **Editor companion as a DSH bundle, not a separate process** _(goal 5)_ — the Agent's tools must live inside DSH's runtime; a bundle rides DSH's existing authenticated Remote connection and adds no port.
- **Timeline as a shared pure reduction, not presentation** _(goal 1)_ — the timeline reduces the stream into immutable node snapshots that are themselves the transcript-window wire DTOs, so the protocol and the Host legitimately share one data model while React/UI stays on the Webview side.
- **Disposable, bounded Webview** _(goals 1, 4)_ — the Webview is untrusted and disposable; authoritative state and secrets live in the Host, and resident budgets plus view credits keep any surface bounded, so the Webview can be rebuilt or reconnected without loss.
- **Secrets in the Host** _(goal 1)_ — the Webview never handles provider secrets, so no secret can leak through rendering or diagnostics.
