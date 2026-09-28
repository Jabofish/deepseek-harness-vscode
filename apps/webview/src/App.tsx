import type { ReactElement } from 'react'
import { useAppController } from './AppController.js'
import { AppView } from './AppView.js'

export function App(): ReactElement {
  const view = useAppController()
  return <AppView {...view} />
}
