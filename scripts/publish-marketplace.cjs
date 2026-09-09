'use strict'

const path = require('node:path')
const { createRequire } = require('node:module')

const repositoryRoot = path.resolve(__dirname, '..')
const extensionRoot = path.join(repositoryRoot, 'apps', 'extension')
const extensionRequire = createRequire(path.join(extensionRoot, 'package.json'))
const vsceRequire = createRequire(extensionRequire.resolve('@vscode/vsce/package.json'))
const packagePath = path.join(repositoryRoot, 'artifacts', 'deepseek-harness-vscode-universal.vsix')
const marketplaceSocketTimeout = 10 * 60 * 1000

if (!process.env.VSCE_PAT) {
  throw new Error('VSCE_PAT is required for Marketplace publishing.')
}

// @vscode/vsce constructs the Azure DevOps client without request options,
// which makes typed-rest-client abort a publish after three minutes. Patch the
// shared constructor before loading vsce so slow Marketplace responses get a
// bounded, explicit timeout without changing the published package.
const httpClientModule = vsceRequire('typed-rest-client/HttpClient')
const BaseHttpClient = httpClientModule.HttpClient

httpClientModule.HttpClient = class MarketplaceHttpClient extends BaseHttpClient {
  constructor(userAgent, handlers, requestOptions) {
    super(userAgent, handlers, {
      ...(requestOptions ?? {}),
      socketTimeout: Math.max(requestOptions?.socketTimeout ?? 0, marketplaceSocketTimeout),
    })
  }
}

const { publishVSIX } = extensionRequire('@vscode/vsce')

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function publish() {
  let lastError

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await publishVSIX(packagePath, {
        cwd: extensionRoot,
        pat: process.env.VSCE_PAT,
        skipDuplicate: true,
      })
      return
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const retryable = /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET/i.test(message)

      if (!retryable || attempt === 2) {
        throw error
      }

      console.warn(`Marketplace publish attempt ${attempt} failed; retrying in 30s.`)
      await delay(30 * 1000)
    }
  }

  throw lastError
}

publish().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
