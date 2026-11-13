/**
 * Gerenciador dos modelos Whisper: inspeção, hash, download e estado.
 *
 * - Nada é baixado na ativação: `prime()` só faz `stat` (barato) e, se os
 *   arquivos já existem com o tamanho certo, dispara a verificação de hash em
 *   background. Sem arquivos, o estado fica `idle` e a UI oficial mostra
 *   "primeiro uso baixa o modelo".
 * - `prepare()` verifica o hash do que já está no disco e baixa só o que falta
 *   ou está corrompido. Download vai para `<arquivo>.<uuid>.part`, com SHA-256
 *   calculado durante o stream e `rename` atômico no fim.
 * - `cancel()` interrompe o download/preparação e preserva os arquivos já
 *   concluídos (o próximo prepare continua de onde parou).
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { filePaths, manifestFor, modelDir, modelTotalBytes } from './models.js'

/**
 * @param {string} filePath
 * @param {{ bytes: number, sha256: string }} file
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>}
 */
async function matchesAsset(filePath, file, signal) {
  signal.throwIfAborted()
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size !== file.bytes) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(filePath, { signal })) digest.update(chunk)
    return digest.digest('hex') === file.sha256
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** Erro de preparação com mensagem pronta para o usuário. */
export class ModelPreparationError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options) {
    super(message, options)
    this.name = 'ModelPreparationError'
  }
}

/**
 * @typedef {{
 *   state: 'idle' | 'verifying' | 'downloading' | 'ready' | 'cancelled' | 'error',
 *   progressBytes: number,
 *   totalBytes: number,
 *   error?: string,
 *   updatedAt: number,
 * }} ModelState
 */

export class ModelManager {
  #dataRoot
  #fetch
  #logger
  #states = new Map()
  #verified = new Set()
  #listeners = new Set()
  #task = null
  #taskAbort = null
  #disposed = false

  /**
   * @param {{ dataRoot: string, fetchImpl?: typeof fetch, logger?: { debug?: Function, warn?: Function, error?: Function } }} options
   */
  constructor({ dataRoot, fetchImpl, logger } = {}) {
    if (typeof dataRoot !== 'string' || dataRoot === '') {
      throw new Error('ModelManager exige dataRoot absoluto.')
    }
    this.#dataRoot = dataRoot
    this.#fetch = fetchImpl ?? globalThis.fetch
    if (typeof this.#fetch !== 'function') {
      throw new Error('fetch indisponível para baixar o modelo (Node 18+ necessário).')
    }
    this.#logger = logger ?? console
  }

  /**
   * Estado corrente do modelo (cópia).
   * @param {string} modelId
   * @returns {ModelState}
   */
  state(modelId) {
    const entry = this.#entry(modelId)
    return {
      state: entry.state,
      progressBytes: entry.progressBytes,
      totalBytes: entry.totalBytes,
      ...(entry.error ? { error: entry.error } : {}),
      updatedAt: entry.updatedAt,
    }
  }

  /**
   * Observa mudanças de estado. Retorna o cancelamento da inscrição.
   * @param {() => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Caminhos canônicos, somente quando pronto.
   * @param {string} modelId
   * @returns {{ encoder: string, decoder: string, tokens: string } | null}
   */
  readyPaths(modelId) {
    if (this.state(modelId).state !== 'ready') return null
    return filePaths(this.#dataRoot, modelId)
  }

  /**
   * Inspeção barata de boot: tamanho dos arquivos (sem hash). Se tudo existe,
   * dispara a verificação em background (a UI mostra `checking`); se falta
   * algo, fica `idle` (a UI oferece o download).
   * @param {string} modelId
   * @returns {Promise<void>}
   */
  async prime(modelId) {
    if (this.#disposed || this.#task !== null || this.#verified.has(modelId)) return
    try {
      const present = await this.#presentBytes(modelId)
      if (this.#disposed || this.#task !== null) return
      if (present.allOk) {
        this.#setState(modelId, {
          state: 'verifying',
          progressBytes: present.bytes,
          totalBytes: modelTotalBytes(modelId),
          error: undefined,
        })
        this.prepare(modelId)
      } else {
        this.#setState(modelId, {
          state: 'idle',
          progressBytes: present.bytes,
          totalBytes: modelTotalBytes(modelId),
          error: undefined,
        })
      }
    } catch (error) {
      this.#fail(modelId, `Falha ao inspecionar o modelo: ${error?.message ?? error}`)
    }
  }

  /**
   * Inicia (ou ignora, se já roda) a preparação.
   * @param {string} modelId
   * @returns {ModelState}
   */
  prepare(modelId) {
    manifestFor(modelId)
    if (this.#disposed) throw new ModelPreparationError('O plugin está sendo descarregado.')
    if (this.#task !== null) return this.state(modelId)
    if (this.#verified.has(modelId) && this.state(modelId).state === 'ready') {
      return this.state(modelId)
    }

    const abort = new AbortController()
    this.#taskAbort = abort
    const task = this.#runPrepare(modelId, abort.signal)
      .then(() => {
        if (abort.signal.aborted) return
        this.#verified.add(modelId)
        this.#setState(modelId, {
          state: 'ready',
          progressBytes: modelTotalBytes(modelId),
          totalBytes: modelTotalBytes(modelId),
          error: undefined,
        })
        this.#logger?.debug?.(`[dsh-voz-pt] modelo ${modelId} verificado e pronto`)
      })
      .catch((error) => {
        if (abort.signal.aborted || this.#disposed) {
          if (!this.#disposed) {
            this.#setState(modelId, {
              state: 'cancelled',
              progressBytes: this.state(modelId).progressBytes,
              error: undefined,
            })
          }
          return
        }
        this.#fail(modelId, `Falha ao preparar o modelo: ${error?.message ?? error}`)
      })
      .finally(() => {
        if (this.#taskAbort === abort) this.#taskAbort = null
        this.#task = null
      })

    this.#task = task
    return this.state(modelId)
  }

  /**
   * Aguarda a preparação em andamento (smoke/testes).
   * @returns {Promise<void>}
   */
  async settled() {
    if (this.#task) await this.#task
  }

  /**
   * Garante que os arquivos ainda existem com o tamanho esperado.
   * @param {string} modelId
   * @returns {Promise<Record<string, string> | null>}
   */
  async ensureReady(modelId) {
    if (this.#disposed || this.state(modelId).state !== 'ready') return null
    const present = await this.#presentBytes(modelId)
    if (!present.allOk) {
      this.#setState(modelId, {
        state: 'idle',
        progressBytes: present.bytes,
        error: undefined,
      })
      return null
    }
    return filePaths(this.#dataRoot, modelId)
  }

  /** Cancela a preparação em andamento, preservando downloads concluídos. */
  async cancel() {
    if (this.#taskAbort === null) return
    this.#taskAbort.abort(new Error('cancelada pelo usuário'))
    await this.settled()
  }

  /** Interrompe tudo e aguarda as tarefas assentarem. */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#taskAbort?.abort(new Error('dispose'))
    await this.settled()
    this.#listeners.clear()
  }

  // -------------------------------------------------------------------------

  /**
   * @param {string} modelId
   * @returns {ModelState}
   */
  #entry(modelId) {
    let entry = this.#states.get(modelId)
    if (!entry) {
      entry = {
        state: 'idle',
        progressBytes: 0,
        totalBytes: modelTotalBytes(modelId),
        error: undefined,
        updatedAt: Date.now(),
      }
      this.#states.set(modelId, entry)
    }
    return entry
  }

  /**
   * @param {string} modelId
   * @param {{ state?: ModelState['state'], progressBytes?: number, totalBytes?: number, error?: string }} patch
   */
  #setState(modelId, patch) {
    const entry = this.#entry(modelId)
    if (patch.state !== undefined) entry.state = patch.state
    if (patch.progressBytes !== undefined) {
      entry.progressBytes = Math.max(0, Math.min(patch.progressBytes, entry.totalBytes || patch.progressBytes))
    }
    if (patch.totalBytes !== undefined) entry.totalBytes = patch.totalBytes
    if ('error' in patch) entry.error = patch.error
    entry.updatedAt = Date.now()
    this.#emit()
  }

  /**
   * @param {string} modelId
   * @param {string} message
   */
  #fail(modelId, message) {
    this.#logger?.warn?.(`[dsh-voz-pt] ${message}`)
    this.#setState(modelId, { state: 'error', error: message })
  }

  #emit() {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // um observador quebrado não pode derrubar a preparação
      }
    }
  }

  /**
   * Soma os bytes presentes com o tamanho esperado (stat, sem hash).
   * @param {string} modelId
   * @returns {Promise<{ allOk: boolean, bytes: number }>}
   */
  async #presentBytes(modelId) {
    const manifest = manifestFor(modelId)
    const dir = modelDir(this.#dataRoot, modelId)
    let bytes = 0
    let allOk = true
    for (const file of manifest.files) {
      try {
        const info = await stat(path.join(dir, file.name))
        if (info.isFile() && info.size === file.bytes) bytes += file.bytes
        else allOk = false
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        allOk = false
      }
    }
    return { allOk, bytes }
  }

  /**
   * Verifica o hash de cada arquivo e baixa o que faltar/estiver corrompido.
   * @param {string} modelId
   * @param {AbortSignal} signal
   */
  async #runPrepare(modelId, signal) {
    const manifest = manifestFor(modelId)
    const dir = modelDir(this.#dataRoot, modelId)
    const total = modelTotalBytes(modelId)
    let completedBytes = 0

    await mkdir(dir, { recursive: true })
    signal.throwIfAborted()

    for (const file of manifest.files) {
      signal.throwIfAborted()
      const destination = path.join(dir, file.name)

      if (completedBytes === 0) {
        this.#setState(modelId, {
          state: 'verifying',
          progressBytes: 0,
          totalBytes: total,
          error: undefined,
        })
      }

      if (await matchesAsset(destination, file, signal)) {
        completedBytes += file.bytes
        this.#setState(modelId, {
          state: 'verifying',
          progressBytes: completedBytes,
          totalBytes: total,
          error: undefined,
        })
        continue
      }

      await rm(destination, { force: true })
      this.#setState(modelId, {
        state: 'downloading',
        progressBytes: completedBytes,
        totalBytes: total,
        error: undefined,
      })
      await this.#downloadAsset({
        modelId,
        file,
        destination,
        dir,
        completedBytes,
        total,
        signal,
      })
      completedBytes += file.bytes
      this.#setState(modelId, {
        state: 'downloading',
        progressBytes: completedBytes,
        totalBytes: total,
        error: undefined,
      })
    }

    signal.throwIfAborted()
  }

  /**
   * Baixa um asset para `.part`, valida tamanho/SHA-256 e publica com rename.
   * @param {{
   *   modelId: string,
   *   file: { name: string, remote: string, url: string, bytes: number, sha256: string },
   *   destination: string,
   *   dir: string,
   *   completedBytes: number,
   *   total: number,
   *   signal: AbortSignal,
   * }} options
   */
  async #downloadAsset({ modelId, file, destination, dir, completedBytes, total, signal }) {
    signal.throwIfAborted()
    await mkdir(dir, { recursive: true })
    const partial = `${destination}.${randomUUID()}.part`
    try {
      let response
      try {
        response = await this.#fetch(file.url, { signal, redirect: 'follow' })
      } catch (error) {
        signal.throwIfAborted()
        throw new ModelPreparationError(
          `Não foi possível baixar ${file.remote} (verifique a conexão): ${error?.message ?? error}`,
          { cause: error },
        )
      }
      if (!response.ok || !response.body) {
        throw new ModelPreparationError(
          `HuggingFace respondeu HTTP ${response.status} para ${file.remote}.`,
        )
      }

      const digest = createHash('sha256')
      let fileBytes = 0
      const manager = this
      const hashing = new Transform({
        transform(chunk, _encoding, callback) {
          fileBytes += chunk.length
          if (fileBytes > file.bytes) {
            callback(new ModelPreparationError(`Tamanho inesperado em ${file.remote}.`))
            return
          }
          digest.update(chunk)
          manager.#setState(modelId, {
            state: 'downloading',
            progressBytes: completedBytes + fileBytes,
            totalBytes: total,
          })
          callback(null, chunk)
        },
      })

      await pipeline(
        Readable.fromWeb(response.body),
        hashing,
        createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
        { signal },
      )

      if (fileBytes !== file.bytes) {
        throw new ModelPreparationError(
          `Tamanho divergente em ${file.remote}: esperado ${file.bytes}, recebido ${fileBytes}.`,
        )
      }
      if (digest.digest('hex') !== file.sha256) {
        throw new ModelPreparationError(`SHA-256 não confere para ${file.remote} (download corrompido).`)
      }
      signal.throwIfAborted()
      await rename(partial, destination)
    } finally {
      await rm(partial, { force: true })
    }
  }
}
