import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { buildRecognizerConfig, normalizeTranscript } from '../lib/engine.js'
import { filePaths, MANIFEST, MODEL_IDS } from '../lib/models.js'
import { isTrustedStreamRequest } from '../lib/stream-route.js'
import { buildStreamingConfig } from '../lib/streaming-engine.js'
import { encodeWave, parseWave, WaveError } from '../lib/wave.js'

/** @param {Record<string, string>} [overrides] */
function request(overrides = {}) {
  return {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:34041',
      origin: 'http://127.0.0.1:34041',
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      ...overrides,
    },
  }
}

test('config defaults point at the live model and Whisper', () => {
  const config = normalizeConfig({ dataRoot: '/tmp/voz-pt' })
  assert.equal(config.model, 'small-int8')
  assert.equal(config.streamingModel, 'streaming-pt')
  assert.equal(config.streamingEnabled, true)
  assert.equal(config.providerId, 'voz-pt-local')
  assert.equal(config.threads, 4)
  assert.equal(config.dataRoot, '/tmp/voz-pt')
})

test('invalid model ids fall back instead of breaking boot', () => {
  const config = normalizeConfig({ model: 'nope', streamingModel: 'nope' })
  assert.equal(config.model, 'small-int8')
  assert.equal(config.streamingModel, 'streaming-pt')
})

test('manifests carry pinned revisions, sizes and sha256', () => {
  assert.deepEqual([...MODEL_IDS].sort(), ['base-int8', 'small-int8', 'streaming-pt'])
  for (const id of MODEL_IDS) {
    const manifest = MANIFEST[id]
    assert.match(manifest.revision, /^[0-9a-f]{40}$/)
    assert.ok(manifest.files.length >= 3)
    for (const file of manifest.files) {
      assert.ok(file.bytes > 0)
      assert.match(file.sha256, /^[0-9a-f]{64}$/)
      assert.match(file.url, /^https:\/\/huggingface\.co\//)
    }
  }
})

test('streaming files keep their upstream names', () => {
  const paths = filePaths('/data', 'streaming-pt')
  assert.equal(paths.encoder, '/data/models/streaming-pt/encoder.onnx')
  assert.equal(paths.decoder, '/data/models/streaming-pt/decoder.onnx')
  assert.equal(paths.joiner, '/data/models/streaming-pt/joiner.onnx')
  assert.equal(paths.tokens, '/data/models/streaming-pt/tokens.txt')
})

test('streaming recognizer config asks for endpointing in Portuguese-friendly mode', () => {
  const config = buildStreamingConfig({
    encoder: '/e.onnx',
    decoder: '/d.onnx',
    joiner: '/j.onnx',
    tokens: '/tokens.txt',
    threads: 4,
  })
  assert.equal(config.featConfig.sampleRate, 16000)
  assert.equal(config.modelConfig.transducer.encoder, '/e.onnx')
  assert.equal(config.modelConfig.numThreads, 4)
  assert.equal(config.enableEndpoint, true)
  assert.equal(config.decodingMethod, 'greedy_search')
})

test('Whisper config pins language pt and transcribe task', () => {
  const config = buildRecognizerConfig({ encoder: '/e', decoder: '/d', tokens: '/t', threads: 2 })
  assert.equal(config.modelConfig.whisper.language, 'pt')
  assert.equal(config.modelConfig.whisper.task, 'transcribe')
  assert.equal(config.modelConfig.numThreads, 2)
})

test('transcript normalization drops silence hallucination', () => {
  assert.equal(normalizeTranscript('  [Música]  '), '')
  assert.equal(normalizeTranscript('  olá   mundo  '), 'olá mundo')
})

test('WAV parser accepts canonical PCM16 and rejects truncation', () => {
  const bytes = encodeWave(new Float32Array(1600))
  const wave = parseWave(bytes, { minSeconds: 0.05 })
  assert.equal(wave.sampleRate, 16000)
  assert.equal(wave.channels, 1)
  assert.equal(wave.samples.length, 1600)
  assert.equal(wave.durationSeconds, 0.1)

  assert.throws(() => parseWave(bytes), WaveError)
  assert.throws(() => parseWave(Buffer.from('not a wave')), WaveError)
})

test('stream route guard is fail-closed', () => {
  assert.equal(isTrustedStreamRequest(request()), true)
  assert.equal(isTrustedStreamRequest(request({ 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isTrustedStreamRequest(request({ 'sec-fetch-site': 'same-site' })), false)
  assert.equal(isTrustedStreamRequest(request({ origin: 'http://evil.example' })), false)
  assert.equal(isTrustedStreamRequest(request({ 'content-type': 'text/plain' })), false)
  assert.equal(
    isTrustedStreamRequest({
      socket: { remoteAddress: '192.168.0.10' },
      headers: request().headers,
    }),
    false,
  )
  assert.equal(isTrustedStreamRequest(request({ host: '127.0.0.1:9999' })), false)
})
