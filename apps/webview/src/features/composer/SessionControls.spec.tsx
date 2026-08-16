// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionControls } from './SessionControls.js'

describe('SessionControls', () => {
  afterEach(() => cleanup())

  it('shows projected context occupancy against the route capacity', () => {
    render(
      <SessionControls
        configuration={{
          preset: 'standard',
          toolMode: 'both',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        }}
        models={[
          {
            id: 'deepseek-v4-flash',
            providerId: 'deepseek',
            label: 'DeepSeek V4 Flash',
            supportsReasoning: true,
          },
        ]}
        presets={[{ id: 'standard', trust: 'system', isDefault: true }]}
        permissionPresets={['workspace-write']}
        estimatedContextTokens={2_200}
        contextWindowTokens={128_000}
        cacheHitRate={0.78}
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Context ~2.2k / 128.0k tokens')).toBeDefined()
  })
})
