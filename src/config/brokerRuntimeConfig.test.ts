import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectBrokerRuntimeConfig, validateBrokerRuntimeConfig } from './brokerRuntimeConfig'
import { renderBrokerRuntimeValidator } from '../../viteWebRuntimeConfig'
import {
  getBackendTarget, getPublicWsTarget, getBrokerConfigurationError,
  getRuntimeConfiguredBrokerId, getRuntimeDiscoveryBaseUrl,
  isConfiguredBrokerEndpoint, resolveBrokerBackendUrl, resolveBrokerWsUrl,
} from './backendTarget.js'

const fixture = (api = 'https://service.achiever.orrnn.com') => ({
  CONFIG_SOURCE: 'deployment', PINNED_BROKER: true, BACKEND_TARGET: 'web',
  API_HOST: api, API_HOST_EXT: api, WS_HOST: api.replace(/^https:/, 'wss:'),
  BROKER_ID: 'Achiever', DEFAULT_MT5_SERVER: 'Achiever Trading Server',
  DISCOVERY_BASE_URL: 'https://directory.independent.example',
})
const runtimeWindow = window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown>; __RUNTIME_CONFIG__?: Record<string, unknown> }
afterEach(() => {
  delete runtimeWindow.__RTX_RUNTIME_CONFIG__
  delete runtimeWindow.__RUNTIME_CONFIG__
  delete (window as any).RUNTIME_CONFIG
  vi.unstubAllEnvs()
})

describe('broker-neutral complete runtime configuration', () => {
  it.each(['BROKER_LOGIN_HERO_URL', 'BROKER_LOGIN_HERO_MOBILE_URL', 'BROKER_TERMS_URL'])('validates public presentation setting %s and its VITE_ alias', key => {
    expect(validateBrokerRuntimeConfig({ ...fixture(), [key]: 'https://cdn.unrelated.example/asset?version=2' }).valid).toBe(true)
    expect(validateBrokerRuntimeConfig({ ...fixture(), [`VITE_${key}`]: 'https://cdn.unrelated.example/asset' }).valid).toBe(true)
    for (const value of ['javascript:alert(1)', 'http://cdn.example/asset', 'https://user:secret@cdn.example/asset', 'not-a-url']) {
      expect(validateBrokerRuntimeConfig({ ...fixture(), [key]: value }).valid).toBe(false)
    }
    expect(validateBrokerRuntimeConfig({ ...fixture(), [key]: '', [`VITE_${key}`]: 'https://old-broker.example/asset' }).valid).toBe(true)
    expect(selectBrokerRuntimeConfig([{ ...fixture(), [key]: 'https://one.example/asset' }, { ...fixture(), [key]: 'https://two.example/asset' }])?.CONFIG_ERRORS).toContain('Conflicting deployment runtime configuration sources.')
  })
  it.each(['https://service.achiever.orrnn.com', 'https://api.independent-finance.example', 'https://previously-unknown.example:8443'])('accepts a configured secure broker without a domain naming restriction: %s', (api) => {
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = fixture(api)
    expect(getBackendTarget()).toBe(api)
    expect(getBrokerConfigurationError()).toBe('')
    expect(resolveBrokerWsUrl({}, '/ws/v2')).toBe(`${api.replace(/^https:/, 'wss:')}/ws/v2`)
    expect(resolveBrokerWsUrl({}, '/ws/feed')).toBe(`${api.replace(/^https:/, 'wss:')}/ws/feed`)
  })

  it('uses one explicit runtime source instead of mixing any compiled Orrnn fields', () => {
    vi.stubEnv('VITE_API_HOST', 'https://service.orrnn.com')
    vi.stubEnv('VITE_API_HOST_EXT', 'https://service.orrnn.com')
    vi.stubEnv('VITE_WS_HOST', 'wss://service.orrnn.com')
    vi.stubEnv('VITE_BROKER_ID', 'Orrnn')
    vi.stubEnv('VITE_DISCOVERY_BASE_URL', 'https://old-directory.example')
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = fixture()
    expect(getBackendTarget()).toBe('https://service.achiever.orrnn.com')
    expect(getPublicWsTarget()).toBe('wss://service.achiever.orrnn.com')
    expect(getRuntimeConfiguredBrokerId()).toBe('Achiever')
    expect(getRuntimeDiscoveryBaseUrl()).toBe('https://directory.independent.example')
    delete runtimeWindow.__RTX_RUNTIME_CONFIG__.DISCOVERY_BASE_URL
    expect(getRuntimeDiscoveryBaseUrl()).toBe('')
  })

  it('prefers a deployment global over a compiled legacy global without merging fields', () => {
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = { ...fixture('https://service.orrnn.com'), CONFIG_SOURCE: 'build', BROKER_ID: 'Orrnn' }
    ;(window as any).RUNTIME_CONFIG = fixture()
    expect(getBackendTarget()).toBe('https://service.achiever.orrnn.com')
    expect(getRuntimeConfiguredBrokerId()).toBe('Achiever')
    expect(selectBrokerRuntimeConfig([runtimeWindow.__RTX_RUNTIME_CONFIG__, (window as any).RUNTIME_CONFIG])).toBe((window as any).RUNTIME_CONFIG)
    ;(window as any).RUNTIME_CONFIG = { ...fixture(), API_HOST: '' }
    expect(getBackendTarget()).toBe('')
    expect(getBrokerConfigurationError()).toContain('API_HOST')
  })

  it('prefers an unmarked explicit runtime global over a compiled global', () => {
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = { ...fixture('https://service.orrnn.com'), CONFIG_SOURCE: 'build' }
    const explicit = { ...fixture(), CONFIG_SOURCE: undefined }
    runtimeWindow.__RUNTIME_CONFIG__ = explicit
    expect(getBackendTarget()).toBe('https://service.achiever.orrnn.com')
  })

  it.each([
    { BROKER_ID: 'achiever' },
    { API_HOST: undefined, API_URL: undefined, FIX_API_URL: 'https://service.orrnn.com' },
    { WS_HOST: undefined, MARKET_WS_URL: 'wss://service.orrnn.com' },
    { API_HOST_EXT: 'https://other-api.example' },
    { BROKER_ALLOWED_ORIGINS: 'https://other-api.example' },
    { DISCOVERY_BASE_URL: 'https://other-directory.example' },
    { FEED_BROKER_ID: 'other-broker' },
    { DEFAULT_MT5_SERVER: 'other-server' },
    { PUBLIC_MARKET_API: 'mt5-bridge-v1' },
  ])('blocks conflicting deployment globals including secondary routing and aliases: %j', changed => {
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = fixture()
    ;(window as any).RUNTIME_CONFIG = { ...fixture(), ...changed }
    expect(getBrokerConfigurationError()).toContain('Conflicting deployment runtime configuration sources')
    expect(getBackendTarget()).toBe('')
    expect(getPublicWsTarget()).toBe('')
    expect(isConfiguredBrokerEndpoint('https://service.orrnn.com/api/v2/auth/login')).toBe(false)
  })

  it('accepts equivalent complete deployment aliases and normalized socket origins', () => {
    const primary = fixture()
    const equivalent = { ...primary, API_HOST: undefined, FIX_API_URL: primary.API_HOST, WS_HOST: undefined, MARKET_WS_URL: `${primary.WS_HOST}/ws/v2` }
    expect(validateBrokerRuntimeConfig(selectBrokerRuntimeConfig([primary, equivalent])).valid).toBe(true)
  })

  it.each(['API_HOST', 'WS_HOST', 'BROKER_ID', 'DEFAULT_MT5_SERVER'])('does not fill missing runtime %s from compiled values or stale discovery', (missing) => {
    vi.stubEnv('VITE_API_HOST', 'https://service.orrnn.com')
    vi.stubEnv('VITE_WS_HOST', 'wss://service.orrnn.com')
    vi.stubEnv('VITE_BROKER_ID', 'Orrnn')
    vi.stubEnv('VITE_DEFAULT_MT5_SERVER', 'Orrnn')
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = { ...fixture(), [missing]: '' }
    expect(getBackendTarget()).toBe('')
    expect(getPublicWsTarget()).toBe('')
    expect(resolveBrokerBackendUrl({ server_url: 'https://service.orrnn.com' })).toBe('')
    expect(resolveBrokerWsUrl({ ws_url: 'wss://service.orrnn.com/ws/v2' })).toBe('')
    expect(isConfiguredBrokerEndpoint('https://service.orrnn.com/api/v2/auth/login')).toBe(false)
    expect(getBrokerConfigurationError()).toContain(missing)
  })

  it('requires runtime configuration in production even if a broker is compiled into the bundle', () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_API_HOST', 'https://service.orrnn.com')
    expect(getBackendTarget()).toBe('')
    expect(getBrokerConfigurationError()).toContain('Runtime broker configuration is missing')
    expect(isConfiguredBrokerEndpoint('https://service.orrnn.com/api/v2/auth/login')).toBe(false)
  })

  it.each(['broker.example', 'http://broker.example', 'https://user:password@broker.example', 'https://broker.example?token=secret', 'https://broker.example/api/v2', 'ftp://broker.example', 'https://127.0.0.1', 'not a url'])('rejects malformed or unsafe production API origin %s', (API_HOST) => {
    const config = validateBrokerRuntimeConfig({ ...fixture(), API_HOST })
    expect(config.valid).toBe(false)
    expect(config.errors.join(' ')).toContain('API_HOST')
  })

  it('rejects stale or inconsistent API/socket authorities and contradictory catalogs', () => {
    for (const changed of [
      { WS_HOST: 'wss://service.orrnn.com' },
      { API_HOST_EXT: 'https://service.orrnn.com' },
      { BROKER_DISCOVERY_URL: 'https://old-directory.example' },
    ]) {
      runtimeWindow.__RTX_RUNTIME_CONFIG__ = { ...fixture(), ...changed }
      expect(getBackendTarget()).toBe('')
      expect(getPublicWsTarget()).toBe('')
      expect(getRuntimeDiscoveryBaseUrl()).toBe('')
    }
  })

  it('allows explicitly configured separate service origins without extending a broker hostname list', () => {
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = {
      ...fixture(), WS_HOST: 'wss://quotes.other-domain.example/ws/v2',
      API_HOST_EXT: 'https://market.third-domain.example',
      BROKER_ALLOWED_ORIGINS: 'https://quotes.other-domain.example,https://market.third-domain.example',
    }
    expect(getBrokerConfigurationError()).toBe('')
    expect(resolveBrokerWsUrl({}, '/ws/feed')).toBe('wss://quotes.other-domain.example/ws/feed')
    expect(isConfiguredBrokerEndpoint('https://market.third-domain.example/api/v2/candles/EURUSD')).toBe(true)
    expect(isConfiguredBrokerEndpoint('https://directory.independent.example/api/v2/auth/login')).toBe(false)
    expect(isConfiguredBrokerEndpoint('https://service.orrnn.com/api/v2/auth/login')).toBe(false)
  })

  it('runs the exact self-contained validator before HTML requests without app modules', () => {
    const context = { window: {} as Record<string, any>, URL }
    runInNewContext(renderBrokerRuntimeValidator(), context)
    expect(context.window.__RTX_SELECT_BROKER_CONFIG__([{ ...fixture('https://service.orrnn.com'), CONFIG_SOURCE: 'build' }, fixture()]).API_HOST).toBe('https://service.achiever.orrnn.com')
    expect(context.window.__RTX_VALIDATE_BROKER_CONFIG__(fixture()).valid).toBe(true)
    expect(context.window.__RTX_VALIDATE_BROKER_CONFIG__({ API_HOST: 'https://service.orrnn.com' }).valid).toBe(false)
  })

  it('limits cleartext exceptions to explicit local development', () => {
    const local = fixture('http://localhost:8090')
    local.WS_HOST = 'ws://localhost:8090'
    expect(validateBrokerRuntimeConfig(local).valid).toBe(false)
    expect(validateBrokerRuntimeConfig(local, { allowLocal: true }).valid).toBe(true)
    expect(validateBrokerRuntimeConfig({ ...local, API_HOST: 'http://public-broker.example' }, { allowLocal: true }).valid).toBe(false)
  })

  it('does not revive a compiled desktop broker for an explicit incomplete desktop configuration', () => {
    vi.stubEnv('VITE_API_URL', 'https://service.orrnn.com')
    ;(window as any).electronAPI = {}
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = { BACKEND_TARGET: 'desktop' }
    expect(getBackendTarget()).toBe('')
    expect(resolveBrokerBackendUrl({ broker_id: 'selected', server_url: 'http://127.0.0.1:8090' })).toBe('http://127.0.0.1:8090')
    delete (window as any).electronAPI
  })

  it('keeps the desktop release source and chart default optional, validated, and conflict-aware', () => {
    expect(validateBrokerRuntimeConfig(fixture())).toMatchObject({
      valid: true, desktopReleaseApiUrl: '', defaultChartSymbol: '',
    })
    const configured = validateBrokerRuntimeConfig({
      ...fixture(),
      DESKTOP_RELEASE_API_URL: 'https://releases.independent.example/api/latest?channel=stable',
      DEFAULT_CHART_SYMBOL: 'eurusd.r',
    })
    expect(configured.valid).toBe(true)
    expect(configured).toMatchObject({
      desktopReleaseApiUrl: 'https://releases.independent.example/api/latest?channel=stable',
      defaultChartSymbol: 'EURUSD.R',
    })
    expect(validateBrokerRuntimeConfig({ ...fixture(), VITE_DESKTOP_RELEASE_API_URL: 'https://releases.independent.example/api/latest' }).desktopReleaseApiUrl)
      .toBe('https://releases.independent.example/api/latest')
    for (const value of ['http://releases.independent.example/latest', 'https://user:secret@releases.independent.example/latest', 'not-a-url']) {
      expect(validateBrokerRuntimeConfig({ ...fixture(), DESKTOP_RELEASE_API_URL: value }).valid).toBe(false)
    }
    expect(validateBrokerRuntimeConfig({ ...fixture(), DEFAULT_CHART_SYMBOL: 'https://evil.example/BTCUSD' }).valid).toBe(false)
    expect(selectBrokerRuntimeConfig([
      { ...fixture(), DESKTOP_RELEASE_API_URL: 'https://one.example/api/latest' },
      { ...fixture(), DESKTOP_RELEASE_API_URL: 'https://two.example/api/latest' },
    ])?.CONFIG_ERRORS).toContain('Conflicting deployment runtime configuration sources.')
    expect(selectBrokerRuntimeConfig([
      { ...fixture(), DEFAULT_CHART_SYMBOL: 'EURUSD' },
      { ...fixture(), DEFAULT_CHART_SYMBOL: 'XAUUSD' },
    ])?.CONFIG_ERRORS).toContain('Conflicting deployment runtime configuration sources.')
  })

  it('validates BROKER_LOGO_URL HTTPS/no-credentials and preserves query and fragment', () => {
    const logoUrl = 'https://images.independent.test/brand/@2x.svg?v=2#icon'
    const valid = validateBrokerRuntimeConfig({ ...fixture('https://api.independent.test'), BROKER_LOGO_URL: logoUrl })
    expect(valid.valid).toBe(true)
    expect(valid.brokerLogoUrl).toBe(logoUrl)
    expect(validateBrokerRuntimeConfig({
      ...fixture('https://api.independent.test'),
      VITE_BROKER_LOGO_URL: 'https://images.independent.test/vite-logo.svg',
    }).brokerLogoUrl).toBe('https://images.independent.test/vite-logo.svg')

    for (const badLogo of [
      'https://private:password@images.independent.test/logo.svg',
      'http://images.independent.test/logo.svg',
      'javascript:alert(1)',
      'not-a-url',
    ]) {
      const invalid = validateBrokerRuntimeConfig({ ...fixture('https://api.independent.test'), BROKER_LOGO_URL: badLogo })
      expect(invalid.valid, badLogo).toBe(false)
      expect(invalid.errors.join(' ')).toContain('BROKER_LOGO_URL')
    }
  })

  it.each(['invalid\nbroker', 'invalid\rbroker', 'invalid\tbroker', 'invalid\u0001broker', 'invalid\u007fbroker'])('rejects control characters in BROKER_ID %j', (badBrokerId) => {
    const result = validateBrokerRuntimeConfig({ ...fixture('https://api.independent.test'), BROKER_ID: badBrokerId })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('BROKER_ID must not contain control characters.')
  })

  it.each([
    ['API_HOST', 'https://api.independent.test#hash', 'API_HOST'],
    ['API_HOST', 'https://api.independent.test:99999', 'API_HOST'],
    ['API_HOST', 'https://localhost', 'API_HOST'],
    ['WS_HOST', 'wss://api.independent.test/badpath', 'WS_HOST: must be an origin without an API path'],
    ['DISCOVERY_BASE_URL', 'http://directory.independent.test', 'DISCOVERY_BASE_URL'],
    ['BROKER_ALLOWED_ORIGINS', 'https://good.test,http://bad.test', 'BROKER_ALLOWED_ORIGINS'],
    ['BROKER_ALLOWED_ORIGINS', 'https://good.test,https://user:secret@bad.test', 'BROKER_ALLOWED_ORIGINS'],
    ['USE_MOCK_DISCOVERY', 'true', 'Mock discovery is unavailable in production deployments.'],
    ['PUBLIC_MARKET_API', 'unknown-contract', 'PUBLIC_MARKET_API must be gateway-v2 or mt5-bridge-v1.'],
    ['BACKEND_TARGET', 'desktop', 'Web container deployments must use BACKEND_TARGET=web.'],
    ['BACKEND_TARGET', 'invalid', 'BACKEND_TARGET is not a supported transport mode.'],
    ['DEFAULT_CHART_SYMBOL', 'TOOLONGTOOLONGTOOLONGTOOLONG', 'DEFAULT_CHART_SYMBOL'],
  ] as const)('rejects invalid deployment setting %s=%s', (key, value, expectedError) => {
    const result = validateBrokerRuntimeConfig({ ...fixture('https://api.independent.test'), [key]: value })
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toContain(expectedError)
  })

  it('handles desktop mode options, EXTRA_BROKER_DISCOVERY_URLS, and WS_HOST allowed paths', () => {
    const localDesktop = validateBrokerRuntimeConfig(
      {
        ...fixture('http://127.0.0.1:8090'),
        CONFIG_SOURCE: 'runtime',
        BACKEND_TARGET: 'direct',
        WS_HOST: 'ws://127.0.0.1:8090/ws/feed',
        EXTRA_BROKER_DISCOVERY_URLS: 'https://dir1.independent.test, https://dir2.independent.test',
      },
      { desktop: true, allowLocal: true },
    )
    expect(localDesktop.valid).toBe(true)
    expect(localDesktop.pinned).toBe(false)
    expect(localDesktop.extraDiscoveryUrls).toEqual(['https://dir1.independent.test', 'https://dir2.independent.test'])

    const viteExtraDesktop = validateBrokerRuntimeConfig(
      {
        ...fixture('http://127.0.0.1:8090'),
        CONFIG_SOURCE: 'runtime',
        BACKEND_TARGET: 'desktop',
        WS_HOST: 'ws://127.0.0.1:8090/ws/v2',
        VITE_EXTRA_BROKER_DISCOVERY_URLS: 'https://vite-dir.independent.test',
      },
      { desktop: true, allowLocal: true },
    )
    expect(viteExtraDesktop.valid).toBe(true)
    expect(viteExtraDesktop.extraDiscoveryUrls).toEqual(['https://vite-dir.independent.test'])

    const remoteDesktopWithoutAllowLocal = validateBrokerRuntimeConfig(
      { ...fixture('https://api.independent.test'), CONFIG_SOURCE: 'runtime', BACKEND_TARGET: 'desktop' },
      { desktop: true },
    )
    expect(remoteDesktopWithoutAllowLocal.valid).toBe(true)
    expect(remoteDesktopWithoutAllowLocal.pinned).toBe(false)
    expect(remoteDesktopWithoutAllowLocal.errors.join(' ')).not.toContain('loopback')
    expect(remoteDesktopWithoutAllowLocal.errors).toEqual([])

    const loopbackCleartextConfig = {
      ...fixture('http://127.0.0.1:8090'),
      CONFIG_SOURCE: 'runtime',
      BACKEND_TARGET: 'desktop',
      WS_HOST: 'ws://127.0.0.1:8090/ws/v2',
    }
    const loopbackCleartextWithoutAllowLocal = validateBrokerRuntimeConfig(
      loopbackCleartextConfig,
      { desktop: true },
    )
    expect(loopbackCleartextWithoutAllowLocal.valid).toBe(false)
    expect(loopbackCleartextWithoutAllowLocal.errors).toEqual([
      'API_HOST: must use HTTPS',
      'API_HOST_EXT: must use HTTPS',
      'WS_HOST: must use WSS',
    ])
    const loopbackCleartextWithAllowLocal = validateBrokerRuntimeConfig(
      loopbackCleartextConfig,
      { desktop: true, allowLocal: true },
    )
    expect(loopbackCleartextWithAllowLocal.valid).toBe(true)
    expect(loopbackCleartextWithAllowLocal.errors).toEqual([])

    const loopbackHttpsConfig = {
      ...fixture('https://127.0.0.1:8090'),
      CONFIG_SOURCE: 'runtime',
      BACKEND_TARGET: 'desktop',
      WS_HOST: 'wss://127.0.0.1:8090/ws/v2',
    }
    const loopbackHttpsWithoutAllowLocal = validateBrokerRuntimeConfig(
      loopbackHttpsConfig,
      { desktop: true },
    )
    expect(loopbackHttpsWithoutAllowLocal.valid).toBe(false)
    expect(loopbackHttpsWithoutAllowLocal.errors).toEqual([
      'API_HOST: loopback is permitted only in explicit development or desktop mode',
      'API_HOST_EXT: loopback is permitted only in explicit development or desktop mode',
      'WS_HOST: loopback is permitted only in explicit development or desktop mode',
    ])
    const loopbackHttpsWithAllowLocal = validateBrokerRuntimeConfig(
      loopbackHttpsConfig,
      { desktop: true, allowLocal: true },
    )
    expect(loopbackHttpsWithAllowLocal.valid).toBe(true)
    expect(loopbackHttpsWithAllowLocal.errors).toEqual([])

    const nonDesktopExtra = validateBrokerRuntimeConfig({
      ...fixture('https://api.independent.test'),
      EXTRA_BROKER_DISCOVERY_URLS: 'https://dir1.independent.test',
    })
    expect(nonDesktopExtra.valid).toBe(true)
    expect(nonDesktopExtra.pinned).toBe(true)
    expect(nonDesktopExtra.extraDiscoveryUrls).toEqual([])
  })

  it('validates PUBLIC_MARKET_API enum, discovery alias agreement, and self-contained validator parity', () => {
    const base = {
      CONFIG_SOURCE: 'deployment',
      BACKEND_TARGET: 'web',
      API_HOST: 'https://api.independent.test',
      WS_HOST: 'wss://api.independent.test',
      BROKER_ID: 'independent-broker',
      DEFAULT_MT5_SERVER: 'Independent Trading',
    }
    expect(validateBrokerRuntimeConfig(base).publicMarketApi).toBe('gateway-v2')
    expect(validateBrokerRuntimeConfig({ ...base, PUBLIC_MARKET_API: 'mt5-bridge-v1' })).toMatchObject({
      valid: true,
      publicMarketApi: 'mt5-bridge-v1',
    })
    expect(validateBrokerRuntimeConfig({ ...base, VITE_PUBLIC_MARKET_API: 'mt5-bridge-v1' })).toMatchObject({
      valid: true,
      publicMarketApi: 'mt5-bridge-v1',
    })

    const mismatchedDiscovery = validateBrokerRuntimeConfig({
      ...base,
      DISCOVERY_BASE_URL: 'https://directory-one.independent.test',
      VITE_BROKER_DISCOVERY_URL: 'https://directory-two.independent.test',
    })
    expect(mismatchedDiscovery.valid).toBe(false)
    expect(mismatchedDiscovery.errors).toContain('DISCOVERY_BASE_URL and BROKER_DISCOVERY_URL must identify the same catalog.')

    const context: {
      window: { __RTX_VALIDATE_BROKER_CONFIG__?: (cfg: Record<string, unknown>) => { valid: boolean } }
      URL: typeof URL
    } = { window: {}, URL }
    runInNewContext(renderBrokerRuntimeValidator(), context)
    const runValidator = context.window.__RTX_VALIDATE_BROKER_CONFIG__!
    expect(runValidator({ ...base, BROKER_ID: 'bad\nbroker' }).valid).toBe(false)
    expect(runValidator({ ...base, USE_MOCK_DISCOVERY: 'true' }).valid).toBe(false)
    expect(runValidator({ ...base, PUBLIC_MARKET_API: 'unknown-contract' }).valid).toBe(false)
    expect(runValidator({ ...base, BACKEND_TARGET: 'desktop' }).valid).toBe(false)
    expect(runValidator({ ...base, BACKEND_TARGET: 'invalid' }).valid).toBe(false)
    expect(runValidator({ ...base, WS_HOST: 'wss://api.independent.test/badpath' }).valid).toBe(false)
    expect(runValidator({ ...base, BROKER_ALLOWED_ORIGINS: 'https://good.test,http://bad.test' }).valid).toBe(false)
    expect(runValidator({ ...base, BROKER_LOGO_URL: 'http://images.independent.test/logo.svg' }).valid).toBe(false)
    expect(runValidator({ ...base, DESKTOP_RELEASE_API_URL: 'http://releases.independent.test/latest' }).valid).toBe(false)
    expect(runValidator({ ...base, DEFAULT_CHART_SYMBOL: 'TOOLONGTOOLONGTOOLONGTOOLONG' }).valid).toBe(false)
    expect(runValidator({
      ...base,
      BROKER_ALLOWED_ORIGINS: 'https://cdn.independent.test',
      BROKER_LOGO_URL: 'https://cdn.independent.test/logo.svg',
      DESKTOP_RELEASE_API_URL: 'https://releases.independent.test/api/latest?channel=stable',
      DEFAULT_CHART_SYMBOL: 'EURUSD.R',
    }).valid).toBe(true)
  })
})
