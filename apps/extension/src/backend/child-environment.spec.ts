import { describe, expect, it } from 'vitest'
import { windowsSystemToolEnvironment, withoutSecrets } from './child-environment.js'

describe('withoutSecrets', () => {
  it('drops credential-bearing variables while keeping ordinary ones', () => {
    const sanitized = withoutSecrets({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      npm_config_registry: 'https://registry.npmjs.org',
      COREPACK_ENABLE_NETWORK: '1',
      DSH_API_KEY: 'secret-dsh',
      GITHUB_TOKEN: 'ghp_secret',
      NPM_TOKEN: 'npm_secret',
      NODE_AUTH_TOKEN: 'node_secret',
      AWS_SECRET_ACCESS_KEY: 'aws_secret',
      AWS_SESSION_TOKEN: 'session_secret',
      MY_PASSWORD: 'hunter2',
      npm_config__authToken: 'registry_auth',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    })
    expect(sanitized).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      npm_config_registry: 'https://registry.npmjs.org',
      COREPACK_ENABLE_NETWORK: '1',
    })
    expect(Object.keys(sanitized)).not.toContain('DSH_API_KEY')
    expect(Object.keys(sanitized)).not.toContain('GITHUB_TOKEN')
    expect(Object.keys(sanitized)).not.toContain('NPM_TOKEN')
    expect(Object.keys(sanitized)).not.toContain('NODE_AUTH_TOKEN')
    expect(Object.keys(sanitized)).not.toContain('AWS_SECRET_ACCESS_KEY')
    expect(Object.keys(sanitized)).not.toContain('AWS_SESSION_TOKEN')
    expect(Object.keys(sanitized)).not.toContain('MY_PASSWORD')
    expect(Object.keys(sanitized)).not.toContain('npm_config__authToken')
    expect(Object.keys(sanitized)).not.toContain('SSH_AUTH_SOCK')
  })
})

describe('windowsSystemToolEnvironment', () => {
  it('exposes only the system tool allowlist', () => {
    const environment = windowsSystemToolEnvironment()
    expect(environment.SystemRoot).toBeDefined()
    expect(environment.windir).toBeDefined()
    expect(environment.PATH).toBeDefined()
    expect(environment).not.toHaveProperty('PSModulePath')
    expect(environment).not.toHaveProperty('GITHUB_TOKEN')
    expect(environment).not.toHaveProperty('DSH_API_KEY')
  })
})
