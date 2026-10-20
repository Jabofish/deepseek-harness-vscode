import { useMemo, type ReactElement } from 'react'
import type { ToolTerminalRenderProps } from '@dsh-vscode/ui'
import { CopyButton } from './CopyButton.js'
import { useI18n } from '../../i18n.js'

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
        <pre className="dsh-tool-terminal-preview__body" tabIndex={0}>
          {lines.map((line, index) => (
            <span className="dsh-tool-terminal-preview__line" key={`${index}:${line}`}>
              {line}
            </span>
          ))}
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
