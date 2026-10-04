/**
 * Host-half smoke test.
 *
 * Mounts the real plugin on a real node:http server backed by a temporary
 * DSH_HOME, then drives the routes over the wire. This is the check that the
 * host half is correct on its own, with no harness and no browser in the loop.
 *
 * Usage: node test/host-smoke.mjs [--generate]
 */

import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const withGenerate = process.argv.includes('--generate')

// The plugin resolves its data directory from DSH_HOME at call time, so this
// must be set before `apply` runs — and it must point somewhere disposable.
const home = mkdtempSync(join(tmpdir(), 'dsh-image-studio-smoke-'))
process.env.DSH_HOME = home

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const { apply } = await import('../lib/index.js')
const { normalizeConfig, publicConfig, resolveImagePath, saveImage, prunePreviews, resolvePreviewDir, resolveImagesDir } = await import('../lib/host/store.js')
const { isImageModelId, joinEndpoint } = await import('../lib/host/upstream.js')

// ---- unit-level ------------------------------------------------------------
console.log('\nstore + upstream units')

check('normalizeConfig drops a channel with no baseUrl', normalizeConfig({ channels: [{ name: 'x' }] }).channels.length === 0)
check('normalizeConfig trims a trailing slash', normalizeConfig({ channels: [{ baseUrl: 'https://a.example/v1///' }] }).channels[0].baseUrl === 'https://a.example/v1')
check('normalizeConfig clamps count to 4', normalizeConfig({ preferences: { count: 99 } }).preferences.count === 4)
check('normalizeConfig defaults allowRemote to false', normalizeConfig({}).preferences.allowRemote === false)
check('normalizeConfig keeps allowRemote true when asked', normalizeConfig({ preferences: { allowRemote: true } }).preferences.allowRemote === true)
check(
  'publicConfig never leaks the literal key',
  JSON.stringify(publicConfig(normalizeConfig({ channels: [{ baseUrl: 'https://a.example/v1', apiKey: 'sk-secret' }] }))).includes('sk-secret') === false,
)
check('publicConfig reports key presence', publicConfig(normalizeConfig({ channels: [{ baseUrl: 'https://a.example/v1', apiKey: 'sk-secret' }] })).channels[0].hasKey === true)
check('a default naming a missing channel is dropped', normalizeConfig({ channels: [{ baseUrl: 'https://a.example/v1' }], defaultChannelId: 'nope' }).defaultChannelId !== 'nope')
check('joinEndpoint joins cleanly', joinEndpoint('https://a.example/v1/', '/models') === 'https://a.example/v1/models')
check('isImageModelId accepts gpt-image-2', isImageModelId('gpt-image-2') === true)
check('isImageModelId rejects gpt-5.4', isImageModelId('gpt-5.4') === false)
check('resolveImagePath refuses traversal', resolveImagePath(home, '../../config.json') === undefined)
check('resolveImagePath refuses an absolute path', resolveImagePath(home, 'C:/windows/win.ini') === undefined)
check('resolveImagePath refuses a nested path', resolveImagePath(home, 'a/b.png') === undefined)

// ---- kept vs preview storage ------------------------------------------------
// The settings page's "try it" is a channel check, not a gallery: its output
// must not accumulate inside the operator's home, and only one preview
// generation may exist at a time.
console.log('\nkept vs preview storage')
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 3, 0])

prunePreviews()
const kept = saveImage(home, png, 'image/png')
check('a kept image lands in the plugin images directory', existsSync(join(resolveImagesDir(home), kept.name)))
check('a kept image is not marked temporary', kept.temporary === false)

const first = saveImage(home, png, 'image/png', { temporary: true })
check('a preview lands in the system temp area', existsSync(join(resolvePreviewDir(), first.name)))
check('a preview is NOT written into the user home', existsSync(join(resolveImagesDir(home), first.name)) === false)
check('a preview reports the temporary flag', first.temporary === true)
check('a preview is still served by name', resolveImagePath(home, first.name) !== undefined)
check('the kept image is still served too', resolveImagePath(home, kept.name) !== undefined)

const second = saveImage(home, png, 'image/png', { temporary: true })
check('a new preview replaces the previous one', existsSync(join(resolvePreviewDir(), first.name)) === false && existsSync(join(resolvePreviewDir(), second.name)))
check('replacing a preview leaves kept images alone', existsSync(join(resolveImagesDir(home), kept.name)))

prunePreviews()
check('pruning removes the whole preview directory', existsSync(resolvePreviewDir()) === false)

// ---- mount the real routes -------------------------------------------------
const routes = new Map()
const registeredTools = []
const fakeAttachments = {
  saveImages: async (inputs) => inputs.map((input, index) => ({
    attachmentId: `sha256:${String(index).padStart(8, '0')}`,
    mediaType: input.mediaType,
    bytes: input.data.length,
    width: 4,
    height: 3,
  })),
  // The transcript view reads generated images back through the plugin route,
  // because tool-result images are absent from model-visible session content.
  readImage: async (ref) => ({ ref, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
}
const ctx = {
  logger: { info: () => {}, warn: (m) => console.log(`  [host warn] ${m}`), error: (m) => console.log(`  [host error] ${m}`) },
  effect: (fn) => fn(),
  // Mirrors cordis: `inject(deps, fn)` runs `fn` against a context that resolves
  // those services. The image tool registers through this path, so a fake
  // without it would leave the registration untested.
  inject: (deps, fn) => fn({
    effect: (f) => f(),
    get: (name) => (name === 'tools'
      ? { register: (definition) => { registeredTools.push(definition); return () => {} } }
      : name === 'attachments' ? fakeAttachments : undefined),
  }),
  // The plugin resolves services lazily through the outer context too.
  get: (name) => (name === 'attachments' ? fakeAttachments : undefined),
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}

apply(ctx, { enabled: true })

check('applying the plugin registers exactly one tool', registeredTools.length === 1, `got ${registeredTools.length}`)
check('the registered tool is generate_image', registeredTools[0]?.name === 'generate_image')

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  for (const route of routes.values()) {
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
      Promise.resolve(route.handler(req, res)).catch((error) => {
        res.writeHead(500).end(String(error))
      })
      return
    }
  }
  res.writeHead(404).end('no route')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const api = `${origin}/api/dsh-image-studio`

const call = async (path, body) => {
  const response = await fetch(`${api}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

console.log('\nHTTP surface')

const health = await call('/health')
check('GET /health answers ok', health.status === 200 && health.json.ok === true, JSON.stringify(health.json))

const unknown = await call('/nope', {})
check('an unknown route 404s', unknown.status === 404)

const initial = await call('/config/get', {})
check('POST /config/get returns an empty config', initial.json.value.config.channels.length === 0)

const badProbe = await call('/channel/models', { channel: { baseUrl: '' } })
check('probing a channel with no URL fails cleanly', badProbe.json.ok === false, JSON.stringify(badProbe.json))

const saved = await call('/config/set', {
  config: normalizeConfig({
    channels: [{
      id: 'chan-1',
      name: 'gpt-img',
      baseUrl: 'https://zdxjl.com/v1',
      apiKey: process.env.SMOKE_API_KEY ?? '',
      models: ['gpt-image-2'],
      responseFormat: 'url',
    }],
    preferences: { defaultModel: 'gpt-image-2', size: '1024x1024', count: 1, timeoutMs: 300_000 },
  }),
})
check('POST /config/set persists a channel', saved.json.ok === true && saved.json.value.config.channels.length === 1, JSON.stringify(saved.json).slice(0, 300))
check('the saved channel reports a key only when one was supplied', saved.json.value.config.channels[0].hasKey === (process.env.SMOKE_API_KEY ?? '').length > 0)

const reread = await call('/config/get', {})
check('the saved channel round-trips', reread.json.value.config.channels[0].baseUrl === 'https://zdxjl.com/v1')

const hasKey = (process.env.SMOKE_API_KEY ?? '').length > 0

if (!hasKey) {
  const missing = await call('/generate', { channelId: 'chan-1', prompt: 'x' })
  check(
    'generating without a key fails as missing-key (not a crash)',
    missing.json.ok === false && missing.json.code === 'missing-key',
    JSON.stringify(missing.json),
  )
}

// An empty prompt is refused before any upstream call, key or no key.
const emptyPrompt = await call('/generate', { channelId: 'chan-1', prompt: '   ' })
check('generating with an empty prompt is refused', emptyPrompt.json.ok === false, JSON.stringify(emptyPrompt.json))

// ---- durable attachment reads -----------------------------------------------
// The transcript view needs the bytes, and the harness's own session-authorized
// loader refuses tool-result images, so the plugin serves them from its own
// route after rebuilding and re-verifying the complete reference.
console.log('\ndurable attachment reads')
const attachment = await fetch(`${origin}/api/dsh-image-studio/attachment?attachment_id=sha256%3A00000000&media_type=image%2Fpng&bytes=8&width=4&height=3`)
const attachmentBytes = Buffer.from(await attachment.arrayBuffer())
check('the attachment route serves the bytes', attachment.status === 200 && attachmentBytes.length === 8, `${attachment.status} / ${attachmentBytes.length} bytes`)
check('the attachment route declares the image type', (attachment.headers.get('content-type') ?? '').startsWith('image/png'))

const badType = await fetch(`${origin}/api/dsh-image-studio/attachment?attachment_id=sha256%3A0&media_type=text%2Fhtml&bytes=8&width=4&height=3`)
check('the attachment route refuses a non-image media type', badType.status === 400, String(badType.status))

const noId = await fetch(`${origin}/api/dsh-image-studio/attachment?media_type=image%2Fpng`)
check('the attachment route refuses an incomplete reference', noId.status === 400, String(noId.status))

// A key-carrying config comes from the environment so no secret enters this file.
if (hasKey) {
  console.log('\nlive upstream probe')
  const probe = await call('/channel/models', { channelId: 'chan-1' })
  check('probing the live channel lists image models', probe.json.ok === true && probe.json.value.imageModels.includes('gpt-image-2'), JSON.stringify(probe.json).slice(0, 300))

  // The settings page tests a channel by posting the DRAFT it is editing, and
  // that draft's key field is empty because the page was never given the
  // literal. A draft probe must inherit the stored key, or "Test connection"
  // reports a missing key for a channel that plainly has one.
  const draftProbe = await call('/channel/models', {
    channel: { id: 'chan-1', name: 'gpt-img', baseUrl: 'https://zdxjl.com/v1', apiKey: '', apiKeyEnv: '', models: ['gpt-image-2'], responseFormat: 'url' },
  })
  check('a draft probe with a blank key uses the stored one', draftProbe.json.ok === true, JSON.stringify(draftProbe.json).slice(0, 240))

  // A draft for a brand-new endpoint must NOT borrow the saved channel's key.
  const strangerProbe = await call('/channel/models', {
    channel: { id: 'brand-new', name: 'elsewhere', baseUrl: 'https://elsewhere.example/v1', apiKey: '', models: [] },
  })
  check('a draft probe for another endpoint borrows no key', strangerProbe.json.ok === false && strangerProbe.json.code === 'missing-key', JSON.stringify(strangerProbe.json).slice(0, 200))

  if (withGenerate) {
    console.log('\nlive generation (this takes ~40s)')
    const generated = await call('/generate', { channelId: 'chan-1', prompt: 'A single red apple on a white table, studio photo', count: 1 })
    check('generation returns a stored image', generated.json.ok === true && generated.json.value.images.length === 1, JSON.stringify(generated.json).slice(0, 400))
    if (generated.json.ok === true && generated.json.value.images.length === 1) {
      const image = generated.json.value.images[0]
      check('the stored image reports pixel dimensions', typeof image.width === 'number' && image.width > 0, JSON.stringify(image))
      const fetched = await fetch(`${origin}${image.url}`)
      check('the stored image is served back', fetched.status === 200 && (fetched.headers.get('content-type') ?? '').startsWith('image/'))
      const bytes = Buffer.from(await fetched.arrayBuffer())
      check('the served bytes are a real image', bytes.length > 1000 && bytes[0] === 0x89, `${bytes.length} bytes`)
      console.log(`        ${image.width}x${image.height} ${image.mime} ${image.bytes} bytes -> ${image.name}`)
    }
  }
}

// ---- credential preservation ------------------------------------------------
// The page only ever receives channels with the key redacted, so a save must
// never drop a stored key. Renaming a channel outside the page (a new id with
// the same endpoint and name) used to defeat the id-only match and silently
// erase the credential; this pins the fallback that prevents it.
console.log('\ncredential preservation across a save')
if (hasKey) {
  const renamed = await call('/config/set', {
    config: normalizeConfig({
      channels: [{ id: 'chan-renamed', name: 'gpt-img', baseUrl: 'https://zdxjl.com/v1', models: ['gpt-image-2'] }],
      preferences: { defaultModel: 'gpt-image-2' },
    }),
  })
  const channel = renamed.json.value?.config?.channels?.[0]
  check('a renamed channel keeps its stored key', channel?.hasKey === true, JSON.stringify(channel))

  // And the preserved key must still be usable, not just reported.
  const usable = await call('/channel/models', { channelId: 'chan-renamed' })
  check('the preserved key still authenticates', usable.json.ok === true, JSON.stringify(usable.json).slice(0, 200))

  // A genuinely new channel must NOT inherit someone else's key.
  const fresh = await call('/config/set', {
    config: normalizeConfig({
      channels: [{ id: 'chan-fresh', name: 'other', baseUrl: 'https://other.example/v1', models: [] }],
      preferences: {},
    }),
  })
  check('an unrelated new channel does not inherit a key', fresh.json.value?.config?.channels?.[0]?.hasKey === false, JSON.stringify(fresh.json.value?.config?.channels?.[0]))
} else {
  const stripped = await call('/config/set', {
    config: normalizeConfig({ channels: [{ id: 'chan-1', name: 'gpt-img', baseUrl: 'https://zdxjl.com/v1' }] }),
  })
  check('a keyless channel stays keyless after a save', stripped.json.value?.config?.channels?.[0]?.hasKey === false)
}

server.close()
rmSync(home, { recursive: true, force: true })

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
