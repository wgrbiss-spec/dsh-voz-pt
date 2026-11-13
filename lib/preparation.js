/**
 * Adaptador do estado do `ModelManager` para o contrato `SpeechPreparation`
 * do serviço `speechToText` do DSH.
 *
 * Fases usadas pela UI oficial:
 * - `unprepared`: modelo ausente; a UI oferece o download.
 * - `checking`: hash/inspeção dos arquivos existentes.
 * - `downloading`: download com bytes e total (barra de progresso).
 * - `ready`: pode gravar.
 * - `cancelled` / `failed`: estados terminais com mensagem.
 */

import { manifestFor, modelTotalBytes } from './models.js'

export class ProviderPreparation {
  #manager
  #model
  #listeners = new Set()
  #unsubscribe

  /**
   * @param {import('./manager.js').ModelManager} manager
   * @param {string} model
   */
  constructor(manager, model) {
    this.#manager = manager
    this.#model = model
    // Notifica em toda mudança (inclusive progresso de download, que mantém a
    // fase `downloading`); o serviço de fala coalesce leituras lentas.
    this.#unsubscribe = manager.subscribe(() => this.#notify())
  }

  /** @returns {import('@deepseek-ai/dsh-experimental-speech-to-text/types').SpeechPreparationState} */
  snapshot() {
    const state = this.#manager.state(this.#model)
    switch (state.state) {
      case 'idle':
        return { phase: 'unprepared', step: 'check' }
      case 'verifying':
        return {
          phase: 'checking',
          startedAt: state.updatedAt,
          step: 'verify',
        }
      case 'downloading':
        return {
          phase: 'downloading',
          resource: manifestFor(this.#model).label,
          completedBytes: state.progressBytes,
          totalBytes: state.totalBytes || modelTotalBytes(this.#model),
          step: 'model',
        }
      case 'ready':
        return { phase: 'ready' }
      case 'cancelled':
        return { phase: 'cancelled' }
      case 'error':
        return {
          phase: 'failed',
          message: state.error ?? 'Falha ao preparar o modelo local.',
        }
      default:
        return { phase: 'unprepared' }
    }
  }

  /**
   * @param {() => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Dispara a preparação em background (a UI acompanha por `snapshot`). */
  prepare() {
    this.#manager.prepare(this.#model)
  }

  /** @returns {Promise<void>} */
  async cancel() {
    await this.#manager.cancel()
  }

  /** Libera a inscrição no manager. */
  dispose() {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#listeners.clear()
  }

  #notify() {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // observador quebrado não derruba a preparação
      }
    }
  }
}
