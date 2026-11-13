/**
 * Smoke test real do dsh-voz-pt (sem DSH no meio).
 *
 * Cobre: WAV válido/ inválido, inspeção + hash do modelo, estados de
 * preparação e uma transcrição real em português com o Whisper ONNX.
 *
 * Uso:
 *   node tools/smoke.mjs              # modelo base-int8 (rápido)
 *   MODEL=small-int8 node tools/smoke.mjs
 *
 * Os arquivos já baixados em `.lab/models/<modelo>/` são semeados por hardlink
 * em `.lab/data/models/<modelo>/` para não baixar 160–375 MB de novo.
 */

import { link, mkdir, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { normalizeConfig } from '../lib/config.js'
import { WhisperEngine } from '../lib/engine.js'
import { ModelManager } from '../lib/manager.js'
import { createProvider } from '../lib/provider.js'
import { encodeWave, parseWave, WaveError } from '../lib/wave.js'

const root = process.cwd()
const model = process.env.MODEL ?? 'base-int8'
const dataRoot = path.join(root, '.lab', 'data')
const manifest = {
  'base-int8': {
    encoder: 'base-encoder.int8.onnx',
    decoder: 'base-decoder.int8.onnx',
    tokens: 'base-tokens.txt',
  },
  'small-int8': {
    encoder: 'small-encoder.int8.onnx',
    decoder: 'small-decoder.int8.onnx',
    tokens: 'small-tokens.txt',
  },
}[model]

const checks = []
/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(label, ok, detail = '') {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function seed() {
  if (!manifest) throw new Error(`MODEL desconhecido: ${model}`)
  const source = path.join(root, '.lab', 'models', model === 'small-int8' ? 'small' : 'base')
  const destination = path.join(dataRoot, 'models', model)
  await mkdir(destination, { recursive: true })
  for (const [role, name] of Object.entries(manifest)) {
    const remoteName = name
    const target = path.join(destination, role === 'tokens' ? 'tokens.txt' : `${role}.int8.onnx`)
    await rm(target, { force: true })
    try {
      await link(path.join(source, remoteName), target)
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
      // fallback: copia
      const { copyFile } = await import('node:fs/promises')
      await copyFile(path.join(source, remoteName), target)
    }
  }
}

async function main() {
  console.log(`workspace: ${root}`)
  console.log(`modelo:    ${model}`)
  console.log(`DSH_PROFILE_DIR=${process.env.DSH_PROFILE_DIR ?? '(não definido)'}`)
  console.log('')

  // 1. WAV
  const audioName = process.env.AUDIO ?? 'google.wav'
  const wave = parseWave(readFileSync(path.join(root, '.lab', 'audio', audioName)))
  check('WAV de teste válido', wave.durationSeconds > 0.5, `${wave.durationSeconds.toFixed(2)} s`)
  try {
    parseWave(Buffer.from('não é wav'))
    check('WAV inválido é recusado', false)
  } catch (error) {
    check('WAV inválido é recusado', error instanceof WaveError, error.message)
  }
  const tiny = parseWave(encodeWave(new Float32Array(1600)), { minSeconds: 0.01 })
  check('WAV sintético decodifica', tiny.samples.length === 1600)

  // 2. Config
  const config = normalizeConfig({ dataRoot, model, threads: 4 })
  check('config aplica dataRoot/model', config.model === model && config.dataRoot === dataRoot)

  // 3. Modelo
  await seed()
  const manager = new ModelManager({ dataRoot })
  const states = new Set()
  manager.subscribe(() => states.add(manager.state(model).state))

  await manager.prime(model)
  await manager.settled()
  const state = manager.state(model)
  check('modelo inspecionado/verificado', state.state === 'ready', `${state.progressBytes} bytes`)
  check(
    'preparação passou por verifying',
    states.has('verifying'),
    [...states].join(' → '),
  )

  // 4. Provider + transcrição real
  const engine = new WhisperEngine()
  const provider = createProvider({ config, manager, engine })
  check('provider anuncia pt', provider.info.languages.includes('pt'), provider.info.name)

  const prepared = provider.preparation.snapshot()
  check('preparation pronto', prepared.phase === 'ready', prepared.phase)

  const audio = readFileSync(path.join(root, '.lab', 'audio', audioName))
  const started = Date.now()
  const result = await provider.transcribe({ audio: new Uint8Array(audio), language: 'pt' }, AbortSignal.timeout(300_000))
  const elapsed = ((Date.now() - started) / 1000).toFixed(2)
  console.log('')
  console.log(`transcrição: ${JSON.stringify(result.text)}`)
  console.log(
    `tempo: ${elapsed} s (inferência ${result.inferenceSeconds.toFixed(2)} s, áudio ${result.audioSeconds.toFixed(2)} s, RTF ${(result.inferenceSeconds / result.audioSeconds).toFixed(3)})`,
  )
  console.log('')

  const normalized = result.text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  check('transcrição não vazia', result.text.length > 0)
  check('transcrição contém "revisar"', normalized.includes('revisar'), result.text)
  check(
    'transcrição menciona pull request',
    normalized.includes('pull request') || normalized.includes('pul request') || normalized.includes('pull'),
    result.text,
  )

  // 5. AbortSignal já abortado
  try {
    await provider.transcribe(
      { audio: new Uint8Array(audio), language: 'pt' },
      AbortSignal.abort(new Error('teste de cancelamento')),
    )
    check('sinal abortado é respeitado', false)
  } catch (error) {
    check('sinal abortado é respeitado', /cancel|abort/i.test(error?.message ?? ''), error?.message)
  }

  // 6. Idioma errado
  try {
    await provider.transcribe({ audio: new Uint8Array(audio), language: 'en' }, AbortSignal.timeout(10_000))
    check('idioma não-pt é recusado', false)
  } catch (error) {
    check('idioma não-pt é recusado', /português/i.test(error?.message ?? ''), error?.message)
  }

  await provider.dispose()
  await manager.dispose()

  const failed = checks.filter((item) => !item.ok)
  console.log('')
  console.log(`${checks.length - failed.length}/${checks.length} verificações passaram`)
  if (failed.length > 0) {
    console.error('FALHAS:', failed.map((item) => item.label).join(', '))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('SMOKE FALHOU:', error)
  process.exitCode = 1
})
