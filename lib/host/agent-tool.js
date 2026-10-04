/**
 * The model-facing `generate_image` tool.
 *
 * This is what makes image generation reachable from the conversation: the
 * operator asks for a picture in the chat, the model decides to call this tool,
 * and the result comes back as image content blocks rendered beside the call.
 * Nothing here is reachable from the settings page — that path stays on the
 * plugin's own HTTP route.
 *
 * Two deliberate constraints:
 *
 * 1. **No harness imports.** `ctx.tools` and `ctx.attachments` are reached
 *    structurally, so this file compiles and runs against any harness whose
 *    services happen to be present. That is the same property the rest of the
 *    host half holds, and `test/compat.mjs` enforces it.
 * 2. **Both surfaces are optional.** A harness without a tools service simply
 *    never gets the tool; a harness without attachments still gets a working
 *    tool that returns the image URL as text. Neither absence may throw during
 *    load, because a throwing plugin entry can take the whole boot down.
 */

import { classifyImage, MAX_COUNT, resolveApiKey, saveImage } from './store.js'
import { generateImages } from './upstream.js'
import { ROUTE_PREFIX } from './routes.js'

/** The tool name the model sees. Stable: prompts and transcripts refer to it. */
export const TOOL_NAME = 'generate_image'

/** Media types the attachment path accepts (mirrors `ImageMediaType`). */
const ACCEPTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The provider/model-visible description of the tool. */
const DESCRIPTION = [
  'Generate one or more images from a text prompt using the image channels configured on this deployment.',
  'Use it whenever the user asks for a picture, illustration, photo, poster, icon or any other raster image.',
  'The generated images are attached to this tool call, so do not also describe them in text or invent a URL.',
  'Write the prompt yourself in concrete visual terms (subject, composition, lighting, style); do not just repeat the user\'s words.',
  'If the call fails, report the error verbatim: the message comes from the upstream gateway and usually names the real cause.',
].join(' ')

/** The canonical value one call returns; its shape is declared to the registry. */
function outputSchema() {
  return {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            attachmentId: { type: 'string' },
            mediaType: { type: 'string' },
            bytes: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            name: { type: 'string' },
          },
          required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
          additionalProperties: false,
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
      urls: { type: 'array', items: { type: 'string' } },
      model: { type: 'string' },
      channel: { type: 'string' },
    },
    required: ['images', 'notes', 'urls', 'model', 'channel'],
    additionalProperties: false,
  }
}

/** The arguments the model may send. */
function parameters() {
  return {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'A concrete visual description of the image to generate. Write it in full; do not pass the user\'s sentence through unchanged.',
      },
      model: {
        type: 'string',
        description: 'Optional image model id. Omit to use the configured default for the channel.',
      },
      size: {
        type: 'string',
        description: 'Optional pixel size such as 1024x1024, 1024x1536 or 1536x1024. Omit to use the configured default.',
      },
      count: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_COUNT,
        description: `Optional number of images, 1 to ${MAX_COUNT}. Defaults to the configured value.`,
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  }
}

/** Find the channel a call should use, or explain why it cannot. */
function selectChannel(config) {
  if (config.enabled !== true) {
    throw new Error('image generation is turned off; enable it in Settings → Image generation')
  }
  if (config.channels.length === 0) {
    throw new Error('no image channel is configured; add one in Settings → Image generation')
  }
  return config.channels.find((entry) => entry.id === config.defaultChannelId) ?? config.channels[0]
}

/**
 * Build the tool definition over the live plugin service.
 *
 * @param service - the plugin's config accessor, data directory and logger.
 * @param attachments - the attachment store when the deployment has one.
 * @returns a `ToolDefinition` for `ctx.tools.register`.
 */
export function buildAgentTool(service, attachments) {
  const log = service.log

  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: parameters(),
    output: {
      schema: outputSchema(),
      /**
       * Project one successful call into model-visible content.
       *
       * Image blocks are the point: the harness renders them beside the call,
       * and a text-only model receives a placeholder instead (the LLM layer
       * substitutes it), so this is safe on every route.
       */
      render(args, value) {
        const blocks = (value?.images ?? []).map((image) => ({ type: 'image', attachment: image }))
        const urls = value?.urls ?? []
        const lines = []
        if (blocks.length > 0) {
          lines.push(`Generated ${blocks.length} image${blocks.length === 1 ? '' : 's'} with ${value.model} on channel "${value.channel}".`)
        } else if (urls.length > 0) {
          lines.push(`${urls.length} image${urls.length === 1 ? '' : 's'} generated with ${value.model} on channel "${value.channel}", stored on the host:`)
        } else {
          lines.push('No image was produced.')
        }
        // The URL list is empty on the normal path; it is populated only when
        // the deployment has no attachment store, where text is all there is.
        for (const url of urls) lines.push(url)
        for (const note of value?.notes ?? []) lines.push(`note: ${note}`)
        blocks.push({ type: 'text', text: lines.join('\n') })
        return blocks
      },
    },

    /**
     * Run one call.
     *
     * @param rawArgs - the model's frozen arguments.
     * @param exec - execution identity and the cancellation signal to forward.
     * @returns the canonical value declared by `output.schema`.
     */
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {}
      const prompt = String(args.prompt ?? '').trim()
      if (prompt.length === 0) throw new Error('a prompt is required')

      const config = service.getConfig()
      const channel = selectChannel(config)
      const model = String(args.model ?? '').trim()
        || config.preferences.defaultModel
        || channel.models[0]
        || ''
      if (model.length === 0) {
        throw new Error(`channel "${channel.name}" lists no models; add one in Settings → Image generation`)
      }

      const result = await generateImages(channel, {
        model,
        prompt,
        size: typeof args.size === 'string' && args.size.length > 0 ? args.size : config.preferences.size,
        count: Math.max(1, Math.min(MAX_COUNT, Number(args.count) || config.preferences.count || 1)),
      }, {
        apiKey: resolveApiKey(channel),
        timeoutMs: config.preferences.timeoutMs,
        signal: exec?.signal,
      })

      // Without an attachment store there is nowhere to put the bytes that the
      // conversation can render, so the images are stored on disk and the model
      // is handed a URL it can relay. Degraded, but honest and usable.
      if (attachments === undefined || typeof attachments.saveImages !== 'function') {
        log.warn('[dsh-image-studio] no attachment service; returning image URLs instead of image blocks')
        return {
          images: [],
          urls: result.images.map((image) => {
            const saved = saveImage(service.root, image.bytes, image.declared)
            return `${ROUTE_PREFIX}/image/${encodeURIComponent(saved.name)}`
          }),
          notes: result.notes,
          model,
          channel: channel.name,
        }
      }

      const inputs = result.images.map((image, index) => {
        const { mime } = classifyImage(image.bytes, image.declared)
        if (!ACCEPTED_MEDIA_TYPES.has(mime)) {
          throw new Error(`the upstream returned ${mime || 'an unknown format'}, which this harness cannot attach`)
        }
        return { data: image.bytes, mediaType: mime, name: `${channel.name}-${Date.now()}-${index + 1}.${mime.split('/')[1]}` }
      })

      const refs = await attachments.saveImages(inputs)
      return {
        images: refs.map((ref) => ({
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
        })),
        urls: [],
        notes: result.notes,
        model,
        channel: channel.name,
      }
    },
  }
}

/**
 * Register the tool on a context that owns a tools service.
 *
 * @param ctx - the host plugin context.
 * @param service - the live plugin service (`getConfig`, `saveImage`, `root`, `log`).
 * @returns a disposer, or undefined when this deployment has no tools service.
 */
export function registerAgentTool(ctx, service) {
  const install = (scoped) => {
    const tools = scoped.get !== undefined ? scoped.get('tools') : scoped.tools
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      service.log.info('[dsh-image-studio] no tools service in this deployment; skipping the image tool')
      return
    }
    const attachments = scoped.get !== undefined ? scoped.get('attachments') : scoped.attachments
    const definition = buildAgentTool(service, attachments)
    scoped.effect(() => tools.register(definition), 'dsh-image-studio: generate_image tool')
    service.log.info(`[dsh-image-studio] registered the ${TOOL_NAME} tool`)
  }

  if (typeof ctx.inject !== 'function') {
    service.log.warn('[dsh-image-studio] context has no inject(); the image tool was not registered')
    return undefined
  }
  ctx.inject(['tools'], install)
  return undefined
}
