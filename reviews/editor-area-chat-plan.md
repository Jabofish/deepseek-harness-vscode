# Move the DSH chat into the editor area — research + phased implementation plan

> Local planning artifact (untracked). Per `AGENTS.md` it must not be committed and is not part of the
> canonical spec set (`docs/`). Delete it once the work ships.

Status: plan for review. Target: VS Code `^1.125.0` (repo `apps/extension/package.json`), extension `0.3.1`,
branch `feat/external-dsh-connection`.

## Implementation status

| Phase | State                                           | Notes                                                                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | code complete, awaiting real-VS Code acceptance | Host surfaces, routing, commands, serializer, handoff, webview surface state + placeholder, tests, docs row `VS-02`. One tab per session was already required by the handoff, so picking a session in the handed-off side bar opens a new tab instead of switching the hidden chat |
| 2     | code complete, awaiting real-VS Code acceptance | `/moveto:editor` / `/moveto:sidebar` client command, colon short form normalized, defensive store interception so no line reaches DSH                                                                                                                                              |
| 3     | not started                                     | the drawer drag needs the spike below; tab titles come from the catalogue at open time (rename sync pending)                                                                                                                                                                       |
| 4     | known follow-up                                 | sidebar view re-resolve still runs the shared teardown (pre-existing behaviour); question-wait isolation across surfaces (`questionWaitKey` is session/call only)                                                                                                                  |
| 5     | partial                                         | matrix row + architecture decision + CHANGELOG done; README, the `dsh.view.openLocation` setting and the a11y pass pending                                                                                                                                                         |

Verified locally for Phase 1: `vitest run` (375 files, 3809 passed), `tsc -b` and `tests/tsconfig.json`,
`eslint .`, `prettier --check .`, `node scripts/check-docs.mjs`, `node scripts/i18n.mjs check`,
extension `esbuild` build and webview `vite build`.

---

### Running the gates in this container

`pnpm` cannot self-install its pinned version here: `/tmp` is mounted `noexec`, so the pnpm 11.19.0 tool
binary pnpm caches under `/tmp/.local/share/pnpm/.tools/` can never be executed (`EACCES`). Two local,
gitignored workarounds make the literal gates runnable (`node_modules/` is ignored, so nothing enters the
repository):

1. `node_modules/.bin/pnpm` is a shim that execs the pinned pnpm through node
   (`exec node /tmp/.local/share/pnpm/.tools/pnpm/11.19.0/node_modules/pnpm/bin/pnpm.cjs "$@"`).
2. pnpm's dependency-freshness check wants to reinstall `node_modules` before running a script (the store was
   built by a different pnpm) and aborts without a TTY. Passing `--config.verify-deps-before-run=false`
   disables exactly that check, and it propagates to the nested `--filter` calls.

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
pnpm --config.verify-deps-before-run=false check   # format, docs, i18n, lint, typecheck, tests
pnpm --config.verify-deps-before-run=false build   # webview bundle into media/, extension bundle into dist/
```

### Evidence to capture during the acceptance run

`docs/quality.md` requires a PR/release record with the exact conditions; capture these during the run so the
matrix row can move off `PARTIAL` without a second round:

| Item                                                                                                                                                | Why                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| VS Code version + commit, OS, and whether it is a Remote/WSL/container window                                                                       | `docs/capability-matrix.md` VS-01/VS-02 acceptance gaps name the minimum build and the environment |
| Extension build used (F5 development host vs installed VSIX)                                                                                        | separates development-host evidence from packaged behaviour                                        |
| Per step result for Phase 1 (1–7), Phase 2 (`/moveto:editor`, `/moveto:sidebar`, `/moveto:bogus`, `/moveto`), the row action and a drag-out attempt | each is an acceptance criterion; a "works" without the step list is not evidence                   |
| A screenshot or description of the handoff card and the editor tab (light and dark)                                                                 | the posture must not depend on colour alone                                                        |
| The `[dnd]` console lines from the drag probe, or an explicit "not run"                                                                             | decides whether the tear-off gesture ships or is removed                                           |
| 240px side bar, normal side bar and editor width with long content, plus reduced motion                                                             | `docs/ui.md` acceptance clause                                                                     |

### Audit findings fixed (self-review rounds)

- `/moveto:editor` is dispatched as the normalized line, so the composer's exact-string draft check left the short form in the input after it ran; the comparison now applies the same rewrite ([useComposerMenuState.ts](../apps/webview/src/features/composer/useComposerMenuState.ts)).
- `EditorChatSurfaceManager.adopt` could replace a live surface for the same session without disposing it, dropping the tab from routing; the replaced tab is now closed ([editor-chat-surface-manager.ts](../apps/extension/src/view/editor-chat-surface-manager.ts)).
- Contract coverage for the two new routes (accepted payloads plus rejected empty id, oversized title, client-chosen surface id and a payload on `moveToSidebar`) in [schemas.spec.ts](../packages/webview-protocol/src/schemas.spec.ts).
- The handoff card's description read as a label glued to a sentence ("Editor chat tabs: 2. This conversation…"); it now states the posture and the count as one sentence in both locales.

## 1. Research findings (what is and is not possible)

### 1.1 A contributed webview _view_ cannot be moved into the editor area

- Views live in view containers, and every `ViewContainerLocation` is `Sidebar | Panel | AuxiliaryBar`
  (microsoft/vscode `src/vs/workbench/common/views.ts`). There is **no editor-area destination**.
- `vscode.moveViews` is an internal action (`MoveViews`, `viewPaneContainer.ts`), takes
  `{ viewIds: string[]; destinationId: string }` where `destinationId` must resolve to a **view container**,
  and is not in `@types/vscode` at all. `workbench.action.moveView` / `moveFocusedView` likewise only offer
  side bar / secondary side bar / panel entries.
- The repo already uses the stable sibling of this: `dsh.openInSecondarySidebar` →
  `workbench.action.moveView` with a textual fallback (`apps/extension/src/vscode/secondary-sidebar.ts:3-19`).
  That stays as-is; it is the "move the _view_" feature, not this one.

**Consequence:** "move the chat into the editor area" must be implemented as a **second surface** — an editor
`WebviewPanel` that loads the same webview bundle (`apps/extension/media/webview.js`) and speaks the same
protocol. This is exactly what Anthropic's Claude Code extension ships
(`registerWebviewPanelSerializer('claudeVSCodePanel', …)` + `onWebviewPanel:` activation). Copilot Chat can
re-host one widget because the widget is workbench-native (`ChatEditorInput`); an extension cannot do that.

### 1.2 Drag from inside a webview onto the editor area is not bridged

- VS Code's webview host forwards a drag to the workbench only when _every_ `dataTransfer` item is a **file**,
  and it forwards only `shiftKey` — no payload (`webview/browser/pre/index.html`, "Only handle drags from
  outside editor for now"; `WebViewDragEvent = { shiftKey: boolean }`). The iframe also gets
  `pointer-events: none` during workbench drags.
- The editor drop target accepts only `Files`, `ResourceURLs`, `CodeEditors` or registered DnD contribution
  keys; anything else gets `dropEffect = 'none'` (`editorDropTarget.ts`). A `vscode-webview://` iframe is
  cross-origin from the workbench, so its payload is also unreadable by the drop target (Chromium protected
  mode — needs a spike to confirm on 1.125).
- `DocumentDropEditProvider` only fires when dropping **into the text of an open editor**, never on empty
  editor area or the tab bar. There is no public API for the tab bar.
- The **only** real "drag into the editor area" bridge is a native **TreeView**: `TreeDragAndDropController`
  with `dragMimeTypes` including `text/uri-list` makes the workbench accept the drop and
  `editorService.openEditors(..., ensureTargetGroup())` opens the URI **in the dropped editor group**. With
  `contributes.customEditors` + `registerCustomEditorProvider` for a `dsh-session:` virtual scheme, that drop
  could open our chat in that group. This requires the session list to become a native TreeView.

**Consequence:** the requested "drag a session from the Open Sessions dialog to the editor area" has no
supported path today. Three candidate mechanisms, in order of effort:

| #   | Mechanism                                                                                                                                                           | Confidence                                                       | Cost                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------- |
| A   | **Tear-off heuristic**: session rows draggable; on `dragend` with `dropEffect === 'none'` and the pointer outside the webview, open that session in the editor area | unverified — must be spiked on your machine                      | small                       |
| B   | **Explicit affordances**: row context menu "Open in editor area", keybinding, Command Palette, `/moveto:editor`                                                     | high                                                             | small                       |
| C   | **Native sessions TreeView + `text/uri-list` + custom editor** (true drop, drop column preserved)                                                                   | drop semantics verified in source; selector/lifecycle unverified | large (parallel UI surface) |

### 1.3 Single-surface assumptions in the Host (the real work)

The extension currently has exactly **one** webview surface and it is not just a UI detail:

| Coupling                                                                                 | Location                                                                                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| One provider, one `WebviewView`                                                          | `apps/extension/src/view/dsh-webview-view-provider.ts:17-19`                             |
| One outbound sink `post` → `provider.postMessage`                                        | `apps/extension/src/composition-root.ts:74-85`                                           |
| Router answers through that one sink; no surface id anywhere                             | `apps/extension/src/view/message-router.ts:24-34, 210`                                   |
| Global in-flight map + global `cancelAll()` + `questionWaits` keyed only by session/call | `message-router.ts:51-52, 70, 106-107, 150-157`                                          |
| Global event sequence, dropped (never retried) when the surface is not ready             | `apps/extension/src/composition/host-event-pipeline.ts:199-222`                          |
| Provider dispose cancels every request and clears editor context                         | `apps/extension/src/composition/request-handler.ts:588-592`                              |
| One editor-context owner identity                                                        | `apps/extension/src/editor/editor-context-provider.ts:23`, `composition-root.ts:158-162` |
| `deliverOrRevealView` focuses `${VIEW_ID}.focus` only                                    | `apps/extension/src/view/deliver-or-reveal.ts:30`                                        |
| Menus gated on `view == dsh.chatView`                                                    | `apps/extension/package.json` `contributes.menus`                                        |
| No surface identity in the protocol envelope                                             | `packages/webview-protocol/src/host-schemas.ts:279-281`, `request-common.ts:5`           |
| No panel/serializer code anywhere in the repo                                            | grep `createWebviewPanel`/`registerWebviewPanelSerializer` → 0 hits                      |

Good news: there is **no host-side "active session"** (the store owns it, `apps/webview/src/app/store.ts:200-205`),
`session.open` is stateless (`apps/extension/src/composition/session-request-handler.ts:127-132`), and every
session-scoped request already carries `sessionId`. Per-tab sessions are therefore representable once routing
is per-surface.

### 1.4 Slash-command syntax

`/moveto:editor` does **not** parse today: the command-name grammar is `/^\/([a-z][a-z0-9_-]*)/` in
`packages/domain/src/advanced.ts:94`, `apps/webview/src/features/composer/composer-input.ts:104,114`,
`apps/webview/src/features/commands/CommandPalette.tsx:267`, `apps/webview/src/app/store/command-directory.ts:119`,
`apps/webview/src/features/commands/popupSelectRegistry.ts:51`. Left alone, `/moveto:editor` is submitted to
DSH **as a model prompt** (`apps/webview/src/app/store/session-actions.ts:114-134`).

There _is_ a client-side command mechanism to extend: `withClientCommandContributions`
(`command-directory.ts:74-86`, used today for `/model`) plus a hard-coded dispatch branch in
`AppController.composerOnCommand` (`apps/webview/src/AppController.tsx:625-649`).

---

## 2. Decisions locked with you

1. **Handoff, not duplication.** The editor surface is the only _live chat_ while it exists; the side-bar view
   switches to a lightweight "Chat is open in the editor area — move back" card. Rationale: one live React tree
   per conversation, no doubled streaming or duplicated approvals, minimal change to existing single-surface
   store semantics. (The side-bar webview stays mounted with `retainContextWhenHidden`, so moving back is
   instant — its transcript is still in memory.)
2. **One editor tab per session.** Tabs are the session switcher, like browser tabs / editor tabs. Two
   sessions dragged to the editor give two tabs; opening an already-open session reveals its tab.
3. **Drag gesture is to be established experimentally** (you explicitly want to see what works). The plan
   implements mechanism B as the guaranteed path in every phase and treats A as a **spike-gated** extra; C is
   held as an optional later phase only if you want a true native drop.
4. Everything else (naming, exact placeholder wording, whether "move back" closes one tab or all tabs) is
   validated with you at the phase acceptance checkpoints.

---

## 3. Target architecture (one paragraph)

Introduce a **surface registry** in the Extension Host. A surface is any live webview that speaks the DSH
protocol: the existing secondary-side-bar view (`surfaceId = 'sidebar'`) and one editor `WebviewPanel` per
session (`surfaceId = 'editor:<sessionId>'`). Each surface owns its readiness handshake, its own inbound
router state (in-flight requests, question waits, cancellation) and its own outbound sink; the Host keeps the
existing broadcast for session-agnostic events and adds a **targeted post** for surface-directed messages
(`surface.assigned`, `ui.surface.handoff`, per-surface session bootstrap). The webview is told which surface it
is and which session it is bound to immediately after `app.ready`; it then loads that session instead of the
"last session" restore. A shared `DshChatSurfaceManager` owns the panel lifecycle: create-or-reveal, one panel
per session keyed by session id, `registerWebviewPanelSerializer` for Reload Window, title updates, and
"last panel closed ⇒ sidebar becomes live again".

```text
                    ┌───────────────────── Extension Host ─────────────────────┐
  sidebar webview ──┤ SurfaceRegistry                                      │
  (surface:sidebar) │   sidebarSurface  ─┐                                │
                    │   editorSurface[] ─┼─► targeted post(surfaceId, msg)  │
  editor panel   ───┤                    ┘                                 │
  (surface:editor:  │   per-surface: router(in-flight), readiness, cancel  │
   <sessionId>)     │   shared: backend stream, session cache, use cases    │
                    └───────────────────────────────────────────────────────┘
```

---

## 4. Phases

Each phase is one vertical slice: Host surface work → protocol → webview → tests → docs → **your manual
acceptance**. Phases 1–4 are the feature; 5 is release polish; 6 is optional.

### Phase 1 — Editor surface foundation (handoff), opened by a command

**Deliverable**

- `WebviewSurface` interface (`postMessage`, `waitUntilReady`, `reveal`, `dispose`, `onDidDispose`) and two
  implementations: the refactored `DshWebviewViewProvider` and a new `DshWebviewPanelSurface`
  (`window.createWebviewPanel(VIEW_ID_EDITOR, title, ViewColumn.Active, { retainContextWhenHidden: true, enableFindWidget: true })`, HTML from the existing `createWebviewHtml`).
- `WebviewSurfaceRegistry`: create/reveal/dispose, per-surface id, targeted `postTo(surfaceId, message)`,
  broadcast `post(message)` for the untouched callers, and "primary surface" resolution.
- Per-surface router state: `WebviewMessageRouter` gains a surface dimension (per-surface router instances
  sharing handlers, or a surface-scoped map) so a response and a cancellation land on the surface that asked.
  `router.cancelAll()` → `cancelSurface(surfaceId)`; job-follow/editor-context teardown only when the last
  surface goes away.
- New command `dsh.openChatInEditor` (+ `view/title` button and Command Palette entry) and the inverse
  `dsh.moveChatToSidebar`; panel disposal restores the sidebar as the live chat.
- Surface identity to the webview: host event `ui.surface.assigned` `{ surfaceId, kind, sessionId? }` after
  `app.ready`; webview store records it and, for an editor surface, opens the bound session instead of
  `attemptStartupRestore`.
- Handoff: while ≥1 editor surface exists, the sidebar surface renders a placeholder card (i18n) with
  "Move back to side bar"; host event `ui.surface.handoff` `{ editorChats: number }`.
- `activationEvents`: `onWebviewPanel:dsh.chatPanel`, `onCommand:dsh.openChatInEditor`, `onCommand:dsh.moveChatToSidebar`.
- Panel serializer restoring `{ sessionId }` across **Reload Window**.

**Tests**

- Unit: surface registry (create/reveal/dedupe/dispose), panel surface lifecycle against a mocked `vscode`
  (`createWebviewPanel`, `onDidDispose`, `onDidChangeViewState`), response targeting (surface A's request is
  answered on A while B is also live), per-surface cancel leaves the other surface's request alive.
- Protocol: `apps/extension/src/view/protocol-route-coverage.spec.ts` + `packages/webview-protocol/src/schemas.spec.ts`
  for any new request/event; `apps/webview/src/app/store-*.spec.ts` for `ui.surface.assigned` / handoff and the
  bound-session boot path; `i18n-keys.spec.ts` for new strings.
- E2E (`tests/vscode-e2e/suite/index.js` runs inside the Extension Host): after `dsh.openChatInEditor`, assert a
  tab exists with `input instanceof vscode.TabInputWebview && input.viewType === <panel viewType>` via
  `vscode.window.tabGroups.all`; after closing it, assert the tab is gone and the command can open it again.

**Acceptance criteria**

- Automated: `pnpm check` and `pnpm build` green; new e2e assertions pass; no `unimplemented`/TODO weakened.
- **Manual (you, F5 Extension Development Host):**
  1. Open a session in the side bar, run **DSH: Open Chat in Editor Area** → the chat appears as a full-width
     editor tab in the active group; sidebar now shows the placeholder card.
  2. Send a prompt in the editor tab → exactly one streaming reply; no duplicated rows anywhere.
  3. During the stream, watch the side bar card: no second renderer animates, no second spinner.
  4. Click "Move back to side bar" → the sidebar chat is live again with the full transcript (no reload).
  5. **Developer: Reload Window** → the editor tab is restored and shows the same session.
  6. Close the editor tab with the tab's ✕ → chat returns to the sidebar.
  7. Open a pending approval (or question) in the sidebar, then move to the editor → the request is visible and
     answerable there, answered exactly once.
- Exit criteria recorded in the PR: target VS Code build, OS, the observed result of each step above.

**Risks specific to this phase:** `retainContextWhenHidden` suspends a hidden panel's scripts (fine, the store
keeps state; the Host may not `postMessage` into a hidden panel — the registry must queue or drop with a
documented policy); the webview is destroyed on user close (all later use must go through the registry).

---

### Phase 2 — `/moveto:editor` and `/moveto:sidebar` in the composer

**Deliverable**

- Client command row `moveto` advertised via `withClientCommandContributions`
  (`apps/webview/src/app/store/command-directory.ts:74-86`) with `input.hint = 'editor|sidebar'` so the palette
  and Enter adjudication claim the line.
- Dispatch branch in `AppController.composerOnCommand` beside the `/model` branch
  (`apps/webview/src/AppController.tsx:625-649`).
- The literal requested syntax `/moveto:editor`: a **narrow normalizer** that maps `moveto:<target>` →
  `moveto <target>` at the two entry points (`composer-input.ts` parsing and the `sendPrompt` guard in
  `apps/webview/src/app/store/session-actions.ts:114-134`) instead of relaxing the shared command-name grammar
  in six places. Unknown/other colon forms are untouched.
- Defensive guard: a `/moveto*` line can never fall through to `session.sendPrompt` (today an unparsed slash
  line is sent to DSH as a prompt — this is a hard negative-test).
- i18n keys in both locales (`pnpm i18n add`), e.g. `commands.movetoDescription`, `commands.movetoMoved`,
  `commands.movetoUnknownTarget`.

**Tests**: `store-command-dispatch.spec.ts`, `store-command-input.spec.ts`, `store-prompt.spec.ts`,
`features/composer/Composer.spec.tsx` (Enter adjudication), `features/commands/CommandPalette.spec.tsx`,
`command-directory.spec.ts` (add the first direct spec for `withClientCommandContributions`).

**Acceptance criteria**

- Typing `/moveto:editor` shows the palette row and opens the editor surface; `/moveto:sidebar` returns.
- `/moveto:bogus` shows a clear inline error and **does not** reach the model (verify: no new user turn in the
  transcript, no `session.sendPrompt` in the passing test).
- `/moveto` with no argument is claimed but rejected with guidance (no accidental send).
- Manual: type both commands inside a focused-layout and classic-layout session; keyboard-only (↑/↓/Enter/Tab)
  works; palette entry reachable from the extras menu.

---

### Phase 3 — One editor tab per session + the drag from Open Sessions

**Deliverable**

- `DshChatSurfaceManager` keyed by session id: `openSessionInEditor(sessionId)` creates the panel or reveals the
  existing one; tab title = session name (host `surface.title` request so renames update the tab); closing one
  tab leaves the others; only the last close returns the chat to the sidebar.
- Webview→host request `surface.openInEditor` `{ sessionId }` (new strict schema next to `session.open`,
  dispatched from `session-request-handler.ts`), used by all drag/menu/keybinding entries so the gesture and the
  explicit actions share one path.
- Lazy bootstrap: a panel loads its session/history on first visibility (`onDidChangeViewState`), so N tabs do
  not all replay history at once.
- **Drag gesture**, gated on the Phase-0/1 spike outcome:
  - _A (if the spike shows it is detectable):_ session rows become draggable regardless of sort mode; the row
    keeps the `ORDER_DRAG_MIME` payload only when reorderable; `onDragEnd` reports "released outside the
    webview" (no accepted drop target) → `surface.openInEditor`. Include a short hint in the drawer
    ("drag a session out of the panel to open it in the editor area").
  - _B (always ships, also the accessibility path):_ row context-menu/nested action "Open in Editor Area",
    a keyboard binding, Command Palette entry, and the `/moveto:editor` command from Phase 2.
  - _C (optional, separate capability):_ native `dsh.sessions` TreeView + `text/uri-list` + custom editor for a
    true drop into a chosen editor group.
- Drawer tests for the new drag semantics: reorder must still work, dragging out must not reorder, dragging
  inside must not open tabs.

**Acceptance criteria**

- Two sessions open as two tabs; switching tabs switches sessions; each tab keeps its own transcript and scroll.
- Dragging session B from the drawer to the editor area opens/focuses B's tab (mechanism A) or shows the
  explicit "Open in Editor Area" affordance (mechanism B) — whichever survives the spike, documented in the PR.
- Reordering robots: manual-sort reorder inside the drawer works exactly as today; a drop inside the drawer
  never opens a tab; dragging out never changes stored order.
- Manual: open 3 tabs, stream in one while the others are hidden, then check each tab's transcript and memory
  behaviour; verify `Close All` returns the chat to the sidebar; verify tab drag between editor groups works
  (free VS Code behaviour).

---

### Phase 4 — Multi-surface correctness hardening

**Deliverable**

- Per-surface event cursors replacing the single global sequence gate
  (`apps/extension/src/composition/host-event-pipeline.ts:199-222`) or an explicit re-baseline contract
  (a new/visible surface replays via `session.open` + `session.history`); no silently dropped live events.
- Per-surface `questionWaits` isolation (a `user-question.wait.release` from tab B must not abort tab A).
- Editor-context identity per surface (or an explicit, documented decision that chips are shared) —
  `apps/extension/src/composition/feature-context.ts:65-116` and
  `apps/extension/src/editor/editor-context-provider.ts:23` are the touch points.
- Reconnect/disconnect semantics with N surfaces: all surfaces rebaseline; approvals raised while a surface was
  dormant are still answerable exactly once.
- Perf guard: bounded live surfaces (documented cap or dormancy) and a measured baseline in
  `docs/capability-matrix.md` PF-01 terms (10,000-node timeline, bounded DOM).

**Acceptance criteria**

- Kill and restart DSH with 2 editor tabs open → both recover to their own sessions without duplicated rows.
- Approve a permission in tab A while tab B has a pending question → each answer settles once, in the tab it was
  given in; neither tab loses its prompt.
- Reload Window with 2 tabs → both restore with their sessions and transcripts.
- No regressions in `pnpm test` (especially `store-*` specs, gap-heal, cursor integrity, reconnect epoch).

---

### Phase 5 — Polish, settings, docs, release gate

**Deliverable**

- Setting `dsh.view.openLocation` (`sidebar` | `editor`, default `sidebar`) and, if you want it, "remember last
  location".
- Editor tab actions: "Move back to side bar", "Open in editor area", find widget (`enableFindWidget`),
  breadcrumb-free title, icon; `editor/title` menu entries gated by a new context key
  (`apps/extension/src/vscode/context-keys.ts:7-24`).
- Accessibility & layout: focus lands in the composer after opening; screen-reader labels for the placeholder
  and tab actions; reduced motion; light/dark/high-contrast; narrow side bar **and** editor width
  (`docs/ui.md:45` already requires editor-width checks).
- Docs (mandatory per `AGENTS.md` / `docs/quality.md:37-38`):
  - `docs/capability-matrix.md` — new row in `## 界面、性能、安全与发布` (e.g. `VS-02` 编辑器区聊天) in the exact
    `| ID | 当前范围与限制 | 已有证据 | 验收缺口 | 状态 |` format, referencing `VS-01`; status `PARTIAL` unless
    real VS Code evidence is captured. Keep the ≥45-row and unique-ID invariants of `scripts/check-docs.mjs`.
  - `docs/architecture.md` — extend the "辅助侧边栏默认位置" decision with the editor-surface decision (editor
    chat is a `WebviewPanel`, one per session, single live surface at a time via handoff).
  - `README.md` + `README.zh-CN.md` — identical section counts and identical sorted local link targets
    (`scripts/check-docs.mjs` enforces this); mention how to move the chat and that drag is an affordance.
  - `apps/extension/CHANGELOG.md` `## Unreleased` — bilingual entry.
  - No `docs/dsh-contract.md` change: this is pure VS Code Host/Webview, no upstream DSH contract.
- Release gate: `pnpm check`, `pnpm build`, `git diff --check`, `git status --short`; `pnpm package:vsix` +
  `vsce ls --no-dependencies` when packaging is requested.

**Acceptance criteria**: your full manual matrix passes (list supplied at that phase); all automated gates green;
matrix row and changelog updated with the exact evidence, no capability claimed as `DONE` without live proof.

---

### Phase 6 (optional) — true native drop into the editor area

Only if you decide the tear-off/explicit affordance is not enough:

- New native `dsh.sessions` TreeView (or a tree form of the session list) with
  `TreeDragAndDropController.dragMimeTypes = ['text/uri-list']` emitting `dsh-session:/<id>.dsh`.
- `contributes.customEditors` + `window.registerCustomEditorProvider` for the `dsh-session:` scheme, reusing the
  same webview bundle; `onCustomEditor:` activation.
- Spike first: does the custom-editor `filenamePattern` selector match a virtual `dsh-session:` URI, and does the
  drop open in the dropped group with the expected `TabInputCustom.viewType`.

---

## 5. What I need from you per phase

| Checkpoint      | What I need                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 kickoff | `pnpm install --frozen-lockfile && pnpm build` in your checkout; your VS Code build/OS; run F5                                                                                                     |
| Phase 1 accept  | Steps 1–7 in §Phase 1; report which surface showed each event and any duplicated rendering                                                                                                         |
| Phase 2 accept  | Run `/moveto:editor`, `/moveto:sidebar`, `/moveto:bogus`; confirm nothing reaches the model                                                                                                        |
| Phase 3 spike   | Drag a session row from the drawer toward the editor area and press F12 in the Extension Development Host webview devtools; report whether `dragend` fires and with which `dropEffect`/coordinates |
| Phase 3 accept  | Two/three simultaneous session tabs; reorder regression check; tab switching                                                                                                                       |
| Phase 4 accept  | Restart DSH with 2 tabs; approve in one tab while the other has a pending question; Reload Window                                                                                                  |
| Phase 5 accept  | Light/dark/high-contrast, reduced motion, narrow side bar + editor width, keyboard-only run                                                                                                        |

If the Phase 3 spike shows `dragend` is unreliable (known macOS/iframe issues), I will switch mechanism A off and
ship the explicit affordances, and we can schedule Phase 6 instead.

---

## 6. Open questions to settle during the phases

1. Placeholder wording and whether "move back" closes the active tab or all editor tabs.
2. Should the side bar, while editor tabs exist, also offer the session list to open more tabs?
3. Cap on simultaneously live editor chat tabs (memory) — a cap, or lazy dormancy.
4. Whether editor-context chips (`@` references) are shared across surfaces or per-surface.
5. Whether `dsh.view.openLocation` should be a setting at all, or the location is simply "whatever the user last
   used" (session-persisted).
