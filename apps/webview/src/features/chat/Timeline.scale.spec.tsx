// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { Timeline } from './Timeline.js'

/**
 * Scale guard for the long-session render path.
 *
 * `docs/quality.md` requires the timeline to stay usable with at least 10,000
 * nodes and forbids relying on a full DOM. jsdom is not a browser: these tests
 * measure DOM node counts and wall-clock work under a simulated viewport, not
 * real paint or scroll performance. They exist to catch a regression where the
 * render path stops windowing and materialises the whole conversation.
 */
const VIEWPORT_HEIGHT = 200
const ROW_ESTIMATED_HEIGHT = 96
const LARGE_SESSION_TURNS = 5_000
const LARGE_SESSION_NODES = LARGE_SESSION_TURNS * 2
/** A full materialisation would produce one row per node; anything of that
 * order means windowing is off. The measured window is far below this. */
const MAX_EXPECTED_ROWS = 200
const MAX_EXPECTED_DOM_ELEMENTS = 2_000

function largeSessionNodes(turns = LARGE_SESSION_TURNS): readonly TimelineNode[] {
  const nodes: TimelineNode[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    nodes.push({
      kind: 'user-message',
      id: `user-${turn}`,
      markdown: `Question ${turn}`,
    })
    nodes.push({
      kind: 'assistant-message',
      id: `assistant-${turn}`,
      markdown: `Answer ${turn}`,
      streaming: false,
    })
  }
  return nodes
}

interface Measurements {
  readonly rows: number
  readonly elements: number
  readonly millis: number
}

function measure(container: HTMLElement, millis: number): Measurements {
  return {
    rows: container.querySelectorAll('.dsh-timeline__row').length,
    elements: container.querySelectorAll('*').length,
    millis: Math.round(millis * 100) / 100,
  }
}

function withViewport(body: () => void): void {
  const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains('dsh-timeline')) return VIEWPORT_HEIGHT
      if (this.classList.contains('dsh-timeline__row')) return ROW_ESTIMATED_HEIGHT
      return 0
    },
  })
  try {
    body()
  } finally {
    if (offsetHeightDescriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
    else Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor)
  }
}

describe('Long-session timeline scale', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('mounts a 10,000-node conversation inside a bounded window', () => {
    withViewport(() => {
      const nodes = largeSessionNodes()
      expect(nodes).toHaveLength(LARGE_SESSION_NODES)

      const startedAt = performance.now()
      const view = render(<Timeline sessionId="session-scale" nodes={nodes} streaming={false} />)
      const mounted = measure(view.container, performance.now() - startedAt)
      try {
        const canvas = view.container.querySelector('.dsh-timeline__canvas')
        expect(canvas?.classList.contains('dsh-timeline__canvas--virtualized')).toBe(true)
        expect(canvas?.classList.contains('dsh-timeline__canvas--virtualized-ready')).toBe(true)

        expect(mounted.rows).toBeGreaterThan(0)
        expect(mounted.rows).toBeLessThanOrEqual(MAX_EXPECTED_ROWS)
        expect(mounted.elements).toBeLessThanOrEqual(MAX_EXPECTED_DOM_ELEMENTS)
        console.log(
          `[timeline-scale] mount nodes=${nodes.length} rows=${mounted.rows} elements=${mounted.elements} ms=${mounted.millis}`,
        )
      } finally {
        view.unmount()
      }
    })
  })

  it('keeps a streamed frame cheap and the tail visible with 10,000 nodes mounted', () => {
    withViewport(() => {
      const nodes = largeSessionNodes()
      const view = render(<Timeline sessionId="session-scale" nodes={nodes} streaming={false} />)
      try {
        const timeline = view.container.querySelector<HTMLDivElement>('.dsh-timeline')
        expect(timeline).not.toBeNull()
        if (timeline === null) throw new Error('the timeline shell is not rendered')
        // Model a reader who is following the stream: the window is at the tail.
        timeline.scrollTop = LARGE_SESSION_NODES * ROW_ESTIMATED_HEIGHT
        fireEvent.scroll(timeline)

        const last = nodes[nodes.length - 1]
        if (last === undefined) throw new Error('the fixture produced no tail node')
        const extendedTail: TimelineNode = {
          kind: 'assistant-message',
          id: last.id,
          markdown: 'Answer 4999 extended',
          streaming: false,
        }
        const startedAt = performance.now()
        view.rerender(
          <Timeline sessionId="session-scale" nodes={[...nodes.slice(0, -1), extendedTail]} streaming />,
        )
        const updated = measure(view.container, performance.now() - startedAt)

        expect(updated.rows).toBeGreaterThan(0)
        expect(updated.rows).toBeLessThanOrEqual(MAX_EXPECTED_ROWS)
        expect(updated.elements).toBeLessThanOrEqual(MAX_EXPECTED_DOM_ELEMENTS)
        const tail = view.container.querySelector<HTMLElement>(
          '.dsh-timeline__row[data-node-id="assistant-4999"]',
        )
        expect(view.container.textContent).toContain('Answer 4999 extended')
        expect(tail).not.toBeNull()
        console.log(
          `[timeline-scale] delta nodes=${nodes.length} rows=${updated.rows} elements=${updated.elements} ms=${updated.millis}`,
        )
      } finally {
        view.unmount()
      }
    })
  })
})
