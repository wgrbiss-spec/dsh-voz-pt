/**
 * Motor Whisper ONNX via `sherpa-onnx-node`.
 *
 * - `sherpa-onnx-node` é carregado dinamicamente (nada de addon nativo na
 *   ativação do plugin). Primeiro `import('sherpa-onnx-node')`; fora do perfil
 *   do DSH, tenta a cópia instalada junto do app.
 * - `OfflineRecognizer.createAsync` não bloqueia o event loop no carregamento.
 * - `decodeAsync` roda a inferência nativa fora do event loop, então o
 *   `AbortSignal` do host responde mesmo com o decode em andamento. O slot da
 *   fila só é liberado quando o decode realmente termina, para nunca
 *   sobrepor duas inferências no addon.
 * - Uma transcrição por vez, com fila curta (2).
 */

import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const DSH_ROOT = process.env.DSH_ROOT || '/usr/lib/node_modules/@deepseek-ai/dsh'

/** Fila máxima de transcrições aguardando. */
export const MAX_QUEUE = 2

/** Erro do motor com código estável. */
export class EngineError extends Error {
  /**
   * @param {'busy' | 'disposed' | 'load' | 'engine'} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'EngineError'
    this.code = code
  }
}

/**
 * @returns {string[]}
 */
function absoluteCandidates() {
  const roots = [
    process.env.DSH_SHERPA_PATH,
    process.env.DSH_PROFILE_DIR
      ? path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'sherpa-onnx-node')
      : undefined,
    path.join(DSH_ROOT, 'node_modules', 'sherpa-onnx-node'),
    path.join(DSH_ROOT, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'),
  ]
  return roots.filter((candidate) => typeof candidate === 'string' && candidate !== '')
}

/**
 * @param {Record<string, unknown>} namespace
 * @returns {Record<string, unknown>}
 */
function unwrapSherpa(namespace) {
  if (namespace && typeof namespace.OfflineRecognizer === 'function') return namespace
  if (namespace && namespace.default && typeof namespace.default.OfflineRecognizer === 'function') {
    return namespace.default
  }
  return namespace
}

/** @type {Promise<Record<string, unknown>> | null} */
let sherpaPromise = null

/**
 * Carrega `sherpa-onnx-node` uma única vez.
 * @returns {Promise<Record<string, unknown>>}
 */
export function loadSherpa() {
  if (sherpaPromise) return sherpaPromise
  sherpaPromise = (async () => {
    const failures = []
    try {
      return unwrapSherpa(await import('sherpa-onnx-node'))
    } catch (error) {
      failures.push(`import('sherpa-onnx-node'): ${error?.message ?? error}`)
    }
    for (const candidate of absoluteCandidates()) {
      try {
        return require(candidate)
      } catch (error) {
        failures.push(`require('${candidate}'): ${error?.message ?? error}`)
      }
    }
    throw new EngineError(
      'load',
      'Não foi possível carregar o sherpa-onnx-node (motor local de transcrição).\n' +
        failures.map((line) => `- ${line}`).join('\n') +
        `\nArquitetura: ${process.platform}-${process.arch}. Defina DSH_SHERPA_PATH se o pacote estiver em outro lugar.`,
    )
  })().catch((error) => {
    sherpaPromise = null
    throw error
  })
  return sherpaPromise
}

/**
 * Configuração do `OfflineRecognizer` para Whisper em português.
 * @param {{ encoder: string, decoder: string, tokens: string, threads?: number }} options
 * @returns {Record<string, unknown>}
 */
export function buildRecognizerConfig({ encoder, decoder, tokens, threads = 4 }) {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder,
        decoder,
        language: 'pt',
        task: 'transcribe',
        tailPaddings: 1000,
      },
      tokens,
      numThreads: Math.max(1, Math.min(16, Math.round(threads))),
      provider: 'cpu',
      debug: 0,
    },
  }
}

/**
 * Limpa o texto do Whisper e descarta ruído de silêncio (`[Música]`).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeTranscript(raw) {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^\[[^\]]*\]$/.test(text)) return ''
  return text
}

/**
 * @param {AbortSignal} signal
 * @returns {Error}
 */
function abortError(signal) {
  const error = new Error(
    signal?.reason instanceof Error && signal.reason.message
      ? signal.reason.message
      : 'Transcrição cancelada.',
  )
  error.name = signal?.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError'
  error.code = error.name === 'TimeoutError' ? 'ETIMEDOUT' : 'ABORT_ERR'
  return error
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

export class WhisperEngine {
  #loader
  #logger
  #recognizer = null
  #recognizerKey = null
  #busy = false
  #waiters = []
  #disposed = false

  /**
   * @param {{ sherpaLoader?: () => Promise<Record<string, unknown>>, logger?: { debug?: Function, warn?: Function, error?: Function } }} [options]
   */
  constructor({ sherpaLoader = loadSherpa, logger } = {}) {
    this.#loader = sherpaLoader
    this.#logger = logger ?? console
  }

  /** @returns {boolean} */
  get loaded() {
    return this.#recognizer !== null
  }

  /**
   * @param {{
   *   samples: Float32Array,
   *   durationSeconds: number,
   *   files: { encoder: string, decoder: string, tokens: string },
   *   model: string,
   *   threads?: number,
   *   signal?: AbortSignal,
   * }} request
   * @returns {Promise<{ text: string, tookMs: number, rtf: number, model: string, audioSeconds: number }>}
   */
  async transcribe({ samples, durationSeconds, files, model, threads = 4, signal }) {
    if (this.#disposed) {
      throw new EngineError('disposed', 'O motor de transcrição foi descarregado.')
    }
    if (!(samples instanceof Float32Array) || samples.length === 0) {
      throw new EngineError('engine', 'Áudio vazio para transcrição.')
    }

    await this.#acquire(signal)
    let releaseAttached = false
    const release = () => {
      if (releaseAttached) return
      releaseAttached = true
      this.#release()
    }

    try {
      const recognizer = await this.#ensureRecognizer({ files, threads })
      signal?.throwIfAborted()

      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples, sampleRate: 16000 })

      const startedAt = process.hrtime.bigint()
      const decoding = recognizer.decodeAsync(stream)

      let result
      try {
        result = await abortable(decoding, signal)
      } finally {
        // Libera o slot só quando o decode nativo realmente terminar, mesmo
        // que o caller tenha abortado antes.
        decoding.then(
          () => this.#release(),
          () => this.#release(),
        )
        releaseAttached = true
      }

      const tookMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      const audioSeconds = Math.max(1e-6, Number(durationSeconds) || samples.length / 16000)
      return {
        text: normalizeTranscript(result?.text),
        tookMs,
        rtf: tookMs / 1000 / audioSeconds,
        model,
        audioSeconds,
      }
    } finally {
      release()
    }
  }

  /** @returns {Promise<void>} */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#recognizer = null
    this.#recognizerKey = null
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.reject(new EngineError('disposed', 'O motor de transcrição foi descarregado.'))
    }
  }

  // -------------------------------------------------------------------------

  /**
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<void>}
   */
  #acquire(signal) {
    if (this.#disposed) {
      return Promise.reject(new EngineError('disposed', 'O motor de transcrição foi descarregado.'))
    }
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (!this.#busy) {
      this.#busy = true
      return Promise.resolve()
    }
    if (this.#waiters.length >= MAX_QUEUE) {
      return Promise.reject(
        new EngineError('busy', 'Muitas transcrições em andamento. Tente novamente em instantes.'),
      )
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) this.#waiters.splice(index, 1)
          reject(abortError(signal))
        },
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.#waiters.push(waiter)
    })
  }

  #release() {
    const waiter = this.#waiters.shift()
    if (!waiter) {
      this.#busy = false
      return
    }
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    waiter.resolve()
  }

  /**
   * @param {{ files: { encoder: string, decoder: string, tokens: string }, threads: number }} options
   * @returns {Promise<any>}
   */
  async #ensureRecognizer({ files, threads }) {
    const key = JSON.stringify({ ...files, threads })
    if (this.#recognizer !== null && this.#recognizerKey === key) return this.#recognizer
    if (this.#disposed) {
      throw new EngineError('disposed', 'O motor de transcrição foi descarregado.')
    }

    let sherpa
    try {
      sherpa = await this.#loader()
    } catch (error) {
      if (error instanceof EngineError) throw error
      throw new EngineError('load', `Falha ao carregar o sherpa-onnx-node: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    if (this.#disposed) {
      throw new EngineError('disposed', 'O motor de transcrição foi descarregado.')
    }

    this.#recognizer = null
    this.#recognizerKey = null
    try {
      this.#recognizer = await sherpa.OfflineRecognizer.createAsync(
        buildRecognizerConfig({ ...files, threads }),
      )
      this.#recognizerKey = key
      this.#logger?.debug?.(`[dsh-voz-pt] recognizer carregado (pt, ${threads} threads)`)
      return this.#recognizer
    } catch (error) {
      throw new EngineError(
        'load',
        `Falha ao carregar o modelo Whisper (${process.platform}-${process.arch}): ${error?.message ?? error}`,
        { cause: error },
      )
    }
  }
}
