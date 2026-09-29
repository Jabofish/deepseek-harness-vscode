// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { DEFAULT_UNMEASURED_ROW_WINDOW } from '../../components/common/index.js'
import { Timeline } from './Timeline.js'
import type * as TimelineRowModule from './TimelineRow.js'

/**
 * Regression guard for the frame the timeline renders before the virtualizer
 * owns a measured viewport.
 *
 * `useVirtualizedCollection` reports `ready: false` in that frame, so the
 * caller falls back to a plain list. That list has to stay bounded: it runs
 * before any measurement exists, so an unbounded collection compares and
 * renders every node once, and the cost lands exactly when a long conversation
 * is opened. jsdom cannot observe paint, so these tests count `TimelineRow`
 * renders and inspect the fallback indexes rather than measure scroll speed.
 */
const counters = vi.hoisted(() => ({ rowRenders: 0 }))

vi.mock('./TimelineRow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineRowModule>()
  return {
    TimelineRow: (props: Parameters<typeof actual.TimelineRow>[0]) => {
      counters.rowRenders += 1
      return createElement(actual.TimelineRow, props)
    },
  }
})

const VIEWPORT_HEIGHT = 200
const ROW_ESTIMATED_HEIGHT = 96

function sessionNodes(turns: number): readonly TimelineNode[] {
  const nodes: TimelineNode[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    nodes.push({ kind: 'user-message', id: `user-${turn}`, markdown: `Question ${turn}` })
    nodes.push({
      kind: 'assistant-message',
      id: `assistant-${turn}`,
      markdown: `Answer ${turn}`,
      streaming: false,
    })
  }
  return nodes
}

interface Measurement {
  readonly turns: number
  readonly renders: number
  readonly rows: number
}

function mountAndCount(turns: number): Measurement {
  counters.rowRenders = 0
  const view = render(
    <Timeline sessionId="session-unmeasured" nodes={sessionNodes(turns)} streaming={false} />,
  )
  const measurement: Measurement = {
    turns,
    renders: counters.rowRenders,
    rows: view.container.querySelectorAll('.dsh-timeline__row').length,
  }
  view.unmount()
  return measurement
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

describe('Timeline unmeasured window', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('bounds the first frame and does not scale it with the conversation length', () => {
    withViewport(() => {
      const measurements = [200, 1_000, 5_000].map(mountAndCount)
      console.log(`[timeline-unmeasured] ${JSON.stringify(measurements)}`)
      const renders = measurements.map((entry) => entry.renders)
      // The fallback frame and the first measured window are both constants. A
      // regression to rendering every node shows up as this list growing with
      // the conversation instead of staying flat.
      expect(new Set(renders).size).toBe(1)
      expect(renders[0]).toBeGreaterThan(0)
      expect(renders[0]).toBeLessThanOrEqual(DEFAULT_UNMEASURED_ROW_WINDOW * 2)
      for (const entry of measurements) expect(entry.rows).toBeLessThanOrEqual(VIEWPORT_HEIGHT)
    })
  })

  it('anchors the unmeasured frame at the tail with indexes into the full list', () => {
    const nodes = sessionNodes(500)
    const view = render(<Timeline sessionId="session-unmeasured" nodes={nodes} streaming={false} />)
    try {
      const rows = Array.from(view.container.querySelectorAll<HTMLElement>('.dsh-timeline__row'))
      // No viewport rect in jsdom, so this is the fallback frame: the newest
      // rows, each still indexed against the whole conversation.
      expect(rows).toHaveLength(DEFAULT_UNMEASURED_ROW_WINDOW)
      expect(rows[0]?.dataset.index).toBe(String(nodes.length - DEFAULT_UNMEASURED_ROW_WINDOW))
      expect(rows[rows.length - 1]?.dataset.index).toBe(String(nodes.length - 1))
      expect(rows[rows.length - 1]?.dataset.nodeId).toBe(nodes[nodes.length - 1]?.id)
      expect(view.container.textContent).toContain('Answer 499')
    } finally {
      view.unmount()
    }
  })

  it('keeps the whole conversation when it is shorter than the window', () => {
    const nodes = sessionNodes(12)
    const view = render(<Timeline sessionId="session-unmeasured" nodes={nodes} streaming={false} />)
    try {
      const rows = Array.from(view.container.querySelectorAll<HTMLElement>('.dsh-timeline__row'))
      expect(rows).toHaveLength(nodes.length)
      expect(rows[0]?.dataset.index).toBe('0')
      expect(rows[rows.length - 1]?.dataset.index).toBe(String(nodes.length - 1))
    } finally {
      view.unmount()
    }
  })
})
