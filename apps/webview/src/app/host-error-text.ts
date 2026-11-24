import { englishText, translate } from '../i18n.js'

/**
 * The Extension Host words public errors in English. When the message starts
 * with the standard sentence for its code, show that sentence in the UI
 * language and keep any appended detail (DSH method, code, diagnostic) as-is.
 * Messages the Host composed for a specific situation stay unchanged.
 */
export function localizeHostErrorMessage(code: unknown, message: string): string {
  if (typeof code !== 'string' || !/^[A-Z_]{1,64}$/u.test(code)) return message
  const key = `hostError.${code}`
  const english = englishText(key)
  if (english === undefined) return message
  const localized = translate(key)
  if (localized === english) return message
  if (message === english) return localized
  if (message.startsWith(`${english} `)) return `${localized} ${message.slice(english.length + 1)}`
  return message
}
