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
import {
  builtInPresetId,
  presetDisplayDescription,
  presetDisplayName,
  type BuiltInPresetId,
} from './preset-display.js'

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

/** Ids a preset directory may be named, mirroring the host's own rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

interface RosterState {
  readonly status: 'loading' | 'ready' | 'unavailable' | 'error'
  readonly rows: readonly AgentPresetDescriptor[]
  readonly authorable: boolean
  readonly compositionReadable?: boolean
  readonly modeSelectionEnabled?: boolean
  readonly defaultSettingPath?: string
  /** Absent when the host did not state whether it can open a directory natively. */
  readonly hasDocument: boolean | undefined
  readonly error: string | undefined
}

interface CopyDraft {
  readonly from: string
  readonly fromTitle: string
  readonly id: string
  readonly name: string
  readonly saving: boolean
  readonly error: string | undefined
}

interface PresetView {
  readonly id: string
  readonly title: string
  readonly content: string
}

/** Exported for the i18n key spec, which pins one label per blocker. */
export type PresetCopyBlocker = 'idRequired' | 'idInvalid' | 'idTaken'

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

type PresetGuidePage = 'explanation' | 'usage'
type PresetGuideId = BuiltInPresetId

const presetGuides = {
  standard: {
    intro: 'presets.guide.standardIntro',
    explanation: 'presets.guide.standardExplanation',
    usage: 'presets.guide.standardUsage',
  },
  ptc: {
    intro: 'presets.guide.ptcIntro',
    explanation: 'presets.guide.ptcExplanation',
    usage: 'presets.guide.ptcUsage',
  },
  minimal: {
    intro: 'presets.guide.minimalIntro',
    explanation: 'presets.guide.minimalExplanation',
    usage: 'presets.guide.minimalUsage',
  },
  cordis: {
    intro: 'presets.guide.cordisIntro',
    explanation: 'presets.guide.cordisExplanation',
    usage: 'presets.guide.cordisUsage',
  },
} as const

/** Why this copy cannot be submitted yet; the host re-checks on submit. */
function copyBlocker(
  draft: CopyDraft,
  rows: readonly AgentPresetDescriptor[],
): PresetCopyBlocker | undefined {
  if (draft.id === '') return 'idRequired'
  if (!PRESET_ID.test(draft.id)) return 'idInvalid'
  // A copy never overwrites: landing on a name already in use would replace
  // something the user did not open.
  if (rows.some((row) => row.id === draft.id)) return 'idTaken'
  return undefined
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
  const [guide, setGuide] = useState<
    { readonly id: PresetGuideId; readonly title: string; readonly page: PresetGuidePage } | undefined
  >(undefined)
  const [viewLoading, setViewLoading] = useState(false)
  const [viewError, setViewError] = useState<string | undefined>(undefined)
  const [copy, setCopy] = useState<CopyDraft | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const defaultWritable = props.defaultWritable !== false
  const codingToolsEnabled = props.codingToolsEnabled !== false
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
  useDismissibleLayer({ open: overlayOpen, refs: [overlayRef], onDismiss: closeOverlay })

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

  const blocker = copy === undefined ? undefined : copyBlocker(copy, roster.rows)
  const copyMessage =
    copy === undefined
      ? undefined
      : (copy.error ?? (blocker === undefined ? undefined : t(`presets.${blocker}`)))
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
      <p className="dsh-presets__intro">{t('presets.intro')}</p>
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
              {creatorCard ?? <p className="dsh-presets__empty-group">{t('presets.emptyCustom')}</p>}
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
                        {row.trust === 'user' ? (
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
                        <button
                          className="dsh-icon-button"
                          type="button"
                          disabled={!roster.authorable || row.broken !== undefined}
                          aria-label={t('presets.copy', { name })}
                          title={
                            row.broken !== undefined
                              ? t('presets.copyBroken')
                              : roster.authorable
                                ? t('presets.copyTitle')
                                : t('presets.noWritableRoot')
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
                        {row.trust === 'user' ? (
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
            <div className="dsh-presets__modal-backdrop" role="presentation">
              <div
                ref={overlayRef}
                className="dsh-presets__dialog"
                role="dialog"
                aria-modal="true"
                aria-label={t('presets.copyAria')}
              >
                <h3>{t('presets.copyHeading', { name: copy.fromTitle })}</h3>
                <label className="dsh-presets__field">
                  <span>{t('presets.id')}</span>
                  <input
                    value={copy.id}
                    autoFocus
                    spellCheck={false}
                    placeholder="my-preset"
                    onChange={(event) => setCopy({ ...copy, id: event.target.value, error: undefined })}
                  />
                </label>
                <label className="dsh-presets__field">
                  <span>{t('presets.displayName')}</span>
                  <input
                    value={copy.name}
                    spellCheck={false}
                    placeholder={t('presets.displayNamePlaceholder')}
                    onChange={(event) => setCopy({ ...copy, name: event.target.value, error: undefined })}
                  />
                </label>
                {copyMessage === undefined ? null : (
                  <p className="dsh-presets__dialog-error" role="alert">
                    {copyMessage}
                  </p>
                )}
                <div className="dsh-presets__dialog-actions">
                  <button
                    className="dsh-button dsh-button--secondary dsh-button--compact"
                    type="button"
                    disabled={copy.saving}
                    onClick={() => setCopy(undefined)}
                  >
                    {t('presets.cancel')}
                  </button>
                  <button
                    className="dsh-button dsh-button--compact"
                    type="button"
                    disabled={copy.saving || blocker !== undefined}
                    onClick={confirmCopy}
                  >
                    {copy.saving ? t('presets.creating') : t('presets.create')}
                  </button>
                </div>
              </div>
            </div>,
          )}
      {viewLoading || viewError !== undefined
        ? portalled(
            <div className="dsh-presets__modal-backdrop" role="presentation">
              <div
                ref={overlayRef}
                className="dsh-presets__dialog"
                role="dialog"
                aria-modal="true"
                aria-label={t('presets.composition')}
              >
                <h3>
                  {viewError === undefined ? t('presets.compositionLoading') : t('presets.composition')}
                </h3>
                {viewError === undefined ? (
                  <p className="dsh-settings__empty" role="status">
                    {t('presets.loading')}
                  </p>
                ) : (
                  <p className="dsh-presets__dialog-error" role="alert">
                    {viewError}
                  </p>
                )}
                <div className="dsh-presets__dialog-actions">
                  <button
                    className="dsh-button dsh-button--secondary dsh-button--compact"
                    type="button"
                    disabled={viewLoading}
                    onClick={() => {
                      setViewError(undefined)
                      setViewLoading(false)
                    }}
                  >
                    {t('presets.close')}
                  </button>
                </div>
              </div>
            </div>,
          )
        : view === undefined
          ? null
          : portalled(
              <div className="dsh-presets__modal-backdrop" role="presentation">
                <div
                  ref={overlayRef}
                  className="dsh-presets__dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label={t('presets.composition')}
                >
                  <h3>{t('presets.compositionHeading', { name: view.title })}</h3>
                  <pre className="dsh-presets__code">{view.content}</pre>
                  <div className="dsh-presets__dialog-actions">
                    <button
                      className="dsh-button dsh-button--secondary dsh-button--compact"
                      type="button"
                      autoFocus
                      onClick={() => setView(undefined)}
                    >
                      {t('presets.close')}
                    </button>
                  </div>
                </div>
              </div>,
            )}
      {guide === undefined
        ? null
        : portalled(
            <div className="dsh-presets__modal-backdrop" role="presentation">
              <div
                ref={overlayRef}
                className="dsh-presets__dialog dsh-presets__dialog--guide"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dsh-presets-guide-title"
                onKeyDownCapture={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    setGuide(undefined)
                    return
                  }
                  if (event.key !== 'Tab') return
                  const focusable = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
                  )
                  const first = focusable[0]
                  const last = focusable[focusable.length - 1]
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last?.focus()
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first?.focus()
                  }
                }}
              >
                <h3 id="dsh-presets-guide-title">{t('presets.guideHeading', { name: guide.title })}</h3>
                <p className="dsh-presets__guide-intro">{t(presetGuides[guide.id].intro)}</p>
                <div className="dsh-presets__guide-tabs" role="group" aria-label={t('presets.guideSections')}>
                  {(['explanation', 'usage'] as const).map((page) => (
                    <button
                      key={page}
                      className="dsh-button dsh-button--secondary dsh-button--compact"
                      type="button"
                      aria-pressed={guide.page === page}
                      onClick={() => setGuide({ ...guide, page })}
                    >
                      {page === 'explanation' ? t('presets.modeExplanation') : t('presets.howToUse')}
                    </button>
                  ))}
                </div>
                <div className="dsh-presets__guide-content" role="region" aria-live="polite">
                  {t(presetGuides[guide.id][guide.page])
                    .split('\n\n')
                    .map((paragraph, index) => (
                      <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>
                    ))}
                </div>
                <div className="dsh-presets__dialog-actions">
                  <button
                    className="dsh-button dsh-button--secondary dsh-button--compact"
                    type="button"
                    autoFocus
                    onClick={() => setGuide(undefined)}
                  >
                    {t('presets.close')}
                  </button>
                </div>
              </div>
            </div>,
          )}
      {pendingDelete === undefined
        ? null
        : portalled(
            <div className="dsh-presets__modal-backdrop" role="presentation">
              <div
                ref={overlayRef}
                className="dsh-presets__dialog"
                role="alertdialog"
                aria-modal="true"
                aria-label={t('presets.deleteAria')}
              >
                <h3>{t('presets.deleteHeading')}</h3>
                <p>{t('presets.deletePrompt', { name: pendingDelete })}</p>
                <div className="dsh-presets__dialog-actions">
                  <button
                    className="dsh-button dsh-button--secondary dsh-button--compact"
                    type="button"
                    disabled={deleting}
                    autoFocus
                    onClick={() => setPendingDelete(undefined)}
                  >
                    {t('presets.cancel')}
                  </button>
                  <button
                    className="dsh-button dsh-button--danger dsh-button--compact"
                    type="button"
                    disabled={deleting}
                    onClick={remove}
                  >
                    {deleting ? t('presets.deleting') : t('presets.deleteAction')}
                  </button>
                </div>
              </div>
            </div>,
          )}
    </div>
  )
}

function portalled(node: ReactElement): ReactElement {
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}
