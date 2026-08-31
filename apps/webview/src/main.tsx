import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@dsh-vscode/ui/styles.css'
import './styles/app.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/theme.css'

import { App } from './App.js'
import { readThemePreference } from './app/ui-preferences.js'
import { I18nProvider } from './i18n.js'

// Set the theme before React paints so a persisted light preference does not
// flash the host's dark palette during Webview startup.
document.documentElement.dataset.dshTheme = readThemePreference()

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Missing #root element')

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
