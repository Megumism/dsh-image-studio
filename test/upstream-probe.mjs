/**
 * Reproduce the finding this plugin is built on.
 *
 * Sends the same image request in three response formats, in parallel and with
 * a bounded deadline, and reports which ones actually come back. Run it against
 * any OpenAI-compatible gateway that appears to hang.
 *
 * Usage:
 *   IMAGE_API_KEY=sk-... node test/upstream-probe.mjs --base https://host/v1
 *   IMAGE_API_KEY=sk-... node test/upstream-probe.mjs --base ... --model gpt-image-2 --timeout 300
 *
 * The key is read from the environment and never from a file, so this script
 * carries no secret and its output is safe to paste.
 */

import https from 'node:https'

const args = process.argv.slice(2)
const valueOf = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const KEY = process.env.IMAGE_API_KEY ?? process.env.SMOKE_API_KEY ?? ''
const BASE = valueOf('--base') ?? 'https://zdxjl.com/v1'
const MODEL = valueOf('--model') ?? 'gpt-image-2'
const TIMEOUT = Number(valueOf('--timeout') ?? 240) * 1000
let PROMPT = valueOf('--prompt') ?? 'A single red apple on a white table, clean studio product photo'

if (KEY === '') {
  console.error('set IMAGE_API_KEY (or SMOKE_API_KEY) in the environment')
  process.exit(2)
}

const target = new URL(BASE)
const AGENT = target.protocol === 'http:' ? (await import('node:http')).default : https

/** One POST with an explicit client-side deadline. */
function post(path, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const started = Date.now()
    const request = AGENT.request({
      host: target.host,
      path: `${target.pathname.replace(/\/$/, '')}${path}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        seconds: (Date.now() - started) / 1000,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`no response within ${timeoutMs / 1000}s`)))
    request.on('error', (error) => resolve({ status: 0, seconds: (Date.now() - started) / 1000, text: `ERR ${error.message}` }))
    request.write(payload)
    request.end()
  })
}

/** A one-line description of a response, with image data elided. */
function describe(result) {
  let body = result.text
  try {
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed.data)) {
      parsed.data = parsed.data.map((item) => ({
        ...item,
        ...(typeof item.b64_json === 'string' ? { b64_json: `<${item.b64_json.length} chars>` } : {}),
        ...(typeof item.url === 'string' && item.url.startsWith('data:') ? { url: `<data-url ${item.url.length} chars>` } : {}),
      }))
    }
    body = JSON.stringify(parsed)
  } catch {}
  return body.length > 320 ? `${body.slice(0, 320)}…` : body
}

console.log(`endpoint : ${BASE}/images/generations`)
console.log(`model    : ${MODEL}`)
console.log(`deadline : ${TIMEOUT / 1000}s per request, all in parallel\n`)

const shapes = [
  ['omitted', { model: MODEL, prompt: PROMPT, n: 1 }],
  ['b64_json', { model: MODEL, prompt: PROMPT, n: 1, response_format: 'b64_json' }],
  ['url', { model: MODEL, prompt: PROMPT, n: 1, response_format: 'url' }],
]

const results = await Promise.all(shapes.map(async ([label, body]) => {
  const result = await post('/images/generations', body, TIMEOUT)
  return { label, result }
}))

console.log('response_format   status   time     result')
console.log('-'.repeat(78))
for (const { label, result } of results) {
  const status = result.status === 0 ? 'none' : String(result.status)
  console.log(`${label.padEnd(17)} ${status.padStart(6)}   ${`${result.seconds.toFixed(1)}s`.padStart(7)}  ${describe(result)}`)
}

const winner = results.find(({ result }) => result.status === 200)
console.log('')
if (winner !== undefined) {
  console.log(`=> "${winner.label}" completed in ${winner.result.seconds.toFixed(1)}s; the others did not.`)
  console.log('   Set the channel\'s Response format to that value.')
} else {
  console.log('=> no shape completed; the gateway or its upstream is unavailable right now.')
}
process.exit(winner === undefined ? 1 : 0)
