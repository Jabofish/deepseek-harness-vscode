import type { ReactElement } from 'react'
import type { Translate } from '../../i18n.js'
import { ContentFlow } from '../../components/common/index.js'
import { Icon } from '../../ui/Icon.js'
import type { ToolTimelineNode } from './ToolCallCollection.js'
import type { DisplayTimelineNode } from './timeline-shared.js'

export function renderDeliverables(
  node: Extract<DisplayTimelineNode, { readonly kind: 'deliverables' }>,
  onOpenLink: ((href: string) => void) | undefined,
  onShowInFolder: ((href: string) => void) | undefined,
  t: Translate,
): ReactElement {
  return (
    <section className="dsh-timeline__card dsh-timeline__card--event" aria-label={t('timeline.deliverables')}>
      <header className="dsh-timeline__card-header">
        <div className="dsh-timeline__card-heading">
          <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
            <Icon name="file" />
          </span>
          <strong>{t('timeline.deliverables')}</strong>
        </div>
        <span className="dsh-timeline__card-meta">{t('timeline.items', { count: node.files.length })}</span>
      </header>
      <ul className="dsh-timeline__event-list dsh-timeline__presented-files" data-presented-files-row="true">
        {node.files.map((file, index) => {
          const label = producedFileLabel(file.path)
          return (
            <li className="dsh-timeline__presented-file" key={`${file.path}:${index}`}>
              <div className="dsh-timeline__presented-file-main" title={file.path}>
                <Icon name="file" />
                <ContentFlow as="span" variant="truncate">
                  {label}
                </ContentFlow>
              </div>
              {file.description === undefined || file.description.trim() === '' ? null : (
                <span className="dsh-timeline__presented-file-description">{file.description}</span>
              )}
              <div className="dsh-timeline__presented-file-actions">
                {onOpenLink === undefined ? null : (
                  <button
                    className="dsh-button dsh-button--secondary dsh-button--compact"
                    type="button"
                    aria-label={t('timeline.openPresented', { name: label })}
                    onClick={() => onOpenLink(file.path)}
                  >
                    {t('timeline.openProduced', { name: label })}
                  </button>
                )}
                {onShowInFolder === undefined ? null : (
                  <button
                    className="dsh-button dsh-button--secondary dsh-button--compact"
                    type="button"
                    aria-label={t('timeline.revealPresented', { name: label })}
                    onClick={() => onShowInFolder(file.path)}
                  >
                    {t('timeline.showInFolder')}
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function renderProducedFiles(
  paths: readonly string[],
  onOpenLink: ((href: string) => void) | undefined,
  onShowInFolder: ((href: string) => void) | undefined,
  t: Translate,
): ReactElement | null {
  if (paths.length === 0) return null
  return (
    <div
      className="dsh-timeline__produced-files"
      data-produced-files-row="true"
      aria-label={t('timeline.producedFiles')}
    >
      <span className="dsh-timeline__produced-label">{t('timeline.producedFiles')}</span>
      <div className="dsh-timeline__produced-list">
        {paths.map((path) => {
          const label = producedFileLabel(path)
          return onOpenLink === undefined ? (
            <span className="dsh-timeline__produced-chip" key={path} title={path}>
              <Icon name="file" />
              <ContentFlow as="span" variant="truncate">
                {label}
              </ContentFlow>
            </span>
          ) : (
            <button
              className="dsh-timeline__produced-chip"
              key={path}
              type="button"
              title={path}
              aria-label={t('timeline.openProduced', { name: path })}
              onClick={() => onOpenLink(path)}
            >
              <Icon name="file" />
              <ContentFlow as="span" variant="truncate">
                {label}
              </ContentFlow>
            </button>
          )
        })}
      </div>
      {onShowInFolder === undefined ? null : (
        <button
          className="dsh-button dsh-button--secondary dsh-button--compact dsh-timeline__show-folder"
          type="button"
          onClick={() => onShowInFolder(paths[0]!)}
        >
          {t('timeline.showInFolder')}
        </button>
      )}
    </div>
  )
}

export function producedFilePaths(tools: readonly ToolTimelineNode[]): readonly string[] {
  const cached = producedFilePathsCache.get(tools)
  if (cached !== undefined) return cached

  const paths: string[] = []
  const seen = new Set<string>()
  for (const node of tools) {
    const tool = node.tool
    if (tool.status !== 'completed' || !isMutationTool(tool)) continue
    for (const location of tool.locations ?? []) {
      if (seen.has(location.path)) continue
      seen.add(location.path)
      paths.push(location.path)
      if (paths.length >= 6) {
        producedFilePathsCache.set(tools, paths)
        return paths
      }
    }
  }
  const result = paths.length === 0 ? EMPTY_PRODUCED_FILE_PATHS : paths
  producedFilePathsCache.set(tools, result)
  return result
}

// Timeline snapshots are immutable, so the tool-array identity safely scopes
// this projection cache without retaining completed conversations forever.
const producedFilePathsCache = new WeakMap<readonly ToolTimelineNode[], readonly string[]>()
const EMPTY_PRODUCED_FILE_PATHS: readonly string[] = []

function isMutationTool(tool: ToolTimelineNode['tool']): boolean {
  const metadata = tool.metadata
  return (
    tool.category === 'diff' ||
    tool.category === 'edit' ||
    metadata.card === 'diff' ||
    metadata.kind === 'edit'
  )
}

export function producedFileLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '')
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slash >= 0 && slash + 1 < normalized.length ? normalized.slice(slash + 1) : normalized
}
