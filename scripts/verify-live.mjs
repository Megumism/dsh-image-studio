/**
 * Verify the plugin inside a *running* harness.
 *
 * The smoke tests prove the halves in isolation; this proves the whole thing is
 * actually mounted in a live instance — route present, config readable, and
 * optionally a real image generated and served back.
 *
 * Usage:
 *   node scripts/verify-live.mjs --url http://127.0.0.1:PORT --token TOKEN
 *   node scripts/verify-live.mjs --url ... --token ... --generate
 *
 * The token is the `?token=` value the harness prints on startup
 * (`dsh web: http://127.0.0.1:PORT/?token=...`). This script trades it for the
 * session cookie the browser uses, because `/api/*` is refused without one.
 * For `--generate`, supply the API key through SMOKE_API_KEY so no secret is
 * written into a command line or a file.
 */

const args = process.argv.slice(2)
const valueOf = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const BASE = (valueOf('--url') ?? '').replace(/\/+$/, '')
const TOKEN = valueOf('--token') ?? ''
const WANT_GENERATE = args.includes('--generate')

if (BASE === '' || TOKEN === '') {
  console.error('usage: node scripts/verify-live.mjs --url http://127.0.0.1:PORT --token TOKEN [--generate]')
  process.exit(2)
}

const failures = []
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- log in ----------------------------------------------------------------
const landing = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' })
const jar = (landing.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
console.log(`\nlogin: HTTP ${landing.status}, ${jar === '' ? 'no cookie' : 'cookie acquired'}`)
if (jar === '') {
  console.error('could not obtain a session cookie; is the token current? (the token changes on every restart)')
  process.exit(2)
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Cookie: jar, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, text, json }
}

// ---- the browser bundle the GUI is composed with ----------------------------
// The bundle rev is a content hash of the file the harness read. Comparing it
// against the file on disk answers the one question that decides whether a
// browser REFRESH is enough: has the running host noticed the latest edit? The
// host half never hot-reloads, so if only the client changed a refresh suffices.
console.log('\nthe browser half')
const page = await fetch(`${BASE}/`, { headers: { Cookie: jar } })
const html = await page.text()
const bootAt = html.indexOf('__DSH_BOOT__')
const braceAt = bootAt < 0 ? -1 : html.indexOf('{', bootAt)
let boot
if (braceAt >= 0) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = braceAt; i < html.length; i += 1) {
    const ch = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { boot = JSON.parse(html.slice(braceAt, i + 1)); break }
    }
  }
}
check('the GUI page renders', page.status === 200 && html.includes('__DSH_BOOT__'), `HTTP ${page.status}`)
const entry = boot?.entries?.find((candidate) => candidate.id === 'dsh-image-studio')
check('the browser half is composed into the boot graph', entry !== undefined, `${boot?.entries?.length ?? 0} entries`)
if (entry !== undefined) {
  console.log(`        bundle rev ${entry.rev}, injecting ${JSON.stringify(entry.inject)}`)
  check('the browser half is keyed to this plugin', entry.id === 'dsh-image-studio')
}

// ---- the plugin is mounted -------------------------------------------------
console.log('\nthe host half is mounted')

// A control that no plugin can have registered: if this is not 404, the 200
// below would prove nothing.
const control = await api('/api/dsh-image-studio-no-such-plugin/health')
check('an unregistered route 404s (control)', control.status === 404, `got ${control.status}`)

const health = await api('/api/dsh-image-studio/health')
check('GET /health answers 200', health.status === 200, `${health.status} ${health.text.slice(0, 120)}`)
check('the health payload has our shape', health.json?.ok === true && typeof health.json?.value?.root === 'string', health.text.slice(0, 160))
if (health.json?.ok === true) console.log(`        data directory: ${health.json.value.root}`)

// The transcript view reads generated images back through this route. A 400 for
// an incomplete reference proves it is MOUNTED; a 404 means the running host
// predates it, which is the failure that leaves a generated picture invisible.
const attachment = await api('/api/dsh-image-studio/attachment?media_type=image%2Fpng')
check('the attachment route is mounted (400, not 404)', attachment.status === 400, `${attachment.status} ${attachment.text.slice(0, 120)}`)

// ---- the configuration round-trips -----------------------------------------
console.log('\nconfiguration')

const config = await api('/api/dsh-image-studio/config/get', 'POST', {})
check('POST /config/get answers 200', config.status === 200, String(config.status))
const channels = config.json?.value?.config?.channels ?? []
console.log(`        ${channels.length} channel(s) configured`)

// The literal must never cross the wire, whatever is stored.
const key = process.env.SMOKE_API_KEY ?? ''
if (key !== '') {
  check('the stored API key is not returned to the browser', config.text.includes(key) === false)
}
for (const channel of channels) {
  check(`channel "${channel.name || channel.id}" reports key presence, not the key`, typeof channel.hasKey === 'boolean' && channel.apiKey === undefined)
}

// ---- a channel can be probed -----------------------------------------------
if (channels.length > 0) {
  console.log('\nupstream reachability')
  const probe = await api('/api/dsh-image-studio/channel/models', 'POST', { channelId: channels[0].id })
  check('POST /channel/models answers 200', probe.status === 200, `${probe.status} ${probe.text.slice(0, 160)}`)
  if (probe.json?.ok === true) {
    console.log(`        ${probe.json.value.models.length} model(s), ${probe.json.value.imageModels.length} image model(s)`)
    check('at least one image model was recognised', probe.json.value.imageModels.length > 0)
  }

  // The settings page probes the DRAFT it is editing, whose key field is blank
  // because the page is never handed the literal. This is the shape that
  // actually reaches this route from the UI, so it is the one worth exercising.
  const draftProbe = await api('/api/dsh-image-studio/channel/models', 'POST', {
    channel: {
      id: channels[0].id,
      name: channels[0].name,
      baseUrl: channels[0].baseUrl,
      apiKey: '',
      apiKeyEnv: channels[0].apiKeyEnv ?? '',
      models: channels[0].models,
      responseFormat: channels[0].responseFormat,
    },
  })
  // A failure here usually means the host half on disk is newer than the one
  // the running process loaded: the browser bundle hot-reloads, a node module
  // in the harness process does not.
  check(
    'a draft probe with a blank key uses the stored one',
    draftProbe.json?.ok === true,
    `${draftProbe.status} ${draftProbe.text.slice(0, 200)}${draftProbe.json?.ok === true ? '' : ' — if the host half changed since boot, restart the harness'}`,
  )
}

// ---- a real generation -----------------------------------------------------
if (WANT_GENERATE) {
  console.log('\nlive generation (this takes ~30-60s)')
  if (channels.length === 0) {
    check('a channel is configured', false, 'add one in Settings → Image Studio first')
  } else {
    const started = Date.now()
    const generated = await api('/api/dsh-image-studio/generate', 'POST', {
      channelId: channels[0].id,
      prompt: 'A single red apple on a white table, clean studio product photo',
      count: 1,
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    check('POST /generate answers 200', generated.status === 200, `${generated.status} after ${seconds}s: ${generated.text.slice(0, 200)}`)

    const image = generated.json?.value?.images?.[0]
    check('it returned an image', image !== undefined, generated.text.slice(0, 200))
    if (image !== undefined) {
      console.log(`        ${image.width}x${image.height} ${image.mime} ${image.bytes} bytes in ${seconds}s`)
      const served = await fetch(`${BASE}${image.url}`, { headers: { Cookie: jar } })
      const bytes = Buffer.from(await served.arrayBuffer())
      check('the stored image is served back', served.status === 200 && (served.headers.get('content-type') ?? '').startsWith('image/'), String(served.status))
      check('the served bytes are a real image', bytes.length > 1000 && (bytes[0] === 0x89 || bytes[0] === 0xff), `${bytes.length} bytes`)
    }
  }
}

console.log(`\n${failures.length === 0 ? 'LIVE VERIFICATION PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
