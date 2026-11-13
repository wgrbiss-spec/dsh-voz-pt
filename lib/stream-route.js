/**
 * Rota HTTP de ditado ao vivo: `/dsh-voz-pt/stream`.
 *
 * O browser manda PCM16 mono 16 kHz em blocos de ~200 ms e recebe a hipótese
 * parcial da frase corrente. Quando o modelo detecta o fim da frase
 * (`endpoint`), o cliente fecha o trecho e começa outro.
 *
 * A rota é fail-closed: só aceita loopback, mesma origem (Origin/Referer
 * batem com Host), `sec-fetch-site` não cross-site e content-type JSON.
 */

import { randomUUID } from 'node:crypto'

const PATH = '/dsh-voz-pt/stream'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const DEFAULT_IDLE_MS = 120_000

/** @param {unknown} address */
function isLoopback(address) {
  const value = String(address ?? '')
  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '::ffff:127.0.0.1' ||
    /^127\./.test(value) ||
    /^::ffff:127\./.test(value)
  )
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isTrustedStreamRequest(req) {
  if (!isLoopback(req.socket?.remoteAddress)) return false
  const site = String(req.headers['sec-fetch-site'] ?? '')
  if (site === 'cross-site' || site === 'same-site') return false

  const host = String(req.headers.host ?? '')
  if (host === '') return false

  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(String(origin)).host !== host) return false
    } catch {
      return false
    }
  } else {
    const referer = req.headers.referer
    if (referer !== undefined) {
      try {
        if (new URL(String(referer)).host !== host) return false
      } catch {
        return false
      }
    }
  }

  const contentType = String(req.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  return contentType === 'application/json'
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<unknown>}
 */
async function readJson(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('body-too-large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/**
 * PCM16 LE mono 16 kHz -> Float32Array [-1, 1].
 * @param {Buffer} buffer
 * @returns {Float32Array}
 */
function pcm16ToFloat32(buffer) {
  const count = Math.floor(buffer.length / 2)
  const view = new DataView(buffer.buffer, buffer.byteOffset, count * 2)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768
  return samples
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   config: ReturnType<typeof import('./config.js').normalizeConfig>,
 *   manager: import('./manager.js').ModelManager,
 *   engine: import('./streaming-engine.js').StreamingEngine,
 *   logger?: { debug?: Function, warn?: Function, error?: Function },
 * }} options
 * @returns {() => void}
 */
export function attachStreamRoute(ctx, { config, manager, engine, logger }) {
  if (!config.streamingEnabled) return () => {}

  /** @type {Map<string, { recognizer: any, stream: any, createdAt: number, lastUsed: number }>} */
  const sessions = new Map()

  const drop = (id) => {
    sessions.delete(id)
  }

  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastUsed > (config.streamingIdleMs || DEFAULT_IDLE_MS)) drop(id)
    }
  }, 15_000)
  cleanup.unref?.()

  const handler = async (req, res) => {
    if (!isTrustedStreamRequest(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }

    let body
    try {
      body = await readJson(req, MAX_BODY_BYTES)
    } catch (error) {
      const tooLarge = error?.code === 'BODY_TOO_LARGE'
      sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body-too-large' : 'bad-json' })
      return
    }
    if (!body || typeof body !== 'object') {
      sendJson(res, 400, { error: 'bad-json' })
      return
    }

    const action = String(body.action ?? '')
    const id = String(body.id ?? '')
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) {
      sendJson(res, 400, { error: 'bad-id' })
      return
    }

    if (action === 'start') {
      const files = await manager.ensureReady(config.streamingModel)
      if (files === null) {
        manager.prepare(config.streamingModel)
        sendJson(res, 409, {
          error: 'preparing',
          state: manager.state(config.streamingModel),
        })
        return
      }
      sessions.delete(id)
      try {
        const session = await engine.createSession(files, Math.min(4, config.threads))
        sessions.set(id, { ...session, createdAt: Date.now(), lastUsed: Date.now() })
        sendJson(res, 200, { ok: true, text: '' })
      } catch (error) {
        logger?.warn?.(`[dsh-voz-pt] falha ao iniciar streaming: ${error?.message ?? error}`)
        sendJson(res, 500, { error: 'engine', message: String(error?.message ?? error) })
      }
      return
    }

    const session = sessions.get(id)
    if (!session) {
      sendJson(res, 410, { error: 'no-session' })
      return
    }
    session.lastUsed = Date.now()
    if (session.lastUsed - session.createdAt > config.streamingMaxSeconds * 1000) {
      drop(id)
      sendJson(res, 410, { error: 'max-duration' })
      return
    }

    if (action === 'audio') {
      const encoded = String(body.audioBase64 ?? '')
      if (encoded === '') {
        sendJson(res, 400, { error: 'no-audio' })
        return
      }
      let buffer
      try {
        buffer = Buffer.from(encoded, 'base64')
      } catch {
        sendJson(res, 400, { error: 'bad-audio' })
        return
      }
      if (buffer.length === 0 || buffer.length % 2 !== 0) {
        sendJson(res, 400, { error: 'bad-audio' })
        return
      }
      try {
        const result = engine.feed(session, pcm16ToFloat32(buffer))
        sendJson(res, 200, { ok: true, text: result.text, endpoint: result.endpoint })
      } catch (error) {
        drop(id)
        logger?.warn?.(`[dsh-voz-pt] falha no streaming: ${error?.message ?? error}`)
        sendJson(res, 500, { error: 'engine', message: String(error?.message ?? error) })
      }
      return
    }

    if (action === 'stop') {
      try {
        let text = ''
        const encoded = String(body.audioBase64 ?? '')
        if (encoded !== '') {
          const buffer = Buffer.from(encoded, 'base64')
          if (buffer.length % 2 === 0) engine.feed(session, pcm16ToFloat32(buffer))
        }
        text = engine.flush(session)
        sendJson(res, 200, { ok: true, text })
      } catch (error) {
        logger?.warn?.(`[dsh-voz-pt] falha ao finalizar streaming: ${error?.message ?? error}`)
        sendJson(res, 500, { error: 'engine', message: String(error?.message ?? error) })
      } finally {
        drop(id)
      }
      return
    }

    sendJson(res, 400, { error: 'bad-action' })
  }

  const unregister = ctx.webServer.register({ kind: 'exact', path: PATH, handler })

  return () => {
    clearInterval(cleanup)
    sessions.clear()
    unregister()
  }
}

/**
 * Gera um id de sessão para o cliente (exportado para teste).
 * @returns {string}
 */
export function newStreamId() {
  return randomUUID()
}
