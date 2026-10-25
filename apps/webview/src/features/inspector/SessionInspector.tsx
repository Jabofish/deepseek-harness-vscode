import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Drawer } from '@dsh-vscode/ui'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { TranscriptEventFact } from '@dsh-vscode/webview-protocol'
import type { AppStore } from '../../app/store.js'
import { useI18n } from '../../i18n.js'
import { inspectChatNode, type InspectorRecord } from './inspector-model.js'
import { InspectorDevtoolsActions } from './InspectorDevtoolsActions.js'
import './inspector.css'
import { createDisplayNodeProjector } from '../chat/timeline-projection.js'
import { timelineSourceNodeIds } from '../chat/timeline-inspector-target.js'
import type { TranscriptViewMode } from '../../app/ui-preferences.js'
import { Icon } from '../../ui/Icon.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'

const PAGE_SIZE = 100
export function SessionInspector(props: {
  readonly eventFacts?: readonly TranscriptEventFact[]
  readonly nodes: readonly TimelineNode[]
  readonly hasMore: boolean
  readonly loading: boolean
  readonly loadOlder: () => Promise<void> | void
  readonly featureRequest: AppStore['featureRequest']
  readonly showDshEvents?: boolean
  readonly transcriptView?: TranscriptViewMode
  readonly onRevealNode?: (nodeId: string) => void
  /** A fresh request opens this mounted session; remounts ignore older requests. */
  readonly openRequestId?: string | undefined
  readonly showTrigger?: boolean
}): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [lastOpenRequestId, setLastOpenRequestId] = useState(props.openRequestId)
  const [source, setSource] = useState<'events' | 'nodes'>('events')
  const [filter, setFilter] = useState('')
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const loading = useRef(false)
  const selectedRowRef = useRef<HTMLLIElement>(null)
  if (lastOpenRequestId !== props.openRequestId) {
    setLastOpenRequestId(props.openRequestId)
    setPicking(false)
    setOpen(props.openRequestId !== undefined)
  }
  const displayProjector = useMemo(() => createDisplayNodeProjector(), [])
  const records = useMemo<readonly InspectorRecord[]>(
    () =>
      !open
        ? []
        : [
            ...(props.eventFacts ?? []).map((fact) => ({
              id: fact.id,
              source: 'events' as const,
              type: fact.type,
              sequence: fact.sequence,
              fields: {
                coordinates: {
                  sequence: fact.sequence,
                  ...(fact.turn === undefined ? {} : { turn: fact.turn }),
                  ...(fact.step === undefined ? {} : { step: fact.step }),
                  ...(fact.attempt === undefined ? {} : { attempt: fact.attempt }),
                },
                structure: { representedSequences: fact.representedSequences },
              },
            })),
            ...props.nodes.map(inspectChatNode),
          ],
    [open, props.nodes, props.eventFacts],
  )
  const sourceRecords = useMemo(() => records.filter((record) => record.source === source), [records, source])
  const types = useMemo(
    () => [...new Set(sourceRecords.map((record) => record.type))].sort(),
    [sourceRecords],
  )
  const filtered = useMemo(
    () => sourceRecords.filter((record) => filter === '' || record.type === filter),
    [filter, sourceRecords],
  )
  const end = Math.max(0, filtered.length - offset)
  const start = Math.max(0, end - PAGE_SIZE)
  // The records map runs per streaming patch while the drawer is open; these
  // two derived scans would otherwise run again on every unrelated render.
  const selected = useMemo(() => records.find((record) => record.id === selectedId), [records, selectedId])
  useEffect(() => {
    if (open) selectedRowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [open, selectedId])
  const matches = useMemo(
    () =>
      selected?.sequence === undefined
        ? []
        : records.filter(
            (record) => record.source !== selected.source && record.sequence === selected.sequence,
          ),
    [records, selected],
  )
  const selectRecord = (record: InspectorRecord): void => {
    const sameSource = records.filter((candidate) => candidate.source === record.source)
    const index = sameSource.findIndex((candidate) => candidate.id === record.id)
    setSource(record.source)
    setFilter('')
    setOffset(Math.floor((sameSource.length - 1 - Math.max(0, index)) / PAGE_SIZE) * PAGE_SIZE)
    setSelectedId(record.id)
  }
  useEffect(() => {
    if (!picking) return
    const pick = (event: MouseEvent): void => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('.dsh-timeline__row[data-node-id]')
          : null
      const display = displayProjector(
        props.nodes,
        props.showDshEvents ?? false,
        props.transcriptView ?? 'standard',
      ).nodes.find((item) => item.id === target?.dataset.nodeId)
      const sourceIds = display === undefined ? [target?.dataset.nodeId] : timelineSourceNodeIds(display)
      const node = props.nodes.find((item) => sourceIds.includes(item.id))
      if (node === undefined) return
      event.preventDefault()
      event.stopPropagation()
      setSource('nodes')
      setFilter('')
      setSelectedId(`node:${node.id}`)
      setOffset(Math.floor((props.nodes.length - 1 - props.nodes.indexOf(node)) / PAGE_SIZE) * PAGE_SIZE)
      setPicking(false)
      setOpen(true)
    }
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPicking(false)
    }
    document.addEventListener('click', pick, true)
    document.addEventListener('keydown', cancel)
    return () => {
      document.removeEventListener('click', pick, true)
      document.removeEventListener('keydown', cancel)
    }
  }, [displayProjector, picking, props.nodes, props.showDshEvents, props.transcriptView])
  const openInspector = (): void => {
    setPicking(false)
    setOpen(true)
  }
  return (
    <>
      {props.showTrigger === false ? null : (
        <button
          type="button"
          className="dsh-button dsh-button--secondary dsh-button--compact"
          onClick={openInspector}
        >
          {t('inspector.title')}
        </button>
      )}
      {picking ? (
        <span role="status">
          {t('inspector.pickHint')}{' '}
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            onClick={() => setPicking(false)}
          >
            {t('inspector.cancelPick')}
          </button>
        </span>
      ) : null}
      <Drawer title={t('inspector.title')} open={open} onClose={() => setOpen(false)}>
        {open ? (
          <div className="dsh-session-inspector">
            <div className="dsh-session-inspector__filters">
              <label>
                <span>{t('inspector.source')}</span>
                <SelectMenu
                  icon="list"
                  density="regular"
                  label={t(source === 'events' ? 'inspector.events' : 'inspector.nodes')}
                  ariaLabel={t('inspector.source')}
                  title={t('inspector.source')}
                  value={source}
                  options={[
                    { value: 'events', label: t('inspector.events') },
                    { value: 'nodes', label: t('inspector.nodes') },
                  ]}
                  onChange={(value) => {
                    setSource(value === 'nodes' ? 'nodes' : 'events')
                    setFilter('')
                    setOffset(0)
                    setSelectedId(undefined)
                  }}
                />
              </label>
              <label>
                <span>{t('inspector.filter')}</span>
                <SelectMenu
                  icon="list"
                  density="regular"
                  label={filter || t('inspector.all')}
                  ariaLabel={t('inspector.filter')}
                  title={t('inspector.filter')}
                  value={filter}
                  options={[
                    { value: '', label: t('inspector.all') },
                    ...types.map((type) => ({ value: type, label: type })),
                  ]}
                  onChange={(value) => {
                    setFilter(value)
                    setOffset(0)
                    setSelectedId(undefined)
                  }}
                />
              </label>
            </div>
            <div className="dsh-session-inspector__toolbar">
              <div className="dsh-session-inspector__actions">
                <button
                  type="button"
                  disabled={start === 0}
                  onClick={() => setOffset((value) => value + PAGE_SIZE)}
                >
                  <Icon name="chevron-left" />
                  {t('inspector.previous')}
                </button>
                <button
                  type="button"
                  disabled={offset === 0}
                  onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
                >
                  {t('inspector.next')}
                  <Icon name="chevron-right" />
                </button>
              </div>
              <div className="dsh-session-inspector__actions">
                <button
                  type="button"
                  disabled={!props.hasMore || props.loading}
                  onClick={() => {
                    if (loading.current) return
                    loading.current = true
                    setLoadFailed(false)
                    void Promise.resolve()
                      .then(() => props.loadOlder())
                      .catch(() => setLoadFailed(true))
                      .finally(() => {
                        loading.current = false
                      })
                  }}
                >
                  {t('inspector.loadOlder')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    setPicking(true)
                  }}
                >
                  {t('inspector.pick')}
                </button>
              </div>
            </div>
            {loadFailed ? <p role="alert">{t('inspector.loadFailed')}</p> : null}
            <InspectorDevtoolsActions featureRequest={props.featureRequest} />
            <div className="dsh-session-inspector__results-header">
              <h3>{t(source === 'events' ? 'inspector.events' : 'inspector.nodes')}</h3>
              <p role="status">
                {t('inspector.rows', {
                  count: filtered.length,
                  start: filtered.length === 0 ? 0 : start + 1,
                  end,
                })}
              </p>
            </div>
            {filtered.length === 0 ? (
              <p className="dsh-session-inspector__empty">{t('inspector.empty')}</p>
            ) : null}
            <ol className="dsh-session-inspector__rows" start={start + 1}>
              {filtered.slice(start, end).map((record) => (
                <li key={record.id} ref={selectedId === record.id ? selectedRowRef : undefined}>
                  <button
                    type="button"
                    className="dsh-session-inspector__row"
                    aria-pressed={selectedId === record.id}
                    onClick={() => setSelectedId(record.id)}
                  >
                    {record.sequence === undefined ? null : (
                      <span className="dsh-session-inspector__sequence">#{record.sequence}</span>
                    )}{' '}
                    <span className="dsh-session-inspector__type">{record.type}</span>
                    <Icon name="chevron-right" />
                  </button>
                  {selected === undefined || selected.id !== record.id ? null : (
                    <section className="dsh-session-inspector__detail" aria-label={t('inspector.detail')}>
                      <h3>{selected.type}</h3>
                      {Object.entries(selected.fields).map(([field, value]) => (
                        <details key={field} open>
                          <summary>{field}</summary>
                          <dl>
                            {Object.entries(value).map(([key, count]) => (
                              <div key={key}>
                                <dt>{key}</dt>
                                <dd>{String(count)}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ))}
                      {matches.map((record) => (
                        <button key={record.id} type="button" onClick={() => selectRecord(record)}>
                          {t('inspector.match', { type: record.type })}
                        </button>
                      ))}
                      {selected.nodeId === undefined || props.onRevealNode === undefined ? null : (
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(false)
                            if (selected.nodeId !== undefined) props.onRevealNode?.(selected.nodeId)
                          }}
                        >
                          {t('inspector.reveal')}
                        </button>
                      )}
                    </section>
                  )}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
