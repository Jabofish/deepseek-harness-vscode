import { describe, expect, it } from 'vitest'
import { reconstructChangeBaseline } from './changes.js'

describe('reconstructChangeBaseline', () => {
  it('undoes every hunk, last first, and keeps untouched text', () => {
    const current = 'a\nB\nc\nd\ne\nF\ng\n'
    const diffs = [
      { oldText: 'a\nb\nc', newText: 'a\nB\nc' },
      { oldText: 'e\nf\ng', newText: 'e\nF\ng' },
    ]
    expect(reconstructChangeBaseline(current, 'modified', diffs)).toBe('a\nb\nc\nd\ne\nf\ng\n')
  })

  it('removes a pure insertion and treats a created file as empty', () => {
    expect(reconstructChangeBaseline('x\nnew\ny\n', 'modified', [{ oldText: null, newText: 'new\n' }])).toBe(
      'x\ny\n',
    )
    expect(reconstructChangeBaseline('hello\n', 'added', [{ oldText: null, newText: 'hello\n' }])).toBe('')
  })

  it('matches LF hunks against a CRLF document', () => {
    expect(
      reconstructChangeBaseline('one\r\nTWO\r\nthree\r\n', 'modified', [
        { oldText: 'one\ntwo\nthree', newText: 'one\nTWO\nthree' },
      ]),
    ).toBe('one\r\ntwo\r\nthree\r\n')
  })

  it('refuses when the file moved on or the previous text was never seen', () => {
    expect(
      reconstructChangeBaseline('a\nZ\nc\n', 'modified', [{ oldText: 'a\nb\nc', newText: 'a\nB\nc' }]),
    ).toBeUndefined()
    expect(
      reconstructChangeBaseline('whole\n', 'modified', [{ oldText: null, newText: 'whole\n' }]),
    ).toBeUndefined()
    expect(reconstructChangeBaseline('a\n', 'modified', [])).toBeUndefined()
  })

  it('undoes edits applied in sequence even when a later edit sits above an earlier one', () => {
    // Edit 1 changed line 5, edit 2 then changed line 1 of the result.
    const current = 'ONE\n2\n3\n4\nFIVE\n'
    const diffs = [
      { oldText: '5', newText: 'FIVE' },
      { oldText: '1', newText: 'ONE' },
    ]
    expect(reconstructChangeBaseline(current, 'modified', diffs)).toBe('1\n2\n3\n4\n5\n')
  })
})
