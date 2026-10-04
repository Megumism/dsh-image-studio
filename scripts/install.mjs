/**
 * Install (or uninstall) dsh-image-studio into a DSH profile.
 *
 * The install is two steps and both are reversible:
 *
 *   1. link the package into the profile's `node_modules` so the loader can
 *      resolve `dsh-image-studio` by name (a directory junction on Windows,
 *      so edits in this checkout are live and nothing is duplicated), and
 *   2. append one loader row to the profile's `cordis.patch.yml`.
 *
 * The patch file is the operator's own file — it holds hand-written comments
 * and other plugins' configuration — so it is edited TEXTUALLY (append, or
 * delete the marked block on uninstall) and backed up first. Re-serializing it
 * through a YAML parser would silently discard every comment in it.
 *
 * Usage:
 *   node scripts/install.mjs             install into the active profile
 *   node scripts/install.mjs --uninstall remove it again
 *   node scripts/install.mjs --copy      copy files instead of linking
 *   node scripts/install.mjs --profile <dir>
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loader row id; also the settings namespace shown in the GUI. */
const ENTRY_ID = 'image-studio'
/** Package name the loader resolves. */
const PACKAGE = 'dsh-image-studio'
/** Marks the block this script owns, so uninstall removes exactly that. */
const MARKER = '# >>> dsh-image-studio (managed by scripts/install.mjs) >>>'
const MARKER_END = '# <<< dsh-image-studio <<<'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const uninstall = flag('--uninstall')
const useCopy = flag('--copy')

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const profileDir = resolve(valueOf('--profile') ?? process.env.DSH_PROFILE_DIR ?? join(home, 'profiles', process.env.DSH_PROFILE ?? 'web'))

const nodeModules = join(profileDir, 'node_modules')
const target = join(nodeModules, PACKAGE)
const patchPath = join(profileDir, 'cordis.patch.yml')

/** Refuse to touch a path that is not the plugin's own slot in this profile. */
function assertOwnSlot() {
  const resolved = resolve(target)
  const expected = resolve(nodeModules, PACKAGE)
  if (resolved !== expected) throw new Error(`refusing to touch ${resolved}`)
  if (!resolved.startsWith(resolve(nodeModules) + sep)) throw new Error(`refusing to write outside ${nodeModules}`)
  if (resolved === resolve(profileDir)) throw new Error('refusing to remove the profile directory')
}

console.log(`plugin:  ${packageRoot}`)
console.log(`profile: ${profileDir}`)

if (!existsSync(profileDir)) {
  console.error(`\nThe profile directory does not exist: ${profileDir}`)
  console.error('Pass --profile <dir>, or set DSH_PROFILE_DIR.')
  process.exit(1)
}

// ---- uninstall -------------------------------------------------------------
if (uninstall) {
  assertOwnSlot()
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
    console.log(`removed ${target}`)
  } else {
    console.log('no linked package to remove')
  }
  if (existsSync(patchPath)) {
    const text = readFileSync(patchPath, 'utf8')
    if (text.includes(MARKER)) {
      const kept = text.replace(new RegExp(`\\n?${escapeRegExp(MARKER)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`, 'g'), '\n')
      writeFileSync(patchPath, kept)
      console.log(`removed the loader row from ${patchPath}`)
    } else {
      console.log('no loader row to remove')
    }
  }
  console.log('\nUninstalled. Restart the harness to drop the loader row.')
  process.exit(0)
}

// ---- install: the package --------------------------------------------------
mkdirSync(nodeModules, { recursive: true })
if (existsSync(target)) {
  const stats = lstatSync(target)
  console.log(`${stats.isSymbolicLink() ? 'relinking' : 'replacing'} ${target}`)
  assertOwnSlot()
  rmSync(target, { recursive: true, force: true })
}
if (useCopy) {
  cpSync(packageRoot, target, { recursive: true })
  console.log(`copied into ${target}`)
} else {
  try {
    symlinkSync(packageRoot, target, 'junction')
    console.log(`linked ${target} -> ${packageRoot}`)
  } catch (error) {
    // A junction needs a writable parent and no elevation on Windows, but a
    // locked-down filesystem can still refuse it; copying always works.
    console.warn(`could not link (${error.message}); copying instead`)
    cpSync(packageRoot, target, { recursive: true })
    console.log(`copied into ${target}`)
  }
}

// ---- install: the loader row ----------------------------------------------
// An `insert` list, not a bare row: a top-level patch entry without `insert`
// targets an EXISTING row by id to override or disable it, so a bare entry for
// a plugin the roster has never seen would be silently ignored.
const row = [
  '',
  MARKER,
  '- insert:',
  `    - id: ${ENTRY_ID}`,
  `      name: ${PACKAGE}`,
  '      config:',
  '        enabled: true',
  MARKER_END,
  '',
].join('\n')

const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
if (existing.includes(MARKER)) {
  console.log(`${patchPath} already has the loader row`)
} else {
  if (existing.length > 0) {
    const backup = `${patchPath}.before-image-studio`
    if (!existsSync(backup)) {
      copyFileSync(patchPath, backup)
      console.log(`backed up ${patchPath} -> ${backup}`)
    }
  }
  writeFileSync(patchPath, `${existing.replace(/\s*$/, '')}\n${row}`)
  console.log(`appended the loader row to ${patchPath}`)
}

console.log(`
Installed.

Next: restart the harness (or reload the profile) so the loader picks up the
new row, then open Settings → ${ENTRY_ID === 'image-studio' ? 'Image Studio' : ENTRY_ID}.

The plugin stores its data in:
  ${join(home, PACKAGE)}/

Uninstall with:
  node scripts/install.mjs --uninstall
`)

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
