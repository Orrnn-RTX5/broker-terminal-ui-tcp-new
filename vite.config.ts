import type { Plugin, ProxyOptions } from 'vite'
import { defineConfig, loadEnv } from 'vite'
import { validateWebBrokerEnvironment } from './viteWebEnv.ts'
import { createWebRuntimeConfig, webRuntimeConfigPlugin } from './viteWebRuntimeConfig.ts'
import { terminalPreloadPlugin } from './viteTerminalPreload.ts'
import { validateBrokerRuntimeConfig } from './src/config/brokerRuntimeConfig.ts'
import { extractBrokerDiscoveryList, isDirectoryBrokerSelectable } from './src/services/brokerDiscovery.ts'
import react from '@vitejs/plugin-react'
import { rtx5BuildInfo } from './viteRtx5BuildInfo.ts'
import reactSwc from '@vitejs/plugin-react-swc'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import { isIP, type Socket } from 'node:net'
import * as tls from 'node:tls'
import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  createPinnedConnectionOptions,
  normalizeProxyAccessOrigin,
  resolveProxyAddresses,
  type ResolvedProxyAddress,
} from './viteBrokerProxyAddress.ts'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

type ViteProxyServer = Parameters<NonNullable<ProxyOptions['configure']>>[0]

const EXPECTED_WS_PROXY_ABORT_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EPIPE',
  'ERR_STREAM_DESTROYED',
])

const getErrorCode = (error: unknown): string => {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const isExpectedWsProxyAbort = (error: unknown): boolean => {
  return EXPECTED_WS_PROXY_ABORT_CODES.has(getErrorCode(error))
}

const endSocketQuietly = (socket: Socket): void => {
  if (!socket.destroyed) {
    socket.end()
  }
}

const replaceSocketErrorLogger = (label: string, socket: Socket): void => {
  queueMicrotask(() => {
    socket.removeAllListeners('error')
    socket.on('error', (error) => {
      if (isExpectedWsProxyAbort(error)) return
      console.warn(`[vite] ${label} proxy socket error: ${getErrorMessage(error)}`)
    })
  })
}

/**
 * Origin decision for WebSocket upgrades proxied to the local web-terminal-server.
 * The proxy rewrites Host to the backend, so the page origin (local or dev tunnel)
 * no longer equals Host there. Only the dev server's own origin is re-stamped with
 * the backend origin; a foreign origin returns null (caller rejects with 403) so
 * cross-site WebSocket hijacking through a tunnel stays blocked. Absent -> undefined.
 */
export const resolveRtx5WsOrigin = (input: {
  origin: string | undefined
  host: string | undefined
  backendOrigin: string
}): string | null | undefined => {
  const origin = (input.origin ?? '').trim()
  if (!origin) return undefined
  const host = (input.host ?? '').trim().toLowerCase()
  if (!host) return null
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    return parsed.host.toLowerCase() === host ? input.backendOrigin : null
  } catch {
    return null
  }
}

const configureWsProxy = (
  label: string,
  options: { stripOrigin?: boolean; backendOrigin?: string } = {}
): NonNullable<ProxyOptions['configure']> => {
  return (proxy: ViteProxyServer) => {
    queueMicrotask(() => {
      proxy.removeAllListeners('error')
      proxy.on('error', (error, req, res) => {
        if (isExpectedWsProxyAbort(error)) {
          if (!('req' in res)) endSocketQuietly(res)
          return
        }

        const requestUrl = req.url ? ` ${req.url}` : ''
        console.warn(`[vite] ${label} proxy error${requestUrl}: ${getErrorMessage(error)}`)
        if ('req' in res) {
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'text/plain' }).end()
          }
          return
        }

        endSocketQuietly(res)
      })
    })

    proxy.on('proxyReqWs', (proxyReq, req, socket) => {
      if (options.backendOrigin) {
        const next = resolveRtx5WsOrigin({
          origin: req.headers.origin,
          host: req.headers.host,
          backendOrigin: options.backendOrigin,
        })
        if (next === null) {
          proxyReq.destroy()
          if (!socket.destroyed) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          }
          return
        }
        if (next !== undefined) proxyReq.setHeader('origin', next)
      } else if (options.stripOrigin) {
        proxyReq.removeHeader('origin')
      }
      replaceSocketErrorLogger(label, socket)
    })
  }
}

const PROXY_STRIPPED_REQUEST_HEADERS = new Set(['host', 'origin'])
const PROXY_STRIPPED_RESPONSE_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
])

const copyProxyHeaders = (
  headers: IncomingHttpHeaders,
  strippedHeaders: ReadonlySet<string> = PROXY_STRIPPED_REQUEST_HEADERS,
): IncomingHttpHeaders => {
  const nextHeaders: IncomingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lower) && !strippedHeaders.has(lower)) {
      nextHeaders[key] = value
    }
  }
  return nextHeaders
}

const addOrigin = (origins: Set<string>, value: string): void => {
  const origin = normalizeProxyAccessOrigin(value)
  if (origin) origins.add(origin)
}

const splitAllowlist = (value: string | undefined): string[] => {
  return String(value || '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export const parseDynamicProxyTarget = (requestUrl: string, prefix: string): URL | null => {
  if (!requestUrl.startsWith(`${prefix}/`)) return null

  const pathAfterPrefix = requestUrl.slice(prefix.length + 1)
  const slashIndex = pathAfterPrefix.indexOf('/')
  const encodedOrigin = slashIndex >= 0 ? pathAfterPrefix.slice(0, slashIndex) : pathAfterPrefix
  const targetPath = slashIndex >= 0 ? pathAfterPrefix.slice(slashIndex) : '/'
  if (!encodedOrigin) return null

  try {
    const origin = new URL(decodeURIComponent(encodedOrigin))
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return null
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') return null
    const queryIndex = targetPath.indexOf('?')
    const pathname = queryIndex >= 0 ? targetPath.slice(0, queryIndex) : targetPath
    const search = queryIndex >= 0 ? targetPath.slice(queryIndex) : ''
    const target = new URL(origin.origin)
    target.pathname = pathname || '/'
    target.search = search
    return target
  } catch {
    return null
  }
}

type BrokerProxyAccess = {
  valid: boolean
  pinned: boolean
  brokerId: string
  trustedOrigins: Set<string>
  brokerOrigins: Set<string>
  discoveryOrigins: Set<string>
  envAllowedOrigins: Set<string>
  discoveredBrokerOrigins: Set<string>
}

export const getBrokerProxyTargets = (env: Record<string, string>) => {
  const runtime = createWebRuntimeConfig(env)
  const config = validateBrokerRuntimeConfig(runtime, { desktop: !runtime.PINNED_BROKER, allowLocal: !runtime.PINNED_BROKER })
  // A desktop picker may start before choosing an account/broker. Malformed
  // destinations still fail closed; only absent picker fields are tolerated.
  const valid = config.valid || (!runtime.PINNED_BROKER && config.errors.every(error => /^\w+ is required for this broker deployment[.]$/.test(error)))
  return {
    valid, pinned: runtime.PINNED_BROKER, brokerId: config.brokerId,
    backendTarget: valid ? config.apiHost : '',
    brokerApiTarget: valid ? config.apiHostExt : '',
    discoveryTarget: valid ? config.discoveryBaseUrl : '',
    wsTarget: valid ? config.wsHost : '',
    allowedOrigins: valid ? config.allowedOrigins : [],
    extraDiscoveryUrls: valid && !runtime.PINNED_BROKER ? config.extraDiscoveryUrls : [],
  }
}

export const createBrokerProxyAccess = (env: Record<string, string>): BrokerProxyAccess => {
  const targets = getBrokerProxyTargets(env)
  const trustedOrigins = new Set<string>()
  const brokerOrigins = new Set<string>()
  const discoveryOrigins = new Set<string>()
  const envAllowedOrigins = new Set<string>()
  if (targets.valid) {
    targets.allowedOrigins.forEach(value => addOrigin(brokerOrigins, value))
    ;[targets.discoveryTarget, ...targets.extraDiscoveryUrls].forEach(value => addOrigin(discoveryOrigins, value))
    for (const origin of [...brokerOrigins, ...discoveryOrigins]) trustedOrigins.add(origin)
    // Explicit development exceptions retain private-address routing. They do
    // not rescue a missing/invalid pinned broker or change static API targets.
    splitAllowlist(env.DEV_PROXY_ALLOWED_ORIGINS ?? env.VITE_DEV_PROXY_ALLOWED_ORIGINS)
      .forEach(value => addOrigin(envAllowedOrigins, value))
    splitAllowlist(env.DEV_BROKER_PROXY_ALLOWED_ORIGINS ?? env.VITE_DEV_BROKER_PROXY_ALLOWED_ORIGINS)
      .forEach(value => addOrigin(envAllowedOrigins, value))
  }

  return {
    valid: targets.valid, pinned: targets.pinned, brokerId: targets.brokerId,
    trustedOrigins,
    brokerOrigins,
    discoveryOrigins,
    envAllowedOrigins,
    discoveredBrokerOrigins: new Set<string>(),
  }
}

export const validateProxyTarget = async (
  target: URL,
  access: BrokerProxyAccess,
  kind: 'broker' | 'discovery' = 'broker',
): Promise<{ allowed: true; resolvedAddresses: ResolvedProxyAddress[] } | { allowed: false; reason: string }> => {
  if (!access.valid) return { allowed: false, reason: 'Broker runtime configuration is missing or invalid' }
  if (target.username || target.password || target.hash) return { allowed: false, reason: 'Broker proxy target contains credentials or a fragment' }
  const comparableOrigin = normalizeProxyAccessOrigin(target.origin)
  if (!comparableOrigin) {
    return { allowed: false, reason: 'Broker proxy target uses an unsupported protocol' }
  }

  const explicitlyAllowed = access.envAllowedOrigins.has(comparableOrigin)
  const knownOrigin = explicitlyAllowed
    || (kind === 'discovery' ? access.discoveryOrigins.has(comparableOrigin) : access.brokerOrigins.has(comparableOrigin))
    || (kind === 'broker' && access.discoveredBrokerOrigins.has(comparableOrigin))

  if (!knownOrigin) {
    return { allowed: false, reason: 'Broker proxy target is not in the trusted origin allowlist' }
  }

  const resolvedAddresses = await resolveProxyAddresses(target.hostname, !explicitlyAllowed)
  if (!resolvedAddresses) {
    return {
      allowed: false,
      reason: explicitlyAllowed
        ? 'Broker proxy target could not be resolved'
        : 'Broker proxy target must resolve to a public host',
    }
  }

  return { allowed: true, resolvedAddresses }
}

export const learnBrokerOrigins = (body: Buffer, access: BrokerProxyAccess): void => {
  if (!access.valid) return
  access.discoveredBrokerOrigins.clear()
  let payload: unknown
  try {
    payload = JSON.parse(body.toString('utf8'))
  } catch {
    return
  }

  // Every fresh directory response replaces the old authority, including an
  // empty catalog. Never retain a removed/suspended broker's origins.
  for (const record of extractBrokerDiscoveryList(payload)) {
    if (access.pinned && record.broker_id !== access.brokerId) continue
    if (!access.pinned && !isDirectoryBrokerSelectable(record)) continue
    if (record.active === false || record.enabled === false || /^(suspended|disabled|inactive|deleted)$/i.test(String(record.status || ''))) continue
    for (const key of [
      'server_url',
      'serverUrl',
      'server',
      'backend_url',
      'backendUrl',
      'market_api_url',
      'marketApiUrl',
      'public_backend_url',
      'publicBackendUrl',
      'public_ext_api_url',
      'publicExtApiUrl',
      'web_backend_url',
      'webBackendUrl',
      'web_ext_api_url',
      'webExtApiUrl',
      'services_url',
      'servicesUrl',
      'API_HOST',
      'API_HOST_EXT',
      'api_host',
      'api_host_ext',
      'ws_url', 'wsUrl', 'public_ws_url', 'publicWsUrl',
      'feed_url', 'feedUrl', 'feed_ws_url', 'feedWsUrl',
    ]) {
      if (typeof record[key] !== 'string') continue
      try {
        const url = new URL(record[key] as string)
        if (url.username || url.password || url.search || url.hash) continue
        if (!(access.pinned ? ['https:', 'wss:'] : ['https:', 'http:', 'wss:', 'ws:']).includes(url.protocol)) continue
        addOrigin(access.discoveredBrokerOrigins, url.origin)
      } catch { /* Invalid discovery destinations never become proxy authorities. */ }
    }
  }
}

const sendProxyError = (res: ServerResponse, statusCode: number, message: string): void => {
  if (res.headersSent) {
    res.end()
    return
  }

  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(message)
}

const BROKER_PROXY_CONNECT_TIMEOUT_MS = 2_500
const BROKER_PROXY_MAX_CONNECT_ATTEMPTS = 4

const brokerHttpProxyAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 2,
  maxFreeSockets: 2,
  keepAliveMsecs: 1_000,
})

const brokerHttpsProxyAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 1,
  maxFreeSockets: 1,
  keepAliveMsecs: 1_000,
})

const brokerTlsHandshakeQueues = new Map<string, Promise<void>>()

const serializeBrokerTlsHandshake = (host: string, connectTask: (release: () => void) => void): void => {
  const key = host.toLowerCase()
  const previous = brokerTlsHandshakeQueues.get(key) ?? Promise.resolve()
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  const current = previous.then(() => gate)
  brokerTlsHandshakeQueues.set(key, current)

  void previous.then(() => {
    let released = false
    const release = () => {
      if (released) return
      released = true
      releaseGate()
      if (brokerTlsHandshakeQueues.get(key) === current) {
        brokerTlsHandshakeQueues.delete(key)
      }
    }
    connectTask(release)
  })
}

const isRetriablePreResponseProxyError = (
  error: unknown,
  socketConnected: boolean,
  reusedSocket: boolean,
  method?: string,
): boolean => {
  const message = getErrorMessage(error)
  if (message === 'BROKER_PROXY_CONNECT_TIMEOUT') return true
  if (!socketConnected || reusedSocket) return true
  const normalizedMethod = String(method || 'GET').toUpperCase()
  const idempotent =
    normalizedMethod === 'GET'
    || normalizedMethod === 'HEAD'
    || normalizedMethod === 'OPTIONS'
    || normalizedMethod === 'PUT'
    || normalizedMethod === 'DELETE'
  if (!idempotent) return false
  const code = getErrorCode(error)
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT' || /socket hang up/i.test(message)
}

const forwardRequest = (
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  resolvedAddresses: readonly ResolvedProxyAddress[],
  onResponseBody?: (body: Buffer) => void
): void => {
  const transport = target.protocol === 'https:' ? https : http
  const agent = target.protocol === 'https:' ? brokerHttpsProxyAgent : brokerHttpProxyAgent
  const headers = copyProxyHeaders(req.headers)
  if (onResponseBody) {
    for (const key of Object.keys(headers)) {
      if (['accept-encoding', 'authorization', 'cookie', 'x-api-key'].includes(key.toLowerCase())) delete headers[key]
    }
  }

  const requestChunks: Buffer[] = []
  let activeProxyReq: http.ClientRequest | null = null
  let clientClosed = false

  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true
      activeProxyReq?.destroy()
    }
  })

  req.on('data', (chunk: Buffer) => {
    requestChunks.push(Buffer.from(chunk))
  })

  req.on('error', (error) => {
    sendProxyError(res, 502, `Broker proxy request failed: ${error.message}`)
  })

  req.on('end', () => {
    if (clientClosed) return
    const requestBody = Buffer.concat(requestChunks)

    const attemptForward = (attempt: number): void => {
      if (clientClosed || res.headersSent || res.writableEnded) return

      const runAttempt = (releaseHandshake: () => void): void => {
        if (clientClosed || res.headersSent || res.writableEnded) {
          releaseHandshake()
          return
        }

        const requestOptions: http.RequestOptions & https.RequestOptions = {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers,
          agent,
          ...createPinnedConnectionOptions(resolvedAddresses),
          rejectUnauthorized: true,
        }

        if (target.protocol === 'https:' && !isIP(target.hostname.replace(/^\[|\]$/g, ''))) {
          requestOptions.servername = target.hostname
        }

        let responseStarted = false
        let socketConnected = false
        let connectTimer: ReturnType<typeof setTimeout> | null = null
        let settled = false

        const clearConnectTimer = () => {
          if (connectTimer !== null) {
            clearTimeout(connectTimer)
            connectTimer = null
          }
        }

        const proxyReq = transport.request(requestOptions, (proxyRes) => {
          responseStarted = true
          socketConnected = true
          clearConnectTimer()
          releaseHandshake()

          const responseHeaders = copyProxyHeaders(proxyRes.headers, PROXY_STRIPPED_RESPONSE_HEADERS)
          res.writeHead(proxyRes.statusCode || 502, proxyRes.statusMessage, responseHeaders)

          if (!onResponseBody) {
            proxyRes.pipe(res)
            return
          }

          const chunks: Buffer[] = []
          proxyRes.on('data', (chunk: Buffer) => {
            chunks.push(Buffer.from(chunk))
          })
          proxyRes.on('end', () => {
            const body = Buffer.concat(chunks)
            onResponseBody(body)
            res.end(body)
          })
        })

        activeProxyReq = proxyReq

        proxyReq.on('socket', (socket: Socket & { encrypted?: boolean }) => {
          if (!socket.connecting) {
            socketConnected = true
            releaseHandshake()
            return
          }

          connectTimer = setTimeout(() => {
            if (!socketConnected && !responseStarted) {
              releaseHandshake()
              proxyReq.destroy(new Error('BROKER_PROXY_CONNECT_TIMEOUT'))
            }
          }, BROKER_PROXY_CONNECT_TIMEOUT_MS)

          const markConnected = () => {
            socketConnected = true
            clearConnectTimer()
            releaseHandshake()
          }

          const releaseOnSocketEnd = () => {
            clearConnectTimer()
            releaseHandshake()
          }

          if (target.protocol === 'https:') {
            socket.once('secureConnect', markConnected)
          } else {
            socket.once('connect', markConnected)
          }
          socket.once('error', releaseOnSocketEnd)
          socket.once('close', releaseOnSocketEnd)
        })

        proxyReq.on('error', (error) => {
          clearConnectTimer()
          releaseHandshake()
          if (settled || clientClosed) return
          settled = true

          if (
            !responseStarted
            && attempt < BROKER_PROXY_MAX_CONNECT_ATTEMPTS
            && isRetriablePreResponseProxyError(error, socketConnected, Boolean(proxyReq.reusedSocket), req.method)
          ) {
            attemptForward(attempt + 1)
            return
          }

          sendProxyError(res, 502, `Broker proxy request failed: ${error.message}`)
        })

        if (requestBody.length > 0) {
          proxyReq.write(requestBody)
        }
        proxyReq.end()
      }

      if (target.protocol === 'https:') {
        serializeBrokerTlsHandshake(target.hostname, runAttempt)
      } else {
        runAttempt(() => {})
      }
    }

    attemptForward(1)
  })
  req.resume()
}

const isBrokerDiscoveryResponse = (prefix: string, target: URL): boolean => {
  return prefix === '/__broker_discovery' && /^\/api\/v\d+\/broker\/servers\/?$/.test(target.pathname)
}

// Vite's static server.proxy cannot route WebSocket upgrades to a per-request
// dynamic origin (the broker is encoded in the path). Bridge the upgrade by
// hand: replay the client's handshake against the decoded broker origin with
// the Origin header stripped (broker backends reject unknown browser origins),
// then pipe raw sockets both ways.
const rewriteUpgradeRequestHead = (req: IncomingMessage, target: URL): Buffer => {
  const lines = [`${req.method || 'GET'} ${target.pathname}${target.search} HTTP/1.1`]
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (lower === 'host' || lower === 'origin' || lower === 'connection' || lower === 'upgrade') continue
    if (Array.isArray(value)) {
      value.forEach((item) => lines.push(`${key}: ${item}`))
    } else if (value !== undefined) {
      lines.push(`${key}: ${value}`)
    }
  }
  lines.push(`Host: ${target.host}`)
  lines.push('Connection: Upgrade')
  lines.push('Upgrade: websocket')
  lines.push('', '')
  return Buffer.from(lines.join('\r\n'))
}

const bridgeWebSocketUpgrade = (
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: URL,
  resolvedAddresses: readonly ResolvedProxyAddress[],
): void => {
  const useTls = target.protocol === 'wss:'
  const port = target.port ? Number(target.port) : useTls ? 443 : 80
  const requestHead = rewriteUpgradeRequestHead(req, target)
  const connectionOptions = createPinnedConnectionOptions(resolvedAddresses)

  let outbound: Socket | null = null
  let clientClosed = false
  const fail = () => {
    clientClosed = true
    socket.destroy()
    outbound?.destroy()
  }
  socket.on('error', fail)
  socket.on('close', () => {
    clientClosed = true
    outbound?.destroy()
  })

  const startPiping = (out: Socket) => {
    if (clientClosed || socket.destroyed) {
      out.destroy()
      return
    }
    outbound = out
    out.on('error', fail)
    out.write(requestHead)
    if (head.length > 0) out.write(head)
    socket.pipe(out)
    out.pipe(socket)
  }

  const attemptUpgradeConnect = (attempt: number) => {
    if (clientClosed || socket.destroyed) return

    if (useTls) {
      serializeBrokerTlsHandshake(target.hostname, (release) => {
        if (clientClosed || socket.destroyed) {
          release()
          return
        }

        let connected = false
        let attemptSettled = false
        const tlsSocket = tls.connect(
          {
            host: target.hostname,
            port,
            servername: target.hostname,
            rejectUnauthorized: true,
            ...connectionOptions,
          },
          () => {
            if (attemptSettled) return
            connected = true
            attemptSettled = true
            clearTimeout(connectTimer)
            release()
            startPiping(tlsSocket)
          },
        )

        const connectTimer = setTimeout(() => {
          if (!connected && !attemptSettled) {
            attemptSettled = true
            release()
            tlsSocket.destroy()
            if (attempt < BROKER_PROXY_MAX_CONNECT_ATTEMPTS) {
              attemptUpgradeConnect(attempt + 1)
            } else {
              fail()
            }
          }
        }, BROKER_PROXY_CONNECT_TIMEOUT_MS)

        tlsSocket.on('error', () => {
          clearTimeout(connectTimer)
          release()
          if (connected) {
            fail()
            return
          }
          if (!attemptSettled) {
            attemptSettled = true
            tlsSocket.destroy()
            if (attempt < BROKER_PROXY_MAX_CONNECT_ATTEMPTS) {
              attemptUpgradeConnect(attempt + 1)
            } else {
              fail()
            }
          }
        })
      })
    } else {
      let connected = false
      let attemptSettled = false
      const netSocket = net.connect(
        { host: target.hostname, port, ...connectionOptions },
        () => {
          if (attemptSettled) return
          connected = true
          attemptSettled = true
          clearTimeout(connectTimer)
          startPiping(netSocket)
        },
      )

      const connectTimer = setTimeout(() => {
        if (!connected && !attemptSettled) {
          attemptSettled = true
          netSocket.destroy()
          if (attempt < BROKER_PROXY_MAX_CONNECT_ATTEMPTS) {
            attemptUpgradeConnect(attempt + 1)
          } else {
            fail()
          }
        }
      }, BROKER_PROXY_CONNECT_TIMEOUT_MS)

      netSocket.on('error', () => {
        clearTimeout(connectTimer)
        if (connected) {
          fail()
          return
        }
        if (!attemptSettled) {
          attemptSettled = true
          netSocket.destroy()
          if (attempt < BROKER_PROXY_MAX_CONNECT_ATTEMPTS) {
            attemptUpgradeConnect(attempt + 1)
          } else {
            fail()
          }
        }
      })
    }
  }

  attemptUpgradeConnect(1)
}

const attachDynamicBrokerWsUpgrade = (
  httpServer: { on: (event: 'upgrade', listener: (req: IncomingMessage, socket: Socket, head: Buffer) => void) => unknown } | null | undefined,
  prefix: string,
  access: BrokerProxyAccess,
): void => {
  httpServer?.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const requestUrl = req.url || ''
    if (!requestUrl.startsWith(`${prefix}/`)) return

    const pathAfterPrefix = requestUrl.slice(prefix.length + 1)
    const slashIndex = pathAfterPrefix.indexOf('/')
    const encodedOrigin = slashIndex >= 0 ? pathAfterPrefix.slice(0, slashIndex) : pathAfterPrefix
    const targetPath = slashIndex >= 0 ? pathAfterPrefix.slice(slashIndex) : '/'

    let target: URL
    try {
      const origin = new URL(decodeURIComponent(encodedOrigin))
      if (origin.protocol !== 'ws:' && origin.protocol !== 'wss:') throw new Error('unsupported ws protocol')
      if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('invalid ws origin')
      const queryIndex = targetPath.indexOf('?')
      origin.pathname = (queryIndex >= 0 ? targetPath.slice(0, queryIndex) : targetPath) || '/'
      origin.search = queryIndex >= 0 ? targetPath.slice(queryIndex) : ''
      target = origin
    } catch {
      ; (socket as Socket).destroy()
      return
    }

    const clientSocket = socket as Socket
    void validateProxyTarget(target, access)
      .then((validation) => {
        if (!validation.allowed) {
          clientSocket.destroy()
          return
        }
        bridgeWebSocketUpgrade(req, clientSocket, head as Buffer, target, validation.resolvedAddresses)
      })
      .catch(() => clientSocket.destroy())
  })
}

const dynamicBrokerWsProxyPlugin = (prefix: string, access: BrokerProxyAccess): Plugin => ({
  name: 'rtx5-dynamic-broker-ws-proxy',
  configureServer(server) {
    attachDynamicBrokerWsUpgrade(server.httpServer, prefix, access)
  },
  configurePreviewServer(server) {
    attachDynamicBrokerWsUpgrade(server.httpServer, prefix, access)
  },
})

const attachDynamicBrokerMiddleware = (
  middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => unknown },
  prefixes: string[],
  access: BrokerProxyAccess,
): void => {
  middlewares.use((req, res, next) => {
    const requestUrl = req.url || ''
    const prefix = prefixes.find((candidate) => requestUrl.startsWith(`${candidate}/`))
    if (!prefix) {
      next()
      return
    }

    const target = parseDynamicProxyTarget(requestUrl, prefix)
    if (!target) {
      sendProxyError(res, 400, 'Invalid broker proxy target')
      return
    }

    req.pause()
    void (async () => {
      const validation = await validateProxyTarget(target, access, prefix === '/__broker_discovery' ? 'discovery' : 'broker')
      if (validation.allowed === false) {
        req.resume()
        sendProxyError(res, 403, validation.reason)
        return
      }

      forwardRequest(
        req,
        res,
        target,
        validation.resolvedAddresses,
        isBrokerDiscoveryResponse(prefix, target) ? (body) => learnBrokerOrigins(body, access) : undefined
      )
    })().catch((error) => {
      req.resume()
      sendProxyError(res, 502, `Broker proxy validation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
}

const dynamicBrokerProxyPlugin = (prefixes: string[], access: BrokerProxyAccess): Plugin => ({
  name: 'rtx5-dynamic-broker-proxy',
  configureServer(server) {
    attachDynamicBrokerMiddleware(server.middlewares, prefixes, access)
  },
  configurePreviewServer(server) {
    attachDynamicBrokerMiddleware(server.middlewares, prefixes, access)
  },
})

const retiredServiceWorkerDevPlugin = (): Plugin => ({
  name: 'rtx5-retired-service-worker',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = String(req.url || '').split(/[?#]/, 1)[0]
      if (pathname !== '/sw.js') {
        next()
        return
      }

      res.statusCode = 404
      res.setHeader('Cache-Control', 'no-store, max-age=0')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('Service worker retired')
    })
  },
})

const DEV_WATCH_IGNORED_DIRS = [
  'artifacts', 'draft', 'dist', 'dist-ssr', 'release', 'build', 'docs', 'test-logs', 'tmp',
  'mt5-trading-panel', '.qwen', '.claude', '.github',
]

const desktopTcpToolbarDevPlugin = (enabled: boolean): Plugin => {
  if (!enabled) {
    return { name: 'rtx5-desktop-tcp-toolbar-dev' }
  }
  return {
    name: 'rtx5-desktop-tcp-toolbar-dev',
    configureServer(server) {
      const localToolbarPath = resolve(process.cwd(), 'web-terminal-server', 'tcp_toolbar.js')
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0]
        if (pathname !== '/rtx5-tcp-toolbar.js' || !existsSync(localToolbarPath)) {
          next()
          return
        }
        try {
          const source = readFileSync(localToolbarPath, 'utf8')
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store, max-age=0')
          res.end(source)
        } catch {
          next()
        }
      })
    },
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { src: '/rtx5-tcp-toolbar.js', defer: true },
          injectTo: 'body',
        },
      ]
    },
  }
}

const localBinaryTcpBridgeDevPlugin = (
  env: Record<string, string>,
  backendTarget: string,
  enabled: boolean,
): Plugin => {
  if (!enabled || !backendTarget) {
    return { name: 'rtx5-local-binary-tcp-bridge' }
  }

  let parsedTarget: URL
  try {
    parsedTarget = new URL(backendTarget)
  } catch {
    return { name: 'rtx5-local-binary-tcp-bridge' }
  }

  if (
    parsedTarget.protocol !== 'http:'
    || (parsedTarget.hostname !== '127.0.0.1' && parsedTarget.hostname !== 'localhost')
  ) {
    return { name: 'rtx5-local-binary-tcp-bridge' }
  }

  const port = parsedTarget.port ? Number(parsedTarget.port) : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { name: 'rtx5-local-binary-tcp-bridge' }
  }

  return {
    name: 'rtx5-local-binary-tcp-bridge',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        let settled = false
        const probe = net.createConnection({ host: parsedTarget.hostname, port })
        probe.setTimeout(400)

        const startBridgeIfNeeded = () => {
          if (settled) return
          settled = true
          probe.destroy()

          const serverDir = resolve(process.cwd(), 'web-terminal-server')
          const binName = process.platform === 'win32'
            ? 'rtx5-web-terminal-server.exe'
            : 'rtx5-web-terminal-server'
          const binPath = resolve(serverDir, binName)
          if (!existsSync(binPath)) {
            console.warn(`[rtx5-tcp-bridge] Bridge binary not found at ${binPath}`)
            return
          }

          const listenAddr = `${parsedTarget.hostname}:${port}`
          const serverTcp = String(env.BROKER_TCP_ADDR || env.VITE_BROKER_TCP_ADDR || '51.195.188.172:4443').trim()
          const superAdminTcp = String(env.SUPERADMIN_TCP_ADDR || env.VITE_SUPERADMIN_TCP_ADDR || '51.195.188.172:9100').trim()
          const brokerId = String(env.BROKER_ID || env.VITE_BROKER_ID || 'orrnn').trim()
          const brokerName = String(env.BROKER_NAME || env.VITE_BROKER_NAME || 'Orrnn').trim()

          console.info(`[rtx5-tcp-bridge] Starting local Binary TCP bridge on ${listenAddr} -> ${serverTcp}`)
          const child: ChildProcess = spawn(
            binPath,
            [
              '-listen', listenAddr,
              '-server', serverTcp,
              '-superadmin', superAdminTcp,
              '-broker-id', brokerId,
              '-broker-name', brokerName,
            ],
            {
              cwd: serverDir,
              stdio: 'inherit',
            },
          )

          const stopChild = () => {
            if (!child.killed) {
              child.kill()
            }
          }
          child.on('error', (error) => {
            console.warn(`[rtx5-tcp-bridge] Failed to start Binary TCP bridge: ${getErrorMessage(error)}`)
          })
          child.once('exit', () => {
            process.off('exit', stopChild)
          })
          server.httpServer?.once('close', stopChild)
          process.once('exit', stopChild)
        }

        probe.once('connect', () => {
          if (settled) return
          settled = true
          probe.destroy()
          console.info(`[rtx5-tcp-bridge] Using running Binary TCP bridge on ${parsedTarget.hostname}:${port}`)
        })
        probe.once('timeout', startBridgeIfNeeded)
        probe.once('error', startBridgeIfNeeded)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (mode === 'web') validateWebBrokerEnvironment(env, process.cwd());
  const { backendTarget, discoveryTarget, brokerApiTarget, wsTarget } = getBrokerProxyTargets(env);
  const brokerProxyAccess = createBrokerProxyAccess(env);
  const runtimeBackendTarget = String(env.BACKEND_TARGET || env.VITE_BACKEND_TARGET || mode || '').trim().toLowerCase();
  const isDesktopServe = command === 'serve' && mode !== 'test' && !process.env.VITEST && runtimeBackendTarget === 'desktop';

  const appVersion = String(JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version ?? '')

  const configureReverseProxy = (): NonNullable<ProxyOptions['configure']> => {
    return (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
      })
      proxy.on('proxyRes', (proxyRes) => {
        for (const header of PROXY_STRIPPED_RESPONSE_HEADERS) {
          delete proxyRes.headers[header]
        }
      })
    }
  }

  const staticProxy = Object.fromEntries(Object.entries({
    '/__broker_discovery': {
      target: discoveryTarget,
      changeOrigin: true,
      secure: true,
      rewrite: (path) => path.replace(/^\/__broker_discovery/, ''),
      configure: configureReverseProxy(),
    },
    '/__broker_api': {
      target: brokerApiTarget,
      changeOrigin: true,
      secure: true,
      rewrite: (path) => path.replace(/^\/__broker_api/, ''),
      configure: configureReverseProxy(),
    },
    '/__rtx5_binary_stream': {
      target: backendTarget,
      changeOrigin: true,
      secure: true,
    },
    '/__rtx5_binary_account_sub': {
      target: backendTarget,
      changeOrigin: true,
      secure: true,
    },
    '/__rtx5_binary_order_ws': {
      target: wsTarget,
      changeOrigin: true,
      secure: true,
      ws: true,
      configure: configureWsProxy('rtx5-binary-order-ws'),
    },
    '/__rtx5_drawing_ws': {
      target: wsTarget,
      changeOrigin: true,
      secure: true,
      ws: true,
      configure: configureWsProxy('rtx5-drawing-ws'),
    },
    '/__rtx5_binary_order': {
      target: backendTarget,
      changeOrigin: true,
      secure: true,
    },
    '/rtx5-tcp-toolbar.js': {
      target: backendTarget,
      changeOrigin: true,
      secure: true,
    },
    '/api': {
      target: backendTarget,
      changeOrigin: true,
      secure: true,
      configure: configureReverseProxy(),
      // NOTE: ws:true removed — it caused 503s by intercepting HTTP requests
      // as WebSocket upgrades. WS connections use /fix-ws proxy below.
    },
    '/fix-ws': {
      target: wsTarget,
      changeOrigin: true,
      secure: true,
      ws: true,
      configure: configureWsProxy('fix-ws'),
    }
    // '/__broker_feed_ws' upgrades are routed by dynamicBrokerWsProxyPlugin,
    // which decodes the per-request broker origin (a static proxy target
    // sent every broker's WebSocket to the .env broker — breaking live data
    // whenever the runtime broker differs).
  } satisfies Record<string, ProxyOptions>).filter(([, proxy]) => Boolean(proxy.target)))

  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    resolve: {
      alias: mode === 'desktop' || mode === 'electron'
        ? [{ find: './startup/WelcomeTerminalEntry', replacement: resolve(process.cwd(), 'src/startup/DesktopWelcomeTerminal.ts') }]
        : [],
    },
    plugins: [
      rtx5BuildInfo(),
      ...(mode === 'web' ? [webRuntimeConfigPlugin(env), terminalPreloadPlugin()] : []),
      retiredServiceWorkerDevPlugin(),
      dynamicBrokerProxyPlugin(['/__broker_api', '/__broker_discovery'], brokerProxyAccess),
      dynamicBrokerWsProxyPlugin('/__broker_feed_ws', brokerProxyAccess),
      desktopTcpToolbarDevPlugin(isDesktopServe && Boolean(backendTarget)),
      localBinaryTcpBridgeDevPlugin(
        env,
        backendTarget,
        isDesktopServe && env.VITE_AUTO_START_TCP_BRIDGE?.trim().toLowerCase() !== 'false',
      ),
      // Dev server: SWC compiles React Fast Refresh several times faster than
      // Babel, which dominated cold first-page loads. Builds keep plugin-react
      // so production output is unchanged.
      command === 'serve' ? reactSwc() : react(),
    ],
    preview: {
      host: '127.0.0.1',
      port: 4173,
      proxy: staticProxy,
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      open: true,
      // Dev tunnels: Vite only appends the raw env value as ONE host, so a comma list never matches.
      ...(command === 'serve' && process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
        ? { allowedHosts: process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean) }
        : {}),
      watch: {
        // Build output, installers, captured artifacts and tool caches hold
        // thousands of files the app never imports. Watching them costs seconds
        // of dev-server CPU on Windows and delays the first page load.
        ignored: DEV_WATCH_IGNORED_DIRS.map((dir) => `${process.cwd().replace(/\\/g, '/')}/${dir}/**`),
      },
      warmup: {
        clientFiles: [
          './src/main.tsx',
          './src/bootstrap.tsx',
          './src/AppShell.tsx',
          './src/components/WelcomeTerminal.tsx',
          './src/App.tsx',
          './src/components/dock/DockWorkspace.tsx',
          './src/components/TradingChart.tsx',
          './src/components/BottomDock.tsx',
          './src/components/layout/TopToolbar.tsx',
        ],
      },
      // Dev-server only (preview keeps staticProxy). The '/__rtx5_' prefix is listed first so
      // it wins over the specific '/__rtx5_*' entries in staticProxy: every local
      // web-terminal-server route (binary stream, account_sub, order, order_ws, drawing_ws)
      // goes to backendTarget with ws:true. http-proxy streams by default and sets no timeout.
      // The local server accepts WS origins only when loopback or equal to its Host, so
      // same-origin pages (local or dev tunnel) are re-stamped with the backend origin;
      // foreign origins are rejected here (403); absent origins stay absent.
      proxy: Object.fromEntries(Object.entries({
        '/__rtx5_': {
          target: backendTarget,
          changeOrigin: true,
          secure: true,
          ws: true,
          configure: configureWsProxy('rtx5-binary', { backendOrigin: (() => { try { return new URL(backendTarget).origin } catch { return undefined } })() }),
        },
        ...staticProxy,
      } satisfies Record<string, ProxyOptions>).filter(([, proxy]) => Boolean(proxy.target)))
    },
    optimizeDeps: {
      include: ['lightweight-charts', 'html2canvas-pro'],
    }
  };
})
