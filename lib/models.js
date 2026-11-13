/**
 * Manifesto dos modelos Whisper ONNX usados pelo dsh-voz-pt.
 *
 * Os pesos **não** são redistribuídos: são baixados em runtime do HuggingFace,
 * com revisão (commit) e SHA-256 fixados. O layout local é
 * `<dataRoot>/models/<modelo>/{encoder.int8.onnx,decoder.int8.onnx,tokens.txt}`.
 *
 * Fontes: `csukuangfj/sherpa-onnx-whisper-{small,base}` (conversões ONNX do
 * Whisper da OpenAI para o sherpa-onnx; licença MIT/Apache-2.0 do upstream).
 */

const HF_BASE = 'https://huggingface.co'

const LOCAL_NAMES = Object.freeze({
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner: 'joiner.onnx',
  tokens: 'tokens.txt',
})

const SMALL_REPO = 'csukuangfj/sherpa-onnx-whisper-small'
const SMALL_REVISION = '8f3c18b358db4d1f2fc1eae49d75cd20989e4309'
const BASE_REPO = 'csukuangfj/sherpa-onnx-whisper-base'
const BASE_REVISION = 'bb53ee204431c90d314c1cc08d28d23e5b7927cc'
const TOKENS_SHA256 = 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'

/**
 * @param {string} repo
 * @param {string} revision
 * @param {'encoder' | 'decoder' | 'tokens'} role
 * @param {string} remote
 * @param {number} bytes
 * @param {string} sha256
 */
function asset(repo, revision, role, remote, bytes, sha256, localName = LOCAL_NAMES[role]) {
  return {
    role,
    name: localName,
    remote,
    bytes,
    sha256,
    url: `${HF_BASE}/${repo}/resolve/${revision}/${remote}`,
  }
}

/** Manifesto imutável. */
export const MANIFEST = Object.freeze({
  'small-int8': Object.freeze({
    id: 'small-int8',
    label: 'Whisper small int8',
    repo: SMALL_REPO,
    revision: SMALL_REVISION,
    files: Object.freeze([
      asset(
        SMALL_REPO,
        SMALL_REVISION,
        'encoder',
        'small-encoder.int8.onnx',
        112442483,
        '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9',
      ),
      asset(
        SMALL_REPO,
        SMALL_REVISION,
        'decoder',
        'small-decoder.int8.onnx',
        262226114,
        'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee',
      ),
      asset(SMALL_REPO, SMALL_REVISION, 'tokens', 'small-tokens.txt', 816730, TOKENS_SHA256),
    ]),
  }),
  'streaming-pt': Object.freeze({
    id: 'streaming-pt',
    label: 'Zipformer streaming pt',
    repo: 'kouhxp/sherpa-onnx-streaming-zipformer-pt-kroko',
    revision: 'd0472d0660a2f6040132e42da37d6906368bcbb7',
    files: Object.freeze([
      asset('kouhxp/sherpa-onnx-streaming-zipformer-pt-kroko', 'd0472d0660a2f6040132e42da37d6906368bcbb7', 'encoder', 'encoder.onnx', 154878660, '336b9a62fd37d8b94855fcbe0414000aa5f1bd75d4cb907e112bd6b7ef97c52e', 'encoder.onnx'),
      asset('kouhxp/sherpa-onnx-streaming-zipformer-pt-kroko', 'd0472d0660a2f6040132e42da37d6906368bcbb7', 'decoder', 'decoder.onnx', 617488, '2380832dbb1867779a550aea3948776d6a53ffa1cccd075bb7592ebaf21b7638', 'decoder.onnx'),
      asset('kouhxp/sherpa-onnx-streaming-zipformer-pt-kroko', 'd0472d0660a2f6040132e42da37d6906368bcbb7', 'joiner', 'joiner.onnx', 336817, 'de7afbc23e7e55af7fed85780690b8f883c62b881fe14d546d9677151581962f', 'joiner.onnx'),
      asset('kouhxp/sherpa-onnx-streaming-zipformer-pt-kroko', 'd0472d0660a2f6040132e42da37d6906368bcbb7', 'tokens', 'tokens.txt', 6239, 'ff7e774b59714285d211a524223885fd9884cb878af97635d10042f56dbc56cd', 'tokens.txt'),
    ]),
  }),
  'base-int8': Object.freeze({
    id: 'base-int8',
    label: 'Whisper base int8',
    repo: BASE_REPO,
    revision: BASE_REVISION,
    files: Object.freeze([
      asset(
        BASE_REPO,
        BASE_REVISION,
        'encoder',
        'base-encoder.int8.onnx',
        29120534,
        '0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11',
      ),
      asset(
        BASE_REPO,
        BASE_REVISION,
        'decoder',
        'base-decoder.int8.onnx',
        130672026,
        '9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d',
      ),
      asset(BASE_REPO, BASE_REVISION, 'tokens', 'base-tokens.txt', 816730, TOKENS_SHA256),
    ]),
  }),
})

/** Ids de modelo aceitos. */
export const MODEL_IDS = Object.freeze(Object.keys(MANIFEST))

/**
 * @param {string} modelId
 * @returns {(typeof MANIFEST)[keyof typeof MANIFEST]}
 */
export function manifestFor(modelId) {
  const manifest = MANIFEST[modelId]
  if (!manifest) {
    throw new Error(`Modelo desconhecido: ${modelId}. Use ${MODEL_IDS.join(' ou ')}.`)
  }
  return manifest
}

/**
 * @param {string} modelId
 * @returns {number}
 */
export function modelTotalBytes(modelId) {
  return manifestFor(modelId).files.reduce((sum, file) => sum + file.bytes, 0)
}

/**
 * @param {string} dataRoot
 * @param {string} modelId
 * @returns {string}
 */
export function modelDir(dataRoot, modelId) {
  manifestFor(modelId)
  return `${dataRoot}/models/${modelId}`
}

/**
 * Caminhos de todos os arquivos do modelo, por papel.
 * @param {string} dataRoot
 * @param {string} modelId
 * @returns {Record<string, string>}
 */
export function filePaths(dataRoot, modelId) {
  const dir = `${dataRoot}/models/${modelId}`
  /** @type {Record<string, string>} */
  const paths = {}
  for (const file of manifestFor(modelId).files) {
    paths[file.role] = `${dir}/${file.name}`
  }
  return paths
}

/**
 * Caminhos do Whisper (encoder/decoder/tokens).
 * @param {string} dataRoot
 * @param {string} modelId
 * @returns {{ encoder: string, decoder: string, tokens: string }}
 */
export function modelPaths(dataRoot, modelId) {
  const paths = filePaths(dataRoot, modelId)
  return { encoder: paths.encoder, decoder: paths.decoder, tokens: paths.tokens }
}
