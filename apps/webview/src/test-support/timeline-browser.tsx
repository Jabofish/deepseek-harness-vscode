import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useLayoutEffect, type ReactElement } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { Timeline, type TimelineProps } from '../features/chat/Timeline.js'
import { I18nProvider } from '../i18n.js'
import { ConversationLayoutProvider, useConversationLayout } from '../app/ConversationLayoutProvider.js'
import type { ConversationLayout } from '../app/conversation-layout.js'
import '../../../../packages/ui/src/styles.css'
import '../styles/app.css'
import '../styles/components.css'
import '../styles/layout.css'
import '../styles/theme.css'
import '../styles/focused-conversation.css'
import '../styles/focused-workbench.css'
import '../styles/focused-surfaces.css'

// Only the browser runner imports this fixture. It renders the production
// transcript, providers and styles; geometry and input are supplied by Chromium.
const mount = document.getElementById('root')
if (mount === null) throw new Error('Missing fixture root')
const root = createRoot(mount)
const paragraph = 'A readable paragraph that wraps naturally across sidebar and editor widths. '
let session = 0
let nodes: readonly TimelineNode[] = []
let width = 760
let footer = 40
let streaming = false
let hidden = false
let loadingHistory = false
let completeHistory: (() => void) | undefined
let publication = 0
let layout: ConversationLayout = 'classic'
let revealTarget: TimelineProps['revealTarget']
let changeLayout: ((next: ConversationLayout) => void) | undefined
const images = new Set<(uri: string | undefined) => void>()
const loadImage = (): Promise<string | undefined> => new Promise((resolve) => images.add(resolve))

function history(turns: number, start = 0): readonly TimelineNode[] {
  return Array.from({ length: turns }, (_, index): TimelineNode[] => {
    const turn = start + index
    return [
      { kind: 'user-message', id: `question-${turn}`, markdown: `Question ${turn}` },
      {
        kind: 'assistant-message',
        id: `answer-${turn}`,
        markdown: `Answer ${turn}\n\n${paragraph.repeat(2 + (index % 4))}\n\nAnswer end ${turn}.`,
        streaming: false,
        turn,
        turnCompleted: true,
      },
    ]
  }).flat()
}

function loadOlderHistory(): Promise<void> {
  loadingHistory = true
  paint()
  return new Promise((resolve) => {
    completeHistory = () => {
      nodes = [...history(6, -6), ...nodes]
      loadingHistory = false
      completeHistory = undefined
      paint()
      resolve()
    }
  })
}

function Conversation(): ReactElement {
  const preference = useConversationLayout()
  useLayoutEffect(() => {
    changeLayout = preference?.setLayout
    return () => {
      changeLayout = undefined
    }
  }, [preference?.setLayout])
  return (
    <div
      className="dsh-app"
      data-conversation-layout={preference?.layout}
      data-dsh-theme="dark"
      style={{ width, height: 600, display: hidden ? 'none' : 'flex', flexDirection: 'column' }}
    >
      <Timeline
        sessionId={String(session)}
        nodes={nodes}
        streaming={streaming}
        {...(streaming
          ? { activeTurn: nodes.findLast((node) => node.kind === 'assistant-message')?.turn ?? 0 }
          : {})}
        {...(revealTarget === undefined ? {} : { revealTarget })}
        onLoadImage={loadImage}
        hasMoreHistory
        pagedHistory
        loadingOlderHistory={loadingHistory}
        onLoadOlderHistory={loadOlderHistory}
      />
      <div style={{ height: footer, flexShrink: 0 }}>Composer fixture</div>
    </div>
  )
}

function paint(): void {
  flushSync(() =>
    root.render(
      <I18nProvider>
        <ConversationLayoutProvider key={session} initialLayout={layout}>
          <Conversation />
        </ConversationLayoutProvider>
      </I18nProvider>,
    ),
  )
}

// Keep product DOM knowledge in this adapter. Scenarios below it describe
// navigation intent and visible content, with no expected row sizes or offsets.
function viewport(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[aria-label="Conversation timeline"]')
  if (element === null) throw new Error('Conversation timeline is unavailable')
  return element
}

function textRanges(): readonly { readonly text: string; readonly bounds: DOMRect }[] {
  const walker = document.createTreeWalker(viewport(), NodeFilter.SHOW_TEXT)
  const ranges: { text: string; bounds: DOMRect }[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? ''
    if (!/^(?:Question |Answer )/u.test(text)) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const bounds = range.getBoundingClientRect()
    if (bounds.width > 0 && bounds.height > 0) ranges.push({ text, bounds })
  }
  return ranges
}

function snapshot(): {
  readonly atLatest: boolean
  readonly latestVisible: boolean
  readonly visible: boolean
  readonly anchor: string | undefined
  readonly offset: number | undefined
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly sources: readonly { readonly text: string; readonly offset: number }[]
} {
  const element = viewport()
  const top = element.getBoundingClientRect().top
  const texts = textRanges()
  const sources = texts.filter(({ text, bounds }) => {
    const heading = /^(Question|Answer) (-?\d+)$/u.exec(text)
    if (heading === null) return false
    const end =
      heading[1] === 'Answer'
        ? texts.find(
            (item) =>
              item.text.startsWith(`Answer end ${heading[2]}.`) ||
              item.text.startsWith(`Answer end ${heading[2]} update `),
          )?.bounds
        : bounds
    return end !== undefined && end.bottom > top + 1 && bounds.top < element.getBoundingClientRect().bottom
  })
  const source = sources[0]
  const lastAnswer = nodes.findLast((node) => node.kind === 'assistant-message')
  const marker =
    lastAnswer?.kind === 'assistant-message'
      ? /Answer end [^.]+\.$/u.exec(lastAnswer.markdown)?.[0]
      : undefined
  const bounds = marker === undefined ? undefined : texts.find((item) => item.text === marker)?.bounds
  const frame = element.getBoundingClientRect()
  return {
    atLatest: element.scrollHeight - element.scrollTop - element.clientHeight <= 2,
    latestVisible: bounds !== undefined && bounds.bottom > frame.top && bounds.top < frame.bottom,
    visible: element.clientHeight > 0,
    anchor: source?.text,
    offset: source === undefined ? undefined : source.bounds.top - top,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    sources: sources.map(({ text, bounds }) => ({ text, offset: bounds.top - top })),
  }
}

/** Wait for observable quiet, including finite CSS animations, not an implementation frame count. */
function settle(): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    let changed = started
    let previous = ''
    const sample = (): void => {
      const now = performance.now()
      const key = JSON.stringify(snapshot())
      const animating = viewport()
        .getAnimations({ subtree: true })
        .some(
          (animation) =>
            animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity,
        )
      if (key !== previous || animating) changed = now
      previous = key
      if (now - changed >= 300) resolve()
      else if (now - started < 8_000) requestAnimationFrame(sample)
      else reject(new Error('Conversation did not become visually quiet'))
    }
    requestAnimationFrame(sample)
  })
}

let observation: ReturnType<typeof snapshot>[] | undefined
let observationFrame: number | undefined
let observationTask: number | undefined
let observationMutations: MutationObserver | undefined
function stopObservation(): readonly ReturnType<typeof snapshot>[] {
  if (observationFrame !== undefined) cancelAnimationFrame(observationFrame)
  if (observationTask !== undefined) window.clearTimeout(observationTask)
  observationMutations?.disconnect()
  const samples = observation ?? []
  observation = undefined
  return samples
}
function observe(): void {
  stopObservation()
  observation = []
  let revision = 0
  observationMutations = new MutationObserver(() => {
    revision += 1
  })
  observationMutations.observe(viewport(), {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  })
  const sample = (): void => {
    observationFrame = requestAnimationFrame(() => {
      const renderedRevision = revision
      // Sample in a task after rendering/ResizeObserver, so pre-paint
      // measurements are not mistaken for a displayed jump.
      observationTask = window.setTimeout(() => {
        // Another host publication can run between this frame and the task.
        // Its unpainted DOM is not evidence that the previous frame jumped.
        if (revision === renderedRevision) observation?.push(snapshot())
        if (observation !== undefined && observation.length < 600) sample()
      }, 0)
    })
  }
  sample()
}

function detailButton(expanded: boolean): HTMLButtonElement | undefined {
  const label = expanded ? /^Collapse .* details$/u : /^Expand .* details$/u
  return [...viewport().querySelectorAll('button')].find((button) =>
    label.test(button.getAttribute('aria-label') ?? ''),
  )
}

function innerScrollport(): HTMLElement {
  const element = [...viewport().querySelectorAll<HTMLElement>('*')].find(
    (node) =>
      node.clientHeight > 0 &&
      node.scrollHeight > node.clientHeight &&
      /^(auto|scroll)$/u.test(getComputedStyle(node).overflowY),
  )
  if (element === undefined) throw new Error('Expanded content has no inner scrollport')
  return element
}

const scenario = {
  reset(turns: number, initialLayout: ConversationLayout, short = false): void {
    stopObservation()
    session += 1
    nodes = short
      ? [
          {
            kind: 'assistant-message',
            id: 'short',
            markdown: 'Hello.\n\nAnswer end short.',
            streaming: false,
          },
        ]
      : history(turns)
    width = 760
    footer = 40
    hidden = false
    streaming = false
    loadingHistory = false
    completeHistory = undefined
    publication = 0
    layout = initialLayout
    revealTarget = undefined
    images.clear()
    document.body.classList.remove('vscode-reduce-motion')
    paint()
  },
  snapshot,
  settle,
  observe,
  stopObservation,
  wheelPoint(): { readonly x: number; readonly y: number; readonly deltaY: number } {
    const rect = viewport().getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, deltaY: -rect.height * 1.25 }
  },
  resize(): void {
    width = 420
    paint()
  },
  toggleLayout(): void {
    layout = layout === 'classic' ? 'focused' : 'classic'
    flushSync(() => changeLayout?.(layout))
  },
  reduceMotion(): void {
    document.body.classList.add('vscode-reduce-motion')
  },
  jump(): void {
    const button = [...document.querySelectorAll('button')].find((button) =>
      /latest/iu.test(button.getAttribute('aria-label') ?? ''),
    )
    if (button === undefined) throw new Error('Jump to latest is unavailable')
    button.click()
  },
  reveal(): void {
    revealTarget = { nodeId: 'answer-1', requestId: String(performance.now()) }
    paint()
  },
  revealedAnswerVisible(): boolean {
    const answer = textRanges().find((item) => item.text === 'Answer 1')
    if (answer === undefined) return false
    const bounds = answer.bounds
    const frame = viewport().getBoundingClientRect()
    return bounds.bottom > frame.top && bounds.top < frame.bottom
  },
  addPendingImage(): void {
    const current = snapshot().anchor
    const turn = Math.max(0, Number(/(-?\d+)$/u.exec(current ?? '')?.[1] ?? 1) - 1)
    const index = nodes.findIndex((node) => node.kind === 'user-message' && node.id === `question-${turn}`)
    if (index < 0) throw new Error('No preceding message for the delayed image')
    nodes = nodes.map((node, i) =>
      i === index && node.kind === 'user-message'
        ? {
            ...node,
            images: [
              {
                attachmentId: 'fixture-image',
                mediaType: 'image/png',
                bytes: 100,
                width: 800,
                height: 400,
                name: 'fixture.png',
              },
            ],
          }
        : node,
    )
    paint()
  },
  resolveImage(): void {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 400
    const context = canvas.getContext('2d')
    if (context === null || images.size === 0) throw new Error('Pending image fixture is unavailable')
    context.fillStyle = '#777'
    context.fillRect(0, 0, canvas.width, canvas.height)
    for (const resolve of images) resolve(canvas.toDataURL())
    images.clear()
  },
  append(): void {
    publication += 1
    nodes = nodes.map((node, index) =>
      index === nodes.length - 1 && node.kind === 'assistant-message'
        ? {
            ...node,
            markdown: node.markdown.replace(
              /\n\nAnswer end [^.]+\.$/u,
              `\n\n${paragraph.repeat(5)}\n\nAnswer end ${node.turn ?? 'short'} update ${publication}.`,
            ),
          }
        : node,
    )
    paint()
  },
  startStream(): void {
    streaming = true
    nodes = nodes.map((node, index) =>
      index === nodes.length - 1 && node.kind === 'assistant-message'
        ? { ...node, streaming: true, turnCompleted: false }
        : node,
    )
    paint()
  },
  newTurn(): void {
    nodes = [...nodes, ...history(1, nodes.filter((node) => node.kind === 'assistant-message').length)]
    paint()
  },
  growEarlier(): void {
    nodes = nodes.map((node, index) =>
      index === 1 && node.kind === 'assistant-message'
        ? { ...node, markdown: `${paragraph.repeat(8)}\n\n${node.markdown}` }
        : node,
    )
    paint()
  },
  composer(): void {
    footer = 150
    paint()
  },
  hide(): void {
    hidden = true
    paint()
  },
  show(): void {
    hidden = false
    paint()
  },
  finish(): void {
    streaming = false
    nodes = nodes.map((node) =>
      node.kind === 'assistant-message'
        ? { ...node, streaming: false, turnCompleted: true }
        : node.kind === 'tool'
          ? { ...node, tool: { ...node.tool, status: 'completed' } }
          : node,
    )
    paint()
  },
  focusTimeline(): void {
    viewport().focus({ preventScroll: true })
  },
  requestHistory(): void {
    const button = [...viewport().querySelectorAll('button')].find(
      (button) => button.textContent === 'Load earlier',
    )
    if (button === undefined) throw new Error('Load earlier is unavailable')
    button.click()
    if (completeHistory === undefined) throw new Error('History request was not delivered')
  },
  completeHistory(): void {
    if (completeHistory === undefined) throw new Error('No pending history page')
    completeHistory()
  },
  prepareRichText(kind: 'code' | 'table'): void {
    const body =
      kind === 'code'
        ? '```typescript\n' +
          Array.from({ length: 30 }, (_, i) => `export const item${i} = ${i};`).join('\n') +
          '\n```'
        : '| Item | Value |\n| --- | --- |\n' +
          Array.from({ length: 20 }, (_, i) => `| row ${i} | ${paragraph} |`).join('\n')
    nodes = nodes.map((node, index) =>
      index === nodes.length - 1 && node.kind === 'assistant-message'
        ? {
            ...node,
            markdown: `${body}\n\nAnswer end ${node.turn ?? 'short'}.`,
            streaming: true,
            turnCompleted: false,
          }
        : node,
    )
    streaming = true
    paint()
  },
  prepareTool(kind: 'terminal' | 'code', short = false): void {
    const last = nodes.findLast((node) => node.kind === 'assistant-message')
    const turn = last?.kind === 'assistant-message' ? last.turn : undefined
    const tool: TimelineNode = {
      kind: 'tool',
      id: 'fixture-tool',
      tool: {
        id: 'fixture-tool',
        name: kind === 'terminal' ? 'bash' : 'read',
        category: kind === 'terminal' ? 'shell' : 'filesystem',
        title: 'Fixture tool',
        status: 'running',
        ...(turn === undefined ? {} : { turn }),
        step: 0,
        presentation:
          kind === 'terminal'
            ? {
                phase: 'result',
                card: 'terminal',
                output: Array.from({ length: 100 }, (_, i) => `Build output ${i}`).join('\n'),
                exitCode: 0,
              }
            : {
                phase: 'result',
                card: 'read',
                path: 'fixture.ts',
                offset: 1,
                lines: Array.from({ length: short ? 4 : 80 }, (_, i) => ({
                  number: i + 1,
                  text: `export const value${i} = ${i};`,
                })),
                totalLines: 80,
                lang: 'text',
              },
        metadata: {},
      },
    }
    nodes = [...nodes.slice(0, -1), tool, ...nodes.slice(-1)]
    paint()
  },
  async expandTool(): Promise<void> {
    if (detailButton(false) === undefined) {
      const outer = [...viewport().querySelectorAll('button')].find((button) =>
        (button.getAttribute('aria-label') ?? button.textContent).trim().startsWith('Tool calls:'),
      )
      if (outer === undefined) throw new Error('Tool disclosure is unavailable')
      outer.click()
      await settle()
    }
    const button = detailButton(false)
    if (button === undefined) throw new Error('Tool details are unavailable')
    button.click()
  },
  collapseTool(): void {
    const button = detailButton(true)
    if (button === undefined) throw new Error('Expanded tool details are unavailable')
    button.click()
  },
  prepareInnerReading(): { readonly x: number; readonly y: number; readonly deltaY: number } {
    const element = innerScrollport()
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
    const focus = element.tabIndex >= 0 ? element : element.querySelector<HTMLElement>('[tabindex="0"]')
    if (focus === null) throw new Error('Inner content has no keyboard target')
    focus.focus({ preventScroll: true })
    const rect = element.getBoundingClientRect()
    const owner = viewport().getBoundingClientRect()
    const top = Math.max(rect.top, owner.top)
    const bottom = Math.min(rect.bottom, owner.bottom)
    if (bottom <= top) throw new Error('Inner scroll content is outside the visible conversation')
    return { x: rect.left + rect.width / 2, y: (top + bottom) / 2, deltaY: -rect.height / 2 }
  },
  innerPosition(): number {
    return innerScrollport().scrollTop
  },
}

declare global {
  interface Window {
    timelineScenario: typeof scenario
  }
}
document.documentElement.dataset.dshTheme = 'dark'
document.documentElement.style.setProperty('--vscode-foreground', '#cccccc')
document.documentElement.style.setProperty('--vscode-editor-background', '#1e1e1e')
window.timelineScenario = scenario
paint()
