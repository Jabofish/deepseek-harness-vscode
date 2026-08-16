import type { ReactElement } from 'react'

export function App(): ReactElement {
  // TODO(implementation): replace this development-only shell after the store,
  // protocol bridge, runtime state, session routing, and error boundary exist.
  // Acceptance: each feature component must be independently testable and the
  // app must remain useful between 240px and 800px width.
  return (
    <section className="scaffold" aria-labelledby="scaffold-title">
      <div className="scaffold__mark" aria-hidden="true">
        DSH
      </div>
      <h1 id="scaffold-title">DeepSeek Harness</h1>
      <p>Development scaffold. Product capabilities are intentionally marked TODO.</p>
    </section>
  )
}
