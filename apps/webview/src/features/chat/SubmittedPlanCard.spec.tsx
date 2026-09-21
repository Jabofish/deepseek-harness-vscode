// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SubmittedPlanCard } from './SubmittedPlanCard.js'

afterEach(cleanup)
it('restores a settled submitted plan and offers its complete markdown for copying', () => {
  const plan = { title: 'Ship', markdown: '# Ship\n\nValidate the result.' }
  const { container } = render(
    <SubmittedPlanCard
      tool={{
        id: 'plan',
        name: 'exit_plan_mode',
        category: 'tool',
        title: 'Plan',
        metadata: {},
        status: 'completed',
        submittedPlan: plan,
      }}
    />,
  )
  const details = container.querySelector('details')!
  expect(details.open).toBe(false)
  fireEvent.click(screen.getByText('Submitted plan: Ship'))
  expect(screen.getByText('Validate the result.')).toBeDefined()
  expect(screen.getByRole('button', { name: /copy/i })).toBeDefined()
})
