import { useMemo, useState, type ReactElement } from 'react'
import type { ToolTerminalRenderProps } from '@dsh-vscode/ui'
import { CopyButton } from './CopyButton.js'
import { useI18n } from '../../i18n.js'

const DEFAULT_MAX_LINES = 16

/**
 * Webview renderer for the structured terminal result contract. The raw
 * output stays escaped plain text: this card deliberately does not interpret
 * ANSI/TUI bytes or infer state from output, while still matching DSH's
 * bounded output, copy, and explicit exit-status affordances.
 */
export function ToolTerminalPreview(props: ToolTerminalRenderProps): ReactElement {
  const { t: defaultTranslate } = useI18n()
  const translate = props.translate ?? defaultTranslate
  const output = props.view.output ?? ''
  const lines = useMemo(() => outputLines(output), [output])
  const [expanded, setExpanded] = useState(false)
  const hidden = Math.max(0, lines.length - DEFAULT_MAX_LINES)
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(DEFAULT_MAX_LINES / 2)
  const tailLines = DEFAULT_MAX_LINES - headLines
  const status = terminalStatus(props.view, translate)
  const empty = output.trim() === ''

  return (
    <div className="dsh-tool-terminal-preview" data-terminal="" data-empty={empty ? 'true' : 'false'}>
      <div className="dsh-tool-terminal-preview__header">
        <span
          className={`dsh-tool-terminal-preview__status${status?.error === true ? ' dsh-tool-terminal-preview__status--error' : ''}`}
          aria-label={status?.label}
        >
          {status?.label ?? ''}
        </span>
        {empty ? null : (
          <CopyButton text={output} className="dsh-tool-terminal-preview__copy" translate={translate} />
        )}
      </div>
      {empty ? (
        <div className="dsh-tool-terminal-preview__empty">{translate('toolrow.presentation.noOutput')}</div>
      ) : (
        <pre className="dsh-tool-terminal-preview__body">
          {(capped ? lines.slice(0, headLines) : lines).map((line, index) => (
            <span className="dsh-tool-terminal-preview__line" key={`${index}:${line}`}>
              {line}
            </span>
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              className="dsh-tool-terminal-preview__fold"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? translate('toolrow.presentation.collapseTerminalLines')
                  : translate('toolrow.presentation.expandTerminalLines', { count: hidden })
              }
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? translate('toolrow.presentation.collapseTerminalLines')
                : translate('toolrow.presentation.expandTerminalLines', { count: hidden })}
            </button>
          ) : null}
          {capped
            ? lines.slice(lines.length - tailLines).map((line, index) => (
                <span
                  className="dsh-tool-terminal-preview__line"
                  key={`${lines.length - tailLines + index}:${line}`}
                >
                  {line}
                </span>
              ))
            : null}
        </pre>
      )}
    </div>
  )
}

function outputLines(output: string): readonly string[] {
  if (output === '') return []
  const normalized = output.replace(/\r\n?/gu, '\n')
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  return body.split('\n')
}

function terminalStatus(
  view: ToolTerminalRenderProps['view'],
  translate: NonNullable<ToolTerminalRenderProps['translate']>,
): { readonly label: string; readonly error: boolean } | undefined {
  if (view.signal !== undefined)
    return {
      label: `${translate('toolrow.presentation.signal')}: ${view.signal}`,
      error: true,
    }
  if (view.exitCode === undefined) return undefined
  return {
    label: `${translate('toolrow.presentation.exit')}: ${view.exitCode}`,
    error: view.exitCode !== 0,
  }
}
