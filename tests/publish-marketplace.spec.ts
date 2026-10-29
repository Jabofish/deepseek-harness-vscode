import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../scripts/publish-marketplace.cjs', import.meta.url), 'utf8')
const retry = createRequire(import.meta.url)('../scripts/marketplace-retry.cjs') as unknown
const oidcEnvironment = {
  GITHUB_ACTIONS: 'true',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.invalid/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request-token',
}

async function runPublisher(
  publishVSIX = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  env: Record<string, string> = oidcEnvironment,
  onRequest: (timeout: number | undefined) => void = () => undefined,
): Promise<{ delays: number[]; exitCode?: number; errors: unknown[][] }> {
  const delays: number[] = []
  const errors: unknown[][] = []
  const process = { env, exitCode: undefined as number | undefined }
  class HttpClient {
    constructor(_agent: unknown, _handlers: unknown, options?: { socketTimeout?: number }) {
      onRequest(options?.socketTimeout)
    }
  }
  const http = { HttpClient }
  const otherHttp = { HttpClient }
  const dependency = Object.assign(
    (name: string): unknown => {
      if (name === 'typed-rest-client/HttpClient') return otherHttp
      if (name === '@vscode/vsce')
        return {
          publishVSIX: (...args: unknown[]) => {
            new http.HttpClient('fixture', [], { socketTimeout: 180_000 })
            return publishVSIX(...args)
          },
        }
      throw new Error(`Unexpected dependency ${name}`)
    },
    { resolve: (name: string) => name },
  )
  await runInNewContext(source, {
    Error,
    __dirname: fileURLToPath(new URL('../scripts/', import.meta.url)),
    process,
    require: (name: string): unknown => {
      if (name === 'node:path') return path
      if (name === 'node:module')
        return {
          createRequire: (manifest: string) =>
            manifest === 'azure-devops-node-api/package.json'
              ? (name: string) => {
                  if (name === 'typed-rest-client/HttpClient') return http
                  throw new Error(`Unexpected Azure dependency ${name}`)
                }
              : dependency,
        }
      if (name === './marketplace-retry.cjs') return retry
      throw new Error(`Unexpected require ${name}`)
    },
    console: { error: (...args: unknown[]) => errors.push(args), warn: vi.fn() },
    setTimeout: (callback: () => void, delay: number) => {
      delays.push(delay)
      callback()
    },
  })
  return { delays, ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }), errors }
}

describe('Trusted Marketplace publisher', () => {
  it('applies the ten-minute timeout to the upload client when vsce has another HTTP module instance', async () => {
    const onRequest = vi.fn()
    await runPublisher(undefined, oidcEnvironment, onRequest)
    expect(onRequest).toHaveBeenCalledExactlyOnceWith(600_000)
  })

  it('authenticates through OIDC even if a legacy PAT is present, and skips duplicate versions', async () => {
    const publish = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined)
    const result = await runPublisher(publish, { ...oidcEnvironment, VSCE_PAT: 'unused-fixture-pat' })
    expect(result).toEqual({ delays: [], errors: [] })
    expect(publish).toHaveBeenCalledTimes(1)
    const [packagePath, options] = publish.mock.calls[0]!
    expect(packagePath).toMatch(/artifacts[/\\]jabodsh-universal\.vsix$/u)
    expect(options).toEqual({
      cwd: fileURLToPath(new URL('../apps/extension', import.meta.url)),
      oidc: true,
      skipDuplicate: true,
    })
  })

  it.each(['GITHUB_ACTIONS', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'])(
    'fails before publishing when %s is missing, without falling back to a PAT',
    async (missing) => {
      const env: Record<string, string> = { ...oidcEnvironment, VSCE_PAT: 'unused-fixture-pat' }
      delete env[missing]
      const publish = vi.fn<(...args: unknown[]) => Promise<void>>()
      await expect(runPublisher(publish, env)).rejects.toThrow('id-token: write')
      expect(publish).not.toHaveBeenCalled()
    },
  )

  it('reacquires authentication on a bounded retry after a transient service failure', async () => {
    const publish = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('Fixture unavailable'), { statusCode: 503 }))
      .mockResolvedValue(undefined)
    const result = await runPublisher(publish)
    expect(result).toEqual({ delays: [30_000], errors: [] })
    expect(publish).toHaveBeenCalledTimes(2)
    for (const [, options] of publish.mock.calls) expect(options).toMatchObject({ oidc: true })
  })

  it('does not retry an authentication failure', async () => {
    const publish = vi.fn<(...args: unknown[]) => Promise<void>>().mockRejectedValue(new Error('Fixture 401'))
    expect(await runPublisher(publish)).toEqual({ delays: [], exitCode: 1, errors: [['Fixture 401']] })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('stops after three failed attempts when Marketplace remains unavailable', async () => {
    const publish = vi.fn<(...args: unknown[]) => Promise<void>>().mockRejectedValue(new Error('Fixture 503'))
    expect(await runPublisher(publish)).toEqual({
      delays: [30_000, 60_000],
      exitCode: 1,
      errors: [['Fixture 503']],
    })
    expect(publish).toHaveBeenCalledTimes(3)
  })
})

const workflow = readFileSync(
  new URL('../.github/workflows/build-vsix.yml', import.meta.url),
  'utf8',
).replace(/\r\n/gu, '\n')
const publishJob = workflow.split('\n  publish:\n')[1]?.split('\n  release:\n')[0]
const expression = publishJob?.match(/^ {4}if: \$\{\{ (.+) \}\}$/mu)?.[1]
if (expression === undefined) throw new Error('Missing Marketplace publishing condition')

it.each([
  ['push', 'refs/tags/v0.4.4', false, true],
  ['push', 'refs/heads/main', false, false],
  ['push', 'refs/tags/v0.4.4-beta.1', false, false],
  ['pull_request', 'refs/tags/v0.4.4', false, false],
  ['workflow_dispatch', 'refs/heads/main', true, true],
  ['workflow_dispatch', 'refs/heads/main', false, false],
  ['workflow_dispatch', 'refs/heads/feature', true, false],
  ['workflow_dispatch', 'refs/tags/v0.4.3', true, false],
])('publishing gate: %s %s opt-in %s -> %s', (event, ref, optIn, allowed) => {
  expect(
    runInNewContext(expression, {
      github: { event_name: event, ref, ref_name: String(ref).replace(/^refs\/(heads|tags)\//u, '') },
      inputs: { publish_marketplace: optIn },
      startsWith: (value: string, prefix: string) => value.startsWith(prefix),
      contains: (value: string, search: string) => value.includes(search),
    }),
  ).toBe(allowed)
})
