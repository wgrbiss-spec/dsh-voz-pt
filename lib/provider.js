/**
 * Provider de ditado em português para o serviço `speechToText` do DSH.
 *
 * A UI oficial de voz cuida do microfone, do download (via `preparation`) e da
 * inserção no rascunho. Aqui ficam apenas validação do WAV, estado do modelo e
 * a chamada ao motor Whisper.
 */

import { manifestFor, modelTotalBytes } from './models.js'
import { ProviderPreparation } from './preparation.js'
import { parseWave, WaveError } from './wave.js'

/**
 * @param {{
 *   config: ReturnType<typeof import('./config.js').normalizeConfig>,
 *   manager: import('./manager.js').ModelManager,
 *   engine: import('./engine.js').WhisperEngine,
 *   logger?: { debug?: Function, warn?: Function, error?: Function },
 * }} options
 */
export function createProvider({ config, manager, engine, logger }) {
  const manifest = manifestFor(config.model)
  const totalBytes = modelTotalBytes(config.model)
  const preparation = new ProviderPreparation(manager, config.model)

  return {
    info: {
      id: config.providerId,
      name: `${manifest.label} — português (local)`,
      location: 'host-local',
      languages: ['pt'],
      setupEstimate: {
        recommendedDiskBytes: Math.round(totalBytes * 1.05),
        expectedMemoryBytes: Math.round(totalBytes * 1.6),
        minimumMinutes: 1,
        maximumMinutes: 10,
      },
    },

    preparation,

    /**
     * @param {{ audio: Uint8Array, language: string }} input
     * @param {AbortSignal} signal
     * @returns {Promise<{ text: string, audioSeconds: number, inferenceSeconds: number }>}
     */
    async transcribe(input, signal) {
      const audio = input?.audio
      const language = String(input?.language ?? 'pt')

      if (!language.toLowerCase().startsWith('pt')) {
        throw new Error(`Este provider só transcreve português (recebido: ${language}).`)
      }
      if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
        throw new Error('Áudio vazio: nenhuma amostra recebida.')
      }
      if (audio.byteLength > config.maxAudioBytes) {
        throw new Error(
          `Áudio grande demais (${(audio.byteLength / 1024 / 1024).toFixed(1)} MiB); ` +
            `o limite é ${(config.maxAudioBytes / 1024 / 1024).toFixed(1)} MiB.`,
        )
      }

      let wave
      try {
        wave = parseWave(audio)
      } catch (error) {
        if (error instanceof WaveError) throw new Error(error.message, { cause: error })
        throw error
      }

      if (manager.state(config.model).state !== 'ready') {
        manager.prepare(config.model)
        throw new Error('O modelo local ainda não está pronto. Abra as configurações de voz e conclua o download.')
      }

      const files = await manager.ensureReady(config.model)
      if (files === null) {
        manager.prepare(config.model)
        throw new Error('Os arquivos do modelo local não estão íntegros. O download foi reiniciado.')
      }

      const timeout = AbortSignal.timeout(config.timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

      try {
        const result = await engine.transcribe({
          samples: wave.samples,
          durationSeconds: wave.durationSeconds,
          files,
          model: config.model,
          threads: config.threads,
          signal: combined,
        })
        return {
          text: result.text,
          audioSeconds: wave.durationSeconds,
          inferenceSeconds: result.tookMs / 1000,
        }
      } catch (error) {
        if (combined.aborted && !signal?.aborted) {
          throw new Error(
            `A transcrição passou de ${Math.round(config.timeoutMs / 1000)} s e foi cancelada.`,
            { cause: error },
          )
        }
        logger?.warn?.(`[dsh-voz-pt] falha na transcrição: ${error?.message ?? error}`)
        throw error
      }
    },

    /** @returns {Promise<void>} */
    async dispose() {
      preparation.dispose()
      await engine.dispose()
    },
  }
}
