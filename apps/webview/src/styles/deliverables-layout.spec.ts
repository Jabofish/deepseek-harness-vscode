import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appStyles = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8')

describe('rc.2 deliverables layout', () => {
  it('keeps delivered-file icons compact and closes the produced-files gap', () => {
    expect(appStyles).toMatch(
      /\.dsh-timeline__presented-file-main\s*>\s*\.dsh-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/s,
    )
    expect(appStyles).toMatch(/\.dsh-timeline__produced-files\s*\{[^}]*margin-top:\s*var\(--dsh-space-1\);/s)
  })
})
