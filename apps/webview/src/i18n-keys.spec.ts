// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  changeSummarySchema,
  checkpointSummarySchema,
  promptTemplateSummarySchema,
  taskSummarySchema,
} from '@dsh-vscode/webview-protocol'
import { translate } from './i18n.js'

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url))

function sourceFiles(directory: string): readonly string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.tsx?$/u.test(entry.name) && !/\.spec\.tsx?$/u.test(entry.name)) files.push(path)
  }
  return files
}

/**
 * Literal keys only: `t('a.b')` / `translate('a.b')`. Keys assembled at runtime
 * (`t(statusKey(state))`) cannot be checked statically and are skipped.
 */
function literalKeys(source: string): readonly string[] {
  const keys: string[] = []
  for (const match of source.matchAll(/\b(?:t|translate)\(\s*'([^'\\]+)'/gu)) {
    if (match[1] !== undefined) keys.push(match[1])
  }
  return keys
}

/** Text of a call's argument list, ending at the `)` that closes the call. */
function argumentList(source: string, start: number): string {
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== undefined) {
      if (character === '\\') index += 1
      else if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"' || character === '`') quote = character
    else if (character === '(') depth += 1
    else if (character === ')') {
      if (depth === 0) return source.slice(start, index)
      depth -= 1
    }
  }
  return source.slice(start)
}

/** Literal call sites paired with the raw text of their arguments. */
function callSites(source: string): readonly { readonly key: string; readonly args: string }[] {
  const sites: { key: string; args: string }[] = []
  for (const match of source.matchAll(/\b(?:t|translate)\(\s*'([^'\\]+)'/gu)) {
    if (match[1] === undefined || match.index === undefined) continue
    sites.push({ key: match[1], args: argumentList(source, match.index + match[0].length) })
  }
  return sites
}

/** Object literal members at the top level, honouring strings and nesting. */
function members(literal: string): readonly string[] {
  const body = literal.slice(1, -1)
  const found: string[] = []
  let current = ''
  let depth = 0
  let quote: string | undefined
  for (const character of body) {
    if (quote !== undefined) {
      current += character
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      current += character
      continue
    }
    if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') depth -= 1
    if (character === ',' && depth === 0) {
      found.push(current)
      current = ''
      continue
    }
    current += character
  }
  found.push(current)
  return found.map((member) => member.trim()).filter((member) => member !== '')
}

/**
 * Names a literal params object supplies, or `undefined` when the shape cannot
 * be read statically (spread, computed keys, a variable instead of an object).
 */
function suppliedNames(args: string): readonly string[] | undefined {
  const object = args.replace(/^\s*,/u, '').trimStart()
  if (!object.startsWith('{')) return undefined
  let depth = 0
  let close = -1
  for (let index = 0; index < object.length; index += 1) {
    if (object[index] === '{') depth += 1
    else if (object[index] === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close === -1) return undefined
  const names: string[] = []
  for (const member of members(object.slice(0, close + 1))) {
    if (member.startsWith('...')) return undefined
    const colon = member.search(/:(?!:)/u)
    const head = (colon === -1 ? member : member.slice(0, colon)).trim().replace(/^['"]|['"]$/gu, '')
    if (!/^[A-Za-z_$][\w$]*$/u.test(head)) return undefined
    names.push(head)
  }
  return names
}

/** One `en: {` / `zh: {` dictionary literal mapped from key to its raw value text. */
function dictionaryEntries(source: string, locale: string): ReadonlyMap<string, string> {
  const start = source.indexOf(`\n  ${locale}: {`)
  if (start < 0) throw new Error(`dictionary ${locale} not found`)
  const lines = source.slice(source.indexOf('{', start) + 1).split('\n')
  const entries = new Map<string, string>()
  let key: string | undefined
  for (const line of lines) {
    if (/^ {2}\},?$/u.test(line)) break
    const opened = /^ {4}'([^']+)':(.*)$/u.exec(line)
    if (opened !== null && opened[1] !== undefined) {
      key = opened[1]
      entries.set(key, opened[2] ?? '')
      continue
    }
    if (key !== undefined) entries.set(key, `${entries.get(key) ?? ''} ${line.trim()}`)
  }
  return entries
}

function placeholders(value: string): readonly string[] {
  return [...value.matchAll(/\{(\w+)\}/gu)]
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    .sort()
}

describe('webview translation keys', () => {
  it('keeps both dictionaries at parity, so a non-English UI is never half-translated', () => {
    // The provider is `zh[key] ?? en[key] ?? key`: a key missing from `zh` is not
    // an exception, it is an English string rendered into a Chinese interface,
    // and a placeholder named differently between the two leaves literal braces.
    const source = readFileSync(fileURLToPath(new URL('./i18n.tsx', import.meta.url)), 'utf8')
    const english = dictionaryEntries(source, 'en')
    const chinese = dictionaryEntries(source, 'zh')

    expect(english.size).toBeGreaterThan(1_000)
    expect([...english.keys()].filter((key) => !chinese.has(key))).toEqual([])
    expect([...chinese.keys()].filter((key) => !english.has(key))).toEqual([])
    const drifted = [...english.entries()]
      .filter(
        ([key, value]) => placeholders(value).join(',') !== placeholders(chinese.get(key) ?? '').join(','),
      )
      .map(
        ([key, value]) =>
          `${key}: en{${placeholders(value).join(',')}} zh{${placeholders(chinese.get(key) ?? '').join(',')}}`,
      )
    expect(drifted).toEqual([])
  })

  it('defines every literal translation key an English UI can render', () => {
    // `translate` falls back to the key itself, so an undefined key is not an
    // exception — it is the raw identifier rendered into the interface.
    const missing = new Set<string>()
    for (const file of sourceFiles(SOURCE_ROOT))
      for (const key of literalKeys(readFileSync(file, 'utf8'))) {
        if (translate(key) === key) missing.add(key)
      }

    expect([...missing].sort()).toEqual([])
  })

  it('passes every placeholder a template asks for', () => {
    // `translate` leaves `{name}` verbatim when the caller omits it, so a
    // partial params object is not an exception — it is literal braces
    // rendered into the interface.
    const broken: string[] = []
    for (const file of sourceFiles(SOURCE_ROOT))
      for (const site of callSites(readFileSync(file, 'utf8'))) {
        const names = [...translate(site.key).matchAll(/\{(\w+)\}/gu)].flatMap((match) =>
          match[1] === undefined ? [] : [match[1]],
        )
        const supplied = names.length === 0 ? undefined : suppliedNames(site.args)
        if (supplied === undefined) continue
        const missing = names.filter((name) => !supplied.includes(name))
        if (missing.length > 0)
          broken.push(`${relative(SOURCE_ROOT, file)}: ${site.key} missing ${missing.join(', ')}`)
      }

    expect(broken.sort()).toEqual([])
  })

  it('labels every protocol enum value that a dynamic key can build', () => {
    // Values reached through `t(`changes.status.${status}`)` are invisible to the
    // literal scan above, so derive them from the protocol schemas instead. The
    // kebab-case protocol values become the camelCase the drawers render.
    const camel = (value: string): string =>
      value.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
    const prefixes: readonly (readonly [string, readonly string[]])[] = [
      ['changes.status.', changeSummarySchema.shape.status.options],
      ['changes.evidence.', changeSummarySchema.shape.evidence.options.map(camel)],
      ['changes.application.', changeSummarySchema.shape.applicationState.options.map(camel)],
      ['changes.review.', changeSummarySchema.shape.reviewState.options],
      ['checkpoints.state.', checkpointSummarySchema.shape.state.options],
      ['tasks.kind.', taskSummarySchema.shape.kind.options],
      ['promptTemplates.scope.', promptTemplateSummarySchema.shape.scope.options],
    ]

    const missing: string[] = []
    for (const [prefix, values] of prefixes)
      for (const value of values) {
        if (translate(`${prefix}${value}`) === `${prefix}${value}`) missing.push(`${prefix}${value}`)
      }

    expect(missing).toEqual([])
  })
})
