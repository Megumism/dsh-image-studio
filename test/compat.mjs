/**
 * Compatibility guard.
 *
 * The 0.1.7-rc.2 → 0.2.x line moved the settings API more than once
 * (`settingsNamespace()` + `installSettingsSection()`, then
 * `provider.installSection()`, then forms derived from the plugin's own Config
 * entry keyed by loader entry id). A plugin that binds to any of those breaks
 * on the release that reshapes them.
 *
 * This test enforces the property that makes the compatibility claim true
 * rather than aspirational: the host half imports nothing from the harness at
 * runtime, and no part of the plugin touches the settings seam. It is a static
 * check on purpose — it fails on the commit that would introduce the coupling,
 * which is when a live test on one version would still pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Every file under a directory, recursively. */
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/**
 * Remove comments, preserving string literals.
 *
 * Prose must not be able to fail (or pass) a check about code: this plugin's
 * own doc comments discuss the settings seam it deliberately avoids, and an
 * import scan has to keep quoted specifiers intact.
 * @param source - the file text.
 * @returns the text with `//` and block comments blanked out.
 */
function stripComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      out += char
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          out += source.slice(index, index + 2)
          index += 2
          continue
        }
        out += source[index]
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** Additionally blank string literals, so prose and quoted names cannot match. */
function stripCommentsAndStrings(source) {
  return stripComments(source).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""')
}

const sourceFiles = walk(join(root, 'lib')).filter((path) => path.endsWith('.js'))
const hostFiles = sourceFiles.filter((path) => !path.endsWith(`${'client'}.js`))
const clientFile = join(root, 'lib', 'client.js')

console.log(`\nsource files (${sourceFiles.length})`)
for (const file of sourceFiles) console.log(`  ${relative(root, file)}`)

// ---- the host half must not depend on the harness at runtime ---------------
console.log('\nhost half: no runtime harness dependency')
check('there is a host half to check', hostFiles.length >= 4, `${hostFiles.length} files`)

const HARNESS_IMPORT = /(?:from|import|require)\s*\(?\s*['"]@deepseek-ai\//
for (const file of hostFiles) {
  const source = stripComments(readFileSync(file, 'utf8'))
  check(`${relative(root, file)} imports nothing from @deepseek-ai`, HARNESS_IMPORT.test(source) === false)
}

// Only node: builtins and its own relative modules are allowed.
const FOREIGN = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g
for (const file of hostFiles) {
  const source = stripComments(readFileSync(file, 'utf8'))
  const specifiers = [...source.matchAll(FOREIGN)].map((match) => match[1])
  const foreign = specifiers.filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'))
  check(`${relative(root, file)} has only node: and relative imports`, foreign.length === 0, foreign.join(', '))
}

// ---- nobody touches the settings seam --------------------------------------
console.log('\nthe settings seam is not used anywhere')
const SEAM = /\bctx\.settings\b|\bconfigForms\b|\binstallSettingsSection\b|\bsettingsNamespace\b|\binstallSection\b|\bSettingsFormModel\b/
for (const file of sourceFiles) {
  const source = stripCommentsAndStrings(readFileSync(file, 'utf8'))
  check(`${relative(root, file)} avoids the settings seam`, SEAM.test(source) === false, (source.match(SEAM) ?? []).join(', '))
}

// ---- the browser half may require only what the loader always supplies ------
console.log('\nbrowser half: only runtime-provided modules')
const clientSource = readFileSync(clientFile, 'utf8')
const requires = [...clientSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
const unexpected = [...new Set(requires)].filter((specifier) => !allowed.has(specifier))
check('the browser half requires only react and its jsx runtime', unexpected.length === 0, unexpected.join(', '))
check('the bundle uses the module-loader contract', clientSource.includes('window.__ModuleLoader__.load'))

// The bundle must declare the same module id the loader expects, which is the
// package name the loader entry resolves.
const declared = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('the bundle id matches the package name', declared?.[1] === packageJson.name, `${declared?.[1]} vs ${packageJson.name}`)

// ---- the manifest ----------------------------------------------------------
console.log('\nmanifest')
check('it declares no runtime dependencies', packageJson.dependencies === undefined || Object.keys(packageJson.dependencies).length === 0, JSON.stringify(packageJson.dependencies))
check('it exports the host entry', packageJson.exports['.'] === './lib/index.js')
check('it exports the browser entry', packageJson.exports['./client'] === './lib/client.js')
check('it declares dsh.client so the browser half is discovered', packageJson.dsh?.client !== undefined)
check('it declares the web platform', packageJson.dsh?.client?.platform === 'web')
check('the declared client entry point exists', statSync(clientFile).size > 1000)

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
