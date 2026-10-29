'use strict'

const path = require('node:path')
const { createRequire } = require('node:module')
const { isRetryableMarketplaceError, marketplaceRetryDelay } = require('./marketplace-retry.cjs')

const repositoryRoot = path.resolve(__dirname, '..')
const extensionRoot = path.join(repositoryRoot, 'apps', 'extension')
const extensionRequire = createRequire(path.join(extensionRoot, 'package.json'))
const vsceRequire = createRequire(extensionRequire.resolve('@vscode/vsce/package.json'))
const galleryRequire = createRequire(vsceRequire.resolve('azure-devops-node-api/package.json'))
const packagePath = path.join(repositoryRoot, 'artifacts', 'jabodsh-universal.vsix')
const marketplaceSocketTimeout = 10 * 60 * 1000
const maxPublishAttempts = 3

if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
  !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
) {
  throw new Error('Trusted Marketplace publishing requires GitHub Actions with id-token: write.')
}

// @vscode/vsce constructs the Azure DevOps client without request options,
// which makes typed-rest-client abort a publish after three minutes. Patch the
// shared constructor before loading vsce so slow Marketplace responses get a
// bounded, explicit timeout without changing the published package.
// vsce can use another typed-rest-client version; patch the upload owner's copy.
const httpClientModule = galleryRequire('typed-rest-client/HttpClient')
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

  for (let attempt = 1; attempt <= maxPublishAttempts; attempt += 1) {
    try {
      await publishVSIX(packagePath, {
        cwd: extensionRoot,
        oidc: true,
        skipDuplicate: true,
      })
      return
    } catch (error) {
      lastError = error
      const retryable = isRetryableMarketplaceError(error)
      const retryDelay = marketplaceRetryDelay(error, attempt)

      if (!retryable || retryDelay === undefined || attempt === maxPublishAttempts) {
        throw error
      }

      console.warn(
        `Marketplace publish attempt ${attempt} failed; retrying in ${Math.ceil(retryDelay / 1_000)}s.`,
      )
      await delay(retryDelay)
    }
  }

  throw lastError
}

publish().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
