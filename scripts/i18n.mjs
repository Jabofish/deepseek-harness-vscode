#!/usr/bin/env node
/**
 * Quick editor for the Webview UI copy in `apps/webview/src/locales/*.json`.
 *
 * The dictionaries are plain JSON with stable, dotted keys; this script keeps
 * both locales in lockstep so a copy change never ships half-translated.
 *
 *   node scripts/i18n.mjs add <key> "<english>" "<中文>"   add a key to both locales (fails if it exists)
 *   node scripts/i18n.mjs set <key> en|zh "<text>"         update one locale's value (creates the key in both)
 *   node scripts/i18n.mjs remove <key>                     drop the key from both locales
 *   node scripts/i18n.mjs find <pattern>                   regex search over keys and values
 *   node scripts/i18n.mjs check                            parity + placeholders + literal-key coverage gate
 *
 * `check` is part of `pnpm check`: it re-runs the same parity rules as
 * `i18n-keys.spec.ts` against the files on disk, before the build does.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCALES_DIR = fileURLToPath(new URL('../apps/webview/src/locales/', import.meta.url))
const SOURCE_DIR = fileURLToPath(new URL('../apps/webview/src/', import.meta.url))
const LOCALES = ['en', 'zh']

function readDictionaries() {
  const dictionaries = new Map(
    LOCALES.map((locale) => [
      locale,
      /** @type {Record<string, string>} */ (
        JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), 'utf8'))
      ),
    ]),
  )
  for (const locale of LOCALES) {
    const values = Object.values(dictionaries.get(locale))
    if (values.some((value) => typeof value !== 'string' || value.trim() === ''))
      fail(`${locale}.json contains a non-string or empty value.`)
  }
  return dictionaries
}

function writeDictionary(dictionaries, locale) {
  const file = join(LOCALES_DIR, `${locale}.json`)
  writeFileSync(file, JSON.stringify(dictionaries.get(locale), null, 2) + '\n')
}

function fail(message) {
  console.error(`i18n: ${message}`)
  process.exit(1)
}

/** @param {string} value @returns {string[]} */
function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort()
}

function commandAdd(dictionaries, positional) {
  const [key, english, chinese] = positional
  if (key === undefined || english === undefined || chinese === undefined)
    fail('usage: add <key> "<english>" "<中文>"')
  if (key in dictionaries.get('en') || key in dictionaries.get('zh'))
    fail(`key "${key}" already exists; use "set" to change it.`)
  dictionaries.get('en')[key] = english
  dictionaries.get('zh')[key] = chinese
  for (const locale of LOCALES) writeDictionary(dictionaries, locale)
  console.log(`added ${key}`)
}

function commandSet(dictionaries, positional) {
  const [key, locale, text] = positional
  if (key === undefined || locale === undefined || text === undefined)
    fail('usage: set <key> <en|zh> "<text>"')
  if (!LOCALES.includes(locale)) fail(`unknown locale "${locale}"; expected one of ${LOCALES.join(', ')}.`)
  dictionaries.get(locale)[key] = text
  writeDictionary(dictionaries, locale)
  console.log(`set ${key} (${locale})`)
}

function commandRemove(dictionaries, positional) {
  const [key] = positional
  if (key === undefined) fail('usage: remove <key>')
  for (const locale of LOCALES) delete dictionaries.get(locale)[key]
  for (const locale of LOCALES) writeDictionary(dictionaries, locale)
  console.log(`removed ${key}`)
}

function commandFind(dictionaries, positional) {
  const [pattern] = positional
  if (pattern === undefined) fail('usage: find <regex>')
  const matcher = new RegExp(pattern, 'iu')
  for (const locale of LOCALES) {
    const entries = dictionaries.get(locale)
    for (const [key, value] of Object.entries(entries)) {
      if (matcher.test(key) || matcher.test(value)) console.log(`${locale}\t${key}\t${value}`)
    }
  }
}

/** Literal `t('…')` / `translate('…')` keys in the source must resolve in both locales. */
function collectLiteralKeys() {
  const literal = /\b(?:t|translate)\(\s*'([^'\\]+)'/gu
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      // Spec files assert on raw keys and fallback behavior; they are not UI.
      if (/\.tsx?$/u.test(entry.name) && !/\.spec\.tsx?$/u.test(entry.name)) files.push(path)
    }
  }
  walk(SOURCE_DIR)
  const missing = new Map()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(literal)) {
      const key = match[1]
      const missingIn = LOCALES.filter((locale) => !(key in dictionaries.get(locale)))
      if (missingIn.length > 0) missing.set(key, missingIn)
    }
  }
  return { missing, files }
}

function commandCheck(dictionaries) {
  const [en, zh] = LOCALES.map((locale) => dictionaries.get(locale))
  const enKeys = new Set(Object.keys(en))
  const zhKeys = new Set(Object.keys(zh))
  const problems = []
  const enOnly = [...enKeys].filter((key) => !zhKeys.has(key))
  const zhOnly = [...zhKeys].filter((key) => !enKeys.has(key))
  if (enOnly.length > 0) problems.push(`keys missing from zh.json: ${enOnly.join(', ')}`)
  if (zhOnly.length > 0) problems.push(`keys missing from en.json: ${zhOnly.join(', ')}`)
  for (const key of enKeys) {
    if (zhKeys.has(key) && placeholders(en[key]).join(',') !== placeholders(zh[key]).join(','))
      problems.push(
        `placeholder drift for "${key}": en{${placeholders(en[key]).join(',')}} zh{${placeholders(zh[key]).join(',')}}`,
      )
  }
  const { missing, files } = collectLiteralKeys()
  for (const [key, missingIn] of missing)
    problems.push(`literal key "${key}" (${relative(SOURCE_DIR, '')}*) missing from: ${missingIn.join(', ')}`)
  if (missing.size === 0 && enKeys.size < 1000)
    problems.push(`dictionaries look truncated: ${enKeys.size} keys across ${files.length} scanned files`)
  if (problems.length > 0) fail(`\n  - ${problems.join('\n  - ')}`)
  console.log(`i18n: ${enKeys.size} keys, both locales at parity, all literal keys resolve.`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || command === '--help' || command === 'help') {
  console.log(
    [
      'usage: node scripts/i18n.mjs <command> [args]',
      '  add <key> "<english>" "<中文>"   add a key to both locales',
      '  set <key> <en|zh> "<text>"      update one locale (creates the key in both on demand)',
      '  remove <key>                    drop the key from both locales',
      '  find <regex>                    search keys and values in both locales',
      '  check                           parity + placeholders + literal-key coverage',
    ].join('\n'),
  )
  process.exit(command === undefined ? 1 : 0)
}
const dictionaries = readDictionaries()
switch (command) {
  case 'add':
    commandAdd(dictionaries, rest)
    break
  case 'set':
    commandSet(dictionaries, rest)
    break
  case 'remove':
    commandRemove(dictionaries, rest)
    break
  case 'find':
    commandFind(dictionaries, rest)
    break
  case 'check':
    commandCheck(dictionaries)
    break
  default:
    fail(`unknown command "${command}"; try --help.`)
}
