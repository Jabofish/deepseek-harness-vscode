# Webview UI specification

Use these rules when changing visual tokens, content sizing, motion or accessibility. Start with the [architecture specification](architecture.en.md) for state/trust boundaries and use the [manual test guide](quality.md#manual-interaction-checks) for evidence. 本文为英文界面规范；中文贡献入口见[贡献指南](../.github/CONTRIBUTING.zh-CN.md)。

**CSS is the source of token values**: `packages/ui/src/styles.css` owns base typography, icons, motion and Host semantic colours; `apps/webview/src/styles/theme.css` owns explicit light/dark palettes. Other global and feature styles consume semantic tokens. Styling must not redefine Host protocol or business-state semantics.

## Colour and themes

`system` uses Host `--vscode-*` colours with fallbacks and does not define `--dsh-theme-*`. Explicit `light`/`dark` overrides only Webview-owned `--dsh-*` tokens, never `--vscode-*`. Apply theme attributes to both `document.documentElement` and the app container so body-mounted menus, dialogs and toasts share the palette.

| Role             | Token                            | Use                                                                                  |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| Filled accent    | `--dsh-accent` / `--dsh-primary` | Primary buttons, switch tracks and selection fills, paired with `--dsh-primary-text` |
| Line/text accent | `--dsh-accent-line`              | Borders, outlines, icons, links and state markers                                    |

Do not substitute the fill accent for the line accent: they need different luminance on dark surfaces. Literal palette colours belong only in `theme.css`; other styles use semantic tokens. Every `--vscode-*` reference needs a fallback. Express state through semantics such as `aria-*`, `data-*` or a state class as well as colour.

`apps/webview/src/styles/theme.spec.ts` guards contrast: text-bearing `TEXT_PAIRS` require at least 4.5:1, and control/focus `UI_PAIRS` at least 3:1. Add new text-bearing colours/tokens to the pairs. Do not use filled accents for text, outlines, shadows, text decoration, `fill` or `stroke`; the border of the same filled control is the existing exception.

## Typography and icons

Use `--dsh-font-size-*`, role aliases, `--dsh-line-height-*` and `--dsh-icon-size*`. Dense metadata, timestamps/status, secondary copy, body and headings each keep the same role across features. Menus, tool details and Markdown headings use existing roles; headings need an explicit role or the zero-specificity fallback in `app.css`, not browser `em` defaults.

`.dsh-conversation` redeclares font tokens and role aliases for the user's conversation font-size preference. Add new aliases inside that scaling block too: a root-level `var()` alias resolves at the root and will not track the local size. Do not add TSX font-size styles or bare CSS font-size/line-height values. Documented exceptions are `inherit`, the Webview root's Host font size and icon glyph sizing through icon tokens. `typography-scale.spec.ts` guards the structure; inspect actual rendered sizes, line heights and icons as well.

Peer menu entries use `--dsh-menu-font-size`, `--dsh-menu-line-height`, normal weight and `--dsh-muted`, with consistent icons, spacing and hover feedback. Scope entry styling to the entry itself, not nested forms/headings/help. Shared selector menus do not inherit an outer form's text role. Compare computed styles in both conversation layouts, all three conversation font sizes, both locales and the affected themes.

## Content width and overflow

Titles, paths, URLs, tool names and model names can be long unbroken strings. No content may push a sidebar ancestor outside the viewport.

1. Ordinary text uses `overflow-wrap: anywhere` to lower min-content width. Rendered Markdown code wraps to the available width with whitespace/indentation preserved, matching `apps/webview/src/styles/components/03-markdown.css`; copying retains the original text. Surfaces whose contract requires unwrapped diff/terminal content scroll within their own bounded box.
2. Flexible grid columns use `minmax(0, 1fr)` and flex children use `min-width: 0`. Inspect each ancestor from the text container to the viewport.
3. Single-line ellipsis is for bounded labels and needs `overflow: hidden`, `text-overflow: ellipsis` and `white-space: nowrap`. Prefer two-line clamping, normal whitespace and a full-text hint for user/model titles.
4. Hidden overflow must not conceal an oversized ancestor or silently cut useful content. Test long tokens at narrow/normal sidebar and editor widths, including focus reachability.

Global wrapping defaults live in `apps/webview/src/styles/app.css`; feature CSS constrains its own containers. Use the existing UI tests and a real Webview for layout acceptance.

Use `SelectMenu` for selectors; native HTML `select` is lint-restricted. State/action buttons participate in real layout rather than a guessed fixed reserve for a variable button count. Empty/error copy wraps completely and does not inherit inline badge truncation.

Enabled selectors use body text and disabled selectors muted text; UI preferences and advisory reads do not establish upstream capability. Both conversation layouts share sizing. At narrow widths, tighten spacing, disclose statistics and wrap controls before replacing all text selectors with fixed icon boxes. Full names remain available through hints/menus, and send/stop remain reachable.

The current-file shortcut stays visible when available. Attachment actions appear on composer hover/focus and remain directly usable; attached items keep a single scrollable row with reachable names/removal. Loading progress does not add composer height. The existing interruptible composer-height/scroll hooks follow the tail when appropriate and preserve a reader's position otherwise; Reduced Motion completes layout changes directly.

Persistent update, connection, error and welcome notices share a collapsed single-line strip before the chat body. Expanded notices have a height budget and internal scrolling. They must not steal input focus, lose a draft or move free reading; the shared scroll owner corrects tail-follow layout. Place return-to-latest at the bottom of the message area and keep trajectory details separate. Keep both clear of message content and input.

Short windows and large font sizes must retain readable message space. When necessary, the conversation scrolls vertically so header, messages and composer remain reachable instead of clipping/overlapping to fit one screen. Inspect boundaries and hit targets while notices appear, expand, collapse and close.

Streamed text follows the installed Host view promptly; stable Markdown prefixes retain DOM identity while the tail changes. Virtual-list measurement and duplicate internal scroll events do not imply the user left the tail; this exception is limited to transient layout protection. Late size changes above a free reader preserve the visible row's position, and tail activity remains below the last row while virtual measurements settle. Loading older history keeps the visible row anchored through the switch to a virtual list and its initial measurements. The statistics area retains its measured height while its contents fluctuate at the same width, and resets for a different width or session. Wheel, keyboard and scrollbar actions immediately regain control of the reading position. Explicit jumps to the latest message and Inspector navigation cancel pending history anchoring.

## Popovers and focus

Approval cards are compact: title and risk share a row, waiting text is not repeated, reason/command content scrolls within bounds, and every upstream choice stays outside the scrolling body. Full-content lists open on demand from the session's More menu, not permanently above messages.

Goals/tasks share a collapsed header entry; narrow layouts show icon/count with details on demand. Secondary tool entries move into More. New sessions and editor tabs retain session-list, create, schedule and settings access; hiding a button does not disable its drawer. Focus returns to a visible trigger on close.

Questions use a short title and bounded scrolling body for full questions/options; submit/cancel remain outside it. Multiple interactions stay reachable through the outer list. Plans begin collapsed and mount content on demand. Tool details, queues, extra panels and feature menus have height limits. Both layouts preserve content actions; generic card styling must not undo compact rules.

While running or waiting for an interaction, keep chat input, attachments and commands available; ordinary follow-up uses upstream Queue/Steer. Drafts are independent of the running message. Stop has its own event, not form submission or a send receipt. Disconnect retains an editable draft, while bounded Adapter recovery and authoritative reads restore the connection/view.

Shared menu positioning measures the trigger and width, flips direction and clamps to the viewport; never hardcode a top-screen coordinate. Opening a separate dialog closes its source menu. Export uses `ModalDialog`; drawers and other modal surfaces use `useDismissibleLayer` for background isolation, Tab scope, inner-first Escape and focus restoration. Normal rerenders must not steal focus. Only the summary of a collapsed `details` remains in keyboard order.

Long popover lists have a clear scroll owner. Inspector details appear beside the selected entry within the drawer body and share its scroll owner. Parent-menu rules target direct entries, not nested refresh/filter/action controls.

## Motion and announcements

Use motion to show state changes, hierarchy and action results. TSX selects classes/`data-*` for CSS animations; do not inject styles/keyframes or add an animation runtime. Durations, easing, scale, shared keyframes and reduced-motion fallbacks belong to `packages/ui/src/styles.css`. Small controls use fast tokens, light disclosure/notices standard, larger surfaces slow; exit is shorter than entry. Looping tokens apply only to current waiting/running states; completed/history entries stay static.

Light resident disclosure can use the reviewed `dsh-disclosure` grid-row transition; collapsed content becomes unfocusable immediately. Heavy tool/diff/code content remains conditionally mounted. Normal animation properties are `transform`, `opacity`, `background-position`, `color` and `border-color`. Keep layout effects within the existing disclosure grid-row transition and controlled composer-height hook. Do not overwrite virtual-row positioning transforms; initial paint, session switches and historical backfill have no per-row entry animations.

A surface containing menus must release its entry transform: even an identity transform changes the containing block of fixed descendants. Shared entry animation uses `backwards`, guarded against persistent `both`/`forwards`; exit retains its final visual state only until unmount.

Either `prefers-reduced-motion: reduce` or `body.vscode-reduce-motion` disables smooth scrolling, transitions and loops. JavaScript scroll/attachment/composer-height effects use the same policy and stop immediately when it changes. Share subscriptions for media/body-class changes and release them after the final consumer; do not add per-component global polling/listeners. Escape, outside click, focus traps/restoration and `aria-live` never wait for animation. A closing drawer becomes non-interactive and semantically hidden immediately.

The local Process display preference has automatic/live/quiet modes. Automatic follows the initial and changing `body.vscode-using-screen-reader`; explicit live/quiet can override it. This preference is independent of DSH compactness/usage and never writes DSH settings. Quiet does not mount collapsed streaming reasoning/previews; running tools retain a stable summary, with details shown at completion or explicit expansion. User-collapsed tools stay collapsed.

Tool batches retain summary DOM identity and focus; disclosure updates use the latest expanded set. On a screen-reader mode change, restore focus only when the focused row control was removed, without stealing it from settings/input. Submitted plans stay outside the tool fold and preserve expansion across display-policy changes. Expansion-to-see-error hints appear only for collapsed groups. Both conversation layouts keep errors, streaming answers, approval/question/stop/disclosure controls and underlying business events intact.

Reasoning text has no live region. Chat and trajectory each use a stable progress region for response start/end, with identity and ARIA role independent of running state. Intermediate model steps/tool gaps do not announce completion. Tool names/counts/stages stay out; quiet mode does not automatically announce task progress or trajectory search counts. Preserve errors and feedback for explicit user actions. DOM/browser/semantic tests do not replace actual assistive-technology acceptance in VS Code.

## Surfaces and drag handoff

Opening an editor chat leaves sidebar create/session/input actions usable. Normal sidebar selection opens locally; Open in Editor Area and accepted editor drops create/reveal a tab. Other tabs cannot replace the sidebar's current session/draft. Tab titles are themeable and keyboard accessible, with explicit focus ownership; moving between surfaces is not communicated through colour/motion alone.

Editor panels use their own width and the same long-text/virtual-list rules. Cross-area session drag starts in the native Explorer **DSH Sessions** list and uses VS Code resource drops/target groups; dragging inside the floating switcher still reorders manual entries. Outside release, Webview exit or Escape must not trigger an open. Only an actual editor-accepted resource passes through workspace-ownership validation and opens a session.

## Acceptance

For affected UI changes, check 240px/normal sidebar and editor widths with light/dark/high-contrast themes and Reduced Motion, keyboard/focus restoration, screen-reader behaviour, menus, long text, live tails and large histories. Report actual scenarios and limitations through the [quality guide](quality.md#report-test-results). Automated checks cover rules, not every rendered/assistive experience; preserve `PARTIAL` until the required native Webview evidence exists.
