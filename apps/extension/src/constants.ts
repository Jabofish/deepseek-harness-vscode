import { DEFAULT_INSTALL_DSH_VERSION, DSH_PACKAGE_NAME } from '@dsh-vscode/dsh-adapter'

export const EXTENSION_ID = 'Jabofish.jabodsh'
export const VIEW_ID = 'dsh.chatView'
export const VIEW_CONTAINER_ID = 'dsh-container'
/** Editor-area chat surface (`WebviewPanel`) view type. */
export const EDITOR_CHAT_VIEW_TYPE = 'dsh.chatPanel'
/** Host-assigned identity of the secondary-side-bar chat surface. */
export const SIDEBAR_SURFACE_ID = 'sidebar'
export const OUTPUT_CHANNEL_NAME = 'JaboDSH'
export const DSH_PACKAGE = `${DSH_PACKAGE_NAME}@${DEFAULT_INSTALL_DSH_VERSION}`
export const INSTALL_COMMAND = `npm install --global ${DSH_PACKAGE} --ignore-scripts`
export const DSH_DOCUMENTATION_URL = 'https://github.com/deepseek-ai/deepseek-harness'
