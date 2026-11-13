/**
 * Configuração do dsh-voz-pt.
 *
 * O plugin é host-only: não tem UI própria nem rotas HTTP. Ele registra um
 * `SpeechProvider` no serviço `speechToText` do DSH, e a UI oficial de voz
 * (botão de microfone do compositor) faz gravação, download e inserção no
 * rascunho. Por isso a configuração é pequena e validada à mão, sem depender
 * de `@deepseek-ai/schemastery`.
 */

import os from 'node:os'
import path from 'node:path'
import { MODEL_IDS } from './models.js'

/** Raiz padrão dos modelos: `~/.dsh/voz-pt`. */
export const DEFAULT_DATA_ROOT = path.join(os.homedir(), '.dsh', 'voz-pt')

/** Ids de provider aceitos pela UI/serviço. */
export const DEFAULT_PROVIDER_ID = 'voz-pt-local'

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
function numberOr(value, fallback, bounds = {}) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const min = bounds.min ?? Number.NEGATIVE_INFINITY
  const max = bounds.max ?? Number.POSITIVE_INFINITY
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

/**
 * Normaliza e valida a configuração crua vinda do patch Cordis.
 *
 * @param {Record<string, unknown>} [raw]
 * @returns {{
 *   providerId: string,
 *   dataRoot: string,
 *   model: string,
 *   threads: number,
 *   maxAudioBytes: number,
 *   timeoutMs: number,
 * }}
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}

  const providerId =
    typeof source.providerId === 'string' && source.providerId.trim() !== ''
      ? source.providerId.trim()
      : DEFAULT_PROVIDER_ID

  const dataRoot =
    typeof source.dataRoot === 'string' && source.dataRoot.trim() !== ''
      ? path.resolve(source.dataRoot)
      : DEFAULT_DATA_ROOT

  const model = MODEL_IDS.includes(source.model) ? source.model : 'small-int8'
  const streamingModel = MODEL_IDS.includes(source.streamingModel)
    ? source.streamingModel
    : 'streaming-pt'

  return {
    providerId,
    dataRoot,
    model,
    streamingEnabled: source.streamingEnabled !== false,
    streamingModel,
    streamingIdleMs: numberOr(source.streamingIdleMs, 120_000, { min: 10_000, max: 3_600_000 }),
    streamingMaxSeconds: numberOr(source.streamingMaxSeconds, 300, { min: 10, max: 3_600 }),
    threads: numberOr(source.threads, 4, { min: 1, max: 16 }),
    maxAudioBytes: numberOr(source.maxAudioBytes, 8 * 1024 * 1024, { min: 46 }),
    timeoutMs: numberOr(source.timeoutMs, 120_000, { min: 1_000 }),
  }
}
