// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MarkdownDocumentPreview, splitDocumentFrontmatter } from './MarkdownDocumentPreview.js'

afterEach(cleanup)
describe('Markdown document frontmatter preview', () => {
  it('splits only a complete leading block, including BOM, CRLF and empty fields', () => {
    expect(splitDocumentFrontmatter('\uFEFF---\r\ntitle: Doc\r\n...\r\n# Body')).toEqual({
      source: 'title: Doc',
      body: '# Body',
    })
    expect(splitDocumentFrontmatter('---\n---\nBody')).toEqual({ source: '', body: 'Body' })
    expect(splitDocumentFrontmatter('Text\n---\nkey: value\n---')).toBeUndefined()
    expect(splitDocumentFrontmatter('---\nkey: value')).toBeUndefined()
  })
  it('renders fields and body safely, and preserves invalid YAML verbatim', async () => {
    const view = render(
      <MarkdownDocumentPreview
        text={
          '---\ntitle: "<script>unsafe</script>"\ncount: 1.0\n---\n# Document\n![remote](https://private/image.png)'
        }
      />,
    )
    expect(await screen.findByText('1.0')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Document' })).toBeDefined()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    view.rerender(<MarkdownDocumentPreview text={'---\nbroken: [\n---\n# After'} />)
    expect(screen.getByText('broken: [')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'After' })).toBeDefined()
  })
})
