import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@dsh-vscode/ui/styles.css'
import './styles/app.css'

import { App } from './App.js'

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Missing #root element')

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
