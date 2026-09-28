import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  AgentPresetDescriptor,
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
} from '@dsh-vscode/domain'
import { PresetCard } from '../../components/common/PresetCard.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'
import { PresetCompositionModal, type PresetView } from './PresetCompositionModal.js'
import { PresetCopyDialog, copyBlocker, type CopyDraft } from './PresetCopyDialog.js'
import { PresetDeleteDialog } from './PresetDeleteDialog.js'
import { PresetGuideModal, type PresetGuideSelection } from './preset-guides.js'
import { builtInPresetId, presetDisplayDescription, presetDisplayName } from './preset-display.js'

export type { PresetCopyBlocker } from './PresetCopyDialog.js'

export interface PresetManagerProps {
  readonly onLoadRoster: () => Promise<AgentPresetRoster | undefined>
  readonly onReadDocument: (presetId: string) => Promise<AgentPresetDocument | undefined>
  readonly onCopy: (from: string, presetId: string, name?: string) => Promise<string | undefined>
  readonly onRemove: (presetId: string) => Promise<void>
  readonly onOpenLocation: (presetId: string) => Promise<AgentPresetLocation | undefined>
  readonly onStartCreatorDraft?: () => Promise<void>
  /** Writes the default field selected by the version adapter. */
  readonly onMakeDefault: (presetId: string, settingsPath?: string) => Promise<void>
  readonly defaultWritable?: boolean
  /** rc.2 Developer Tools preference gates preset selection and creation. */
  readonly codingToolsEnabled?: boolean | undefined
}

interface RosterState {
  readonly status: 'loading' | 'ready' | 'unavailable' | 'error'
  readonly rows: readonly AgentPresetDescriptor[]
  readonly authorable: boolean
  readonly compositionReadable?: boolean
  readonly canOpenPresetLocation?: boolean
  readonly canRemoveUserPresets?: boolean
  readonly modeSelectionEnabled?: boolean
  readonly defaultSettingPath?: string
  /** Absent when the host did not state whether it can open a directory natively. */
  readonly hasDocument: boolean | undefined
  readonly error: string | undefined
}

/**
 * The location action stays available whatever the host stated: the answer to
 * the request itself says whether the directory was opened or its path
 * revealed. Only the wording changes, and an unstated capability claims
 * neither behavior.
 */
function locationLabels(hasDocument: boolean | undefined): {
  readonly label: 'presets.openLocation' | 'presets.showLocation' | 'presets.location'
  readonly title: 'presets.openDirectory' | 'presets.showPath' | 'presets.locationUnknown'
} {
  if (hasDocument === true) return { label: 'presets.openLocation', title: 'presets.openDirectory' }
  if (hasDocument === false) return { label: 'presets.showLocation', title: 'presets.showPath' }
  return { label: 'presets.location', title: 'presets.locationUnknown' }
}

/**
 * The agent-preset management surface: the roster as cards grouped by trust,
 * version-supported authoring actions, built-in mode guidance, a read-only
 * viewer over declared compositions, and a location action for user presets.
 *
 * The Webview edits no composition text — a copy is host-side, and everything
 * after creation happens in the preset's own files.
 */
export function PresetManager(props: PresetManagerProps): ReactElement | null {
  const { t } = useI18n()
  const [roster, setRoster] = useState<RosterState>({
    status: 'loading',
    rows: [],
    authorable: false,
    hasDocument: undefined,
    error: undefined,
  })
  const [view, setView] = useState<PresetView | undefined>(undefined)
  const [guide, setGuide] = useState<PresetGuideSelection | undefined>(undefined)
  const [viewLoading, setViewLoading] = useState(false)
  const [viewError, setViewError] = useState<string | undefined>(undefined)
  const [copy, setCopy] = useState<CopyDraft | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const defaultWritable = props.defaultWritable !== false
  // Unknown is not an accepted Host value. The settings adapter supplies true
  // only after the connected Host has resolved the Developer Tools preference.
  const codingToolsEnabled = props.codingToolsEnabled === true
  const modeSelectionEnabled = codingToolsEnabled && roster.modeSelectionEnabled !== false
  const canSetDefault = defaultWritable && modeSelectionEnabled
  const [defaultingId, setDefaultingId] = useState<string | undefined>(undefined)
  const [revealedPaths, setRevealedPaths] = useState<Readonly<Record<string, string>>>({})
  const [creatorBusy, setCreatorBusy] = useState(false)
  const location = locationLabels(roster.hasDocument)
  const overlayRef = useRef<HTMLDivElement>(null)
  const overlayOpen =
    copy !== undefined ||
    pendingDelete !== undefined ||
    guide !== undefined ||
    viewLoading ||
    viewError !== undefined ||
    view !== undefined

  /**
   * Every preset modal is portalled out of this subtree, so the dismissal is
   * document-scoped. In-flight work keeps its modal: a copy or a removal that
   * is already on the wire must not lose its own progress or error surface.
   */
  const closeOverlay = (): void => {
    if (copy !== undefined) {
      if (!copy.saving) setCopy(undefined)
      return
    }
    if (pendingDelete !== undefined) {
      if (!deleting) setPendingDelete(undefined)
      return
    }
    if (guide !== undefined) {
      setGuide(undefined)
      return
    }
    if (viewLoading || roster.compositionReadable === false) return
    if (viewError !== undefined) {
      setViewError(undefined)
      return
    }
    setView(undefined)
  }
  // The overlays are `aria-modal`: while one is up, Tab must cycle inside it
  // and the settings surface behind it has to go inert.
  useDismissibleLayer({
    open: overlayOpen,
    refs: [overlayRef],
    onDismiss: closeOverlay,
    trapFocus: true,
  })

  /**
   * The modals are `aria-modal`, so the keyboard belongs inside while one is
   * up. Focus is captured from the control that opened the overlay rather than
   * from the effect, because the overlay mounts with its own `autoFocus`.
   */
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const overlayWasOpen = useRef(false)
  useEffect(() => {
    if (overlayWasOpen.current && !overlayOpen) {
      const target = restoreFocusRef.current
      restoreFocusRef.current = null
      // A removal deletes the row that opened the dialog; nothing to go back to.
      if (target !== null && target.isConnected) target.focus()
    }
    overlayWasOpen.current = overlayOpen
  }, [overlayOpen])

  const fetchRoster = (): Promise<void> =>
    props
      .onLoadRoster()
      .catch(() => undefined)
      .then((snapshot) => {
        if (snapshot === undefined) {
          setRoster((current) => ({
            ...current,
            status: 'error',
            error: t('presets.rosterError'),
          }))
          return
        }
        if (snapshot.presets.length === 0) {
          // A deployment that composes no presets has nothing to manage.
          setRoster({
            status: 'unavailable',
            rows: [],
            authorable: false,
            hasDocument: undefined,
            error: undefined,
          })
          return
        }
        setRoster({
          status: 'ready',
          rows: snapshot.presets,
          ...(snapshot.compositionReadable === undefined
            ? {}
            : { compositionReadable: snapshot.compositionReadable }),
          ...(snapshot.canOpenPresetLocation === undefined
            ? {}
            : { canOpenPresetLocation: snapshot.canOpenPresetLocation }),
          ...(snapshot.canRemoveUserPresets === undefined
            ? {}
            : { canRemoveUserPresets: snapshot.canRemoveUserPresets }),
          ...(snapshot.modeSelectionEnabled === undefined
            ? {}
            : { modeSelectionEnabled: snapshot.modeSelectionEnabled }),
          ...(snapshot.defaultSettingPath === undefined
            ? {}
            : { defaultSettingPath: snapshot.defaultSettingPath }),
          authorable: snapshot.authorable,
          hasDocument: snapshot.hasDocument,
          error: undefined,
        })
      })

  const load = (): Promise<void> => {
    // Event-triggered re-reads flip the indicator first; the first render
    // already starts out in 'loading'.
    setRoster((current) => ({ ...current, status: 'loading', error: undefined }))
    return fetchRoster()
  }

  useEffect(() => {
    void fetchRoster()
    // The section loads once when it first renders, as upstream does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const makeDefault = (id: string): void => {
    if (!canSetDefault || defaultingId !== undefined) return
    setDefaultingId(id)
    setRoster((current) => ({ ...current, error: undefined }))
    void (
      roster.defaultSettingPath === undefined
        ? props.onMakeDefault(id)
        : props.onMakeDefault(id, roster.defaultSettingPath)
    )
      .then(() => load())
      .catch((reason: unknown) =>
        setRoster((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : t('presets.rosterError'),
        })),
      )
      .finally(() => setDefaultingId(undefined))
  }

  const openComposition = (id: string): void => {
    if (viewLoading || roster.compositionReadable === false) return
    setView(undefined)
    setViewError(undefined)
    setViewLoading(true)
    void props
      .onReadDocument(id)
      .then((document) => {
        if (document === undefined) {
          setViewError(t('presets.compositionError'))
          return
        }
        setView({ id, title: document.name ?? document.id, content: document.content })
      })
      .catch((reason: unknown) =>
        setViewError(reason instanceof Error ? reason.message : t('presets.compositionError')),
      )
      .finally(() => setViewLoading(false))
  }

  const openLocation = (id: string): void => {
    void props
      .onOpenLocation(id)
      .catch(() => undefined)
      .then((location) => {
        if (location === undefined) {
          setRoster((current) => ({
            ...current,
            error: t('presets.locationError'),
          }))
          return
        }
        if (location.opened) return
        const path = location.path
        if (path === undefined) return
        setRevealedPaths((current) => ({ ...current, [id]: path }))
      })
  }

  const confirmCopy = (): void => {
    if (copy === undefined || copy.saving) return
    if (copyBlocker(copy, roster.rows) !== undefined) return
    const draft = copy
    setCopy({ ...draft, saving: true, error: undefined })
    void props
      .onCopy(draft.from, draft.id, draft.name)
      .catch((reason: unknown) => {
        setCopy((current) =>
          current === undefined
            ? current
            : {
                ...current,
                saving: false,
                error: reason instanceof Error ? reason.message : t('presets.copyError'),
              },
        )
        return undefined
      })
      .then((created) => {
        if (created === undefined) return
        setCopy(undefined)
        // A copy changes more than the row it targeted; re-read the roster.
        void load().then(() => openLocation(created))
      })
  }

  const remove = (): void => {
    if (pendingDelete === undefined || deleting) return
    setDeleting(true)
    setRoster((current) => ({ ...current, error: undefined }))
    void props
      .onRemove(pendingDelete)
      .then(() => {
        setPendingDelete(undefined)
        return load()
      })
      .catch((reason: unknown) =>
        setRoster((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : t('presets.rosterError'),
        })),
      )
      .finally(() => setDeleting(false))
  }

  if (roster.status === 'unavailable') return null
  if (roster.status === 'loading') {
    return (
      <div className="dsh-presets">
        <p className="dsh-settings__empty" role="status">
          {t('presets.loading')}
        </p>
      </div>
    )
  }
  if (roster.status === 'error') {
    return (
      <div className="dsh-presets">
        <p className="dsh-settings__error" role="alert">
          {roster.error}
        </p>
        <button
          className="dsh-button dsh-button--secondary dsh-button--compact"
          type="button"
          onClick={() => void load()}
        >
          {t('presets.retry')}
        </button>
      </div>
    )
  }

  const hasCordisPreset = roster.rows.some((row) => row.id === 'cordis' && row.broken === undefined)
  const creatorCard =
    hasCordisPreset && props.onStartCreatorDraft !== undefined ? (
      <button
        className="dsh-presets__creator-card"
        type="button"
        disabled={!codingToolsEnabled || creatorBusy}
        title={codingToolsEnabled ? t('presets.creatorDraftTitle') : t('presets.creatorDraftDisabled')}
        onClick={() => {
          if (creatorBusy) return
          setCreatorBusy(true)
          void props.onStartCreatorDraft!()
            .catch((reason: unknown) =>
              setRoster((current) => ({
                ...current,
                error: reason instanceof Error ? reason.message : t('presets.rosterError'),
              })),
            )
            .finally(() => setCreatorBusy(false))
        }}
      >
        <Icon name="add" />
        <span>{t('presets.creatorDraft')}</span>
      </button>
    ) : null

  return (
    <div className="dsh-presets">
      <p className="dsh-presets__intro">{t(roster.authorable ? 'presets.intro' : 'presets.introReadOnly')}</p>
      {roster.error === undefined ? null : (
        <p className="dsh-settings__error" role="alert">
          {roster.error}
        </p>
      )}
      {(
        [
          ['system', 'presets.builtInGroup'],
          ['user', 'presets.customGroup'],
        ] as const
      ).map(([trust, heading]) => {
        const group = roster.rows.filter((row) => row.trust === trust)
        if (group.length === 0)
          return trust === 'user' ? (
            <section className="dsh-presets__group" key={trust}>
              <h3>{t(heading)}</h3>
              {creatorCard}
              <p className="dsh-presets__empty-group">
                {t(roster.authorable ? 'presets.emptyCustom' : 'presets.emptyCustomCreator')}
              </p>
            </section>
          ) : null
        return (
          <section className="dsh-presets__group" key={trust}>
            <h3>{t(heading)}</h3>
            <ul className="dsh-presets__cards">
              {group.map((row) => {
                const name = presetDisplayName(row, t)
                const description = presetDisplayDescription(row, t)
                return (
                  <PresetCard
                    key={row.id}
                    className={
                      row.broken !== undefined
                        ? 'dsh-preset-card--broken'
                        : row.isDefault
                          ? 'dsh-preset-card--active'
                          : undefined
                    }
                    title={name}
                    description={description}
                    id={row.id}
                    reason={row.broken}
                    tags={
                      <>
                        {row.broken !== undefined ? (
                          <span className="dsh-presets__badge dsh-presets__badge--broken">
                            {t('presets.broken')}
                          </span>
                        ) : null}
                        <span className="dsh-presets__badge">
                          {row.trust === 'user' ? t('presets.custom') : t('presets.builtIn')}
                        </span>
                        {row.isDefault ? (
                          <span className="dsh-presets__badge dsh-presets__badge--in-use">
                            {t('presets.inUse')}
                          </span>
                        ) : null}
                      </>
                    }
                    mainPressed={row.isDefault}
                    mainDisabled={
                      row.isDefault ||
                      row.broken !== undefined ||
                      !canSetDefault ||
                      defaultingId !== undefined
                    }
                    mainLabel={`${
                      row.broken !== undefined
                        ? t('presets.broken')
                        : row.isDefault
                          ? t('presets.inUse')
                          : t('presets.setDefault')
                    }: ${name}`}
                    mainTitle={
                      row.broken ??
                      (row.isDefault
                        ? t('presets.inUse')
                        : !modeSelectionEnabled
                          ? t('presets.modeSelectionHidden')
                          : defaultWritable
                            ? t('presets.setDefault')
                            : t('presets.defaultReadOnly'))
                    }
                    onMainClick={() => makeDefault(row.id)}
                    footer={
                      <>
                        {roster.compositionReadable === false ? null : (
                          <button
                            className="dsh-icon-button"
                            type="button"
                            aria-label={t('presets.viewComposition', { name })}
                            title={t('presets.viewCompositionTitle')}
                            onClick={(event) => {
                              restoreFocusRef.current = event.currentTarget
                              openComposition(row.id)
                            }}
                          >
                            <Icon name="file" />
                          </button>
                        )}
                        {row.trust === 'user' && roster.canOpenPresetLocation !== false ? (
                          <button
                            className="dsh-icon-button"
                            type="button"
                            aria-label={t(location.label, {
                              name,
                            })}
                            title={t(location.title)}
                            onClick={() => openLocation(row.id)}
                          >
                            <Icon name="folder" />
                          </button>
                        ) : null}
                        {builtInPresetId(row) === undefined ? null : (
                          <div className="dsh-presets__guide-actions">
                            <button
                              className="dsh-button dsh-button--secondary dsh-button--compact"
                              type="button"
                              aria-label={t('presets.modeExplanationFor', { name })}
                              onClick={(event) => {
                                const id = builtInPresetId(row)
                                if (id === undefined) return
                                restoreFocusRef.current = event.currentTarget
                                setGuide({ id, title: name, page: 'explanation' })
                              }}
                            >
                              {t('presets.modeExplanation')}
                            </button>
                            <button
                              className="dsh-button dsh-button--secondary dsh-button--compact"
                              type="button"
                              aria-label={t('presets.howToUseFor', { name })}
                              onClick={(event) => {
                                const id = builtInPresetId(row)
                                if (id === undefined) return
                                restoreFocusRef.current = event.currentTarget
                                setGuide({ id, title: name, page: 'usage' })
                              }}
                            >
                              {t('presets.howToUse')}
                            </button>
                          </div>
                        )}
                        {roster.authorable ? (
                          <button
                            className="dsh-icon-button"
                            type="button"
                            disabled={row.broken !== undefined}
                            aria-label={t('presets.copy', { name })}
                            title={
                              row.broken !== undefined ? t('presets.copyBroken') : t('presets.copyTitle')
                            }
                            onClick={(event) => {
                              restoreFocusRef.current = event.currentTarget
                              setView(undefined)
                              setCopy({
                                from: row.id,
                                fromTitle: name,
                                id: '',
                                name: '',
                                saving: false,
                                error: undefined,
                              })
                            }}
                          >
                            <Icon name="add" />
                          </button>
                        ) : null}
                        {row.trust === 'user' && roster.canRemoveUserPresets !== false ? (
                          <button
                            className="dsh-icon-button"
                            type="button"
                            disabled={deleting}
                            aria-label={t('presets.delete', { name })}
                            title={t('presets.deleteTitle')}
                            onClick={(event) => {
                              restoreFocusRef.current = event.currentTarget
                              setPendingDelete(row.id)
                            }}
                          >
                            <Icon name="trash" />
                          </button>
                        ) : null}
                      </>
                    }
                    revealed={
                      revealedPaths[row.id] === undefined ? undefined : (
                        <p className="dsh-presets__revealed">
                          <span>{t('presets.directory')}</span>
                          <code>{revealedPaths[row.id]}</code>
                        </p>
                      )
                    }
                  />
                )
              })}
            </ul>
            {trust === 'user' ? creatorCard : null}
          </section>
        )
      })}
      {copy === undefined
        ? null
        : portalled(
            <PresetCopyDialog
              copy={copy}
              rows={roster.rows}
              overlayRef={overlayRef}
              onChange={setCopy}
              onConfirm={confirmCopy}
              onDismiss={() => setCopy(undefined)}
            />,
          )}
      {viewLoading || viewError !== undefined || view !== undefined
        ? portalled(
            <PresetCompositionModal
              view={view}
              loading={viewLoading}
              error={viewError}
              overlayRef={overlayRef}
              onErrorDismiss={() => {
                setViewError(undefined)
                setViewLoading(false)
              }}
              onClose={() => setView(undefined)}
            />,
          )
        : null}
      {guide === undefined
        ? null
        : portalled(
            <PresetGuideModal
              guide={guide}
              overlayRef={overlayRef}
              onPage={(page) => setGuide({ ...guide, page })}
              onClose={() => setGuide(undefined)}
            />,
          )}
      {pendingDelete === undefined
        ? null
        : portalled(
            <PresetDeleteDialog
              presetId={pendingDelete}
              deleting={deleting}
              overlayRef={overlayRef}
              onCancel={() => setPendingDelete(undefined)}
              onConfirm={remove}
            />,
          )}
    </div>
  )
}

function portalled(node: ReactElement): ReactElement {
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}
