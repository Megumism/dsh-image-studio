/**
 * Upstream image-generation client (OpenAI-compatible HTTP).
 *
 * Two behaviours here are not obvious and are load-bearing for the gateways
 * this plugin targets:
 *
 * 1. `response_format: "url"` is the default, not `"b64_json"`.
 *    Measured against a real relay (`zdxjl.com`), `b64_json` accepts the request
 *    and then never answers — the connection sits until the client gives up —
 *    while `"url"` returns a finished image in ~38s. Because a hang is
 *    indistinguishable from slowness, the fix cannot be a longer timeout; the
 *    request shape itself has to default to the one that is known to complete.
 *
 * 2. A result URL is fetched WITHOUT the API key unless it shares the channel's
 *    origin. Gateways hand back signed links on their own CDN hosts, and
 *    forwarding a bearer token to a host the operator did not configure would
 *    leak the credential to a third party.
 */

import { classifyImage, DEFAULT_RESPONSE_FORMAT } from './store.js'

/** One channel failure, carrying a machine code the panel can localize. */
export class UpstreamError extends Error {
  /**
   * @param message - operator-facing text; upstream wording is preserved verbatim.
   * @param code - stable machine code (see the list below).
   * @param status - HTTP status when the failure came from a response.
   */
  constructor(message, code, status = 0) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.status = status
  }
}

/** Largest upstream response body accepted, to bound a hostile or broken gateway. */
const MAX_JSON_BYTES = 8 * 1024 * 1024

/** Largest generated image accepted. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** Model ids that look like image models, mirroring the gateway's own naming. */
const IMAGE_MODEL_PATTERN = /(?:^|[-_.])(?:image|img|diffusion|flux|dall-e|gpt-image|seedream|nanobanana|nano-banana|grok-imagine|imagen|qwen-image|glm-image|cogview|sdxl|stable-diffusion|ideogram|recraft|hunyuan|jimeng)(?:$|[-_.0-9])/i

/**
 * Whether a model id is plausibly an image model.
 *
 * The relay rejects text models on the images endpoint ("images endpoint
 * requires an image model"), so filtering the catalog here turns a 400 into a
 * picker that only lists models that can work.
 *
 * @param id - the upstream model id.
 * @returns true when the id matches a known image-family convention.
 */
export function isImageModelId(id) {
  return IMAGE_MODEL_PATTERN.test(String(id).trim())
}

/**
 * Append an API path to a channel base URL.
 *
 * Operators paste every shape of base — with `/v1`, with a trailing slash, or
 * pointing straight at the endpoint — so the join is normalized rather than
 * concatenated.
 *
 * @param baseUrl - the channel's configured base.
 * @param path - the API path, beginning with a slash.
 * @returns the absolute request URL.
 */
export function joinEndpoint(baseUrl, path) {
  const base = String(baseUrl).trim().replace(/\/+$/, '')
  return `${base}${path}`
}

/** Turn an abort reason into the error the caller should see. */
function toUpstreamError(error, timeoutMs, signal) {
  if (signal?.aborted === true) return new UpstreamError('generation cancelled', 'cancelled')
  const name = error?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new UpstreamError(`upstream did not answer within ${Math.round(timeoutMs / 1000)}s`, 'timeout')
  }
  return new UpstreamError(`could not reach upstream: ${error?.message ?? String(error)}`, 'unreachable')
}

/** Combine the caller's cancellation with this request's own deadline. */
function budgeted(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Read a response body, refusing anything implausibly large. */
async function readJson(response) {
  const text = await response.text()
  if (text.length > MAX_JSON_BYTES) throw new UpstreamError('upstream response too large', 'invalid-response')
  try {
    return JSON.parse(text)
  } catch {
    throw new UpstreamError(
      `upstream returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
      'invalid-response',
      response.status,
    )
  }
}

/** The message a gateway put in its error envelope, whatever shape it used. */
function upstreamMessage(payload, status) {
  const error = payload?.error
  if (typeof error === 'string' && error.length > 0) return error
  if (error && typeof error.message === 'string' && error.message.length > 0) return error.message
  if (typeof payload?.message === 'string' && payload.message.length > 0) return payload.message
  return `upstream rejected the request (HTTP ${status})`
}

/** Headers for one upstream call. */
function authHeaders(channel, apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

/**
 * List the models a channel advertises.
 *
 * @param channel - the channel to probe.
 * @param options - the API key to use and the caller's cancellation.
 * @returns every advertised id plus the subset that looks like an image model.
 */
export async function fetchModels(channel, { apiKey, signal, timeoutMs = 60_000 }) {
  if (apiKey.length === 0) {
    throw new UpstreamError(`channel "${channel.name}" has no API key`, 'missing-key')
  }
  const url = joinEndpoint(channel.baseUrl, '/models')
  let response
  try {
    response = await fetch(url, { method: 'GET', headers: authHeaders(channel, apiKey), signal: budgeted(signal, timeoutMs) })
  } catch (error) {
    throw toUpstreamError(error, timeoutMs, signal)
  }
  const payload = await readJson(response)
  if (!response.ok) {
    throw new UpstreamError(upstreamMessage(payload, response.status), 'upstream-rejected', response.status)
  }
  const ids = (Array.isArray(payload?.data) ? payload.data : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
    .filter((id) => typeof id === 'string' && id.length > 0)
  return { models: ids, imageModels: ids.filter(isImageModelId) }
}

/** Extract base64 image bytes from any of the shapes gateways use. */
function inlineImage(item) {
  for (const key of ['b64_json', 'base64', 'image_base64', 'b64']) {
    const value = item?.[key]
    if (typeof value === 'string' && value.length > 0) {
      return Buffer.from(value.replace(/^data:[^,]*,/, ''), 'base64')
    }
  }
  const url = item?.url ?? item?.image_url
  if (typeof url === 'string' && url.startsWith('data:')) {
    const comma = url.indexOf(',')
    if (comma > 0) return Buffer.from(url.slice(comma + 1), 'base64')
  }
  return undefined
}

/** The remote result URL one item carries, when it carries one. */
function remoteUrl(item) {
  const url = item?.url ?? item?.image_url
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined
}

/**
 * Download one result URL.
 *
 * The API key rides along only when the URL shares the channel's origin: a
 * signed CDN link needs no credential, and sending one there would hand the
 * operator's key to a host they never configured.
 *
 * @param url - the result URL.
 * @param channel - the channel it came from.
 * @param apiKey - the channel's key.
 * @param signal - the caller's cancellation.
 * @returns the image bytes and the upstream's declared content type.
 */
async function download(url, channel, apiKey, signal, redirects = 3) {
  const target = new URL(url)
  const sameOrigin = (() => {
    try {
      return new URL(joinEndpoint(channel.baseUrl, '/')).origin === target.origin
    } catch {
      return false
    }
  })()
  const headers = sameOrigin ? { Authorization: `Bearer ${apiKey}` } : {}
  let response
  try {
    response = await fetch(target, { method: 'GET', headers, signal, redirect: 'follow' })
  } catch (error) {
    throw toUpstreamError(error, 120_000, signal)
  }
  if (!response.ok) {
    throw new UpstreamError(`could not download the generated image (HTTP ${response.status})`, 'download-failed', response.status)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_IMAGE_BYTES) throw new UpstreamError('generated image exceeds 32MB', 'image-too-large')
  if (buffer.length === 0) throw new UpstreamError('upstream returned an empty image', 'no-image')
  return { bytes: buffer, declared: response.headers.get('content-type') ?? '' }
}

/** One request body for the images endpoint. */
function generationBody(channel, request, responseFormat) {
  const body = {
    model: request.model,
    prompt: request.prompt,
    n: 1,
    response_format: responseFormat,
  }
  if (typeof request.size === 'string' && request.size.length > 0 && request.size !== 'auto') {
    body.size = request.size
  }
  return body
}

/** The response formats worth trying, in order, for one channel. */
function formatsFor(channel) {
  const configured = channel.responseFormat || DEFAULT_RESPONSE_FORMAT
  if (configured !== 'auto') return [configured]
  // "auto" probes the known-good shape first, then the wider-compatibility one.
  return ['url', 'b64_json']
}

/**
 * Issue one images request.
 *
 * @returns the payload plus the origin the result URLs came from.
 */
async function requestImages(channel, request, responseFormat, apiKey, signal, timeoutMs) {
  const url = joinEndpoint(channel.baseUrl, '/images/generations')
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(channel, apiKey),
      body: JSON.stringify(generationBody(channel, request, responseFormat)),
      signal: budgeted(signal, timeoutMs),
    })
  } catch (error) {
    throw toUpstreamError(error, timeoutMs, signal)
  }
  const payload = await readJson(response)
  if (!response.ok) {
    throw new UpstreamError(upstreamMessage(payload, response.status), 'upstream-rejected', response.status)
  }
  const data = Array.isArray(payload?.data) ? payload.data : undefined
  if (data === undefined) throw new UpstreamError('upstream response has no data array', 'invalid-response')
  if (data.length === 0) throw new UpstreamError('upstream returned no images', 'no-image')
  return { data, payload }
}

/**
 * Generate one image and return its bytes.
 *
 * `count` is satisfied by issuing several single-image requests rather than by
 * sending `n > 1`: gateways fronting the newer image APIs reject the batch
 * parameter outright, and parallel single requests keep one failed sibling from
 * discarding the images that did succeed.
 *
 * @param channel - the channel to call.
 * @param request - model, prompt, optional size and count.
 * @param options - the resolved API key, the caller's cancellation, and the deadline.
 * @returns the generated images plus any per-sibling failures worth reporting.
 */
export async function generateImages(channel, request, { apiKey, signal, timeoutMs = 300_000 }) {
  if (apiKey.length === 0) {
    throw new UpstreamError(
      `channel "${channel.name}" has no API key; add one in Settings → Image Studio`,
      'missing-key',
    )
  }
  const prompt = String(request.prompt ?? '').trim()
  if (prompt.length === 0) throw new UpstreamError('a prompt is required', 'empty-prompt')

  const count = Math.max(1, Math.min(4, Number(request.count) || 1))
  const formats = formatsFor(channel)
  /** Non-fatal notes: a sibling request that failed while others succeeded. */
  const notes = []
  const images = []

  const runOne = async () => {
    let lastError
    for (const [index, format] of formats.entries()) {
      try {
        const { data } = await requestImages(channel, { ...request, prompt }, format, apiKey, signal, timeoutMs)
        const item = data[0]
        const inline = inlineImage(item)
        if (inline !== undefined) return { bytes: inline, declared: classifyImage(inline).mime }
        const url = remoteUrl(item)
        if (url === undefined) {
          lastError = new UpstreamError('upstream returned neither a URL nor inline image data', 'no-image')
          continue
        }
        const downloaded = await download(url, channel, apiKey, signal)
        return downloaded
      } catch (error) {
        lastError = error
        // Only a shape mismatch is worth retrying in another format: a missing
        // credential, a cancellation or an exhausted rate limit fails the same
        // way twice and would just double the wait.
        const retryable = error instanceof UpstreamError
          && (error.code === 'upstream-rejected' || error.code === 'invalid-response' || error.code === 'no-image')
        if (!retryable || index === formats.length - 1) throw error
      }
    }
    throw lastError ?? new UpstreamError('upstream returned no image', 'no-image')
  }

  const settled = await Promise.allSettled(Array.from({ length: count }, runOne))
  for (const result of settled) {
    if (result.status === 'fulfilled') images.push(result.value)
    else notes.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
  }

  if (images.length === 0) {
    const first = settled.find((result) => result.status === 'rejected')
    throw first?.status === 'rejected' && first.reason instanceof UpstreamError
      ? first.reason
      : new UpstreamError(notes[0] ?? 'generation failed', 'no-image')
  }
  return { images, notes }
}
