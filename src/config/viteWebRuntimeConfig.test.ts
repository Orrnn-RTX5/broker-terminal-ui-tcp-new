import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { Rolldown, ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createWebRuntimeConfig,
  renderWebRuntimeConfig,
  webRuntimeConfigPlugin,
} from '../../viteWebRuntimeConfig'

const testEnvironment = {
  VITE_BACKEND_TARGET: 'web',
  VITE_API_URL: 'https://fxtrustbrokerbackend.orrnn.com',
  VITE_WS_URL: 'wss://fxtrustbrokerbackend.orrnn.com/ws/v2',
  VITE_BROKER_DISCOVERY_URL: 'https://fxtrustsuperbackned.orrnn.com',
  VITE_BROKER_ID: 'TEST',
  VITE_DEFAULT_MT5_SERVER: 'TEST',
}

const achieverEnvironment = {
  VITE_BACKEND_TARGET: 'web',
  VITE_BACKEND_URL: 'https://service.achieverfinancials.com',
  VITE_BROKER_DISCOVERY_URL: 'https://superbackend.orrnn.com',
  VITE_BROKER_ID: 'achiever-financials',
  VITE_DEFAULT_MT5_SERVER: 'Achiever Financials',
}

const orrnnEnvironment = {
  VITE_BACKEND_TARGET: 'web',
  VITE_API_HOST: 'https://service.orrnn.com',
  VITE_API_HOST_EXT: 'https://service.orrnn.com',
  VITE_WS_HOST: 'wss://service.orrnn.com',
  VITE_DISCOVERY_BASE_URL: 'https://superadmin-prod.orrnn.com',
  VITE_BROKER_DISCOVERY_URL: 'https://superadmin-prod.orrnn.com',
  VITE_DEFAULT_MT5_SERVER: 'Orrnn',
  VITE_BROKER_ID: 'Orrnn',
  VITE_FEED_BROKER_ID: 'Orrnn',
}

const executeConfig = (source: string, overrides: Record<string, unknown> = {}, userAgent = 'Browser') => {
  const context = {
    window: { location: { protocol: 'http:' }, ...overrides } as Record<string, unknown>,
    navigator: { userAgent },
  }
  runInNewContext(source, context)
  return context.window
}

describe('environment-based web runtime configuration', () => {
  it('gives every unprefixed deployment alias precedence over VITE aliases, including empty values', () => {
    const config = createWebRuntimeConfig({
      ...orrnnEnvironment,
      API_URL: 'https://service.achiever.orrnn.com',
      WS_URL: 'wss://service.achiever.orrnn.com/ws/v2',
      BROKER_ID: 'achiever', DEFAULT_MT5_SERVER: 'Achiever Trading Server',
      DISCOVERY_BASE_URL: '', BROKER_DISCOVERY_URL: '',
    })
    expect(config).toMatchObject({ API_HOST: 'https://service.achiever.orrnn.com', WS_HOST: 'wss://service.achiever.orrnn.com', BROKER_ID: 'achiever', DISCOVERY_BASE_URL: '', BROKER_DISCOVERY_URL: '' })
    // A separately supplied EXT address is contradictory until explicitly replaced.
    expect(config.CONFIG_ERRORS.join(' ')).toContain('API_HOST_EXT')
    expect(createWebRuntimeConfig({ ...orrnnEnvironment, API_HOST: '' }).API_HOST).toBe('')
  })
  it('leaves broker endpoints and identity empty when no configuration is supplied', () => {
    expect(createWebRuntimeConfig({})).toMatchObject({
      API_HOST: '', API_HOST_EXT: '', WS_HOST: '',
      BROKER_ID: '', FEED_BROKER_ID: '', DEFAULT_MT5_SERVER: '',
      DISCOVERY_BASE_URL: '', BROKER_DISCOVERY_URL: '',
    })
  })
  it('maps the complete Orrnn VITE profile to browser runtime fields', () => {
    expect(createWebRuntimeConfig(orrnnEnvironment)).toMatchObject({
      BACKEND_TARGET: 'web',
      API_HOST: 'https://service.orrnn.com',
      API_HOST_EXT: 'https://service.orrnn.com',
      WS_HOST: 'wss://service.orrnn.com',
      DEFAULT_MT5_SERVER: 'Orrnn',
      DISCOVERY_BASE_URL: 'https://superadmin-prod.orrnn.com',
      BROKER_DISCOVERY_URL: 'https://superadmin-prod.orrnn.com',
      BROKER_ID: 'Orrnn',
      VITE_BROKER_ID: 'Orrnn',
      FEED_BROKER_ID: 'Orrnn',
      USE_MOCK_DISCOVERY: false,
    })
  })

  it('retains the explicitly selected same-origin local desktop gateway configuration', () => {
    const runtime = executeConfig(renderWebRuntimeConfig(createWebRuntimeConfig({
      ...achieverEnvironment,
      VITE_BACKEND_TARGET: 'desktop',
    })), {
      location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:5175' },
    })
    expect(runtime.RUNTIME_CONFIG).toEqual(expect.objectContaining({
      BACKEND_TARGET: 'desktop', BROKER_ID: 'achiever-financials',
      API_HOST: 'http://localhost:5175', API_HOST_EXT: 'http://localhost:5175',
      WS_HOST: 'ws://localhost:5175',
    }))
  })

  it('keeps the selected web broker active on localhost', () => {
    const runtime = executeConfig(renderWebRuntimeConfig(createWebRuntimeConfig(achieverEnvironment)), {
      location: { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' },
    })
    expect(runtime.RUNTIME_CONFIG).toEqual(expect.objectContaining({
      BACKEND_TARGET: 'web',
      BROKER_ID: 'achiever-financials',
      API_HOST: 'https://service.achieverfinancials.com',
      WS_HOST: 'wss://service.achieverfinancials.com',
    }))
  })

  it.each([
    [testEnvironment, 'TEST', 'https://fxtrustbrokerbackend.orrnn.com'],
    [achieverEnvironment, 'achiever-financials', 'https://service.achieverfinancials.com'],
    [orrnnEnvironment, 'Orrnn', 'https://service.orrnn.com'],
  ])('publishes the selected broker to every supported runtime global', (env, brokerId, apiHost) => {
    const config = createWebRuntimeConfig(env)
    const runtime = executeConfig(renderWebRuntimeConfig(config))

    expect(runtime.RUNTIME_CONFIG).toEqual(expect.objectContaining({ BROKER_ID: brokerId, API_HOST: apiHost }))
    expect(runtime.__RTX_RUNTIME_CONFIG__).toBe(runtime.RUNTIME_CONFIG)
    expect(runtime.__RUNTIME_CONFIG__).toBe(runtime.RUNTIME_CONFIG)
    expect(config.VITE_BROKER_ID).toBe(brokerId)
    expect(config.FEED_BROKER_ID).toBe(brokerId)
  })

  it('can keep the configured desktop broker on localhost instead of the nginx TEST preview', () => {
    const config = createWebRuntimeConfig({
      VITE_BACKEND_TARGET: 'desktop',
      VITE_API_HOST: 'https://trivanta.orrnn.com',
      VITE_BROKER_ID: 'trivanta-markets',
    })
    const location = { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' }
    expect(executeConfig(renderWebRuntimeConfig(config, false), { location }).RUNTIME_CONFIG)
      .toEqual(expect.objectContaining({ API_HOST: 'https://trivanta.orrnn.com', BROKER_ID: 'trivanta-markets', BACKEND_TARGET: 'desktop' }))
    expect(executeConfig(renderWebRuntimeConfig(config), { location }).RUNTIME_CONFIG)
      .toEqual(expect.objectContaining({ API_HOST: location.origin, BROKER_ID: 'trivanta-markets' }))
  })

  it('derives all broker endpoints without retaining the prior broker', () => {
    createWebRuntimeConfig(testEnvironment)
    const config = createWebRuntimeConfig(achieverEnvironment)

    expect(config).toMatchObject({
      API_HOST: 'https://service.achieverfinancials.com',
      API_HOST_EXT: 'https://service.achieverfinancials.com',
      WS_HOST: 'wss://service.achieverfinancials.com',
      DEFAULT_MT5_SERVER: 'Achiever Financials',
      DISCOVERY_BASE_URL: 'https://superbackend.orrnn.com',
      FEED_BROKER_ID: 'achiever-financials',
      USE_MOCK_DISCOVERY: false,
    })
    expect(JSON.stringify(config)).not.toContain('TEST')
  })

  it('carries the optional tenant release channel and chart defaults into the browser config', () => {
    expect(createWebRuntimeConfig({})).toMatchObject({
      DESKTOP_RELEASE_API_URL: '', DEFAULT_CHART_SYMBOL: '',
      DEFAULT_CHART_TIMEFRAME: '', FIRST_PAINT_HISTORY_COUNT: '',
    })
    const passthrough = createWebRuntimeConfig({
      ...achieverEnvironment,
      VITE_DESKTOP_RELEASE_API_URL: 'https://releases.independent.test/api/latest?channel=stable',
      VITE_DEFAULT_CHART_SYMBOL: 'eurusd.r',
      VITE_DEFAULT_CHART_TIMEFRAME: 'h1',
      VITE_FIRST_PAINT_HISTORY_COUNT: '250',
    })
    expect(passthrough).toMatchObject({
      DESKTOP_RELEASE_API_URL: 'https://releases.independent.test/api/latest?channel=stable',
      DEFAULT_CHART_SYMBOL: 'EURUSD.R',
      DEFAULT_CHART_TIMEFRAME: 'h1',
      FIRST_PAINT_HISTORY_COUNT: '250',
    })
    expect(executeConfig(renderWebRuntimeConfig(passthrough)).RUNTIME_CONFIG).toEqual(expect.objectContaining({
      DESKTOP_RELEASE_API_URL: 'https://releases.independent.test/api/latest?channel=stable',
      DEFAULT_CHART_SYMBOL: 'EURUSD.R',
    }))
  })

  it('respects explicit external API, feed identity, websocket, and mock settings', () => {
    const config = createWebRuntimeConfig({
      ...achieverEnvironment,
      VITE_API_HOST_EXT: ' https://external.example.com/ ',
      VITE_WS_HOST: 'wss://feed.example.com/',
      VITE_FEED_BROKER_ID: 'backend-feed-id',
      VITE_USE_MOCK_DISCOVERY: ' TRUE ',
    })
    expect(config).toMatchObject({
      API_HOST_EXT: 'https://external.example.com',
      WS_HOST: 'wss://feed.example.com',
      BROKER_ID: 'achiever-financials',
      FEED_BROKER_ID: 'backend-feed-id',
      USE_MOCK_DISCOVERY: true,
    })
  })

  it('does not export server secrets or arbitrary VITE environment values', () => {
    const source = renderWebRuntimeConfig(createWebRuntimeConfig({
      ...achieverEnvironment,
      DATABASE_PASSWORD: 'database-secret',
      MANAGER_PASSWORD: 'manager-secret',
      BACKEND_PASSWORD: 'backend-secret',
      PRIVATE_KEY: 'private-key-secret',
      VITE_ADMIN_PASSWORD: 'admin-password-secret',
      FEED_BROKER_TOKEN: 'server-only-secret',
      VITE_FEED_BROKER_TOKEN: 'retired-feed-secret',
      VITE_UNRELATED_SECRET: 'unrelated-secret',
      PATH: 'private-machine-path',
    }))
    for (const value of [
      'database-secret',
      'manager-secret',
      'backend-secret',
      'private-key-secret',
      'admin-password-secret',
      'server-only-secret',
      'retired-feed-secret',
      'unrelated-secret',
      'private-machine-path',
    ]) {
      expect(source).not.toContain(value)
    }
    expect(source).not.toMatch(/FEED_BROKER_TOKEN|MANAGER_PASSWORD|BACKEND_PASSWORD|PRIVATE_KEY|ADMIN_PASSWORD/)
    const runtime = executeConfig(source).RUNTIME_CONFIG as Record<string, unknown>
    expect(runtime.FEED_BROKER_TOKEN).toBeUndefined()
    expect(runtime.MANAGER_PASSWORD).toBeUndefined()
    expect(runtime.BACKEND_PASSWORD).toBeUndefined()
    expect(runtime.PRIVATE_KEY).toBeUndefined()
  })

  it('escapes source text without raw < while preserving hostile multiline and control characters', () => {
    const hostile = `broker'\\"</ScRiPt><script data-injected>window.injected=true</script><!--\r\n\t\b\f\u0001\u2028\u2029\n`
    const source = renderWebRuntimeConfig(createWebRuntimeConfig({
      BACKEND_TARGET: 'web',
      API_HOST: 'https://api.independent-broker.test',
      WS_HOST: 'wss://api.independent-broker.test',
      BROKER_ID: 'independent-broker',
      DEFAULT_MT5_SERVER: hostile,
      BROKER_NAME: hostile,
    }))
    expect(source).not.toContain('<')
    expect(source).not.toContain('</script>')
    expect(source).not.toContain('\u2028')
    expect(source).not.toContain('\u2029')
    const win = executeConfig(source) as {
      RUNTIME_CONFIG?: { DEFAULT_MT5_SERVER?: string; BROKER_NAME?: string }
      injected?: unknown
    }
    expect(win.RUNTIME_CONFIG?.DEFAULT_MT5_SERVER).toBe(hostile.trim())
    expect(win.RUNTIME_CONFIG?.BROKER_NAME).toBe(hostile.trim())
    expect(win.injected).toBeUndefined()
  })

  it('maps remaining API, WebSocket, discovery, candle, and presentation aliases with precedence', () => {
    const base = {
      BROKER_ID: 'independent-broker',
      DEFAULT_MT5_SERVER: 'Independent Trading',
    }
    expect(createWebRuntimeConfig({
      ...base,
      API_V2_URL: 'https://api-v2.independent.test/',
      WS_HOST: 'wss://api-v2.independent.test',
    })).toMatchObject({ API_HOST: 'https://api-v2.independent.test', CONFIG_ERRORS: [] })

    expect(createWebRuntimeConfig({
      ...base,
      VITE_API_V2_URL: 'https://vite-api-v2.independent.test/',
      WS_HOST: 'wss://vite-api-v2.independent.test',
    })).toMatchObject({ API_HOST: 'https://vite-api-v2.independent.test', CONFIG_ERRORS: [] })

    const aliased = createWebRuntimeConfig({
      ...base,
      API_V2_URL: 'https://primary.independent.test',
      VITE_API_HOST: 'https://fallback.independent.test',
      RTX5_WS_URL: 'wss://stream.independent.test/ws/feed',
      FIX_WS_URL: 'wss://ignored.independent.test',
      SHARED_DISCOVERY_BASE_URL: 'https://catalog.independent.test/',
      VITE_SHARED_DISCOVERY_BASE_URL: 'https://ignored-catalog.independent.test',
      BROKER_ALLOWED_ORIGINS: 'https://stream.independent.test',
      PUBLIC_CANDLE_BRIDGE: 'yes',
      PUBLIC_MARKET_API: 'mt5-bridge-v1',
      BROKER_NAME: 'Independent Broker',
      BROKER_LOGO_URL: 'https://images.independent.test/logo.svg?v=2#icon',
      BROKER_LOGIN_HERO_URL: 'https://images.independent.test/hero.webp',
      BROKER_LOGIN_HERO_MOBILE_URL: 'https://images.independent.test/mobile.jpg',
      BROKER_TERMS_URL: 'https://independent.test/terms',
    })
    expect(aliased).toMatchObject({
      API_HOST: 'https://primary.independent.test',
      WS_HOST: 'wss://stream.independent.test',
      DISCOVERY_BASE_URL: 'https://catalog.independent.test',
      BROKER_DISCOVERY_URL: 'https://catalog.independent.test',
      PUBLIC_CANDLE_BRIDGE: true,
      PUBLIC_MARKET_API: 'mt5-bridge-v1',
      BROKER_NAME: 'Independent Broker',
      BROKER_LOGO_URL: 'https://images.independent.test/logo.svg?v=2#icon',
      BROKER_LOGIN_HERO_URL: 'https://images.independent.test/hero.webp',
      BROKER_LOGIN_HERO_MOBILE_URL: 'https://images.independent.test/mobile.jpg',
      BROKER_TERMS_URL: 'https://independent.test/terms',
      CONFIG_ERRORS: [],
    })

    expect(createWebRuntimeConfig({
      ...base,
      API_HOST: 'https://alias.independent.test',
      FIX_WS_URL: 'wss://alias.independent.test/ws/v2',
      VITE_SHARED_DISCOVERY_BASE_URL: 'https://vite-catalog.independent.test/',
      VITE_PUBLIC_CANDLE_BRIDGE: 'true',
      VITE_PUBLIC_MARKET_API: 'mt5-bridge-v1',
    })).toMatchObject({
      WS_HOST: 'wss://alias.independent.test',
      DISCOVERY_BASE_URL: 'https://vite-catalog.independent.test',
      PUBLIC_CANDLE_BRIDGE: true,
      PUBLIC_MARKET_API: 'mt5-bridge-v1',
      CONFIG_ERRORS: [],
    })

    expect(createWebRuntimeConfig({
      ...base,
      API_HOST: 'https://feed.independent.test',
      WS_HOST: 'wss://feed.independent.test',
      FEED_WS_URL: 'https://feed1.independent.test/',
      FEED_WS_HOST: 'https://feed2.independent.test/',
      VITE_FEED_WS_URL: 'https://feed3.independent.test/',
      VITE_FEED_WS_HOST: 'https://feed4.independent.test/',
      EXTRA_BROKER_DISCOVERY_URLS: 'https://extra1.independent.test',
      VITE_EXTRA_BROKER_DISCOVERY_URLS: 'https://extra2.independent.test',
    })).toMatchObject({
      FEED_WS_URL: 'wss://feed1.independent.test',
      EXTRA_BROKER_DISCOVERY_URLS: 'https://extra1.independent.test',
    })
    expect(createWebRuntimeConfig({
      ...base,
      API_HOST: 'https://feed.independent.test',
      WS_HOST: 'wss://feed.independent.test',
      FEED_WS_HOST: 'http://feed2.independent.test/',
      VITE_FEED_WS_URL: 'https://feed3.independent.test/',
      VITE_EXTRA_BROKER_DISCOVERY_URLS: 'https://extra2.independent.test',
    })).toMatchObject({
      FEED_WS_URL: 'ws://feed2.independent.test',
      EXTRA_BROKER_DISCOVERY_URLS: 'https://extra2.independent.test',
    })
    expect(createWebRuntimeConfig({
      ...base,
      API_HOST: 'https://feed.independent.test',
      WS_HOST: 'wss://feed.independent.test',
      FEED_WS_URL: '',
      VITE_FEED_WS_URL: 'https://feed3.independent.test/',
      VITE_FEED_WS_HOST: 'https://feed4.independent.test/',
      EXTRA_BROKER_DISCOVERY_URLS: '',
      VITE_EXTRA_BROKER_DISCOVERY_URLS: 'https://extra2.independent.test',
    })).toMatchObject({
      FEED_WS_URL: '',
      EXTRA_BROKER_DISCOVERY_URLS: '',
    })
    expect(createWebRuntimeConfig({
      ...base,
      API_HOST: 'https://feed.independent.test',
      WS_HOST: 'wss://feed.independent.test',
      VITE_FEED_WS_HOST: 'https://feed4.independent.test/',
    }).FEED_WS_URL).toBe('wss://feed4.independent.test')
  })

  it.each([
    [{ electron: { window: {} } }, 'Browser'],
    [{ electronAPI: {} }, 'Browser'],
    [{ location: { protocol: 'file:' } }, 'Browser'],
    [{}, 'Mozilla/5.0 Electron/40.0.0'],
  ])('preserves the existing Electron broker selection', (overrides, userAgent) => {
    const desktopConfig = { BROKER_ID: 'desktop-selected-broker' }
    const runtime = executeConfig(renderWebRuntimeConfig(createWebRuntimeConfig(achieverEnvironment)), {
      ...overrides,
      __RTX_RUNTIME_CONFIG__: desktopConfig,
      RUNTIME_CONFIG: desktopConfig,
      __RUNTIME_CONFIG__: desktopConfig,
    }, userAgent)
    expect(runtime.RUNTIME_CONFIG).toBe(desktopConfig)
    expect(runtime.__RTX_RUNTIME_CONFIG__).toBe(desktopConfig)
    expect(runtime.__RUNTIME_CONFIG__).toBe(desktopConfig)
  })

  it('serves uncached runtime config and validator assets before the public development file', () => {
    const plugin = webRuntimeConfigPlugin({
      VITE_BACKEND_TARGET: 'web',
      VITE_BACKEND_URL: 'https://api.independent-broker.test',
      VITE_BROKER_DISCOVERY_URL: 'https://directory.independent-broker.test',
      VITE_BROKER_ID: 'independent-broker',
      VITE_DEFAULT_MT5_SERVER: 'Independent Broker',
    })
    const use = vi.fn()
    const server = { middlewares: { use } } as unknown as ViteDevServer
    if (typeof plugin.configureServer !== 'function') throw new Error('Missing development hook')
    plugin.configureServer.call({} as never, server)
    const middleware = use.mock.calls[0][0]

    for (const url of ['/runtime-config.js?t=123', '/runtime-config-validator.js?t=123']) {
      const res = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 }
      const next = vi.fn()
      middleware({ url, method: 'GET' } as IncomingMessage, res as unknown as ServerResponse, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.statusCode).toBe(200)
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/javascript; charset=utf-8')
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0')

      const headRes = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 }
      middleware({ url, method: 'HEAD' } as IncomingMessage, headRes as unknown as ServerResponse, next)
      expect(headRes.statusCode).toBe(200)
      expect(headRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0')
      expect(headRes.end).toHaveBeenCalledWith(undefined)

      if (url.startsWith('/runtime-config.js')) {
        expect(executeConfig(res.end.mock.calls[0][0]).RUNTIME_CONFIG).toEqual(expect.objectContaining({ BROKER_ID: 'independent-broker' }))
      } else {
        const validatorCtx: {
          window: {
            __RTX_SELECT_BROKER_CONFIG__?: unknown
            __RTX_VALIDATE_BROKER_CONFIG__?: (cfg: Record<string, unknown>) => { valid: boolean }
          }
          URL: typeof URL
        } = { window: {}, URL }
        runInNewContext(res.end.mock.calls[0][0], validatorCtx)
        expect(typeof validatorCtx.window.__RTX_SELECT_BROKER_CONFIG__).toBe('function')
        expect(typeof validatorCtx.window.__RTX_VALIDATE_BROKER_CONFIG__).toBe('function')
        expect(validatorCtx.window.__RTX_VALIDATE_BROKER_CONFIG__!({ BROKER_ID: 'bad\nbroker' }).valid).toBe(false)
      }
    }

    const nextRes = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 }
    const next = vi.fn()
    middleware({ url: '/api/login', method: 'GET' } as IncomingMessage, nextRes as unknown as ServerResponse, next)
    expect(next).toHaveBeenCalledOnce()

    for (const [url, method] of [
      ['/runtime-config.js', 'POST'],
      ['/runtime-config.js', 'OPTIONS'],
      ['/runtime-config-validator.js', 'POST'],
      ['/runtime-config-validator.js', 'DELETE'],
    ]) {
      const skippedRes = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 }
      const skippedNext = vi.fn()
      middleware({ url, method } as IncomingMessage, skippedRes as unknown as ServerResponse, skippedNext)
      expect(skippedNext).toHaveBeenCalledOnce()
      expect(skippedRes.setHeader).not.toHaveBeenCalled()
      expect(skippedRes.end).not.toHaveBeenCalled()
    }
  })

  it('disables local nginx desktop rewrite when VITE_LOCAL_NGINX_PREVIEW is false', () => {
    const plugin = webRuntimeConfigPlugin({
      VITE_BACKEND_TARGET: 'desktop',
      VITE_API_HOST: 'https://trivanta.orrnn.com',
      VITE_BROKER_ID: 'trivanta-markets',
      VITE_LOCAL_NGINX_PREVIEW: ' false ',
    })
    const use = vi.fn()
    if (typeof plugin.configureServer !== 'function') throw new Error('Missing development hook')
    plugin.configureServer.call({} as never, { middlewares: { use } } as unknown as ViteDevServer)
    const middleware = use.mock.calls[0][0]
    const devRes = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 }
    middleware({ url: '/runtime-config.js', method: 'GET' } as IncomingMessage, devRes as unknown as ServerResponse, vi.fn())
    const location = { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' }
    expect(executeConfig(devRes.end.mock.calls[0][0], { location }).RUNTIME_CONFIG).toEqual(
      expect.objectContaining({ API_HOST: 'https://trivanta.orrnn.com', BROKER_ID: 'trivanta-markets', BACKEND_TARGET: 'desktop' }),
    )

    const emitFile = vi.fn()
    if (typeof plugin.generateBundle !== 'function') throw new Error('Missing build hook')
    plugin.generateBundle.call({ emitFile } as unknown as Rolldown.PluginContext, {} as never, {}, true)
    const emitted = emitFile.mock.calls.find(([asset]) => asset.fileName === 'runtime-config.js')![0]
    expect(executeConfig(emitted.source, { location }).RUNTIME_CONFIG).toEqual(
      expect.objectContaining({ API_HOST: 'https://trivanta.orrnn.com', BROKER_ID: 'trivanta-markets', BACKEND_TARGET: 'desktop' }),
    )
  })

  it('emits both runtime-config.js and runtime-config-validator.js without preview override', () => {
    const plugin = webRuntimeConfigPlugin({
      VITE_BACKEND_TARGET: 'web',
      VITE_BACKEND_URL: 'https://api.independent-broker.test',
      VITE_BROKER_DISCOVERY_URL: 'https://directory.independent-broker.test',
      VITE_BROKER_ID: 'independent-broker',
      VITE_DEFAULT_MT5_SERVER: 'Independent Broker',
    })
    const emitFile = vi.fn()
    if (typeof plugin.generateBundle !== 'function') throw new Error('Missing build hook')
    plugin.generateBundle.call({ emitFile } as unknown as Rolldown.PluginContext, {} as never, {}, true)

    expect(emitFile).toHaveBeenCalledWith(expect.objectContaining({ type: 'asset', fileName: 'runtime-config.js' }))
    expect(emitFile).toHaveBeenCalledWith(expect.objectContaining({ type: 'asset', fileName: 'runtime-config-validator.js' }))

    const configAsset = emitFile.mock.calls.find(([asset]) => asset.fileName === 'runtime-config.js')![0]
    expect(executeConfig(configAsset.source).RUNTIME_CONFIG).toEqual(expect.objectContaining({ BROKER_ID: 'independent-broker' }))

    const validatorAsset = emitFile.mock.calls.find(([asset]) => asset.fileName === 'runtime-config-validator.js')![0]
    const validatorCtx: {
      window: {
        __RTX_SELECT_BROKER_CONFIG__?: unknown
        __RTX_VALIDATE_BROKER_CONFIG__?: (cfg: Record<string, unknown>) => { valid: boolean }
      }
      URL: typeof URL
    } = { window: {}, URL }
    runInNewContext(validatorAsset.source, validatorCtx)
    expect(typeof validatorCtx.window.__RTX_SELECT_BROKER_CONFIG__).toBe('function')
    expect(typeof validatorCtx.window.__RTX_VALIDATE_BROKER_CONFIG__).toBe('function')
    expect(plugin.configurePreviewServer).toBeUndefined()
  })
})
