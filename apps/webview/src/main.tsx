import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@dsh-vscode/ui/styles.css'
import './styles/app.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/theme.css'
import './styles/focused-conversation.css'
import './styles/focused-workbench.css'
import './styles/focused-surfaces.css'
import './styles/focused-plugin-manager.css'
import './styles/focused-overlays.css'

import { App } from './App.js'
import { readThemePreference } from './app/ui-preferences.js'
import { I18nProvider } from './i18n.js'
import { ConversationLayoutProvider } from './app/ConversationLayoutProvider.js'
import { AccessibilityProvider } from './app/AccessibilityProvider.js'
import { watchNativeTitlebarLayout } from './app/native-titlebar-layout.js'
import { getVsCodeApi, hasVsCodeApi } from './vscode-api.js'

// Set the theme before React paints so a persisted light preference does not
// flash the host's dark palette during Webview startup.
document.documentElement.dataset.dshTheme = readThemePreference()
if (hasVsCodeApi()) watchNativeTitlebarLayout(getVsCodeApi())

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Missing #root element')

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <AccessibilityProvider>
        <ConversationLayoutProvider>
          <App />
        </ConversationLayoutProvider>
      </AccessibilityProvider>
    </I18nProvider>
  </StrictMode>,
)
