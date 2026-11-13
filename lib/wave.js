/**
 * Parser/validador do WAV canônico entregue pela UI oficial de voz.
 *
 * O browser reencoda o microfone para PCM16, mono, 16 kHz antes de mandar ao
 * host. Aqui a validação é dura: qualquer outro formato é recusado com
 * mensagem em português antes de chegar ao Whisper, que espera `Float32Array`
 * em [-1, 1] a 16 kHz.
 */

const PCM = 1
const IEEE_FLOAT = 3
const EXTENSIBLE = 0xfffe
const CANONICAL_SAMPLE_RATE = 16000
const CANONICAL_CHANNELS = 1
const CANONICAL_BITS = 16

/** Duração mínima aceitável: cliques acidentais geram lixo/alucinação. */
export const MIN_SECONDS = 0.2

/** Erro de áudio com código estável (`short`, `empty`, `unsupported`, `bad-body`). */
export class WaveError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'WaveError'
    this.code = code
  }
}

/**
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {string}
 */
function fourcc(buffer, offset) {
  return buffer.toString('latin1', offset, offset + 4)
}

/**
 * Valida e decodifica um WAV PCM16 mono 16 kHz.
 *
 * @param {Buffer | Uint8Array} input
 * @param {{ minSeconds?: number }} [options]
 * @returns {{
 *   samples: Float32Array,
 *   sampleRate: number,
 *   channels: number,
 *   bitsPerSample: number,
 *   durationSeconds: number,
 *   dataBytes: number,
 *   byteLength: number,
 * }}
 * @throws {WaveError}
 */
export function parseWave(input, options = {}) {
  const { minSeconds = MIN_SECONDS } = options
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? [])

  if (buffer.length < 12) {
    throw new WaveError('bad-body', 'Áudio inválido: arquivo WAV truncado (menos de 12 bytes).')
  }
  if (fourcc(buffer, 0) !== 'RIFF' || fourcc(buffer, 8) !== 'WAVE') {
    throw new WaveError('bad-body', 'Áudio inválido: não é um arquivo WAV (RIFF/WAVE ausente).')
  }

  let fmt = null
  let data = null
  let offset = 12
  let truncated = false

  while (offset + 8 <= buffer.length) {
    const id = fourcc(buffer, offset)
    const size = buffer.readUInt32LE(offset + 4)
    const payload = offset + 8
    const end = payload + size
    const next = end + (size % 2)

    if (end > buffer.length) {
      truncated = true
      break
    }

    if (id === 'fmt ') {
      if (size < 16) throw new WaveError('bad-body', 'Áudio inválido: chunk fmt incompleto.')
      let format = buffer.readUInt16LE(payload)
      const channels = buffer.readUInt16LE(payload + 2)
      const sampleRate = buffer.readUInt32LE(payload + 4)
      const bitsPerSample = buffer.readUInt16LE(payload + 14)
      if (format === EXTENSIBLE) {
        if (size < 40) {
          throw new WaveError('bad-body', 'Áudio inválido: WAVE_FORMAT_EXTENSIBLE incompleto.')
        }
        format = buffer.readUInt16LE(payload + 24)
      }
      fmt = { format, channels, sampleRate, bitsPerSample }
    } else if (id === 'data') {
      if (data === null) data = { offset: payload, size }
    }

    if (next <= offset) break
    offset = next
  }

  if (truncated) throw new WaveError('bad-body', 'Áudio inválido: arquivo WAV truncado.')
  if (fmt === null) throw new WaveError('bad-body', 'Áudio inválido: chunk fmt ausente.')
  if (data === null) throw new WaveError('bad-body', 'Áudio inválido: chunk data ausente.')
  if (fmt.format !== PCM) {
    throw new WaveError(
      'unsupported',
      `Áudio inválido: formato ${fmt.format === IEEE_FLOAT ? 'float' : fmt.format} não suportado; use PCM 16 bits.`,
    )
  }
  if (fmt.channels !== CANONICAL_CHANNELS) {
    throw new WaveError(
      'unsupported',
      `Áudio inválido: ${fmt.channels} canais; o esperado é mono (1 canal).`,
    )
  }
  if (fmt.sampleRate !== CANONICAL_SAMPLE_RATE) {
    throw new WaveError(
      'unsupported',
      `Áudio inválido: ${fmt.sampleRate} Hz; o esperado é 16000 Hz.`,
    )
  }
  if (fmt.bitsPerSample !== CANONICAL_BITS) {
    throw new WaveError(
      'unsupported',
      `Áudio inválido: ${fmt.bitsPerSample} bits por amostra; o esperado é 16 bits (PCM).`,
    )
  }
  if (data.size === 0) throw new WaveError('empty', 'Áudio vazio: nenhuma amostra recebida.')
  if (data.size % 2 !== 0) {
    throw new WaveError('bad-body', 'Áudio inválido: chunk data com tamanho ímpar para PCM16.')
  }

  const sampleCount = data.size / 2
  const durationSeconds = sampleCount / CANONICAL_SAMPLE_RATE
  if (durationSeconds < Math.max(0, minSeconds)) {
    throw new WaveError(
      'short',
      `Áudio muito curto (${durationSeconds.toFixed(2)} s); grave pelo menos ${Number(minSeconds).toFixed(1)} s.`,
    )
  }

  const samples = new Float32Array(sampleCount)
  const view = new DataView(buffer.buffer, buffer.byteOffset + data.offset, data.size)
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768
  }

  return {
    samples,
    sampleRate: CANONICAL_SAMPLE_RATE,
    channels: CANONICAL_CHANNELS,
    bitsPerSample: CANONICAL_BITS,
    durationSeconds,
    dataBytes: data.size,
    byteLength: buffer.length,
  }
}

/**
 * Gera um WAV PCM16 mono 16 kHz. Usado pelo smoke test.
 *
 * @param {Float32Array | number[]} samples
 * @param {{ sampleRate?: number }} [options]
 * @returns {Buffer}
 */
export function encodeWave(samples, options = {}) {
  const { sampleRate = CANONICAL_SAMPLE_RATE } = options
  const input = samples instanceof Float32Array ? samples : Float32Array.from(samples)
  const dataBytes = input.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(PCM, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(dataBytes, 40)
  const body = Buffer.alloc(dataBytes)
  for (let i = 0; i < input.length; i += 1) {
    const value = Math.max(-1, Math.min(1, input[i]))
    body.writeInt16LE(Math.round(value * 32767), i * 2)
  }
  return Buffer.concat([header, body])
}
