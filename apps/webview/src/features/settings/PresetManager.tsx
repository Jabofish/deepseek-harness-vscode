import { useEffect, useState, type ReactElement } from 'react'
import type {
  AgentPresetDescriptor,
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
} from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'

export interface PresetManagerProps {
  readonly onLoadRoster: () => Promise<AgentPresetRoster | undefined>
  readonly onReadDocument: (presetId: string) => Promise<AgentPresetDocument | undefined>
  readonly onCopy: (from: string, presetId: string, name?: string) => Promise<string | undefined>
  readonly onRemove: (presetId: string) => Promise<void>
  readonly onOpenLocation: (presetId: string) => Promise<AgentPresetLocation | undefined>
  /** Writes the host-side `agent-presets.default` settings field. */
  readonly onMakeDefault: (presetId: string) => Promise<void>
  readonly defaultWritable?: boolean
}

/** Ids a preset directory may be named, mirroring the host's own rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

interface RosterState {
  readonly status: 'loading' | 'ready' | 'unavailable' | 'error'
  readonly rows: readonly AgentPresetDescriptor[]
  readonly authorable: boolean
  readonly hasDocument: boolean
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

/** Why this copy cannot be submitted yet; the host re-checks on submit. */
function copyBlocker(
  draft: CopyDraft,
  rows: readonly AgentPresetDescriptor[],
): 'idRequired' | 'idInvalid' | 'idTaken' | undefined {
  if (draft.id === '') return 'idRequired'
  if (!PRESET_ID.test(draft.id)) return 'idInvalid'
  // A copy never overwrites: landing on a name already in use would replace
  // something the user did not open.
  if (rows.some((row) => row.id === draft.id)) return 'idTaken'
  return undefined
}

/**
 * The agent-preset management surface, mirroring the upstream settings
 * section: the roster as cards grouped by trust, a copy dialog as the only
 * way a preset is created, a read-only viewer over shipped compositions, and
 * a location action leading to a user preset's files.
 *
 * The Webview edits no composition text — a copy is host-side, and everything
 * after creation happens in the preset's own files.
 */
export function PresetManager(props: PresetManagerProps): ReactElement | null {
  const { t } = useI18n()
  const defaultWritable = props.defaultWritable !== false
  const [roster, setRoster] = useState<RosterState>({
    status: 'loading',
    rows: [],
    authorable: false,
    hasDocument: false,
    error: undefined,
  })
  const [view, setView] = useState<PresetView | undefined>(undefined)
  const [copy, setCopy] = useState<CopyDraft | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [defaultingId, setDefaultingId] = useState<string | undefined>(undefined)
  const [revealedPaths, setRevealedPaths] = useState<Readonly<Record<string, string>>>({})

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
            hasDocument: false,
            error: undefined,
          })
          return
        }
        setRoster({
          status: 'ready',
          rows: snapshot.presets,
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
    if (!defaultWritable || defaultingId !== undefined) return
    setDefaultingId(id)
    setRoster((current) => ({ ...current, error: undefined }))
    void props
      .onMakeDefault(id)
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
    void props
      .onReadDocument(id)
      .catch(() => undefined)
      .then((document) => {
        if (document === undefined) {
          setRoster((current) => ({
            ...current,
            error: t('presets.compositionError'),
          }))
          return
        }
        setView({ id, title: document.name ?? document.id, content: document.content })
      })
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
              <p className="dsh-presets__empty-group">{t('presets.emptyCustom')}</p>
            </section>
          ) : null
        return (
          <section className="dsh-presets__group" key={trust}>
            <h3>{t(heading)}</h3>
            <ul className="dsh-presets__cards">
              {group.map((row) => (
                <li
                  key={row.id}
                  className={`dsh-presets__card${
                    row.broken !== undefined
                      ? ' dsh-presets__card--broken'
                      : row.isDefault
                        ? ' dsh-presets__card--active'
                        : ''
                  }`}
                >
                  <button
                    className="dsh-presets__card-main"
                    type="button"
                    aria-pressed={row.isDefault}
                    disabled={
                      row.isDefault ||
                      row.broken !== undefined ||
                      !defaultWritable ||
                      defaultingId !== undefined
                    }
                    aria-label={`${
                      row.broken !== undefined
                        ? t('presets.broken')
                        : row.isDefault
                          ? t('presets.inUse')
                          : t('presets.setDefault')
                    }: ${row.name ?? row.id}`}
                    title={
                      row.broken ??
                      (row.isDefault
                        ? t('presets.inUse')
                        : defaultWritable
                          ? t('presets.setDefault')
                          : t('presets.defaultReadOnly'))
                    }
                    onClick={() => makeDefault(row.id)}
                  >
                    <span className="dsh-presets__card-head">
                      <span className="dsh-presets__card-name">{row.name ?? row.id}</span>
                      {row.broken !== undefined ? (
                        <span className="dsh-presets__badge dsh-presets__badge--broken">
                          {t('presets.broken')}
                        </span>
                      ) : null}
                      <span className="dsh-presets__badge">
                        {row.trust === 'user' ? t('presets.custom') : t('presets.builtIn')}
                      </span>
                      {row.isDefault ? (
                        <span className="dsh-presets__badge--in-use">{t('presets.inUse')}</span>
                      ) : null}
                    </span>
                    <span className="dsh-presets__card-desc">
                      {row.description ?? t('presets.noDescription')}
                    </span>
                    {row.broken === undefined ? null : (
                      <span className="dsh-presets__card-reason" role="alert">
                        {row.broken}
                      </span>
                    )}
                    <code className="dsh-presets__card-id">{row.id}</code>
                  </button>
                  <div className="dsh-presets__card-foot">
                    {row.trust === 'system' ? (
                      row.broken === undefined ? (
                        <button
                          className="dsh-icon-button"
                          type="button"
                          aria-label={t('presets.viewComposition', { name: row.name ?? row.id })}
                          title={t('presets.viewCompositionTitle')}
                          onClick={() => openComposition(row.id)}
                        >
                          <Icon name="file" />
                        </button>
                      ) : null
                    ) : (
                      <button
                        className="dsh-icon-button"
                        type="button"
                        aria-label={t(roster.hasDocument ? 'presets.openLocation' : 'presets.showLocation', {
                          name: row.name ?? row.id,
                        })}
                        title={roster.hasDocument ? t('presets.openDirectory') : t('presets.showPath')}
                        onClick={() => openLocation(row.id)}
                      >
                        <Icon name="folder" />
                      </button>
                    )}
                    <button
                      className="dsh-icon-button"
                      type="button"
                      disabled={!roster.authorable || row.broken !== undefined}
                      aria-label={t('presets.copy', { name: row.name ?? row.id })}
                      title={
                        row.broken !== undefined
                          ? t('presets.copyBroken')
                          : roster.authorable
                            ? t('presets.copyTitle')
                            : t('presets.noWritableRoot')
                      }
                      onClick={() => {
                        setView(undefined)
                        setCopy({
                          from: row.id,
                          fromTitle: row.name ?? row.id,
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
                        aria-label={t('presets.delete', { name: row.name ?? row.id })}
                        title={t('presets.deleteTitle')}
                        onClick={() => setPendingDelete(row.id)}
                      >
                        <Icon name="trash" />
                      </button>
                    ) : null}
                  </div>
                  {revealedPaths[row.id] === undefined ? null : (
                    <p className="dsh-presets__revealed">
                      <span>{t('presets.directory')}</span>
                      <code>{revealedPaths[row.id]}</code>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {copy === undefined ? null : (
        <div className="dsh-presets__dialog" role="dialog" aria-label={t('presets.copyAria')}>
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
      )}
      {view === undefined ? null : (
        <div className="dsh-presets__dialog" role="dialog" aria-label={t('presets.composition')}>
          <h3>{t('presets.compositionHeading', { name: view.title })}</h3>
          <pre className="dsh-presets__code">{view.content}</pre>
          <div className="dsh-presets__dialog-actions">
            <button
              className="dsh-button dsh-button--secondary dsh-button--compact"
              type="button"
              onClick={() => setView(undefined)}
            >
              {t('presets.close')}
            </button>
          </div>
        </div>
      )}
      {pendingDelete === undefined ? null : (
        <div className="dsh-presets__dialog" role="alertdialog" aria-label={t('presets.deleteAria')}>
          <h3>{t('presets.deleteHeading')}</h3>
          <p>{t('presets.deletePrompt', { name: pendingDelete })}</p>
          <div className="dsh-presets__dialog-actions">
            <button
              className="dsh-button dsh-button--secondary dsh-button--compact"
              type="button"
              disabled={deleting}
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
      )}
    </div>
  )
}
