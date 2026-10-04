/**
 * Browser-half smoke test.
 *
 * Loads `lib/client.js` through a stand-in module loader, mounts it on a fake
 * client context, and drives a full round trip against a stubbed host: read
 * configuration, render it, then run a generation and render the result. This
 * is the check that the bundle the harness will serve is well-formed and its
 * page actually works, without needing a browser or the GUI.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createMiniReact } from './mini-react.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const failures = []

function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const mini = createMiniReact()

// ---- a stand-in browser ----------------------------------------------------
let createdStyles = 0
globalThis.document = {
  createElement: () => ({ setAttribute() {}, set textContent(_) {} }),
  head: { appendChild: () => { createdStyles += 1 } },
}

/** Capture the module the bundle registers. */
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => { loaded = spec },
  },
}

// ---- a stubbed host --------------------------------------------------------
const HOST_CONFIG = {
  version: 1,
  enabled: true,
  defaultChannelId: 'chan-1',
  channels: [{
    id: 'chan-1',
    name: 'gpt-img',
    baseUrl: 'https://zdxjl.com/v1',
    apiKeyEnv: '',
    models: ['gpt-image-2', 'gpt-image-2.5-flare'],
    responseFormat: 'url',
    hasKey: true,
    hasStoredKey: true,
  }],
  preferences: { defaultModel: 'gpt-image-2', size: '1024x1024', count: 1, timeoutMs: 300000, allowRemote: false },
}

const calls = []
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : {}
  calls.push({ url, body })
  const json = (payload) => ({ ok: true, status: 200, json: async () => payload })
  if (url.endsWith('/config/get')) return json({ ok: true, value: { config: HOST_CONFIG, writable: true, root: 'C:/Users/x/.dsh/dsh-image-studio' } })
  if (url.endsWith('/config/set')) return json({ ok: true, value: { config: body.config } })
  if (url.endsWith('/channel/models')) return json({ ok: true, value: { models: ['gpt-image-2', 'gpt-5.4'], imageModels: ['gpt-image-2'] } })
  if (url.endsWith('/generate')) {
    return json({
      ok: true,
      value: {
        channelId: 'chan-1',
        notes: [],
        images: [{ name: 'shot.png', mime: 'image/png', bytes: 204800, width: 1024, height: 1024, url: '/api/dsh-image-studio/image/shot.png' }],
      },
    })
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, message: 'no route' }) }
}

// ---- load the bundle -------------------------------------------------------
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

console.log('\nbundle loading')
check('the bundle is not empty', source.length > 5000, `${source.length} bytes`)
check('the bundle has no JSX left in it', source.includes('</div>') === false)

// The bundle is an expression statement over `window`; evaluating is the only
// faithful way to load it, since its contract is the loader call itself.
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'fetch', 'URLSearchParams', 'AbortController', 'DOMException', source)(
  globalThis.window, globalThis.document, globalThis.fetch, globalThis.URLSearchParams, globalThis.AbortController, globalThis.DOMException,
)
check('the bundle registered itself with the module loader', loaded !== null)
check('it registered under its own package name', loaded?.id === 'dsh-image-studio', String(loaded?.id))

const exported = loaded.factory((id) => {
  if (id === 'react') return mini.react
  if (id === 'react/jsx-runtime') return mini.jsxRuntime
  throw new Error(`unexpected require(${id})`)
})

check('it exports a locale namespace', exported.NS === 'dsh-image-studio')
check('it exports apply()', typeof exported.apply === 'function')
check('it injects the slots and locale services', Array.isArray(exported.inject) && exported.inject.includes('slots') && exported.inject.includes('locale'), JSON.stringify(exported.inject))

// ---- mount -----------------------------------------------------------------
console.log('\nmounting the settings page')
const registrations = []
const injections = []
const dictionaries = []
const ctx = {
  effect: (fn) => fn(),
  locale: {
    bind: () => (key) => key,
    register: (ns, dict) => { dictionaries.push({ ns, dict }); return () => {} },
  },
  slots: {
    // Mirrors the real seam: `inject` consumes a GENERATOR of disposers. A
    // callback that merely RETURNS a disposer registers nothing at all, and an
    // unclaimed key falls back to the generic row silently — which is exactly
    // how a generated picture ends up invisible. A fake that just calls the
    // callback cannot tell the two apart, so this one drains the generator.
    inject: (slot, contribute) => {
      const returned = contribute()
      const iterable = returned !== undefined && returned !== null && typeof returned[Symbol.iterator] === 'function'
      injections.push({ slot, iterable, registrationsBefore: registrations.length })
      if (iterable) for (const _dispose of returned) { /* drain the yielded disposers */ }
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
exported.apply(ctx)

check('the stylesheet was injected exactly once', createdStyles === 1, String(createdStyles))
check('it registered both dictionaries', dictionaries.length === 1 && dictionaries[0].ns === 'dsh-image-studio' && dictionaries[0].dict.zh !== undefined && dictionaries[0].dict.en !== undefined)
check('it registered a result view and a settings page', registrations.length === 2, String(registrations.length))

const toolview = registrations.find((entry) => entry.options.name === 'tool.call.toolview')
const page = registrations.find((entry) => entry.options.name === 'settings.section')

// The registration must come out of a GENERATOR. A plain callback returning a
// disposer registers nothing, and the generic row then hides a generated image
// with no error anywhere — the bug this assertion exists to keep fixed.
const toolviewInjection = injections.find((entry) => entry.slot === 'tool.call.toolview')
check('the result view registers through a generator of disposers', toolviewInjection?.iterable === true, JSON.stringify(injections))
check('the generator actually ran the registration', toolviewInjection !== undefined && registrations.length > toolviewInjection.registrationsBefore)
check('the result view is keyed to the generate_image tool', toolview?.options.key === 'generate_image', JSON.stringify(toolview?.options))
check('the result view declares the locale namespace', toolview?.options.locale === 'dsh-image-studio')
check('the page registers into settings.section', page !== undefined)
check('the page has a stable id', page?.options.id === 'image-studio')
check('the page declares a locale namespace', page?.options.locale === 'dsh-image-studio')
check('the page orders itself in the nav', typeof page?.options.order === 'number')
check('the page supplies a label function', typeof page?.options.label === 'function')

// ---- the inline result view -------------------------------------------------
// Without this view a generated picture never reaches the transcript: the
// generic tool card renders a result's text but not its image blocks.
console.log('\nrendering the generate_image result row')
const imageRef = { attachmentId: 'sha256:abc123', mediaType: 'image/png', bytes: 4096, width: 1024, height: 1536, name: 'gpt-img-1.png' }
const settled = { kind: 'tool-result', isError: false, content: [{ type: 'image', attachment: imageRef }, { type: 'text', text: 'Generated 1 image with gpt-image-2.' }] }
const view = mini.expand(mini.react.createElement(toolview.component, { t: (key) => key, toolName: 'generate_image', block: settled }))

const rendered = mini.hosts(view, 'img')
check('the row renders the generated image', rendered.length === 1, JSON.stringify(mini.text(view)))
check('the image is served by the plugin attachment route', String(rendered[0]?.props.src).startsWith('/api/dsh-image-studio/attachment?'), String(rendered[0]?.props.src))
check('the URL carries the whole reference', String(rendered[0]?.props.src).includes('attachment_id=sha256%3Aabc123') && String(rendered[0]?.props.src).includes('media_type=image%2Fpng'), String(rendered[0]?.props.src))
check('the image has a stable key', rendered[0]?.props.alt === 'gpt-img-1.png')
check('the row shows the result text', mini.text(view).includes('Generated 1 image'))
check('the row links to the full-size image', mini.hosts(view, 'a').some((node) => node.props.target === '_blank'))
check('a settled row reports success', mini.text(view).includes('resultDone'))

const running = mini.expand(mini.react.createElement(toolview.component, { t: (key) => key, toolName: 'generate_image', block: { kind: 'tool-call', args: {} } }))
check('a running row reports progress and draws no image', mini.text(running).includes('resultRunning') && mini.hosts(running, 'img').length === 0)

const failed = mini.expand(mini.react.createElement(toolview.component, { t: (key) => key, toolName: 'generate_image', block: { kind: 'tool-result', isError: true, content: [{ type: 'text', text: 'upstream did not answer within 300s' }] } }))
check('a failed row reports failure and echoes the upstream message', mini.text(failed).includes('resultFailed') && mini.text(failed).includes('upstream did not answer'))

// ---- first render ----------------------------------------------------------
const Page = page.component
const element = mini.react.createElement(Page, { t: (key) => key, ...page.options.inject() })

console.log('\nrendering with the loaded configuration')
const tree = await mini.flush(element)
const text = mini.text(tree)

check('it asked the host for the configuration', calls.some((entry) => entry.url.endsWith('/config/get')))
check('it shows the page title', text.includes('title'))
check('it renders the configured channel name', text.includes('gpt-img'), text.slice(0, 200))
check('it renders the channel endpoint', text.includes('zdxjl.com'))
check('it renders the configured models', text.includes('gpt-image-2'))
check('it reports the ready status', text.includes('statusReady'))
check('it renders the generation section', text.includes('generateRun'))
check('it renders the sticky save bar', text.includes('clean'))
check('it renders the data directory', text.includes('C:/Users/x/.dsh/dsh-image-studio'))

// ---- interaction -----------------------------------------------------------
console.log('\ndriving a generation')
const buttons = mini.hosts(tree, 'button')
const generateButton = buttons.find((node) => mini.text(node).includes('generateRun'))
check('the generate button is rendered', generateButton !== undefined)

const textarea = mini.hosts(tree, 'textarea')[0]
check('the prompt textarea is rendered', textarea !== undefined)
// The box is prefilled so a channel check is one click; `t` is identity here,
// so the seeded value reads back as the locale key.
check('the prompt box is prefilled with the default prompt', textarea?.props.value === 'promptDefault', String(textarea?.props.value))
textarea.props.onChange({ target: { value: '一只坐在窗台的橘猫' } })
const afterTyping = await mini.flush(element)
// A textarea's value is a prop, not a child text node, so read it back directly.
check('typing the prompt is held in state', mini.hosts(afterTyping, 'textarea')[0]?.props.value === '一只坐在窗台的橘猫')

const buttonAfterTyping = mini.hosts(afterTyping, 'button').find((node) => mini.text(node).includes('generateRun'))
await buttonAfterTyping.props.onClick()
const afterGenerate = await mini.flush(element)
const generatedText = mini.text(afterGenerate)

check('it posted the prompt to the host', calls.some((entry) => entry.url.endsWith('/generate') && entry.body.prompt === '一只坐在窗台的橘猫'), JSON.stringify(calls.at(-1)))
check('the request carried the configured model and size', calls.at(-1).body.model === 'gpt-image-2' && calls.at(-1).body.size === '1024x1024')
// A channel check must not leave pictures in the operator's home.
check('the settings preview asks for temporary output', calls.at(-1).body.temporary === true)
check('it reports the generation finished', generatedText.includes('generateDone'))
check('it renders the returned image', mini.hosts(afterGenerate, 'img').some((node) => node.props.src === '/api/dsh-image-studio/image/shot.png'))
check('it shows the image dimensions', generatedText.includes('1024×1024'))

// ---- testing a connection --------------------------------------------------
// The regression behind this: the page is never handed the literal key, so a
// draft probe arrives keyless and the host reports "no API key" for a channel
// that plainly has one.
console.log('\ntesting a saved channel connection')
const channelRow = mini.hosts(afterGenerate, 'button').find((node) => mini.text(node).includes('gpt-img'))
check('the channel row is rendered', channelRow !== undefined)
channelRow.props.onClick()
const opened = await mini.flush(element)

const probeButton = mini.hosts(opened, 'button').find((node) => mini.text(node) === 'test')
check('the test-connection button appears once the channel is open', probeButton !== undefined)
await probeButton.props.onClick()
const afterProbe = await mini.flush(element)

const probeCall = calls.filter((entry) => entry.url.endsWith('/channel/models')).at(-1)
check('an untouched saved channel is probed by id, not as a keyless draft', probeCall?.body.channelId === 'chan-1' && probeCall?.body.channel === undefined, JSON.stringify(probeCall?.body))
check('the probe result is surfaced', mini.text(afterProbe).includes('testOk'), mini.text(afterProbe).slice(-160))

// ---- saving ----------------------------------------------------------------
console.log('\nsaving an edit')
const switches = mini.hosts(afterGenerate, 'input').filter((node) => node.props.type === 'checkbox')
check('the master switch is rendered', switches.length >= 1)
check('the master switch starts on', switches[0]?.props.checked === true)
switches[0].props.onChange({ target: { checked: false } })
const afterToggle = await mini.flush(element)
check('toggling marks the form dirty', mini.text(afterToggle).includes('dirty'))

const saveButton = mini.hosts(afterToggle, 'button').find((node) => mini.text(node).includes('save'))
await saveButton.props.onClick()
const afterSave = await mini.flush(element)
const savedCall = calls.filter((entry) => entry.url.endsWith('/config/set')).at(-1)
check('saving posted the whole configuration', savedCall !== undefined, JSON.stringify(calls.map((entry) => entry.url)))
check('the saved document carries the toggled value', savedCall?.body.config.enabled === false, JSON.stringify(savedCall?.body.config.enabled))
check('it confirms the save and leaves the dirty state', mini.text(afterSave).includes('saved') && !mini.text(afterSave).includes('dirty'), mini.text(afterSave).slice(-120))

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
