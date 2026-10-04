/**
 * Persistent configuration and image storage for dsh-image-studio.
 *
 * Everything the plugin owns lives under a single directory, so removing the
 * plugin is one delete and no user-authored file is ever rewritten in place:
 *
 *   <DSH_HOME>/dsh-image-studio/
 *     config.json   0600 — the channels and preferences the settings page edits
 *     images/       generated PNG/JPEG/WebP, served back by the host
 *
 * The store stays deliberately dumb: it reads and writes JSON and reports the
 * shape it found. All repair lives in `normalizeConfig`, so a hand-edited file
 * with a missing field still boots instead of throwing inside a cordis loader
 * (a throw there takes the whole GUI down, not just this plugin).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Schema version of `config.json`; bumped only for breaking shape changes. */
export const CONFIG_VERSION = 1

/** Largest accepted `count` for one request, mirroring what the panel offers. */
export const MAX_COUNT = 4

/** The upstream's own default when a channel names no response format. */
export const DEFAULT_RESPONSE_FORMAT = 'url'

/** Directory holding every file this plugin owns. */
export function resolveRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-image-studio')
}

/** Directory holding generated images. */
export function resolveImagesDir(root = resolveRoot()) {
  return join(root, 'images')
}

/**
 * Directory holding throwaway previews.
 *
 * Previews deliberately live in the OS temporary area rather than under the
 * plugin's own data directory: an image the operator generated once to check a
 * channel is scratch, and scratch must not accumulate inside the user's home.
 * The OS owns cleanup of that tree on its own schedule; this plugin additionally
 * keeps at most one preview generation alive at a time.
 */
export function resolvePreviewDir() {
  return join(tmpdir(), 'dsh-image-studio-preview')
}

/** Delete every preview image. Called on mount, before each preview, and on dispose. */
export function prunePreviews() {
  rmSync(resolvePreviewDir(), { recursive: true, force: true })
}

/** Absolute path of the configuration file. */
export function resolveConfigPath(root = resolveRoot()) {
  return join(root, 'config.json')
}

/** A configuration with no channels, before the user adds one. */
export function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    defaultChannelId: '',
    channels: [],
    preferences: {
      defaultModel: '',
      size: '1024x1024',
      count: 1,
      // 300s was too tight for the relay this was measured against, where a
      // normal generation took 148–414s. A deadline that cuts off successful
      // work is worse than a slow failure, so the default is generous and the
      // value is reported back on every timeout.
      timeoutMs: 600_000,
      allowRemote: false,
      // Where generated files land. Empty means the plugin's own images
      // directory; a path here is what makes the output addressable by other
      // tools instead of living only inside the attachment store.
      outputDir: '',
    },
  }
}

/** A fresh channel with every field present, so the editor renders empty inputs. */
export function emptyChannel() {
  return {
    id: randomUUID(),
    name: '',
    baseUrl: '',
    apiKey: '',
    apiKeyEnv: '',
    models: [],
    responseFormat: DEFAULT_RESPONSE_FORMAT,
  }
}

/** Coerce one unknown value into a string, defaulting when absent. */
function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Coerce one unknown value into a positive integer, defaulting when absurd. */
function int(value, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(str(value), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Repair arbitrary parsed JSON into a usable configuration.
 *
 * A hand-edited or older file must never crash the host: every field is
 * re-derived, unknown fields are dropped, and channels without an id or a base
 * URL are discarded rather than kept in a half-usable state.
 *
 * @param raw - the parsed file contents, or anything else.
 * @returns a configuration that satisfies every invariant the rest of the code assumes.
 */
export function normalizeConfig(raw) {
  const base = emptyConfig()
  if (raw === null || typeof raw !== 'object') return base
  const input = /** @type {Record<string, unknown>} */ (raw)

  const seen = new Set()
  const channels = (Array.isArray(input.channels) ? input.channels : [])
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => {
      const channel = /** @type {Record<string, unknown>} */ (entry)
      return {
        id: str(channel.id) || randomUUID(),
        name: str(channel.name).trim(),
        baseUrl: str(channel.baseUrl).trim().replace(/\/+$/, ''),
        apiKey: str(channel.apiKey),
        apiKeyEnv: str(channel.apiKeyEnv).trim(),
        models: (Array.isArray(channel.models) ? channel.models : [])
          .map((model) => (typeof model === 'string' ? model.trim() : ''))
          .filter((model) => model.length > 0),
        responseFormat: str(channel.responseFormat, DEFAULT_RESPONSE_FORMAT) || DEFAULT_RESPONSE_FORMAT,
      }
    })
    .filter((channel) => {
      if (channel.baseUrl.length === 0 || seen.has(channel.id)) return false
      seen.add(channel.id)
      return true
    })

  const preferences = (input.preferences !== null && typeof input.preferences === 'object'
    ? /** @type {Record<string, unknown>} */ (input.preferences)
    : {})

  const defaultChannelId = str(input.defaultChannelId)
  return {
    version: CONFIG_VERSION,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    // A default that names a channel which no longer exists is worse than none:
    // the panel would select a channel that cannot resolve a credential.
    defaultChannelId: channels.some((channel) => channel.id === defaultChannelId)
      ? defaultChannelId
      : (channels[0]?.id ?? ''),
    channels,
    preferences: {
      defaultModel: str(preferences.defaultModel),
      size: str(preferences.size, base.preferences.size) || base.preferences.size,
      count: Math.min(MAX_COUNT, int(preferences.count, base.preferences.count)),
      timeoutMs: Math.max(30_000, int(preferences.timeoutMs, base.preferences.timeoutMs)),
      // Secure by default: opening the plugin's HTTP surface to non-loopback
      // callers is a deliberate act, never something a repaired config infers.
      allowRemote: preferences.allowRemote === true,
      outputDir: str(preferences.outputDir).trim(),
    },
  }
}

/**
 * Read the configuration, repairing whatever is on disk.
 *
 * An unreadable or corrupt file is reported and replaced in memory by an empty
 * configuration; the next write repairs the file itself. Booting with no
 * channels is recoverable through the settings page, a thrown loader is not.
 *
 * @param root - the plugin data directory.
 * @param onWarn - sink for the "could not read" case.
 * @returns the live configuration.
 */
export function readConfig(root = resolveRoot(), onWarn = () => {}) {
  const path = resolveConfigPath(root)
  if (!existsSync(path)) return emptyConfig()
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    onWarn(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return emptyConfig()
  }
}

/**
 * Replace the configuration file atomically.
 *
 * The temporary file is written beside the target and renamed over it, so a
 * crash mid-write can never leave a truncated config behind. Mode 0600 keeps
 * the stored API keys out of other users' reach on a shared machine.
 *
 * @param config - the configuration to persist (normalized first).
 * @param root - the plugin data directory.
 * @returns the normalized configuration that was written.
 */
export function writeConfig(config, root = resolveRoot()) {
  const normalized = normalizeConfig(config)
  mkdirSync(root, { recursive: true })
  const path = resolveConfigPath(root)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows has no POSIX mode bits; the write above is still the only writer.
  }
  return normalized
}

/** Delete the whole plugin data directory. */
export function removeRoot(root = resolveRoot()) {
  rmSync(root, { recursive: true, force: true })
}

/**
 * The credential one channel authenticates with.
 *
 * `apiKeyEnv` is checked first so a deployment can keep the literal out of the
 * file entirely; a stored literal is the fallback the settings page writes.
 *
 * @param channel - the channel to resolve.
 * @param env - the environment to read (injected for tests).
 * @returns the key, or an empty string when the channel has none.
 */
export function resolveApiKey(channel, env = process.env) {
  if (channel.apiKeyEnv.length > 0) {
    const fromEnv = env[channel.apiKeyEnv]
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  }
  return channel.apiKey
}

/**
 * The render-safe projection of the configuration.
 *
 * Literal keys never cross the wire — not even to the loopback settings page —
 * so the browser learns only whether a channel can authenticate, and writes a
 * new key by sending a replacement. This mirrors how the harness treats every
 * other credential surface.
 *
 * @param config - the configuration to project.
 * @param env - the environment used to answer "is a key available".
 * @returns the configuration with every secret replaced by presence flags.
 */
export function publicConfig(config, env = process.env) {
  return {
    version: config.version,
    enabled: config.enabled,
    defaultChannelId: config.defaultChannelId,
    channels: config.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      baseUrl: channel.baseUrl,
      apiKeyEnv: channel.apiKeyEnv,
      models: [...channel.models],
      responseFormat: channel.responseFormat,
      hasKey: resolveApiKey(channel, env).length > 0,
      hasStoredKey: channel.apiKey.length > 0,
    })),
    preferences: { ...config.preferences },
  }
}

/** Image container formats this plugin stores and serves back. */
const IMAGE_TYPES = [
  { mime: 'image/png', ext: 'png', magic: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', magic: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/gif', ext: 'gif', magic: (b) => b.length > 4 && b.toString('ascii', 0, 3) === 'GIF' },
]

/**
 * Classify image bytes by magic number.
 *
 * The upstream's `content-type` is not trusted: a gateway that labels a PNG as
 * `application/octet-stream` must still produce a file the browser renders.
 *
 * @param bytes - the downloaded payload.
 * @param declared - the upstream's declared content type, used as a last resort.
 * @returns the container's mime type and extension.
 */
export function classifyImage(bytes, declared = '') {
  for (const type of IMAGE_TYPES) {
    if (type.magic(bytes)) return { mime: type.mime, ext: type.ext }
  }
  const normalized = declared.split(';')[0].trim().toLowerCase()
  const known = IMAGE_TYPES.find((type) => type.mime === normalized)
  if (known) return { mime: known.mime, ext: known.ext }
  return { mime: 'application/octet-stream', ext: 'bin' }
}

/** Pixel dimensions of a PNG, JPEG, WebP or GIF payload, when the header carries them. */
export function imageSize(bytes, mime) {
  try {
    if (mime === 'image/png') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    if (mime === 'image/jpeg') {
      let i = 2
      while (i < bytes.length - 9) {
        if (bytes[i] !== 0xff) { i += 1; continue }
        const marker = bytes[i + 1]
        const length = bytes.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
        }
        i += 2 + length
      }
    }
    if (mime === 'image/webp' && bytes.toString('ascii', 12, 16) === 'VP8X') {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { width, height }
    }
    if (mime === 'image/gif') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  } catch {
    // A truncated header is not worth failing a generation over.
  }
  return {}
}

/** A filename-safe stamp for one generated image. */
function imageName(ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${randomUUID().slice(0, 8)}.${ext}`
}

/**
 * The directory a generated file should be written to.
 *
 * An absolute `preferences.outputDir` wins, which is what lets a deployment put
 * generated images somewhere another tool can pick them up — a session
 * workspace, a shared folder, a project's assets directory. Empty means the
 * plugin's own images directory.
 *
 * @param root - the plugin data directory.
 * @param preferences - the live preferences block.
 * @returns the absolute directory to write into.
 */
export function resolveOutputDir(root, preferences) {
  const configured = typeof preferences?.outputDir === 'string' ? preferences.outputDir.trim() : ''
  if (configured.length === 0) return resolveImagesDir(root)
  // A relative path is resolved against the plugin directory rather than the
  // host's working directory, which means nothing to the person typing it.
  return isAbsolute(configured) ? configured : join(root, configured)
}

/**
 * Persist one generated image and describe the stored file.
 *
 * @param root - the plugin data directory.
 * @param bytes - the image payload.
 * @param declared - the upstream's declared content type.
 * @param options - `temporary` routes the file to the preview area instead of
 *   the plugin's own images directory, and drops the previous preview first;
 *   `dir` overrides the destination; `name` overrides the generated file name.
 * @returns the stored file's name, absolute path, mime type, byte length and
 *   pixel size.
 */
export function saveImage(root, bytes, declared = '', options = {}) {
  const temporary = options.temporary === true
  const dir = temporary
    ? resolvePreviewDir()
    : (typeof options.dir === 'string' && options.dir.length > 0 ? options.dir : resolveImagesDir(root))
  // One preview generation at a time: replacing rather than appending is what
  // keeps repeated "try it" clicks from filling a directory at all.
  if (temporary) prunePreviews()
  mkdirSync(dir, { recursive: true })
  const { mime, ext } = classifyImage(bytes, declared)
  const name = typeof options.name === 'string' && options.name.length > 0 ? options.name : imageName(ext)
  const path = join(dir, name)
  writeFileSync(path, bytes)
  // The absolute path is the point: it is what lets a caller hand the file to
  // another tool, instead of only being able to show it.
  return { name, path, dir, mime, bytes: bytes.length, temporary, ...imageSize(bytes, mime) }
}

/**
 * Resolve a stored image's absolute path, refusing anything that escapes the
 * images directory.
 *
 * The name arrives from an HTTP path, so it is untrusted: traversal, absolute
 * paths and Windows drive letters are all rejected rather than normalized.
 *
 * @param root - the plugin data directory.
 * @param name - the requested file name.
 * @param extraDirs - additional directories to search, such as a configured output directory.
 * @returns the absolute path, or undefined when the name is not a plain file in one of those directories.
 */
export function resolveImagePath(root, name, extraDirs = []) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return undefined
  if (name.includes(':')) return undefined
  // Kept images, the preview area, and a configured output directory form one
  // flat name space, so the serving route needs no notion of which is which.
  for (const dir of [resolveImagesDir(root), resolvePreviewDir(), ...extraDirs]) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return undefined
}
