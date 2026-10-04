/**
 * dsh-image-studio — host half.
 *
 * Owns four things and nothing else:
 *
 *   1. the configuration file and the generated-image directory (store.js),
 *   2. the upstream OpenAI-compatible image client (upstream.js),
 *   3. one loopback HTTP surface the browser half talks to (routes.js),
 *   4. the model-facing `generate_image` tool (agent-tool.js), which is what
 *      lets the conversation generate images at all.
 *
 * The browser half owns all presentation. Nothing here imports a client
 * package, and the client half imports nothing from here beyond the route
 * prefix, so the two halves stay independently loadable — which is what keeps
 * this plugin working across harness versions whose settings APIs differ.
 *
 * Version posture: this host half touches only the cordis core (`ctx.effect`,
 * `ctx.inject`, `ctx.logger`) plus `ctx.webServer`, `ctx.tools` and
 * `ctx.attachments` — and the last two are reached structurally, never by
 * import, so a deployment missing either degrades instead of throwing. It
 * deliberately does NOT use `ctx.settings` / `installSettingsSection` /
 * `settingsNamespace`, whose shape changed across those releases; configuration
 * lives in this plugin's own file instead, edited through the plugin's own page.
 */

import { normalizeConfig, prunePreviews, readConfig, resolveRoot, writeConfig } from './host/store.js'
import { registerRoutes } from './host/routes.js'
import { registerAgentTool } from './host/agent-tool.js'

/** Cordis service this plugin needs before it can mount. */
export const inject = ['webServer']

/** The harness logger, falling back to the console outside a cordis runtime. */
function loggerOf(ctx) {
  const logger = ctx?.logger
  if (logger !== undefined && logger !== null && typeof logger.warn === 'function') return logger
  return {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  }
}

/**
 * Seed the configuration file from the loader's own config, once.
 *
 * A deployment can therefore ship channels in `cordis.yml` and have the
 * settings page open on a working configuration, while every later edit is
 * owned by the file. Seeding only when the file has no channels keeps a YAML
 * row from silently reverting whatever the operator changed in the UI.
 *
 * @param root - the plugin data directory.
 * @param config - the loader row's config object.
 * @param log - the harness logger.
 * @returns the configuration the plugin will serve.
 */
function bootstrap(root, config, log) {
  const stored = readConfig(root, (message) => log.warn(`[dsh-image-studio] ${message}`))
  const seeded = Array.isArray(config?.channels) ? config.channels : []
  if (stored.channels.length > 0 || seeded.length === 0) {
    if (typeof config?.enabled === 'boolean' && config.enabled !== stored.enabled) {
      return writeConfig({ ...stored, enabled: config.enabled }, root)
    }
    return stored
  }
  log.info(`[dsh-image-studio] seeding ${seeded.length} channel(s) from the loader config`)
  return writeConfig(normalizeConfig({
    ...stored,
    enabled: typeof config?.enabled === 'boolean' ? config.enabled : stored.enabled,
    defaultChannelId: typeof config?.defaultChannelId === 'string' ? config.defaultChannelId : '',
    channels: seeded,
  }), root)
}

/**
 * Mount the plugin.
 *
 * @param ctx - the host plugin context.
 * @param config - the loader row's config (`enabled`, and optional bootstrap `channels`).
 */
export function apply(ctx, config = {}) {
  const root = resolveRoot()
  const log = loggerOf(ctx)

  // The live configuration is cached in memory and rewritten through one
  // accessor: the settings page saves the whole document at once, so a
  // read-modify-write race would otherwise let two tabs clobber each other.
  let current = bootstrap(root, config, log)

  const service = {
    root,
    log,
    getConfig: () => current,
    setConfig: (next) => {
      current = writeConfig(next, root)
      return current
    },
    // Resolved lazily: the attachment service may not be up when this plugin
    // applies, and a deployment without one must still serve its settings page.
    getAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
  }

  // Preview images are scratch: nothing from a previous run may survive a
  // restart, and nothing survives this one either.
  prunePreviews()

  ctx.effect(
    () => {
      const disposeRoutes = registerRoutes(ctx, service)
      return () => {
        disposeRoutes()
        prunePreviews()
      }
    },
    'dsh-image-studio: routes',
  )

  // The model-facing tool is what makes image generation reachable from the
  // conversation; it registers only when this deployment owns a tools service.
  registerAgentTool(ctx, service)

  log.info(`[dsh-image-studio] mounted (${current.channels.length} channel(s), data at ${root})`)
}

/** Exported for the plugin's own tests; not part of the mounted contract. */
export { normalizeConfig, publicConfig } from './host/store.js'
export { ROUTE_PREFIX } from './host/routes.js'
