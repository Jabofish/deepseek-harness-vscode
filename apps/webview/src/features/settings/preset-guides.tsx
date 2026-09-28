import type { Ref, ReactElement } from 'react'

import { useI18n } from '../../i18n.js'
import type { BuiltInPresetId } from './preset-display.js'

export type PresetGuidePage = 'explanation' | 'usage'
export type PresetGuideId = BuiltInPresetId

export interface PresetGuideSelection {
  readonly id: PresetGuideId
  readonly title: string
  readonly page: PresetGuidePage
}

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

export function PresetGuideModal({
  guide,
  overlayRef,
  onPage,
  onClose,
}: {
  readonly guide: PresetGuideSelection
  readonly overlayRef: Ref<HTMLDivElement>
  readonly onPage: (page: PresetGuidePage) => void
  readonly onClose: () => void
}): ReactElement {
  const { t } = useI18n()
  return (
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
            onClose()
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
              onClick={() => onPage(page)}
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
            onClick={onClose}
          >
            {t('presets.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
