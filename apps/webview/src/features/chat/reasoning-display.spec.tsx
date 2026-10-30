// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { reasoningDisplayText } from './reasoning-display.js'
import { Timeline } from './Timeline.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

afterEach(cleanup)

describe('rc.5 reasoning presentation', () => {
  it.each([
    '',
    'Ordinary reasoning',
    '普通思考正文',
    '\n  Original text  \n',
    '<note>Original text</note>',
    '<signature-like>Ordinary text</signature-like>',
    'Explain <signature> as literal text',
  ])('preserves ordinary reasoning %j', (text) => {
    expect(reasoningDisplayText(text)).toBe(text)
  })

  it.each(['<', '<sign', '<signature>', '<signature>opaque', '<signature>opaque</sign'])(
    'waits for the entire leading signature before displaying %j',
    (text) => expect(reasoningDisplayText(text)).toBe(''),
  )

  it('removes only the first leading envelope and its following line breaks', () => {
    expect(reasoningDisplayText('<signature>opaque</signature>\r\n\n  Visible thought\n')).toBe(
      '  Visible thought\n',
    )
    expect(reasoningDisplayText('<signature>opaque</signature>')).toBe('')
    expect(reasoningDisplayText('<signature>opaque</signature>\nExplain <signature> literally')).toBe(
      'Explain <signature> literally',
    )
    expect(
      reasoningDisplayText('<signature>opaque</signature>\n<signature>literal example</signature>'),
    ).toBe('<signature>literal example</signature>')
  })

  it.each(['classic', 'focused'] as const)(
    'keeps signature-only streams hidden and reveals growing reasoning in %s layout',
    (layout) => {
      const view = (markdown: string, streaming = true): ReactElement => (
        <ConversationLayoutProvider initialLayout={layout}>
          <Timeline
            sessionId="signed-stream"
            streaming={streaming}
            nodes={[{ kind: 'reasoning', id: 'reasoning-stream', markdown, streaming }]}
          />
        </ConversationLayoutProvider>
      )
      const result = render(view('<sign'))
      for (const raw of ['<signature>opaque', '<signature>opaque</signature>\n']) {
        result.rerender(view(raw))
        expect(screen.queryByRole('button', { name: 'Show reasoning' })).toBeNull()
        expect(result.container.textContent).not.toContain('opaque')
      }
      const raw = '<signature>opaque</signature>\nVisible thought\nMore detail'
      result.rerender(view(raw))
      fireEvent.click(screen.getByRole('button', { name: 'Show reasoning' }))
      expect(result.container.textContent).toContain('Visible thought')
      result.rerender(view(`${raw}\nExpanded update`))
      expect(result.container.textContent).toContain('Expanded update')
      result.rerender(view(`${raw}\nExpanded update`, false))
      expect(result.container.textContent).toContain('Expanded update')
      expect(result.container.textContent).not.toContain('opaque')
    },
  )

  it.each(['classic', 'focused'] as const)(
    'cleans every grouped step without changing the raw source or answer in %s layout',
    (layout) => {
      const first = '<signature>opaque-first</signature>\nFirst visible thought'
      const second = '<signature>opaque-second</signature>\nSecond visible thought'
      const nodes: readonly TimelineNode[] = [
        { kind: 'reasoning', id: 'step-one', markdown: first, streaming: false },
        {
          kind: 'assistant-message',
          id: 'step-two',
          markdown: 'Final answer',
          streaming: false,
          reasoning: { markdown: second, streaming: false },
        },
      ]
      const result = render(
        <ConversationLayoutProvider initialLayout={layout}>
          <Timeline sessionId="signed-steps" streaming={false} nodes={nodes} />
        </ConversationLayoutProvider>,
      )
      for (const toggle of screen.getAllByRole('button', { name: 'Show reasoning' })) fireEvent.click(toggle)
      expect(result.container.textContent).toContain('First visible thought')
      expect(result.container.textContent).toContain('Second visible thought')
      expect(result.container.textContent).toContain('Final answer')
      expect(result.container.textContent).not.toContain('opaque-')
      expect(nodes[0]).toMatchObject({ markdown: first })
      expect(nodes[1]).toMatchObject({ reasoning: { markdown: second } })
    },
  )
})
