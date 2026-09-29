import { DEFAULT_INSTALL_DSH_VERSION, DSH_PACKAGE_NAME } from '@dsh-vscode/dsh-adapter'

export const EXTENSION_ID = 'Direwolf.deepseek-harness-client'
export const VIEW_ID = 'dsh.chatView'
export const OUTPUT_CHANNEL_NAME = 'DeepSeek Harness'
export const DSH_PACKAGE = `${DSH_PACKAGE_NAME}@${DEFAULT_INSTALL_DSH_VERSION}`
export const INSTALL_COMMAND = `npm install --global ${DSH_PACKAGE}`
export const DSH_DOCUMENTATION_URL = 'https://github.com/deepseek-ai/deepseek-harness'
