import type { ReactElement } from 'react'
import type { SessionStatsProjection, TokenUsage } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import './stats-details.css'
export function StatsDetails(props: {
  readonly stats: SessionStatsProjection
  readonly usage: TokenUsage | undefined
}): ReactElement | null {
  const { t, locale } = useI18n()
  const exact = (value: number): string =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value)
  const stats = props.stats
  const usage = props.usage
  const rows: { readonly label: string; readonly value: string }[] = []
  if (stats.llmMs > 0) rows.push({ label: t('stats.llmTime'), value: `${exact(stats.llmMs)} ms` })
  if (stats.toolMs > 0) rows.push({ label: t('stats.toolTime'), value: `${exact(stats.toolMs)} ms` })
  if (stats.ttftSteps > 0) rows.push({ label: 'TTFT', value: `${exact(stats.ttftMs / stats.ttftSteps)} ms` })
  if (stats.decodeMs > 0 && stats.decodeTokens > 0)
    rows.push({
      label: t('stats.speed'),
      value: `${exact(stats.decodeTokens / (stats.decodeMs / 1000))} tk/s`,
    })
  if (usage !== undefined) {
    rows.push(
      { label: t('stats.uncachedInput'), value: exact(usage.inputTokens) },
      { label: t('stats.output'), value: exact(usage.outputTokens) },
    )
    if (usage.cacheReadTokens !== undefined)
      rows.push({ label: t('stats.cacheRead'), value: exact(usage.cacheReadTokens) })
    if (usage.cacheWriteTokens !== undefined)
      rows.push({ label: t('stats.cacheWrite'), value: exact(usage.cacheWriteTokens) })
    if (usage.totalTokens !== undefined)
      rows.push({ label: t('stats.totalTokens'), value: exact(usage.totalTokens) })
  }
  if (rows.length === 0) return null
  return (
    <details className="dsh-stats-details">
      <summary>{t('stats.details')}</summary>
      <dl>
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
