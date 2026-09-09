'use strict'

const path = require('node:path')
const { createRequire } = require('node:module')

const repositoryRoot = path.resolve(__dirname, '..')
const extensionRoot = path.join(repositoryRoot, 'apps', 'extension')
const extensionRequire = createRequire(path.join(extensionRoot, 'package.json'))
const vsceRequire = createRequire(extensionRequire.resolve('@vscode/vsce/package.json'))
const packagePath = path.join(repositoryRoot, 'artifacts', 'deepseek-harness-vscode-universal.vsix')
const marketplaceSocketTimeout = 10 * 60 * 1000
const maxPublishAttempts = 3

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

function getErrorText(error) {
  if (error instanceof Error) {
    return `${error.name}\n${error.message}`
  }

  if (error && typeof error === 'object') {
    const errorRecord = error
    return [
      typeof errorRecord.message === 'string' ? errorRecord.message : '',
      typeof errorRecord.statusCode === 'number' ? String(errorRecord.statusCode) : '',
      typeof errorRecord.code === 'string' ? errorRecord.code : '',
      typeof errorRecord.result === 'string' ? errorRecord.result : '',
    ].join('\n')
  }

  return String(error)
}

function isRetryableMarketplaceError(error) {
  return /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|502|503|504|bad gateway|gateway timeout|service(?:s)? (?:isn't|are not|unavailable)/i.test(
    getErrorText(error),
  )
}

async function publish() {
  let lastError

  for (let attempt = 1; attempt <= maxPublishAttempts; attempt += 1) {
    try {
      await publishVSIX(packagePath, {
        cwd: extensionRoot,
        pat: process.env.VSCE_PAT,
        skipDuplicate: true,
      })
      return
    } catch (error) {
      lastError = error
      const retryable = isRetryableMarketplaceError(error)

      if (!retryable || attempt === maxPublishAttempts) {
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
