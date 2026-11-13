/**
 * dsh-voz-pt — ditado em português do Brasil no DeepSeek Harness.
 *
 * Duas frentes:
 * 1. **Provider** Whisper local no serviço `speechToText`, usado pelo botão de
 *    microfone oficial (transcrição depois de parar).
 * 2. **Ditado ao vivo** (`/dsh-voz-pt/stream` + botão próprio no compositor):
 *    modelo Zipformer streaming devolve hipóteses parciais enquanto a pessoa
 *    fala, e o cliente atualiza o rascunho em tempo real.
 *
 * Nada de rede ou addon nativo na ativação: os modelos são inspecionados com
 * `stat`/hash e baixados apenas quando necessário.
 */

import { normalizeConfig } from './config.js'
import { WhisperEngine } from './engine.js'
import { ModelManager } from './manager.js'
import { createProvider } from './provider.js'
import { StreamingEngine } from './streaming-engine.js'
import { attachStreamRoute } from './stream-route.js'

export const name = 'dsh-voz-pt'
export const inject = ['speechToText', 'webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = {
    debug: (...args) => ctx.logger?.debug?.(...args),
    warn: (...args) => ctx.logger?.warn?.(...args),
    error: (...args) => ctx.logger?.error?.(...args),
  }

  const manager = new ModelManager({ dataRoot: config.dataRoot, logger })
  const engine = new WhisperEngine({ logger })
  const streaming = new StreamingEngine({ logger })
  const provider = createProvider({ config, manager, engine, logger })

  // Rota do ditado ao vivo (some junto com o plugin).
  ctx.effect(() => attachStreamRoute(ctx, { config, manager, engine: streaming, logger }))

  ctx.effect(() => {
    const unregister = ctx.speechToText.register(provider)
    // Inspeção barata dos modelos; hash em background. Em série porque o
    // manager faz uma preparação por vez.
    void (async () => {
      await manager.prime(config.model)
      await manager.settled()
      await manager.prime(config.streamingModel)
      await manager.settled()
    })()

    return async () => {
      const removing = unregister()
      await provider.dispose()
      await streaming.dispose()
      await manager.dispose()
      await removing
    }
  })

  ctx.logger?.debug?.(
    `[dsh-voz-pt] provider ${config.providerId} + streaming ${config.streamingModel} (${config.dataRoot})`,
  )
}
