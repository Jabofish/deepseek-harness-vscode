import { describe, expect, it } from 'vitest'
import { runtimeNpmEnvironment, streamRuntimeCommand } from './runtime-command.js'
import { runtimeInstallationFailureMessage, withNpmFetchDefaults } from './runtime-installation.js'

describe('runtime npm execution', () => {
  it('streams output before completion and retains bounded tails without interrupting npm', async () => {
    let streamed = ''
    let completed = false
    let notify: (() => void) | undefined
    const output = new Promise<void>((resolve) => {
      notify = resolve
    })
    const operation = streamRuntimeCommand(
      process.execPath,
      [
        '-e',
        "process.stdout.write('开始\\n'); setTimeout(() => process.stdout.write('x'.repeat(4096)), 100)",
      ],
      {
        timeout: 5_000,
        maxBuffer: 128,
        onOutput: (text) => {
          streamed += text
          if (text.includes('开始')) notify?.()
        },
      },
    ).then((result) => {
      completed = true
      return result
    })
    await output
    expect(completed).toBe(false)
    const result = await operation
    expect(streamed).toContain('开始')
    expect(streamed.length).toBeGreaterThan(4096)
    expect(result.stdout).toBe('x'.repeat(128))
  })

  it('terminates its own timed out child and returns a distinguishable failure', async () => {
    await expect(
      streamRuntimeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeout: 100,
        maxBuffer: 128,
      }),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT', timedOut: true, killed: true })
  })

  it('reports startup and nonzero exit errors with bounded diagnostics', async () => {
    await expect(
      streamRuntimeCommand('dsh-test-missing-executable', [], { timeout: 1000, maxBuffer: 128 }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      streamRuntimeCommand(process.execPath, ['-e', "process.stderr.write('failure'); process.exitCode=7"], {
        timeout: 5000,
        maxBuffer: 128,
      }),
    ).rejects.toMatchObject({ code: 7, stderr: 'failure', timedOut: false })
  })

  it('inherits routing, exclusions and certificates without overriding explicit proxy or fetch settings', () => {
    const environment = {
      https_proxy: 'http://configured.invalid',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/test/ca.pem',
      NPM_CONFIG_FETCH_TIMEOUT: '900000',
    }
    expect(runtimeNpmEnvironment(environment, 'http://fallback.invalid')).toEqual(environment)
    expect(runtimeNpmEnvironment({ NO_PROXY: 'localhost' }, 'http://fallback.invalid')).toEqual({
      NO_PROXY: 'localhost',
      HTTP_PROXY: 'http://fallback.invalid',
      HTTPS_PROXY: 'http://fallback.invalid',
    })
    const result = withNpmFetchDefaults(environment)
    expect(result.NPM_CONFIG_FETCH_TIMEOUT).toBe('900000')
    expect(result.npm_config_fetch_timeout).toBeUndefined()
    expect(result.npm_config_fetch_retries).toBe('2')
    expect(runtimeNpmEnvironment({ ALL_PROXY: 'socks5://localhost:1080' }).HTTPS_PROXY).toBe(
      'socks5://localhost:1080',
    )
    expect(runtimeNpmEnvironment({ HTTP_PROXY: 'http://localhost:8080' }).HTTPS_PROXY).toBe(
      'http://localhost:8080',
    )
  })

  it.each([
    ['EAI_AGAIN', 'network'],
    ['E407', 'authentication'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'certificate'],
    ['ENOSPC', 'disk space'],
    ['EINTEGRITY', 'verify'],
    ['EPERM', 'not writable'],
  ])('classifies %s without returning raw diagnostics', (code, expected) => {
    const message = runtimeInstallationFailureMessage({
      code: 1,
      stderr: `npm error code ${code}\nhttps://user:secret@registry.invalid/private`,
    })
    expect(message).toContain(expected)
    expect(message).not.toContain('secret')
    expect(message).not.toContain('registry.invalid')
  })
})
