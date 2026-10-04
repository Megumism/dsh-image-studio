/**
 * The plugin's loopback HTTP surface.
 *
 * Every route lives under one prefix so a single registration owns the whole
 * surface and one disposer removes it:
 *
 *   POST /api/dsh-image-studio/config/get      read the redacted configuration
 *   POST /api/dsh-image-studio/config/set      replace it
 *   POST /api/dsh-image-studio/channel/models  probe one channel's /models
 *   POST /api/dsh-image-studio/generate        generate, download and store
 *   GET  /api/dsh-image-studio/image/<name>    serve a stored image
 *   GET  /api/dsh-image-studio/health          liveness, for the panel's banner
 *
 * Access policy: the whole surface is refused to non-loopback callers unless
 * the operator turns on `preferences.allowRemote`. The page is reached over the
 * same origin as the GUI, so on a desktop (or an on-device app pointed at
 * 127.0.0.1) nothing needs configuring; opening the harness to a LAN is a
 * deliberate act, and this flag makes it one.
 */

import { createReadStream } from 'node:fs'
import { resolveImagePath, saveImage, resolveApiKey, publicConfig, normalizeConfig, MAX_COUNT } from './store.js'
import { UpstreamError, fetchModels, generateImages } from './upstream.js'

/** The single prefix every route below hangs off. */
export const ROUTE_PREFIX = '/api/dsh-image-studio'

/** Largest JSON request body accepted. */
const MAX_BODY_BYTES = 1_000_000

/** Media types an image reference may declare (the attachment vocabulary). */
const ACCEPTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Addresses that count as loopback in a node HTTP socket. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Whether a socket address is loopback. */
function isLoopback(address) {
  return typeof address === 'string' && LOOPBACK.has(address)
}

/** Send a JSON response. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Read and decode a JSON request body, refusing oversized input. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** Find a configured channel, or explain why it is missing. */
function requireChannel(config, channelId) {
  const id = typeof channelId === 'string' && channelId.length > 0 ? channelId : config.defaultChannelId
  const channel = config.channels.find((entry) => entry.id === id)
  if (channel === undefined) throw new Error('no channel is configured; add one in Settings → Image Studio')
  return channel
}

/**
 * Carry a stored credential onto an incoming channel that brought none.
 *
 * The page only ever RECEIVES channels with the literal key redacted, so every
 * save and every probe sends back a channel whose `apiKey` is empty even though
 * the operator has one configured. Both paths must therefore resolve the key
 * from what is on disk, or "Test connection" reports a missing key for a
 * channel that plainly has one.
 *
 * Matching by id is the normal path — the page never rewrites an id. The
 * endpoint+name fallback covers a configuration edited outside the page:
 * silently losing a credential because a channel was renamed is far worse than
 * carrying it to the same endpoint under a new id.
 *
 * @param channel - the incoming channel, mutated in place when a key is found.
 * @param previous - the configuration currently on disk.
 * @returns the same channel, for chaining.
 */
function carryStoredKey(channel, previous) {
  if (channel === undefined || channel.apiKey.length > 0) return channel
  const existing = previous.channels.find((entry) => entry.id === channel.id)
    ?? previous.channels.find((entry) => entry.baseUrl === channel.baseUrl && entry.name === channel.name)
  if (existing !== undefined) channel.apiKey = existing.apiKey
  return channel
}

/**
 * Register the route family.
 *
 * @param ctx - the host plugin context, providing `webServer`.
 * @param service - the live configuration accessor and the data directory.
 * @param service.getConfig - reads the current configuration.
 * @param service.setConfig - persists and returns a normalized configuration.
 * @param service.root - the plugin data directory.
 * @param service.log - the harness logger for non-fatal notes.
 * @returns a disposer removing every route this call registered.
 */
export function registerRoutes(ctx, service) {
  const refuseRemote = (req) => {
    if (isLoopback(req.socket?.remoteAddress)) return false
    if (service.getConfig().preferences.allowRemote === true) return false
    return true
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

    if (refuseRemote(req)) {
      sendJson(res, 403, {
        ok: false,
        code: 'remote-refused',
        message: 'this surface is loopback-only; enable "Allow remote access" in Settings → Image Studio to open it to the network',
      })
      return
    }

    try {
      // ---- liveness -------------------------------------------------------
      if (route === '/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, value: { root: service.root } })
        return
      }

      // ---- read the configuration ----------------------------------------
      if (route === '/config/get' && req.method === 'POST') {
        const config = service.getConfig()
        sendJson(res, 200, {
          ok: true,
          value: {
            config: {
              ...publicConfig(config),
              preferences: { ...config.preferences, allowRemote: config.preferences.allowRemote === true },
            },
            writable: true,
            root: service.root,
          },
        })
        return
      }

      // ---- replace the configuration -------------------------------------
      if (route === '/config/set' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const incoming = normalizeConfig(body.config)
        // A round-trip through the page cannot carry the stored literal keys, so
        // an incoming channel that reports a key but sends none keeps the one
        // already on disk. This is what makes editing an unrelated field safe.
        const previous = service.getConfig()
        for (const channel of incoming.channels) carryStoredKey(channel, previous)
        const saved = service.setConfig({ ...incoming, preferences: { ...incoming.preferences, allowRemote: body.config?.preferences?.allowRemote === true } })
        sendJson(res, 200, { ok: true, value: { config: publicConfig(saved) } })
        return
      }

      // ---- probe one channel ---------------------------------------------
      if (route === '/channel/models' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const config = service.getConfig()
        // A draft channel that has never been saved is still probeable: the
        // operator should be able to test an endpoint before committing to it.
        // A draft that carries no key inherits the stored one, because the page
        // cannot send a literal it was never given.
        //
        // `normalizeConfig` DROPS a channel with no base URL, so an empty draft
        // normalizes to undefined rather than to an empty channel — that is the
        // "not filled in yet" case, not a crash.
        const draft = body.channel
        const normalized = draft !== undefined && draft !== null && typeof draft === 'object'
          ? normalizeConfig({ channels: [draft] }).channels[0]
          : undefined
        const channel = normalized !== undefined
          ? carryStoredKey(normalized, config)
          : requireChannel(config, body.channelId)
        if (channel === undefined) throw new Error('the channel has no API URL yet')
        const apiKey = resolveApiKey(channel)
        const result = await fetchModels(channel, { apiKey, timeoutMs: 60_000 })
        sendJson(res, 200, { ok: true, value: result })
        return
      }

      // ---- generate -------------------------------------------------------
      if (route === '/generate' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const config = service.getConfig()
        if (config.enabled !== true) throw new Error('image generation is turned off in Settings → Image Studio')
        const channel = requireChannel(config, body.channelId)
        const prompt = String(body.prompt ?? '').trim()
        if (prompt.length === 0) throw new Error('enter a prompt')

        // A browser that navigates away abandons the request; cancelling the
        // upstream call keeps the operator from paying for an image nobody sees.
        const controller = new AbortController()
        req.on('close', () => controller.abort())

        const result = await generateImages(channel, {
          model: String(body.model ?? '').trim() || config.preferences.defaultModel || channel.models[0] || '',
          prompt,
          size: typeof body.size === 'string' ? body.size : config.preferences.size,
          count: Math.max(1, Math.min(MAX_COUNT, Number(body.count) || config.preferences.count || 1)),
        }, {
          apiKey: resolveApiKey(channel),
          timeoutMs: config.preferences.timeoutMs,
          signal: controller.signal,
        })

        // `temporary` is the settings page's "try it": scratch output that must
        // not accumulate in the operator's home. Everything else is kept.
        const temporary = body.temporary === true
        const stored = result.images.map((image) => {
          const saved = saveImage(service.root, image.bytes, image.declared, { temporary })
          return { ...saved, url: `${ROUTE_PREFIX}/image/${encodeURIComponent(saved.name)}` }
        })
        sendJson(res, 200, { ok: true, value: { images: stored, notes: result.notes, channelId: channel.id, temporary } })
        return
      }

      // ---- serve a stored image ------------------------------------------
      if (route.startsWith('/image/') && req.method === 'GET') {
        const name = decodeURIComponent(route.slice('/image/'.length))
        const path = resolveImagePath(service.root, name)
        if (path === undefined) {
          sendJson(res, 404, { ok: false, code: 'not-found', message: 'no such image' })
          return
        }
        res.writeHead(200, {
          'Content-Type': name.endsWith('.png') ? 'image/png'
            : name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg'
              : name.endsWith('.webp') ? 'image/webp'
                : name.endsWith('.gif') ? 'image/gif' : 'application/octet-stream',
          // Names are content-addressed by time and randomness, so a stored file
          // never changes: caching it is safe and keeps the gallery instant.
          'Cache-Control': 'private, max-age=31536000, immutable',
        })
        createReadStream(path).pipe(res)
        return
      }

      // ---- serve a durable attachment by reference ------------------------
      // Tool-result images deliberately do not appear in model-visible session
      // content, so the browser's own session-authorized loader refuses them.
      // The plugin therefore reads back the attachment it created, after
      // rebuilding the complete reference from the query and letting the
      // attachment store verify the digest.
      if (route === '/attachment' && req.method === 'GET') {
        const attachments = service.getAttachments()
        if (attachments === undefined || typeof attachments.readImage !== 'function') {
          sendJson(res, 503, { ok: false, code: 'no-attachments', message: 'this deployment has no attachment store' })
          return
        }
        const ref = {
          attachmentId: url.searchParams.get('attachment_id') ?? '',
          mediaType: url.searchParams.get('media_type') ?? '',
          bytes: Number(url.searchParams.get('bytes') ?? 0),
          width: Number(url.searchParams.get('width') ?? 0),
          height: Number(url.searchParams.get('height') ?? 0),
        }
        if (ref.attachmentId.length === 0 || !ACCEPTED_MEDIA_TYPES.has(ref.mediaType)) {
          sendJson(res, 400, { ok: false, code: 'bad-reference', message: 'incomplete image reference' })
          return
        }
        const stored = await attachments.readImage(ref)
        const body = Buffer.from(stored.data)
        res.writeHead(200, {
          'Content-Type': ref.mediaType,
          'Content-Length': body.length,
          // The reference is content-addressed by digest, so the bytes for one
          // id never change.
          'Cache-Control': 'private, max-age=31536000, immutable',
        })
        res.end(body)
        return
      }

      sendJson(res, 404, { ok: false, code: 'not-found', message: `unknown route ${route}` })
    } catch (error) {
      const upstream = error instanceof UpstreamError
      const status = upstream && error.code === 'cancelled' ? 499
        : upstream && error.code === 'missing-key' ? 400
          : upstream && error.status >= 400 && error.status < 500 ? 502
            : 500
      if (!upstream || error.code !== 'cancelled') {
        service.log.warn(`[dsh-image-studio] ${route}: ${error instanceof Error ? error.message : String(error)}`)
      }
      sendJson(res, status, {
        ok: false,
        code: upstream ? error.code : 'internal',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
