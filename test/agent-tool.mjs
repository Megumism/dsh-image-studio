/**
 * Offline test for the model-facing `generate_image` tool.
 *
 * `execute` is exercised against a stubbed `fetch`, so the whole path — channel
 * selection, the upstream request shape, image classification, attachment
 * admission, and the rendered content — is covered without a network call or a
 * harness. This is what makes the tool shippable before anyone restarts.
 *
 * Usage: node test/agent-tool.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { buildAgentTool, TOOL_NAME } from '../lib/host/agent-tool.js'
import { normalizeConfig } from '../lib/host/store.js'

const failures = []
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A minimal PNG header: enough for magic-number classification. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 3, 0])

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-image-studio-tool-'))

/** What the stubbed upstream saw, so the request shape can be asserted. */
const seen = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  seen.push({ url: target, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
  if (target.includes('/images/generations')) {
    return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/one.png', revised_prompt: 'a red apple' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (target.startsWith('https://cdn.example/')) {
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  return new Response('unexpected', { status: 404 })
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} }

/** A service over a fixed configuration. */
function serviceFor(config) {
  return { root: dataRoot, log: quiet, getConfig: () => config }
}

const configured = normalizeConfig({
  channels: [{ id: 'c1', name: 'gpt-img', baseUrl: 'https://relay.example/v1', apiKey: 'sk-test', models: ['gpt-image-2'], responseFormat: 'url' }],
  defaultChannelId: 'c1',
  preferences: { defaultModel: 'gpt-image-2', size: '1024x1024', count: 1, timeoutMs: 60_000 },
})

// ---- definition -------------------------------------------------------------
console.log('\ntool definition')
const admitted = []
const attachments = {
  async saveImages(inputs) {
    admitted.push(...inputs)
    return inputs.map((input, index) => ({
      attachmentId: `sha256:${String(index).padStart(8, '0')}`,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 1024,
      height: 1024,
      name: input.name,
    }))
  },
}

const tool = buildAgentTool(serviceFor(configured), attachments)
check('the tool is named generate_image', tool.name === TOOL_NAME && TOOL_NAME === 'generate_image')
check('it declares a description', typeof tool.description === 'string' && tool.description.length > 100)
check('it declares an object parameter schema', tool.parameters?.type === 'object')
check('prompt is required', Array.isArray(tool.parameters?.required) && tool.parameters.required.includes('prompt'))
check('count is bounded to 1..4', tool.parameters?.properties?.count?.minimum === 1 && tool.parameters?.properties?.count?.maximum === 4)
check('it declares an output schema', tool.output?.schema?.type === 'object')
check('it declares a render function', typeof tool.output?.render === 'function')

// ---- argument and configuration guards --------------------------------------
console.log('\nguards')
const t1 = buildAgentTool(serviceFor(normalizeConfig({ ...configured, enabled: false })), attachments)
check('a disabled plugin refuses the call', await t1.execute({ prompt: 'x' }, {}).then(() => false, (e) => /turned off/.test(e.message)))
const t2 = buildAgentTool(serviceFor(normalizeConfig({ channels: [] })), attachments)
check('no channel refuses the call', await t2.execute({ prompt: 'x' }, {}).then(() => false, (e) => /no image channel/.test(e.message)))
check('an empty prompt refuses the call', await tool.execute({ prompt: '   ' }, {}).then(() => false, (e) => /prompt is required/.test(e.message)))

// ---- the happy path ---------------------------------------------------------
console.log('\nexecute with an attachment store')
const value = await tool.execute({ prompt: 'a red apple on a white table' }, {})

const generation = seen.find((entry) => entry.url.includes('/images/generations'))
check('it called the channel endpoint', generation !== undefined, JSON.stringify(seen.map((entry) => entry.url)))
check('it used the configured response format', generation?.body?.response_format === 'url', JSON.stringify(generation?.body))
check('it used the configured model', generation?.body?.model === 'gpt-image-2')
check('it forwarded the prompt', generation?.body?.prompt === 'a red apple on a white table')
check('it did not send a batch count', generation?.body?.n === 1)
check('it downloaded the result URL', seen.some((entry) => entry.url.startsWith('https://cdn.example/')))
check('it sent the key only to the channel origin, not the CDN', seen.find((e) => e.url.startsWith('https://cdn.example/'))?.body === undefined)

check('the value declares one image', value.images.length === 1, JSON.stringify(value))
check('the image carries a durable reference', typeof value.images[0]?.attachmentId === 'string' && value.images[0].attachmentId.startsWith('sha256:'))
check('the image carries its verified media type', value.images[0]?.mediaType === 'image/png')
check('the image carries dimensions', value.images[0]?.width === 1024 && value.images[0]?.height === 1024)
check('no URLs are reported on the attachment path', Array.isArray(value.urls) && value.urls.length === 0)
check('the value reports the model and channel', value.model === 'gpt-image-2' && value.channel === 'gpt-img')
check('the attachment store received PNG bytes', admitted.length === 1 && admitted[0].mediaType === 'image/png' && admitted[0].data.length === PNG.length)

// ---- rendered content -------------------------------------------------------
console.log('\nrendered content')
const blocks = tool.output.render({}, value)
check('the first block is the image', blocks[0]?.type === 'image' && blocks[0]?.attachment?.attachmentId === value.images[0].attachmentId, JSON.stringify(blocks[0]))
check('a text block summarises the call', blocks.at(-1)?.type === 'text' && /Generated 1 image/.test(blocks.at(-1).text), JSON.stringify(blocks.at(-1)))
check('every image becomes a block', blocks.filter((block) => block.type === 'image').length === 1)

// ---- the file path, diagnostics and error classes ---------------------------
// These are the four things a caller cannot work around when they are missing:
// where the file is, how long it took, how many tries, and whether retrying
// could possibly help.
console.log('\ndiagnostics and file paths')
check('the value reports an absolute file path', typeof value.images[0]?.path === 'string' && isAbsolute(value.images[0].path), JSON.stringify(value.images[0]?.path))
check('the reported file actually exists', existsSync(value.images[0].path), value.images[0]?.path)
check('the reported file is real PNG bytes', readFileSync(value.images[0].path).subarray(0, 4).toString('hex') === '89504e47')
check('it reports the attempt count', value.attempts === 1, String(value.attempts))
check('it reports elapsed time', Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0, String(value.elapsedMs))
check('it reports the response format used', value.format === 'url', String(value.format))
check('it reports the deadline it was given', value.timeoutMs === 60_000, String(value.timeoutMs))
check('the rendered text carries the path', blocks.at(-1).text.includes(value.images[0].path), blocks.at(-1).text)

// An explicit destination is what makes the tool usable in a pipeline.
const explicit = await tool.execute({ prompt: 'a red apple', path: join(dataRoot, 'chosen', 'apple.png') }, {})
check('an absolute path argument is honoured', explicit.images[0].path === join(dataRoot, 'chosen', 'apple.png'), String(explicit.images[0].path))
check('the chosen directory is created and the file written', existsSync(join(dataRoot, 'chosen', 'apple.png')))
const named = await tool.execute({ prompt: 'a red apple', path: 'just-a-name.png' }, {})
check('a bare name lands in the configured directory', named.images[0].path === join(dataRoot, 'images', 'just-a-name.png'), String(named.images[0].path))

// A configured output directory is what lets another tool find the picture.
const elsewhere = normalizeConfig({ ...configured, preferences: { ...configured.preferences, outputDir: join(dataRoot, 'outbox') } })
const toOutbox = await buildAgentTool(serviceFor(elsewhere), attachments).execute({ prompt: 'a red apple' }, {})
check('preferences.outputDir redirects the write', toOutbox.images[0].path.startsWith(join(dataRoot, 'outbox')), String(toOutbox.images[0].path))
check('the redirected file exists', existsSync(toOutbox.images[0].path))

console.log('\nerror classification')
const healthyFetch = globalThis.fetch
const classify = async (channel, prompt, timeoutMs) => {
  const failing = normalizeConfig({ ...configured, channels: [channel], preferences: { ...configured.preferences, timeoutMs } })
  try {
    await buildAgentTool(serviceFor(failing), attachments).execute({ prompt }, {})
    return { action: 'none', message: '' }
  } catch (error) {
    return { action: error.action, message: error.message }
  }
}

// A gateway fault carries a status that says "try again".
const stubChannel = { id: 'c1', name: 'gpt-img', baseUrl: 'https://relay.example/v1', apiKey: 'sk-test', models: ['gpt-image-2'], responseFormat: 'url' }
globalThis.fetch = async (url) => (String(url).includes('/images/generations')
  ? new Response(JSON.stringify({ error: { message: 'upstream request failed' } }), { status: 502, headers: { 'content-type': 'application/json' } })
  : new Response('nope', { status: 404 }))
const transient = await classify(stubChannel, 'x', 60_000)
check('a 502 is classified as retry', transient.action === 'retry', JSON.stringify(transient))

// A content refusal is also a 400, exactly like a malformed request — the
// status carries no signal, so only the wording distinguishes them.
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/images/generations')) {
    return new Response(JSON.stringify({ error: { message: 'your request was rejected as a result of our safety system' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  return new Response('nope', { status: 404 })
}
const refused = await classify(stubChannel, 'x', 60_000)
check('a content refusal is classified as rephrase', refused.action === 'rephrase', JSON.stringify(refused))
check('the refusal message is tagged with its action', refused.message.startsWith('[rephrase]'), refused.message)

await (async () => {
  const noKey = normalizeConfig({ channels: [{ id: 'c1', name: 'gpt-img', baseUrl: 'https://relay.example/v1', apiKey: '', models: ['gpt-image-2'] }], defaultChannelId: 'c1' })
  try {
    await buildAgentTool(serviceFor(noKey), attachments).execute({ prompt: 'x' }, {})
    check('a missing key is classified as configure', false, 'no error thrown')
  } catch (error) {
    check('a missing key is classified as configure', error.action === 'configure' || error.code === 'missing-key', JSON.stringify({ code: error.code, action: error.action }))
  }
})()

// ---- the degraded path ------------------------------------------------------
console.log('\nexecute without an attachment store')
// Restore the healthy upstream: the classification block above replaced fetch
// with a refusal stub, and the degraded path still needs a working gateway.
globalThis.fetch = healthyFetch
const bare = buildAgentTool(serviceFor(configured), undefined)
const fallback = await bare.execute({ prompt: 'a red apple' }, {})
check('it still succeeds', fallback.images.length === 0 && fallback.urls.length === 1, JSON.stringify(fallback))
check('it reports a served URL', fallback.urls[0].startsWith('/api/dsh-image-studio/image/'), fallback.urls[0])
check('the file really exists on disk', existsSync(join(dataRoot, 'images', decodeURIComponent(fallback.urls[0].split('/').at(-1)))))
check('it still reports diagnostics', fallback.attempts === 1 && fallback.format === 'url', JSON.stringify({ attempts: fallback.attempts, format: fallback.format }))
const fallbackBlocks = bare.output.render({}, fallback)
check('the rendered text mentions the URL', fallbackBlocks.at(-1).text.includes('/api/dsh-image-studio/image/'), fallbackBlocks.at(-1).text)
check('no image blocks are claimed without attachments', fallbackBlocks.every((block) => block.type !== 'image'))

rmSync(dataRoot, { recursive: true, force: true })

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
