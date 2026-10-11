import { readFileSync } from 'node:fs'

/**
 * Read the local cascade for Node-only style contracts.
 * @param {URL} source
 * @param {readonly URL[]} [excluded]
 * @returns {string}
 */
export function readStylesheet(source, excluded = []) {
  const excludedFiles = new Set(excluded.map((file) => file.href))
  const reading = new Set()
  /** @param {URL} file @returns {string} */
  function read(file) {
    if (excludedFiles.has(file.href)) return ''
    if (reading.has(file.href)) throw new Error('Stylesheet imports form a cycle.')
    reading.add(file.href)
    try {
      return readFileSync(file, 'utf8').replace(
        /@import\s+['"](\.[^'"]+\.css)['"]\s*;/gu,
        (_import, reference) => read(new URL(reference, file)),
      )
    } finally {
      reading.delete(file.href)
    }
  }
  return read(source)
}
