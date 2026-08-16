import type { ReactElement } from 'react'
import { Icon } from '../../ui/Icon.js'

export interface RuntimeMissingViewProps {
  readonly searchedLocations: readonly string[]
  readonly busyAction: 'install' | 'select' | undefined
  readonly onAction: (action: 'install' | 'select' | 'copy-command' | 'open-docs') => void
  readonly onRetry?: () => void
}

export function RuntimeMissingView(props: RuntimeMissingViewProps): ReactElement {
  return (
    <section className="dsh-runtime-missing" aria-labelledby="runtime-missing-title">
      <div className="dsh-runtime-missing__intro">
        <span className="dsh-app__eyebrow">RUNTIME CHECK · 运行环境检查</span>
        <div className="dsh-runtime-missing__title-row">
          <span className="dsh-runtime-missing__icon" aria-hidden="true">
            <Icon name="box" />
          </span>
          <h1 id="runtime-missing-title">DeepSeek Harness isn&apos;t ready yet</h1>
        </div>
        <p className="dsh-runtime-missing__description">
          DSH runs locally in the VS Code Extension Host. Install <code>@deepseek-ai/dsh</code> with Node.js
          22.19+ or use an existing executable.
        </p>
      </div>
      <ol className="dsh-runtime-missing__steps" aria-label="Setup steps">
        <li>
          Install DSH, or select the <code>dsh</code> executable you already use.
        </li>
        <li>After installation, the extension reconnects automatically.</li>
        <li>If DSH is installed outside PATH, copy the command or open the documentation.</li>
      </ol>
      <div className="dsh-runtime-missing__actions">
        <button
          className="dsh-button dsh-button--primary"
          type="button"
          disabled={props.busyAction === 'install'}
          onClick={() => props.onAction('install')}
        >
          {props.busyAction === 'install' ? 'Installing… / 安装中…' : 'Install DSH / 安装 DSH'}
        </button>
        <button
          className="dsh-button dsh-button--secondary"
          type="button"
          disabled={props.busyAction === 'select'}
          onClick={() => props.onAction('select')}
        >
          {props.busyAction === 'select' ? 'Selecting… / 选择中…' : 'Select DSH / 选择 DSH'}
        </button>
        <button
          className="dsh-button dsh-button--ghost"
          type="button"
          onClick={() => props.onAction('copy-command')}
        >
          Copy command / 复制命令
        </button>
        <button className="dsh-button dsh-button--ghost" type="button" onClick={props.onRetry}>
          Retry / 重试
        </button>
        <button
          className="dsh-button dsh-button--ghost"
          type="button"
          onClick={() => props.onAction('open-docs')}
        >
          Docs / 文档
        </button>
      </div>
      <details>
        <summary>Searched locations ({props.searchedLocations.length})</summary>
        <ul>
          {props.searchedLocations.map((location) => (
            <li key={location}>
              <code>{location}</code>
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
