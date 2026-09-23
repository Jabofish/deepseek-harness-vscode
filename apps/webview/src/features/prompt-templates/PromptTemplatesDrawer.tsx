import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import {
  PROMPT_TEMPLATE_VARIABLES,
  type PromptTemplate,
  type PromptTemplateDraft,
  type PromptTemplateInsertion,
  type PromptTemplateScope,
  type PromptTemplateSummary,
  type PromptTemplateUpdate,
  type PromptTemplateVariable,
} from '@dsh-vscode/domain'

import { useI18n } from '../../i18n.js'
import { MarkdownContent } from '../chat/MarkdownContent.js'
import { Icon } from '../../ui/Icon.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'

export interface PromptTemplatesDrawerProps {
  readonly onOpenLink?: (href: string) => void | Promise<void>
  readonly templates: readonly PromptTemplateSummary[]
  readonly loading: boolean
  readonly onRefresh: () => Promise<void>
  readonly onRead: (templateId: string) => Promise<PromptTemplate | undefined>
  readonly onInsert: (
    templateId: string,
    variables?: Readonly<Record<string, string>>,
  ) => Promise<PromptTemplateInsertion | undefined>
  readonly onCreate: (draft: PromptTemplateDraft) => Promise<PromptTemplateSummary | undefined>
  readonly onUpdate: (
    templateId: string,
    patch: PromptTemplateUpdate,
  ) => Promise<PromptTemplateSummary | undefined>
  readonly onDelete: (templateId: string) => Promise<void>
  readonly onApply: (text: string) => void
}

interface TemplateFormState {
  readonly title: string
  readonly description: string
  readonly templateText: string
  readonly scope: PromptTemplateScope
  readonly variables: readonly PromptTemplateVariable[]
}

type DialogState =
  | { readonly kind: 'editor'; readonly templateId?: string }
  | { readonly kind: 'delete'; readonly template: PromptTemplateSummary }
  | undefined

const EMPTY_FORM: TemplateFormState = {
  title: '',
  description: '',
  templateText: '',
  scope: 'global',
  variables: [],
}

/** Host-mediated template picker. Template text is preview-only until the user explicitly inserts it. */
export function PromptTemplatesDrawer(props: PromptTemplatesDrawerProps): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<PromptTemplate | undefined>()
  const [selectedLoading, setSelectedLoading] = useState(false)
  const [dialog, setDialog] = useState<DialogState>()
  const [form, setForm] = useState<TemplateFormState>(EMPTY_FORM)
  const [pendingInsertion, setPendingInsertion] = useState<PromptTemplateInsertion | undefined>()
  const [pendingValues, setPendingValues] = useState<Partial<Record<PromptTemplateVariable, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const readGeneration = useRef(0)
  /** The control that opened a confirmation takes the keyboard back. */
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
  const dialogWasOpen = useRef(false)

  const dialogOpen = dialog !== undefined || pendingInsertion !== undefined
  useEffect(() => {
    if (dialogWasOpen.current && !dialogOpen) {
      const target = dialogTriggerRef.current
      dialogTriggerRef.current = null
      // Deleting a template removes the row that opened the confirmation.
      if (target !== null && target.isConnected) target.focus()
    }
    dialogWasOpen.current = dialogOpen
  }, [dialogOpen])

  const visibleTemplates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (normalized === '') return props.templates
    return props.templates.filter(
      (template) =>
        template.title.toLocaleLowerCase().includes(normalized) ||
        template.description.toLocaleLowerCase().includes(normalized),
    )
  }, [props.templates, query])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const closeEditor = (): void => {
    if (busy) return
    setDialog(undefined)
    setForm(EMPTY_FORM)
    setError(undefined)
  }

  const readTemplate = (templateId: string): void => {
    const generation = ++readGeneration.current
    setSelectedLoading(true)
    setError(undefined)
    void props
      .onRead(templateId)
      .then((template) => {
        if (generation === readGeneration.current) setSelected(template)
      })
      .catch((reason: unknown) => {
        if (generation === readGeneration.current)
          setError(reason instanceof Error ? reason.message : t('promptTemplates.error'))
      })
      .finally(() => {
        if (generation === readGeneration.current) setSelectedLoading(false)
      })
  }

  const startCreate = (): void => {
    setSelected(undefined)
    setError(undefined)
    setNotice(undefined)
    setForm(EMPTY_FORM)
    setDialog({ kind: 'editor' })
  }

  const startEdit = (): void => {
    if (selected === undefined || busy) return
    setError(undefined)
    setNotice(undefined)
    setForm({
      title: selected.title,
      description: selected.description,
      templateText: selected.templateText,
      scope: selected.scope,
      variables: [...selected.variables],
    })
    setDialog({ kind: 'editor', templateId: selected.templateId })
  }

  const submitEditor = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy || dialog?.kind !== 'editor') return
    setBusy(true)
    setError(undefined)
    const operation =
      dialog.templateId === undefined
        ? props.onCreate({ ...form, variables: [...form.variables] })
        : props.onUpdate(dialog.templateId, {
            title: form.title,
            description: form.description,
            templateText: form.templateText,
            variables: [...form.variables],
          })
    void operation
      .then((summary) => {
        if (summary === undefined) throw new Error(t('promptTemplates.error'))
        setDialog(undefined)
        setNotice(
          dialog.templateId === undefined ? t('promptTemplates.created') : t('promptTemplates.updated'),
        )
        if (dialog.templateId !== undefined) readTemplate(dialog.templateId)
        setForm(EMPTY_FORM)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : t('promptTemplates.error'))
      })
      .finally(() => setBusy(false))
  }

  const requestInsert = (variables?: Readonly<Record<string, string>>): void => {
    if (selected === undefined || busy) return
    setBusy(true)
    setError(undefined)
    void props
      .onInsert(selected.templateId, variables)
      .then((insertion) => {
        if (insertion === undefined) throw new Error(t('promptTemplates.error'))
        if (insertion.unresolvedVariables.length > 0) {
          setPendingInsertion(insertion)
          setPendingValues({})
          return
        }
        props.onApply(insertion.text)
        setNotice(t('promptTemplates.inserted'))
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : t('promptTemplates.error'))
      })
      .finally(() => setBusy(false))
  }

  const insertWithValues = (): void => {
    if (pendingInsertion === undefined) return
    const values = Object.fromEntries(
      pendingInsertion.unresolvedVariables.map((variable) => [variable, pendingValues[variable] ?? '']),
    )
    requestInsert(values)
    setPendingInsertion(undefined)
  }

  const insertUnresolved = (): void => {
    if (pendingInsertion === undefined) return
    props.onApply(pendingInsertion.text)
    setPendingInsertion(undefined)
    setNotice(t('promptTemplates.inserted'))
  }

  const deleteTemplate = (): void => {
    if (dialog?.kind !== 'delete' || busy) return
    const templateId = dialog.template.templateId
    setBusy(true)
    setError(undefined)
    void props
      .onDelete(templateId)
      .then(() => {
        if (selected?.templateId === templateId) setSelected(undefined)
        setDialog(undefined)
        setNotice(t('promptTemplates.deleted'))
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : t('promptTemplates.error'))
      })
      .finally(() => setBusy(false))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // An inner layer (for example the scope SelectMenu) already consumed this
    // Escape; closing the editor here would discard the in-progress form.
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    readGeneration.current += 1
    if (dialog !== undefined && !busy) closeEditor()
    else if (pendingInsertion !== undefined && !busy) setPendingInsertion(undefined)
    else {
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  const countLabel = t('promptTemplates.count', { count: props.templates.length })
  return (
    <div ref={rootRef} className="dsh-prompt-templates-popover" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-prompt-templates-popover__trigger"
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          setNotice(undefined)
          setOpen((current) => !current)
        }}
      >
        <Icon name="sparkles" />
        <span>{countLabel}</span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div
          className="dsh-prompt-templates-popover__menu"
          role="dialog"
          aria-label={t('promptTemplates.list.aria')}
        >
          <div className="dsh-prompt-templates-popover__header">
            <strong>{t('promptTemplates.title')}</strong>
            <div className="dsh-prompt-templates-popover__header-actions">
              <button
                type="button"
                className="dsh-button dsh-button--secondary dsh-button--compact"
                onClick={startCreate}
                disabled={busy}
              >
                <Icon name="add" />
                {t('promptTemplates.create')}
              </button>
              <button
                type="button"
                className="dsh-icon-button"
                aria-label={t('promptTemplates.refresh')}
                title={t('promptTemplates.refresh')}
                disabled={busy || props.loading}
                onClick={() =>
                  void props
                    .onRefresh()
                    .catch((reason) =>
                      setError(reason instanceof Error ? reason.message : t('promptTemplates.error')),
                    )
                }
              >
                <Icon name="refresh" />
              </button>
            </div>
          </div>
          <label className="dsh-prompt-templates-popover__search">
            <span>{t('promptTemplates.searchLabel')}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('promptTemplates.searchPlaceholder')}
            />
          </label>
          {props.loading && props.templates.length === 0 ? (
            <div className="dsh-prompt-templates-popover__status" role="status">
              {t('promptTemplates.loading')}
            </div>
          ) : null}
          {visibleTemplates.length === 0 && !props.loading ? (
            <div className="dsh-prompt-templates-popover__status">
              {query.trim() === '' ? t('promptTemplates.empty') : t('promptTemplates.noMatch')}
            </div>
          ) : null}
          <ul className="dsh-prompt-templates-popover__rows">
            {visibleTemplates.map((template) => (
              <li key={template.templateId} className="dsh-prompt-templates-popover__row">
                <button
                  type="button"
                  className="dsh-prompt-templates-popover__row-main"
                  aria-pressed={selected?.templateId === template.templateId}
                  onClick={() => readTemplate(template.templateId)}
                >
                  <Icon name="file" />
                  <span>
                    <strong>{template.title}</strong>
                    <small>{template.description || t('promptTemplates.noDescription')}</small>
                  </span>
                  <em>{t(`promptTemplates.scope.${template.scope}`)}</em>
                </button>
                <button
                  type="button"
                  className="dsh-icon-button"
                  aria-label={t('promptTemplates.delete', { title: template.title })}
                  title={t('promptTemplates.delete', { title: template.title })}
                  disabled={busy}
                  onClick={(event) => {
                    dialogTriggerRef.current = event.currentTarget
                    setDialog({ kind: 'delete', template })
                  }}
                >
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
          {selectedLoading ? (
            <div className="dsh-prompt-templates-popover__status" role="status">
              {t('promptTemplates.previewLoading')}
            </div>
          ) : null}
          {selected !== undefined && !selectedLoading ? (
            <section
              className="dsh-prompt-templates-popover__preview"
              aria-label={t('promptTemplates.previewTitle')}
            >
              <div className="dsh-prompt-templates-popover__preview-header">
                <div>
                  <strong>{selected.title}</strong>
                  <span>
                    {t('promptTemplates.previewMeta', {
                      scope: t(`promptTemplates.scope.${selected.scope}`),
                    })}
                  </span>
                </div>
                <div className="dsh-prompt-templates-popover__row-actions">
                  <button
                    type="button"
                    className="dsh-icon-button"
                    aria-label={t('promptTemplates.edit')}
                    title={t('promptTemplates.edit')}
                    disabled={busy}
                    onClick={startEdit}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    type="button"
                    className="dsh-button dsh-button--compact"
                    disabled={busy}
                    onClick={(event) => {
                      dialogTriggerRef.current = event.currentTarget
                      requestInsert()
                    }}
                  >
                    <Icon name="add" />
                    {t('promptTemplates.insert')}
                  </button>
                </div>
              </div>
              <p>{selected.description}</p>
              <div className="dsh-prompt-templates-popover__variables">
                {selected.variables.length === 0
                  ? t('promptTemplates.noVariables')
                  : selected.variables.map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}
              </div>
              <div className="dsh-prompt-templates-popover__markdown">
                <MarkdownContent
                  markdown={selected.templateText}
                  onOpenLink={(href) => {
                    void Promise.resolve()
                      .then(() => props.onOpenLink?.(href))
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : t('promptTemplates.error')),
                      )
                  }}
                />
              </div>
            </section>
          ) : null}
          {pendingInsertion !== undefined ? (
            <section className="dsh-prompt-templates-popover__dialog" role="alertdialog" aria-modal="true">
              <strong>{t('promptTemplates.missingTitle')}</strong>
              <p>{t('promptTemplates.missingDescription')}</p>
              {pendingInsertion.unresolvedVariables.map((variable, index) => (
                <label key={variable}>
                  <span>{`{{${variable}}}`}</span>
                  <input
                    autoFocus={index === 0}
                    value={pendingValues[variable] ?? ''}
                    onChange={(event) =>
                      setPendingValues((current) => ({ ...current, [variable]: event.target.value }))
                    }
                  />
                </label>
              ))}
              <div className="dsh-prompt-templates-popover__dialog-actions">
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  onClick={() => setPendingInsertion(undefined)}
                >
                  {t('promptTemplates.cancel')}
                </button>
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  onClick={insertUnresolved}
                >
                  {t('promptTemplates.insertUnresolved')}
                </button>
                <button type="button" className="dsh-button" disabled={busy} onClick={insertWithValues}>
                  {t('promptTemplates.insertWithValues')}
                </button>
              </div>
            </section>
          ) : null}
          {dialog?.kind === 'editor' ? (
            <form
              className="dsh-prompt-templates-popover__dialog"
              aria-label={
                dialog.templateId === undefined
                  ? t('promptTemplates.createTitle')
                  : t('promptTemplates.editTitle')
              }
              onSubmit={submitEditor}
            >
              <strong>
                {dialog.templateId === undefined
                  ? t('promptTemplates.createTitle')
                  : t('promptTemplates.editTitle')}
              </strong>
              <label>
                <span>{t('promptTemplates.titleLabel')}</span>
                <input
                  autoFocus
                  maxLength={256}
                  required
                  value={form.title}
                  onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                />
              </label>
              <label>
                <span>{t('promptTemplates.descriptionLabel')}</span>
                <input
                  maxLength={2_000}
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </label>
              <div className="dsh-prompt-templates-popover__field">
                <span>{t('promptTemplates.scopeLabel')}</span>
                <SelectMenu
                  icon="folder"
                  density="regular"
                  displayLabel
                  label={t(`promptTemplates.scope.${form.scope}`)}
                  ariaLabel={t('promptTemplates.scopeLabel')}
                  title={t('promptTemplates.scopeLabel')}
                  value={form.scope}
                  disabled={dialog.templateId !== undefined}
                  options={[
                    { value: 'global', label: t('promptTemplates.scope.global') },
                    { value: 'workspace', label: t('promptTemplates.scope.workspace') },
                    { value: 'session', label: t('promptTemplates.scope.session') },
                  ]}
                  placement="below"
                  onChange={(scope) => {
                    if (scope === 'global' || scope === 'workspace' || scope === 'session')
                      setForm((current) => ({ ...current, scope }))
                  }}
                />
              </div>
              <fieldset>
                <legend>{t('promptTemplates.variablesLabel')}</legend>
                <div className="dsh-prompt-templates-popover__variable-options">
                  {PROMPT_TEMPLATE_VARIABLES.map((variable) => (
                    <label key={variable}>
                      <input
                        type="checkbox"
                        checked={form.variables.includes(variable)}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            variables: event.target.checked
                              ? [...current.variables, variable]
                              : current.variables.filter((entry) => entry !== variable),
                          }))
                        }
                      />
                      <code>{`{{${variable}}}`}</code>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label>
                <span>{t('promptTemplates.bodyLabel')}</span>
                <textarea
                  required
                  maxLength={100_000}
                  rows={8}
                  value={form.templateText}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, templateText: event.target.value }))
                  }
                />
              </label>
              <p className="dsh-prompt-templates-popover__hint">{t('promptTemplates.bodyHint')}</p>
              <div className="dsh-prompt-templates-popover__dialog-actions">
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  onClick={closeEditor}
                >
                  {t('promptTemplates.cancel')}
                </button>
                <button type="submit" className="dsh-button" disabled={busy}>
                  {busy ? t('promptTemplates.working') : t('promptTemplates.save')}
                </button>
              </div>
            </form>
          ) : null}
          {dialog?.kind === 'delete' ? (
            <section className="dsh-prompt-templates-popover__dialog" role="alertdialog" aria-modal="true">
              <strong>{t('promptTemplates.deleteTitle')}</strong>
              <p>{t('promptTemplates.deleteWarning', { title: dialog.template.title })}</p>
              <div className="dsh-prompt-templates-popover__dialog-actions">
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  autoFocus
                  onClick={() => setDialog(undefined)}
                >
                  {t('promptTemplates.cancel')}
                </button>
                <button
                  type="button"
                  className="dsh-button dsh-button--danger"
                  disabled={busy}
                  onClick={deleteTemplate}
                >
                  {t('promptTemplates.deleteConfirm')}
                </button>
              </div>
            </section>
          ) : null}
          {notice !== undefined ? (
            <div className="dsh-prompt-templates-popover__status" role="status">
              {notice}
            </div>
          ) : null}
          {error !== undefined ? (
            <div className="dsh-prompt-templates-popover__error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
