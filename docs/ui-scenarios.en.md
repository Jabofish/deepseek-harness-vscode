# Daily UI behavior scenarios and coverage

English | [简体中文](ui-scenarios.md)

This inventory contains 142 daily scenarios defined by user intent and observable outcomes. History sizes, layouts and input samples are variants of a scenario, not additional behavior coverage.

Browser status: `B` means at least one representative behavior is registered in `pnpm test:ui-stability`; `G` means browser behavior coverage is still needed. A `B` does not imply all branches or environments in that row are covered. The command also runs the explicitly selected functional suites in `scripts/ui-behavior-suites.mjs`, including the scroll behavior regressions. Component tests listed for an area are a foundation, not proof that every branch has full-page coverage. `DSH_UI_GROUP=daily` runs only full-App browser cases; `DSH_UI_SCENARIO` runs a named browser case. These filtered runs do not run the functional suites. Generated JSON reports record actual run results. Native files, windows, drag handoff, credentials, real DSH and assistive technology require separate acceptance.

Current acceptance scope: common input, send, Stop, queue editing/admission, session drafts/navigation, attachments, model selection, approvals/questions, settings/export dialogs and narrow windows. Remaining rows are a backlog, not a requirement for this common-scenario pass. Session pinning and permanent deletion are not offered operations and are excluded from the inventory. Include applicable success, refusal, cancellation, retry and stale-result branches.

Cross-cutting conditions: classic/focused layouts; English/Chinese; sidebar/editor and narrow/short windows; light/dark/high contrast; keyboard/mouse/IME; motion enabled/disabled and runtime changes; short/long histories; normal/delayed/disconnected delivery. Combine conditions where behavior differs rather than mechanically multiplying every axis.

## Connection and startup

Existing component/protocol foundation: [features/runtime/RuntimeConnectionView.spec.tsx](../apps/webview/src/features/runtime/RuntimeConnectionView.spec.tsx).

| ID      | Action or situation                              | Observable outcome                                                 | Browser |
| ------- | ------------------------------------------------ | ------------------------------------------------------------------ | ------- |
| BOOT-01 | Restore the last conversation on startup         | Show its content and an editable composer without sending a prompt | B       |
| BOOT-02 | Start with no existing conversation              | Offer workspace/session creation without a false error             | G       |
| BOOT-03 | Missing or unsupported runtime                   | Show a clear recovery action and preserve user input               | G       |
| BOOT-04 | Connection fails, then Retry succeeds            | Replace the failure state and retain the draft                     | B       |
| BOOT-05 | Connection is slow while the user opens settings | Settings and cancellation remain reachable                         | G       |
| BOOT-06 | Disconnect during output, then reconnect         | Keep accepted content and the draft without duplicate messages     | B       |
| BOOT-07 | Cancel runtime installation or update            | Stop owned work, explain the result and allow retry                | G       |
| BOOT-08 | Receive update/progress notices while reading    | No focus theft or displacement of the reading position             | G       |

## Workspaces

Existing component/protocol foundation: [features/sessions/SessionDrawer.spec.tsx](../apps/webview/src/features/sessions/SessionDrawer.spec.tsx).

| ID    | Action or situation                          | Observable outcome                                         | Browser |
| ----- | -------------------------------------------- | ---------------------------------------------------------- | ------- |
| WS-01 | Open the workspace/session switcher          | The current workspace/session is identifiable              | B       |
| WS-02 | Add a folder and cancel its native picker    | Cancellation leaves the previous selection intact          | G       |
| WS-03 | Create and rename a workspace                | The resulting name is visible and persisted                | G       |
| WS-04 | Switch across multiple workspaces            | Each list and draft stays with its owner                   | G       |
| WS-05 | Move and reorder workspaces/sessions         | The visible order matches the accepted action              | G       |
| WS-06 | Remove a workspace, including failure/cancel | Require intended confirmation; failure retains its entries | G       |

## Session lifecycle

Existing component/protocol foundation: [features/sessions/SessionDrawer.spec.tsx](../apps/webview/src/features/sessions/SessionDrawer.spec.tsx).

| ID         | Action or situation                                | Observable outcome                                          | Browser |
| ---------- | -------------------------------------------------- | ----------------------------------------------------------- | ------- |
| SESSION-01 | Create a local draft and send its first prompt     | Create one session on send with the chosen configuration    | B       |
| SESSION-02 | Switch between two sessions with separate drafts   | Content, attachments and drafts never cross sessions        | B       |
| SESSION-03 | Search titles and conversation content             | Show relevant results and open the selected conversation    | B       |
| SESSION-04 | Clear search or receive an empty/error result      | Restore the list or show a retryable state honestly         | B       |
| SESSION-05 | Rename a session, including failed save            | Commit the accepted title; failure keeps the prior title    | B       |
| SESSION-07 | Archive and restore a conversation                 | Remove/restore the intended row and keep its content        | G       |
| SESSION-09 | Branch or restore from an earlier point            | Open the intended branch/state without damaging the source  | G       |
| SESSION-10 | Switch while another session is loading/outputting | Late results cannot replace the newly selected conversation | B       |

## Composer and delivery

Existing component/protocol foundation: [features/composer/Composer.spec.tsx](../apps/webview/src/features/composer/Composer.spec.tsx).

| ID       | Action or situation                               | Observable outcome                                                    | Browser |
| -------- | ------------------------------------------------- | --------------------------------------------------------------------- | ------- |
| INPUT-01 | Type and send an ordinary prompt                  | The accepted text appears once and the admitted draft clears          | B       |
| INPUT-02 | Use Shift+Enter and multiline editing             | Insert/edit newlines without accidental submission                    | B       |
| INPUT-03 | Use Chinese/Japanese IME composition              | Composition confirmation does not submit a prompt                     | B       |
| INPUT-04 | Try empty/whitespace-only input                   | No empty turn is sent                                                 | B       |
| INPUT-05 | Send a long prompt or a long unbroken token       | Text stays intact and send/stop controls remain reachable             | B       |
| INPUT-06 | Hold a send while editing the next draft          | The receipt cannot erase newer text                                   | B       |
| INPUT-07 | Double-click or repeat the submit key             | One intended admission has one visible turn                           | B       |
| INPUT-08 | A send fails, then succeeds on retry              | Preserve the draft, show safe feedback, then clear on admission       | B       |
| INPUT-09 | Cancel an unconfirmed send                        | Show an honest result and preserve unadmitted text                    | B       |
| INPUT-10 | Stop an active response                           | Deliver Stop independently of prompt send and settle visible activity | B       |
| INPUT-11 | Keep composing while approval/question is pending | Draft editing and Stop remain usable                                  | B       |
| INPUT-12 | Open and dismiss command/reference suggestions    | Selection inserts/executes the intended item; Escape retains text     | G       |

## Queue and steering

Existing component/protocol foundation: [features/input/QueuePanel.spec.tsx](../apps/webview/src/features/input/QueuePanel.spec.tsx).

| ID       | Action or situation                             | Observable outcome                                      | Browser |
| -------- | ----------------------------------------------- | ------------------------------------------------------- | ------- |
| QUEUE-01 | Queue input while the agent is running          | The accepted item appears once in the queue             | B       |
| QUEUE-02 | Send steering input to a running turn           | Use the intended mode without duplicating queue content | B       |
| QUEUE-03 | Edit a queued item                              | Accepted edits replace the targeted text                | B       |
| QUEUE-04 | Remove or change the mode of a queued item      | Only the targeted item changes                          | B       |
| QUEUE-05 | Queue operation fails or a stale result arrives | Retain current content and offer retry                  | B       |
| QUEUE-06 | Queued input is admitted into the transcript    | Remove its queue receipt and render one durable message | B       |

## Attachments and editor context

Existing component/protocol foundation: [features/composer/attachmentDrafts.spec.ts](../apps/webview/src/features/composer/attachmentDrafts.spec.ts).

| ID        | Action or situation                            | Observable outcome                                         | Browser |
| --------- | ---------------------------------------------- | ---------------------------------------------------------- | ------- |
| ATTACH-01 | Pick a file/image and cancel the picker        | Only selected attachments appear; cancel retains the draft | B       |
| ATTACH-02 | Paste or drop supported images/files           | Ingest valid content with usable names/previews            | G       |
| ATTACH-03 | Reject oversized/unsupported attachments       | Explain rejection without corrupting other attachments     | G       |
| ATTACH-04 | Preview, retry and dismiss an image            | Show the correct image and restore focus after close       | G       |
| ATTACH-05 | Remove an attachment while it is loading       | It does not return from a late result                      | G       |
| ATTACH-06 | Switch sessions while an attachment is loading | The result stays with the originating draft                | B       |
| ATTACH-07 | Attach the current file/selection/diagnostics  | Show only the intended scoped context                      | G       |
| ATTACH-08 | Send/cancel/fail with attachments              | Retain retryable handles and release only safe resources   | B       |

## Models, presets and permissions

Existing component/protocol foundation: [features/models/ModelPicker.spec.tsx](../apps/webview/src/features/models/ModelPicker.spec.tsx).

| ID        | Action or situation                           | Observable outcome                                           | Browser |
| --------- | --------------------------------------------- | ------------------------------------------------------------ | ------- |
| CONFIG-01 | Select a discovered provider/model            | The displayed and sent route matches the selection           | B       |
| CONFIG-02 | Search a long model list and use the keyboard | The chosen model is visible and reachable                    | G       |
| CONFIG-03 | Change reasoning effort or prompt mode        | Retain the exact chosen setting                              | G       |
| CONFIG-04 | Use a missing/slow/failed model catalogue     | Show the failure while send/stop controls remain usable      | G       |
| CONFIG-05 | Switch permission or Plan mode while running  | Apply accepted structured state and preserve draft/focus     | G       |
| CONFIG-06 | Switch sessions while configuration is saving | Late results do not alter the new session                    | G       |
| CONFIG-07 | Choose a preset for a new conversation        | First send uses the selected/default advertised preset       | B       |
| CONFIG-08 | Provider/configuration save is refused        | Retain the previous configuration and provide retry feedback | B       |

## Conversation reading and rendering

Existing component/protocol foundation: [features/chat/Timeline.spec.tsx](../apps/webview/src/features/chat/Timeline.spec.tsx).

| ID      | Action or situation                                   | Observable outcome                                          | Browser |
| ------- | ----------------------------------------------------- | ----------------------------------------------------------- | ------- |
| READ-01 | Follow streamed output or a new turn                  | The actual latest text remains visible                      | B       |
| READ-02 | Read earlier content while output continues           | Keep the selected source and observed reading position      | B       |
| READ-03 | Resize the panel/composer or switch layout            | Keep reading content or following intent                    | B       |
| READ-04 | Load older history while streaming or moving          | Preserve current intent and do not duplicate content        | B       |
| READ-05 | Jump/reveal during layout or history correction       | The newest explicit navigation wins                         | B       |
| READ-06 | Receive delayed images or earlier content growth      | Preserve reader position; follow the tail when requested    | B       |
| READ-07 | Hide/reveal or switch sessions during output          | Recover the correct session and reading mode                | B       |
| READ-08 | Render code, tables, math, frontmatter and long links | Keep content intact and overflow locally bounded            | G       |
| READ-09 | Copy text/code and follow a link                      | Copy exact content; refuse/retry links visibly              | G       |
| READ-10 | Finish, fail or interrupt a streamed answer           | Render truthful terminal state without losing accepted text | G       |

## Tools, reasoning and process details

Existing component/protocol foundation: [features/chat/ToolCallCollection.spec.tsx](../apps/webview/src/features/chat/ToolCallCollection.spec.tsx).

| ID      | Action or situation                               | Observable outcome                                               | Browser |
| ------- | ------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| TOOL-01 | Expand/collapse reasoning and tool details        | Show the correct content without moving unrelated reading        | G       |
| TOOL-02 | Scroll long terminal/code/diff content internally | Move inner content without detaching outer following             | B       |
| TOOL-03 | Change tool status while details are open         | Keep focus, disclosure state and complete results                | G       |
| TOOL-04 | Use quiet/live/automatic process display          | Preserve controls and business state while reducing motion/noise | G       |
| TOOL-05 | Open a tool file/URL and handle refusal           | The intended target is used; failure remains retryable           | G       |
| TOOL-06 | Expand a long code result through animation end   | Keep the final answer visible without a phantom blank range      | B       |

## Approvals and questions

Existing component/protocol foundation: [features/interactions/UserQuestionCard.spec.tsx](../apps/webview/src/features/interactions/UserQuestionCard.spec.tsx).

| ID          | Action or situation                          | Observable outcome                                                 | Browser |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------ | ------- |
| INTERACT-01 | Approve or refuse an upstream option         | Send the intended option and settle the correct card               | B       |
| INTERACT-02 | Approval delivery fails, then retry          | Keep the card actionable and show safe feedback                    | B       |
| INTERACT-03 | Read a long approval while output continues  | Choices and Stop remain reachable                                  | G       |
| INTERACT-04 | Answer a single-choice question              | Deliver the selected answer and settle its card                    | B       |
| INTERACT-05 | Answer multiple-choice and custom questions  | Preserve the intended combination/custom text                      | B       |
| INTERACT-06 | Answer a batch with keyboard and IME         | Only the submit shortcut submits; Enter/IME edit normally          | G       |
| INTERACT-07 | Question answer fails/cancels/retries        | Keep the draft unless authoritative settlement confirms acceptance | B       |
| INTERACT-08 | Timed wait, expiry and a late answer         | Follow authoritative timed state without stale submission          | G       |
| INTERACT-09 | Resolve/remount/switch a pending interaction | No stale duplicate card or cross-session response                  | G       |
| INTERACT-10 | Several pending interactions at narrow size  | Every pending item and its controls remain reachable               | G       |

## Menus, drawers and focus

Existing component/protocol foundation: [features/sessions/SessionDrawer.spec.tsx](../apps/webview/src/features/sessions/SessionDrawer.spec.tsx).

| ID     | Action or situation                               | Observable outcome                                   | Browser |
| ------ | ------------------------------------------------- | ---------------------------------------------------- | ------- |
| NAV-01 | Open each drawer from its public entry            | The requested surface and title become visible       | B       |
| NAV-02 | Close a drawer with Escape and restore focus      | Return focus to a visible trigger                    | B       |
| NAV-03 | Dismiss the inner popup before the outer dialog   | Escape closes the innermost active layer first       | B       |
| NAV-04 | Tab/Shift+Tab in a modal                          | Keep keyboard focus in the active modal              | B       |
| NAV-05 | Click outside a popover or reopen it              | Dismiss/reopen reliably without losing draft text    | B       |
| NAV-06 | Open menus near screen edges or in a short window | Options stay visible and clickable                   | B       |
| NAV-07 | Move among Chat/Trajectory and search results     | Show the intended view/result with correct focus     | G       |
| NAV-08 | Open dialogs from menus during streaming          | Close the source menu and preserve independent input | B       |

## Settings, providers and account

Existing component/protocol foundation: [features/settings/SettingsDrawer.spec.tsx](../apps/webview/src/features/settings/SettingsDrawer.spec.tsx).

| ID     | Action or situation                               | Observable outcome                                            | Browser |
| ------ | ------------------------------------------------- | ------------------------------------------------------------- | ------- |
| SET-01 | Change layout/theme/font/language                 | Apply the visible choice and preserve it on reopen            | G       |
| SET-02 | Read/update/reset a schema-driven setting         | Show the accepted value and truthful restart requirements     | G       |
| SET-03 | Handle save conflict/failure and stale results    | Keep the latest accepted value and allow recovery             | G       |
| SET-04 | Configure provider credentials through native UI  | Show only configured/missing state and honor cancellation     | G       |
| SET-05 | Create/edit/remove custom providers and presets   | Validate input and retain failed edits for retry              | G       |
| SET-06 | Install/enable/disable/remove a plugin            | Reflect authoritative state and prevent duplicate operations  | G       |
| SET-07 | Cancel/recover a plugin installation              | Track original operation and keep outcome uncertainty visible | G       |
| SET-08 | Sign in/out or cancel/expire authentication       | Preserve scope, release waiting state and show safe feedback  | G       |
| SET-09 | Inspect usage/cost and change local billing rates | Retain correct units, currency and unpriced explanations      | G       |
| SET-10 | Open settings while optional services fail        | Other settings remain usable and failures can be retried      | G       |

## Goals, tasks, jobs and schedules

Existing component/protocol foundation: [features/tasks/TasksDrawer.spec.tsx](../apps/webview/src/features/tasks/TasksDrawer.spec.tsx).

| ID      | Action or situation                                   | Observable outcome                                     | Browser |
| ------- | ----------------------------------------------------- | ------------------------------------------------------ | ------- |
| TASK-01 | Open/edit/clear the current Goal/Todo                 | Show accepted structured state and scoped controls     | G       |
| TASK-02 | Watch task phase/completion/failure updates           | Reflect real state without invented progress           | G       |
| TASK-03 | Open task details and linked conversations            | Navigate to the intended owning session                | G       |
| TASK-04 | Follow long job output then stop/retry                | Keep complete ordered text and useful retry feedback   | G       |
| TASK-05 | Job output gaps or reconnects                         | Recover content without duplication or silent loss     | G       |
| TASK-06 | Open a subagent and follow up or interrupt            | Respect parent ownership and read-only modes           | G       |
| TASK-07 | Show workflow start/phase/end/error                   | Use structured lifecycle state and clear failures      | G       |
| TASK-08 | List schedules and open linked history                | Keep ownership and linked-session context correct      | G       |
| TASK-09 | Delete a schedule or refuse/cancel its action         | Act only on the selected item; retain failures visibly | G       |
| TASK-10 | Optional controller is missing or becomes unavailable | Show unavailable state without breaking chat controls  | G       |

## Documents, changes, checkpoints and export

Existing component/protocol foundation: [features/checkpoints/CheckpointDrawer.spec.tsx](../apps/webview/src/features/checkpoints/CheckpointDrawer.spec.tsx).

| ID       | Action or situation                                 | Observable outcome                                           | Browser |
| -------- | --------------------------------------------------- | ------------------------------------------------------------ | ------- |
| FILES-01 | Preview Markdown/frontmatter or an attachment       | Render safe complete content and close reliably              | G       |
| FILES-02 | Open a changed file or diff                         | Reveal the intended relative target and handle refusal       | G       |
| FILES-03 | Refresh/filter a large Changes list                 | Keep the selected file and expose read failures              | G       |
| FILES-04 | Create/preview a checkpoint                         | Show the recorded files and intended restore impact          | G       |
| FILES-05 | Restore/delete a checkpoint, including cancellation | Require explicit intent and show the actual outcome          | G       |
| FILES-06 | Export Markdown/JSON/ZIP                            | Export the intended full content and selected format         | G       |
| FILES-07 | Cancel export or refuse overwrite/path access       | Leave existing files intact and report cancellation honestly | B       |
| FILES-08 | Operate with unreadable/removed/remote files        | Keep the UI usable with retryable scoped failures            | G       |

## Multiple panels and native integration

Existing component/protocol foundation: [App.connected.spec.tsx](../apps/webview/src/App.connected.spec.tsx).

| ID         | Action or situation                          | Observable outcome                                           | Browser |
| ---------- | -------------------------------------------- | ------------------------------------------------------------ | ------- |
| SURFACE-01 | Open editor chat while sidebar stays active  | Each surface keeps its own selected session and draft        | G       |
| SURFACE-02 | Split, hide/reveal, close/reopen a panel     | Correct state returns without duplicate subscriptions        | G       |
| SURFACE-03 | Reload the editor/window                     | Restore the intended session/preferences safely              | G       |
| SURFACE-04 | Drag a session into an accepted editor split | Only accepted handoff opens the intended tab                 | G       |
| SURFACE-05 | Cancel drag with Escape/outside release      | No unrequested editor tab is opened                          | G       |
| SURFACE-06 | Open Web UI/DevTools through native actions  | Use the authorized target and show unsupported environments  | G       |
| SURFACE-07 | Revoke trust or move to a remote workspace   | Disable privileged actions while retaining safe cancellation | G       |
| SURFACE-08 | Close during pending reads or subscriptions  | Release resources and ignore late updates                    | G       |

## Appearance, keyboard and accessibility

Existing component/protocol foundation: [features/goals/GoalsTasksStrip.accessibility.spec.tsx](../apps/webview/src/features/goals/GoalsTasksStrip.accessibility.spec.tsx).

| ID    | Action or situation                                 | Observable outcome                                              | Browser |
| ----- | --------------------------------------------------- | --------------------------------------------------------------- | ------- |
| AX-01 | Use both locales with long translated labels        | All essential text and controls remain understandable/reachable | B       |
| AX-02 | Use narrow/short panels and larger text             | Read content and reach send/stop without clipping               | B       |
| AX-03 | Use light/dark/high-contrast Host themes            | Text, focus and status remain distinguishable                   | G       |
| AX-04 | Change Reduced Motion at runtime                    | Ongoing motion ends promptly without losing state               | G       |
| AX-05 | Navigate all main controls by keyboard              | Logical focus order, activation and visible focus               | B       |
| AX-06 | Open an image/modal then close it                   | Focus returns to the right visible control                      | G       |
| AX-07 | Switch automatic quiet display/screen-reader signal | Controls survive and only removed focus is restored             | G       |
| AX-08 | Receive start/end/error announcements               | No streamed-token/tool chatter or false completion              | G       |

## Races, rejection and cleanup

Existing component/protocol foundation: [app/store-realtime-delivery.spec.ts](../apps/webview/src/app/store-realtime-delivery.spec.ts).

| ID         | Action or situation                              | Observable outcome                                             | Browser |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------- | ------- |
| RECOVER-01 | A late response belongs to a previous session    | It cannot alter the current conversation/draft                 | B       |
| RECOVER-02 | Events are duplicated/reordered or have a gap    | Maintain accepted order and recover authoritatively            | G       |
| RECOVER-03 | A business action is refused                     | Keep the relevant draft/state and explain safe recovery        | G       |
| RECOVER-04 | A request times out or is cancelled              | Release waiting controls and ignore stale completion           | G       |
| RECOVER-05 | A long hidden conversation resumes               | Show current content without a stale replay or blank view      | G       |
| RECOVER-06 | Malformed optional data arrives                  | Keep healthy functions usable without inventing defaults       | G       |
| RECOVER-07 | A drawer closes during an asynchronous save/read | Late completion cannot reopen or overwrite a newer surface     | G       |
| RECOVER-08 | Repeated open/close/session churn                | No growing observers, timers, subscriptions or retained bodies | G       |

See the [testing guide](quality.md) for validation and evidence requirements. This inventory tracks behavioral coverage and does not promote incomplete runtime acceptance in the [capability matrix](capability-matrix.en.md).
