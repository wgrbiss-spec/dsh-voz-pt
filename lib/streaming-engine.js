/**
 * Motor de transcrição **streaming** em português (Zipformer transducer).
 *
 * Diferente do Whisper offline, este modelo aceita áudio em pequenos blocos e
 * devolve hipóteses parciais enquanto a pessoa fala. É o que alimenta o texto
 * ao vivo no compositor.
 *
 * Fonte: `kouhxp/sherpa-onnx-streaming-zipformer-pt-kroko` (HuggingFace),
 * revisão e SHA-256 fixados em `models.js`.
 */

import { loadSherpa, EngineError } from './engine.js'

/** @param {Record<string, unknown>} namespace */
function unwrap(namespace) {
  if (namespace && typeof namespace.OnlineRecognizer === 'function') return namespace
  if (namespace?.default && typeof namespace.default.OnlineRecognizer === 'function') {
    return namespace.default
  }
  return namespace
}

/**
 * @param {{ encoder: string, decoder: string, joiner: string, tokens: string, threads?: number }} options
 * @returns {Record<string, unknown>}
 */
export function buildStreamingConfig({ encoder, decoder, joiner, tokens, threads = 2 }) {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder, decoder, joiner },
      tokens,
      numThreads: Math.max(1, Math.min(8, Math.round(threads))),
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    // 1,2 s de silêncio fecha a frase; 2,4 s fecha mesmo com ruído de fundo.
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  }
}

export class StreamingEngine {
  #loader
  #logger
  #recognizer = null
  #key = null
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
   * Cria uma sessão de reconhecimento independente (uma por gravação).
   * @param {{ encoder: string, decoder: string, joiner: string, tokens: string }} files
   * @param {number} threads
   * @returns {Promise<{ recognizer: any, stream: any }>}
   */
  async createSession(files, threads) {
    const recognizer = await this.#ensure(files, threads)
    return { recognizer, stream: recognizer.createStream() }
  }

  /**
   * Alimenta um bloco PCM16 já convertido para Float32 a 16 kHz.
   * @param {{ recognizer: any, stream: any }} session
   * @param {Float32Array} samples
   * @returns {{ text: string, endpoint: boolean }}
   */
  feed(session, samples) {
    if (this.#disposed) throw new EngineError('disposed', 'O motor streaming foi descarregado.')
    if (samples.length > 0) {
      session.stream.acceptWaveform({ samples, sampleRate: 16000 })
    }
    const { recognizer, stream } = session
    while (recognizer.isReady(stream)) recognizer.decode(stream)
    const text = String(recognizer.getResult(stream)?.text ?? '').trim()
    const endpoint = Boolean(recognizer.isEndpoint(stream))
    if (endpoint) recognizer.reset(stream)
    return { text, endpoint }
  }

  /**
   * Fecha a frase com um pequeno rabo de silêncio (o endpointing precisa ver
   * silêncio para emitir o último token).
   * @param {{ recognizer: any, stream: any }} session
   * @returns {string}
   */
  flush(session) {
    const tail = new Float32Array(8000) // 0,5 s
    session.stream.acceptWaveform({ samples: tail, sampleRate: 16000 })
    const { recognizer, stream } = session
    while (recognizer.isReady(stream)) recognizer.decode(stream)
    return String(recognizer.getResult(stream)?.text ?? '').trim()
  }

  /** @returns {Promise<void>} */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#recognizer = null
    this.#key = null
  }

  /**
   * @param {{ encoder: string, decoder: string, joiner: string, tokens: string }} files
   * @param {number} threads
   * @returns {Promise<any>}
   */
  async #ensure(files, threads) {
    if (this.#disposed) {
      throw new EngineError('disposed', 'O motor streaming foi descarregado.')
    }
    const key = JSON.stringify({ ...files, threads })
    if (this.#recognizer !== null && this.#key === key) return this.#recognizer

    let sherpa
    try {
      sherpa = unwrap(await this.#loader())
    } catch (error) {
      if (error instanceof EngineError) throw error
      throw new EngineError('load', `Falha ao carregar o sherpa-onnx-node: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    if (this.#disposed) {
      throw new EngineError('disposed', 'O motor streaming foi descarregado.')
    }

    this.#recognizer = null
    this.#key = null
    try {
      this.#recognizer = new sherpa.OnlineRecognizer(buildStreamingConfig({ ...files, threads }))
      this.#key = key
      this.#logger?.debug?.('[dsh-voz-pt] reconhecedor streaming em português carregado')
      return this.#recognizer
    } catch (error) {
      throw new EngineError(
        'load',
        `Falha ao carregar o modelo streaming (${process.platform}-${process.arch}): ${error?.message ?? error}`,
        { cause: error },
      )
    }
  }
}
