# dsh-image-studio

A lean image-generation plugin for the DeepSeek Harness web GUI: configurable
OpenAI-compatible channels, a mobile-first settings page, and a generation panel
— with every API key kept on the host.

It is a deliberate replacement for the heavyweight image plugins: **~1,700 lines
across 8 files**, no build step, no runtime dependencies, and a client bundle of
about 36 KB instead of several megabytes.

---

## Why this exists

The plugin this replaces sends `response_format: "b64_json"` (or omits the field
entirely) on `/images/generations`. Measured against a real relay, that request
is **accepted and then never answered** — the connection sits until the client
gives up, which surfaces as "upstream timed out" or "failed or needs review".
The identical request with `response_format: "url"` returns a finished image.

Because a hang is indistinguishable from slowness, no timeout or retry fixes
this; only the request shape does. This plugin therefore defaults to `url`,
downloads the result host-side, and stores it locally.

Observed against `https://zdxjl.com/v1` with `gpt-image-2` across repeated runs:

| Request | Observed |
|---|---|
| `{model, prompt}` | no answer within a 240s/600s client deadline on two attempts; **later completed in 234s** returning inline `b64_json` |
| `{model, prompt, response_format: "b64_json"}` | no answer within 240s and 150s on two attempts |
| `{model, prompt, response_format: "url"}` | **completed on 7 of 9 attempts**, in 32–142s, as a 1024×1024 PNG or a result URL — the two failures being one client-side timeout and one upstream 502 |
| `dall-e-3` on the same endpoint | HTTP 400 `images endpoint requires an image model` — the route and auth are healthy |
| `gpt-image-2` on `/chat/completions` | HTTP 400 `This model is not supported on the Chat Completions endpoint` |
| `gpt-5.4` on `/chat/completions` | HTTP 429 `Upstream rate limit exceeded` — the relay's upstream is quota-limited |
| `{model, prompt, response_format: "url"}`, minutes later | HTTP 502 `database_unavailable` — the relay's own backend, surfaced verbatim |

**The honest reading of this table, after more measurements:** the endpoint is
not "broken for `b64_json`" — it is *very slow*, and how slow varies by an order
of magnitude between attempts. On one run all three shapes were issued in
parallel and `url` answered in 142s, the bare request in 234s, and `b64_json`
missed a 150s deadline. Earlier runs had `url` finish in 32s. What survives as a
real finding is the ordering, not an absolute:

- **`url` is consistently the fastest and the most likely to finish** inside a
  client deadline, which is why it is the default. That is a pragmatic choice
  supported by every run so far, not a claim that the other shapes cannot work.
- **A timeout here usually means "slow", not "wrong".** Retrying is a reasonable
  first response; the one successful generation through the chat tool needed two
  attempts, the first hitting the 300s ceiling.

Two further caveats, because they shape how the plugin behaves:

- **The upstream is intermittently saturated.** Two `url` attempts — one timeout,
  one upstream 502 `database_unavailable` — failed within minutes of successful
  ones, while the relay was reporting rate limiting on its chat routes. `url` is
  therefore *necessary but not sufficient*: a run in which nothing completes does
  not mean the shape is wrong. The plugin surfaces the upstream's own message
  rather than pretending the request was malformed — which is why a generation
  failure here reads `upstream-rejected: database_unavailable`, not "invalid
  prompt". The default deadline is 600s for exactly this reason, and every
  timeout names the deadline it was given, so the failure is self-explaining.
- **Only shape-level rejections are retried.** `responseFormat: "auto"` tries
  `url` and then `b64_json`, but only when the first attempt was *rejected* (HTTP
  400, a non-JSON body, an empty `data` array). A timeout is not retried in the
  other shape: the gateway is far more likely to be slow than to have silently
  changed format, and a second attempt would only double the wait.

Reproduce it against any gateway with:

```bash
IMAGE_API_KEY=sk-... node test/upstream-probe.mjs --base https://host/v1 --timeout 120
```

---

## Layout

```
lib/
  index.js            host entry — mounts the store, the tool, the routes, the page
  host/
    store.js          config file, image storage, secret redaction
    upstream.js       the OpenAI-compatible image client
    routes.js         the loopback HTTP surface
    agent-tool.js     the model-facing `generate_image` tool
  client.js           browser entry — the whole settings page
scripts/install.mjs   install / uninstall into a DSH profile
test/                 host and browser smoke tests
cordis.patch.yml      bundle patch (loader row) for bundle-style installs
```

## Install

### From the harness (one click, for anyone you share this with)

Open **Settings → Plugins → Plugin market** and use its install field. It accepts
four spec forms, and this package works with the first two out of the box:

| What to paste | Where it resolves |
|---|---|
| `github:Megumism/dsh-image-studio` | GitHub, cloned by pnpm |
| `dsh-image-studio` | the npm registry, once published |
| `https://github.com/Megumism/dsh-image-studio` | GitHub (hosted-repository form) |
| `/absolute/path/to/dsh-image-studio` | a local checkout |

Then **restart the harness**. The loader reads the roster at boot, and the host
half does not hot-reload.

**Why no extra wiring is needed.** The plugin manager refuses a package that does
not declare `dsh.bundle` (it reports `not-a-bundle`), and for one that does, it
reads the declared patch and applies it as a profile layer. This package ships
`cordis.patch.yml` with an `insert:` row and points `dsh.bundle.patch` at it, so
installing it also inserts the loader row — the row is not something the user has
to add by hand.

Two caveats worth knowing when you publish:

- The spec parser treats `git+https://…`, `git@host:owner/repo`, and
  `https://github.com/owner/repo` (optionally `#ref` or `.git`) as git, and
  anything ending in `.tgz` / `.tar.gz` as a tarball. Anything else under
  `http(s)://` is refused — there is no plain-file URL form.
- A git install runs pnpm's `prepare` script if the package declares one. This
  package declares none, because `lib/client.js` **is** the built artifact
  (hand-written in the harness module-loader format) — so a git install needs no
  toolchain on the user's machine.

### From a local checkout (development)

```bash
node scripts/install.mjs
```

That links the package into the profile's `node_modules` and appends one loader
row to the profile's `cordis.patch.yml` (backing the file up first, and editing it
textually so hand-written comments survive). **Restart the harness** afterwards —
the loader reads the roster at boot.

```bash
node scripts/install.mjs --uninstall   # remove it again
node scripts/install.mjs --copy        # copy instead of linking
node scripts/install.mjs --profile DIR # target a different profile
```

## Publish

Two independent channels; you can use either or both.

### GitHub (no account setup beyond the repo)

```bash
cd dsh-image-studio
git init
git add .
git commit -m "dsh-image-studio 0.2.0"
git branch -M main
git remote add origin https://github.com/Megumism/dsh-image-studio.git
git push -u origin main

# tag a release so people can pin one: github:Megumism/dsh-image-studio#v0.2.0
git tag v0.2.0
git push origin v0.2.0
```

The `.gitignore` already excludes `node_modules/` and generated `*.png`, so a
test image cannot leak into the repo.

### npm (makes the name discoverable in the market)

```bash
cd dsh-image-studio
npm login
npm publish --access public
```

`private` is already absent from `package.json` (it was there during
development), and `files` lists only `lib`, `cordis.patch.yml`, `README.md` and
`LICENSE`, so tests and scripts stay out of the tarball.

Check what would ship before you publish:

```bash
npm pack --dry-run
```

### Making it findable

- Keep the `dsh-plugin` keyword in `package.json` — that is what a market search
  matches on.
- The declared `dsh.bundle` and `dsh.client` blocks are what make the package
  installable and its browser half discoverable; do not remove them.
- Bump `version` for every change users should receive. A git install without a
  `#tag` follows the default branch, so an unversioned install silently changes
  under people.


## Use

### Generate from the conversation

Ask for a picture in ordinary language ("画一只坐在窗台的橘猫", "make me a poster
for a jazz night"). The model calls the `generate_image` tool when it decides an
image is wanted, and the result comes back as image content blocks rendered
beside the tool call. There is no slash command and no separate panel: the tool
is the whole integration.

Tool behaviour worth knowing:

- **Arguments.** `prompt` (required), plus optional `model`, `size`, `count`
  (1–4), and `path`. Anything omitted falls back to the configured preferences.
  `model` is optional on purpose: a single-channel deployment should not need a
  model-picking round trip before every picture.
- **Every image is written to a file, and the tool returns the absolute path.**
  This is the difference between a picture you can only *look at* and one a later
  step can *use* — read it, edit it, embed it in a document, move it. The
  attachment store is what makes it render in the transcript; the file is what
  makes it a deliverable. `path` names the destination (an absolute path, or a
  bare name placed in the configured directory), and `preferences.outputDir`
  redirects the whole thing into a workspace.
- **The result carries diagnostics**: `attempts`, `elapsedMs`, `format`, and
  `timeoutMs`. Without them a three-minute success and a dead gateway look
  identical, and the difference decides whether to wait, retry, or reword.
- **Failures are classified, not just described.** Every failure carries an
  `action` — `retry`, `rephrase`, `configure`, or `none` — and the model-visible
  message is tagged with it (e.g. `[rephrase] ...`). The classes need opposite
  responses, and the gateway's own wording does not distinguish them: a content
  refusal and a malformed request are both an ordinary HTTP 400.
- **The images also live in the attachment store**, so they are durable and
  deduplicated by the harness like every other image; the model receives them as
  content and does not need a URL.
- **On a text-only model route** the harness replaces each image block with a
  placeholder, so a text-only conversation degrades instead of failing.
- **Failure messages preserve the upstream's wording.** A relay that is being
  rate-limited surfaces as its own words, not as a generic "generation failed".
- **Degraded mode.** Without an attachment service the tool still works: it
  writes the images and hands the model a served URL instead of image blocks.

### On automatically rewording a refusal

A refusal on content grounds is reported as `rephrase`, which tells the caller
that different wording is the only thing that can help. The plugin stops there
and does **not** silently rewrite the prompt and retry.

That is deliberate. Rewording a refused request until a safety filter stops
objecting is not the plugin's decision to make, and a tool that did it silently
would be a moderation bypass with an extra step. Surfacing the class, so the
model or the person can decide what to actually ask for, is the honest half of
that feature.

### Why the tool also needs a client view

Returning image blocks is not enough to make a picture appear. Two separate
things had to be true, and only one of them is about the model:

1. **Model-facing content** — `output.render` returns the image blocks, which is
   how the model receives them (and how a text-only route gets a placeholder
   instead).
2. **Presentation** — the transcript is drawn by the client, and the generic tool
   card renders a result's *text* but not its *image blocks*. A tool that returns
   images therefore has to register its own `tool.call.toolview` row, keyed by
   tool name, or the picture exists everywhere except on screen.

That view also cannot use the harness's own image loader: tool-result images
deliberately do not occur in model-visible session content, so the
session-authorized loader refuses them. The plugin serves those bytes itself
through `GET /attachment`, rebuilding the complete reference from the query and
letting the attachment store re-verify the digest before returning anything.

### The settings page

**Settings → Image generation**, or the sidebar's settings dialog.

1. **Add channel** and fill in the endpoint (`https://host/v1`), the API key, and
   optionally an environment variable name that should win over the stored key.
2. **Test connection** lists the endpoint's models and keeps the ones that look
   like image models; tap one to add it.
3. **Try it** generates an image with the current configuration and shows the
   result inline.

The page is deliberately shaped for a phone: one column, no horizontal scroll,
44px minimum touch targets, 16px inputs (so iOS does not zoom on focus), a sticky
save bar above the safe-area inset, and collapsible channel editors so a long
channel list stays scannable.

### Try it is scratch, not a gallery

The settings page's **Try it** exists to answer "does this channel work?", so its
output is deliberately disposable:

- it is written to the **system temp area** (`<tmp>/dsh-image-studio-preview`),
  never into the plugin's own directory under your home;
- only **one preview generation** exists at a time — generating again replaces
  the previous one rather than appending;
- the whole preview directory is dropped on mount, on dispose, and before every
  preview, so nothing survives a restart.

Kept images (anything generated with the tool or the route without
`temporary: true`) live in `<DSH_HOME>/dsh-image-studio/images/` as before.
Serving treats both directories as one flat name space, so a preview URL looks
exactly like a kept one.

## Configuration

Stored at `<DSH_HOME>/dsh-image-studio/config.json` (mode 0600), with kept
generated images in `images/` beside it. Previews never land here. Nothing else
in your harness is written.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; off stops generation but keeps the config |
| `defaultChannelId` | first channel | Channel a generation uses when none is named |
| `preferences.defaultModel` | first model on the channel | Model a generation uses |
| `preferences.size` | `1024x1024` | Sent only when non-empty and not `auto` |
| `preferences.count` | `1` | 1–4; satisfied by parallel single-image requests |
| `preferences.timeoutMs` | `600000` | Upstream deadline. Raised from 300s because a normal generation on the measured relay took 148–414s, and a deadline that cuts off successful work is worse than a slow failure |
| `preferences.allowRemote` | `false` | Whether non-loopback callers may use the HTTP surface |
| `preferences.outputDir` | `''` | Where generated files are written. Empty means the plugin's own `images/`; an absolute path can point into a workspace so other tools can pick the files up |

Per channel: `name`, `baseUrl`, `apiKey`, `apiKeyEnv`, `models[]`,
`responseFormat` (`url` \| `b64_json` \| `auto`; `auto` tries `url` first).

A loader row may also seed channels, which is convenient for a deployment that
ships a working configuration — the file takes over the moment the page saves.

```yaml
- insert:
    - id: image-studio
      name: dsh-image-studio
      config:
        enabled: true
        channels:
          - name: gpt-img
            baseUrl: https://zdxjl.com/v1
            apiKeyEnv: IMAGE_API_KEY
            models: [gpt-image-2, gpt-image-2.5-flare]
```

## HTTP surface

One prefix, `/api/dsh-image-studio`. Loopback only unless `allowRemote` is on.

| Route | Purpose |
|---|---|
| `POST /config/get` | Redacted configuration — literals never cross the wire |
| `POST /config/set` | Replace the configuration |
| `POST /channel/models` | Probe an endpoint's `/models` |
| `POST /generate` | Generate, download, store, and describe the images; `temporary: true` routes the output to the scratch area |
| `GET /image/<name>` | Serve a stored image |
| `GET /attachment` | Serve one durable attachment by reference, for the transcript view |
| `GET /health` | Liveness |

## Compatibility posture

Targets **harness 0.1.7-rc.2 and later**, including the 0.2.x line.

The settings API is what moved across those releases: `settingsNamespace()` +
`installSettingsSection()` in the older releases, `provider.installSection()`
after that, and — from 0.1.7 — forms derived from the plugin's own Config entry,
keyed by **loader entry id**. Fighting that churn is what makes plugins brittle.

This plugin sidesteps it: it uses only the cordis core (`ctx.effect`,
`ctx.inject`, `ctx.logger`) and `ctx.webServer`, all stable across the range, and
keeps its configuration in its own file edited through its own page. It does not
call `ctx.settings`, `installSettingsSection`, or `settingsNamespace`, so a
release that reshapes them cannot break it. The browser half registers into the
long-standing `settings.section` slot and reads nothing version-specific.

Two other details matter for a third-party namespace:

- The official settings scope answers `unavailable` for namespaces the host's
  allowlist does not carry, so a plugin cannot rely on `configForms.get(ownNs)`.
  Serving the page from the plugin's own loopback routes avoids that entirely.
- The client half is discovered by scanning loader entries for packages that
  declare `dsh.client`, so the loader row **and** the `dsh.client` declaration in
  `package.json` are both required. A loader row alone mounts only the host half.

## Security

- API keys live in the config file (0600) or in an environment variable, and are
  replaced by `hasKey` presence flags before anything reaches the browser.
- Saving from the page cannot erase a stored key: an incoming channel that
  reports a key but sends none keeps the one on disk.
- A result URL is fetched **without** the API key unless it shares the channel's
  origin, so a signed CDN link never receives the operator's credential.
- The HTTP surface refuses non-loopback callers by default.
- Image reads reject traversal, absolute paths, nested paths and drive letters.
- The endpoint is validated as a channel, never chosen by the model.

## Tests

```bash
node test/compat.mjs                    # compatibility guard (static)
node test/agent-tool.mjs                # the model-facing tool, fetch stubbed
node test/host-smoke.mjs                # store, upstream client, HTTP routes
node test/client-smoke.mjs              # the browser bundle, end to end
SMOKE_API_KEY=sk-... node test/host-smoke.mjs --generate   # + a real generation

# against a running harness (token changes on every restart)
node scripts/verify-live.mjs --url http://127.0.0.1:PORT --token TOKEN [--generate]
```

| Suite | What it actually proves |
|---|---|
| `compat.mjs` | The host half imports nothing from `@deepseek-ai/*` at runtime, nothing anywhere touches the settings seam, the browser half requires only React, and the bundle id matches the package name. This is what makes the cross-version claim checkable instead of aspirational — it fails on the commit that would introduce the coupling. |
| `agent-tool.mjs` | The tool definition, its guards, and a full `execute` against a stubbed `fetch`: the request carries `response_format: "url"` and the configured model, the result is admitted to attachments, the rendered blocks start with the image, and the API key is never sent to the CDN origin. Also covers the no-attachment degraded path. |
| `host-smoke.mjs` | Applying the plugin registers the tool and answers on a real `node:http` server against a temporary `DSH_HOME`: config round-trips, secrets are redacted, traversal is refused, previews never touch the home directory, and (with `--generate`) a real image is generated, stored and served. |
| `client-smoke.mjs` | The real bundle loads through the module-loader contract, registers its slot, renders the loaded configuration, accepts a typed prompt, runs a generation, tests a saved channel, and saves — driven by a minimal React stand-in, since React itself is supplied by the harness at runtime. |
| `verify-live.mjs` | The plugin is mounted in a *running* harness: an unregistered route 404s (the control), `/health` and `/config/get` answer, no key crosses the wire, a channel probes its upstream, and `--generate` produces an image that is served back. |

`upstream-probe.mjs` is the reproduction for the finding above rather than a
pass/fail suite. Every suite exits non-zero on failure.

## Deliberate omissions

No canvas, no node graphs, no skills, no subscription OAuth, no template library,
no gallery. Those are what made the previous plugin unmaintainable; if one is
wanted, it belongs in its own plugin.
