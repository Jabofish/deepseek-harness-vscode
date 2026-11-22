// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSurfaceFocusReport } from './useSurfaceFocusReport.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('reports initial focus, focus changes, and stops listening after unmount', () => {
  const report = vi.fn(() => Promise.resolve())
  const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  function View(): React.ReactElement {
    useSurfaceFocusReport(report)
    return <p>chat</p>
  }
  const view = render(<View />)
  expect(report).toHaveBeenLastCalledWith(true)

  focused.mockReturnValue(false)
  window.dispatchEvent(new Event('blur'))
  expect(report).toHaveBeenLastCalledWith(false)

  focused.mockReturnValue(true)
  window.dispatchEvent(new Event('focus'))
  expect(report).toHaveBeenLastCalledWith(true)

  const calls = report.mock.calls.length
  view.unmount()
  window.dispatchEvent(new Event('blur'))
  expect(report).toHaveBeenCalledTimes(calls)
})
