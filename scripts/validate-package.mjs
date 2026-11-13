#!/usr/bin/env node
/**
 * Validação local do pacote antes de publicar/taguear.
 *
 * Confere o que o DSH e o catálogo comunitário realmente leem:
 *  - `dsh.bundle.patch` existe e monta a linha do plugin com o nome do pacote;
 *  - `dsh.client.platform === "web"` e o bundle `./client` existe;
 *  - o id do bundle lazy-CJS casa com o nome do pacote;
 *  - o client registra o slot `conversation.input.left`;
 *  - `main`/`exports`/`files` apontam para arquivos reais;
 *  - `engines.dsh` cobre a série atual do Harness;
 *  - nenhum segredo óbvio vazou.
 *
 * Uso: `npm run validate` (também roda no `prepack`).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []
const fail = (message) => problems.push(message)
const ok = (message) => notes.push(message)

const pkgPath = join(root, 'package.json')
if (!existsSync(pkgPath)) {
  console.error('package.json ausente')
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

if (typeof pkg.name !== 'string' || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg.name)) {
  fail(`nome de pacote npm inválido: ${String(pkg.name)}`)
} else {
  ok(`nome npm: ${pkg.name}`)
}

if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  fail(`versão semver inválida: ${String(pkg.version)}`)
} else {
  ok(`versão: ${pkg.version}`)
}

if (pkg.license !== 'MIT') fail('license deve ser MIT')
if (typeof pkg.description !== 'string' || pkg.description.length < 40) {
  fail('description curta demais para o catálogo')
}
if (pkg.dsh?.manifestVersion !== 1) fail('dsh.manifestVersion deve ser 1')

// Bundle (host)
const bundlePatch = pkg.dsh?.bundle?.patch
if (typeof bundlePatch !== 'string') {
  fail('dsh.bundle.patch ausente — causa nº 1 de rejeição no catálogo')
} else {
  const patchPath = join(root, bundlePatch)
  if (!existsSync(patchPath)) {
    fail(`dsh.bundle.patch não existe: ${bundlePatch}`)
  } else {
    const patch = readFileSync(patchPath, 'utf8')
    if (!patch.includes('insert:')) fail('cordis.patch.yml sem bloco insert:')
    if (!patch.includes(pkg.name)) fail(`cordis.patch.yml não monta o pacote "${pkg.name}"`)
    ok('dsh.bundle.patch monta a linha do plugin')
  }
}

// Client
if (pkg.dsh?.client?.platform !== 'web') {
  fail('dsh.client.platform deve ser "web"')
} else {
  ok('dsh.client.platform: web')
}
const clientExport = pkg.exports?.['./client']
const clientPath = typeof clientExport === 'string' ? clientExport : (clientExport?.default ?? clientExport?.import)
if (typeof clientPath !== 'string') {
  fail('exports["./client"] ausente — o botão do compositor não carrega')
} else {
  const absolute = join(root, clientPath)
  if (!existsSync(absolute)) {
    fail(`bundle client ausente: ${clientPath}`)
  } else {
    const bundle = readFileSync(absolute, 'utf8')
    if (!bundle.includes('__ModuleLoader__.load')) fail('client bundle não usa o ModuleLoader')
    const idMatch = bundle.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*['"]([^'"]+)['"]/)
    if (idMatch === null) fail('client bundle sem `id` no __ModuleLoader__.load')
    else if (idMatch[1] !== pkg.name) fail(`id do bundle (${idMatch[1]}) difere do pacote (${pkg.name})`)
    else ok(`client bundle registra o id "${idMatch[1]}"`)
    if (!/exports\.apply\s*=|return\s*\{\s*apply/.test(bundle)) fail('client bundle não exporta apply')
    if (!/exports\.inject\s*=|return\s*\{[^}]*\binject\b/.test(bundle)) fail('client bundle não exporta inject')
    if (!bundle.includes('conversation.input.left')) fail('client bundle não registra conversation.input.left')
    else ok('client bundle registra o botão em conversation.input.left')
    if (!bundle.includes('/dsh-voz-pt/stream')) fail('client bundle não fala com /dsh-voz-pt/stream')
  }
}

// Host
if (typeof pkg.main !== 'string' || !existsSync(join(root, pkg.main))) {
  fail(`main host ausente: ${String(pkg.main)}`)
} else {
  const host = readFileSync(join(root, pkg.main), 'utf8')
  if (!/export\s+function\s+apply/.test(host)) fail('host não exporta apply')
  if (!/export\s+const\s+inject\s*=/.test(host)) fail('host não exporta inject')
  if (!/export\s+const\s+name\s*=/.test(host)) fail('host não exporta name')
  ok(`host: ${pkg.main}`)
}

// files[]
if (Array.isArray(pkg.files)) {
  const required = ['lib', 'assets', 'cordis.patch.yml', 'README.md', 'README.pt-BR.md', 'LICENSE']
  const missing = required.filter((entry) => !pkg.files.some((file) => file === entry || file.startsWith(entry + '/')))
  if (missing.length > 0) fail(`files[] não inclui: ${missing.join(', ')}`)
  for (const entry of pkg.files) {
    if (!existsSync(join(root, entry.replace(/\/$/, '')))) fail(`files[] aponta para caminho inexistente: ${entry}`)
  }
  ok('files[] cobre host, client, patch, READMEs, licença e assets')
} else {
  fail('files[] ausente (o pacote publicaria sobras do repo)')
}

// engines
const dshRange = pkg.engines?.dsh
if (typeof dshRange !== 'string' || !dshRange.includes('0.2.')) {
  fail(`engines.dsh deve declarar a série atual (recebido: ${String(dshRange)})`)
} else {
  ok(`engines.dsh: ${dshRange}`)
}
if (typeof pkg.engines?.node !== 'string') fail('engines.node ausente')

// repository
if (typeof pkg.repository?.url !== 'string' || !pkg.repository.url.includes('github.com')) {
  fail('repository.url deve apontar para o repositório GitHub')
}
if (pkg.publishConfig?.access !== 'public') fail('publishConfig.access deve ser "public"')

// Segredos
const SECRET_PATTERNS = [
  /x-dsh-auth-token['"]?\s*[:=]\s*['"][^'"]{12,}/i,
  /sk-[A-Za-z0-9]{20,}/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
]
for (const dir of ['lib', 'assets', 'scripts', '.github', 'publish']) {
  const absolute = join(root, dir)
  if (!existsSync(absolute)) continue
  for (const file of walk(absolute)) {
    if (/\.(png|jpg|jpeg|webp|tgz|zip|onnx)$/i.test(file)) continue
    const content = readFileSync(file, 'utf8')
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(content)) fail(`possível segredo em ${file.replace(root + '/', '')}`)
    }
  }
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

for (const note of notes) console.log(`  ok  ${note}`)
if (problems.length > 0) {
  console.error('\nFalhas:')
  for (const problem of problems) console.error(`  x   ${problem}`)
  console.error(`\n${problems.length} problema(s). Corrija antes de publicar.`)
  process.exit(1)
}
console.log('\nPacote válido para publicar e submeter ao catálogo.')
