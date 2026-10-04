/**
 * dsh-image-studio — browser half.
 *
 * One settings page ("Image Studio") that owns channels, preferences and a
 * generation panel. Design constraints, in order:
 *
 *   1. Mobile first. The page is a single column that never scrolls
 *      horizontally, every control is at least 44px tall, inputs are 16px so
 *      iOS does not zoom on focus, and the primary action sits in a sticky bar
 *      above the safe-area inset. Wider viewports only get more breathing room.
 *   2. The host owns the truth. This file never holds an API key: it renders
 *      `hasKey` and sends a replacement when the operator types one.
 *   3. No build step and no cross-package value imports. The bundle is plain
 *      JSX-free React loaded through the harness module loader, so it survives
 *      harness versions whose client build pipeline differs.
 */

window.__ModuleLoader__.load({
  id: 'dsh-image-studio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const { useState, useEffect, useRef, useCallback } = react

    /** Locale namespace this plugin owns. */
    const NS = 'dsh-image-studio'
    /** Host route family; mirrors `ROUTE_PREFIX` in lib/host/routes.js. */
    const API = '/api/dsh-image-studio'

    // ---------------------------------------------------------------------
    // copy
    // ---------------------------------------------------------------------

    const zh = {
      title: '图像生成',
      subtitle: '管理出图渠道：接口地址、密钥和模型。密钥只保存在宿主机器上，不会回传到浏览器。',
      statusLoading: '正在读取配置…',
      statusReady: '已就绪',
      statusNoChannel: '还没有渠道',
      statusDisabled: '已关闭',
      statusError: '无法连接宿主（{0}）',
      enabled: '启用图像生成',
      enabledHint: '关闭后本页不再出图，已有配置保留。',
      channels: '渠道',
      channelsHint: '一个渠道 = 一个接口地址 + 一个密钥 + 一组模型。',
      addChannel: '添加渠道',
      noChannels: '还没有渠道。点「添加渠道」，把接口地址和密钥填进去。',
      channelName: '名称',
      channelNamePlaceholder: '例如 gpt-img',
      baseUrl: '接口地址',
      baseUrlPlaceholder: 'https://example.com/v1',
      baseUrlHint: '留空则不保存该渠道。末尾的 / 会自动去掉。',
      apiKey: 'API 密钥',
      apiKeyHint: '只保存在宿主机器上，不会再传回浏览器。',
      apiKeySet: '已配置密钥，留空表示不修改。',
      apiKeyUnset: '还没有密钥。',
      apiKeyEnv: '环境变量名（可选）',
      apiKeyEnvHint: '填了就优先从环境变量读取，比写在文件里更安全。',
      models: '模型',
      modelsPlaceholder: '每行一个，或逗号分隔',
      modelsHint: '留空可先点「测试连接」自动列出图像模型。',
      responseFormat: '返回格式',
      responseFormatHint: 'url 最稳；若上游只支持 base64 再切换。',
      responseFormatAuto: '自动（先 url 再 base64）',
      test: '测试连接',
      testing: '测试中…',
      testOk: '连接成功，发现 {0} 个图像模型',
      testOkNone: '连接成功，但没有识别到图像模型',
      testFailed: '测试失败：{0}',
      errMissingKey: '这个渠道还没有可用的密钥：请在上面「API 密钥」里填写，或指定一个已存在的环境变量名。',
      errTimeout: '上游没在超时时间内返回（{0}）。中转账号被限流时经常就是这个表现：先重试一次，或者过一会儿再试；如果你确认渠道本身没问题，可以到「偏好」里把超时调大。',
      errUnreachable: '连不上这个接口地址（{0}）。检查地址是否正确、宿主机能不能访问它。',
      errRejected: '上游拒绝了请求：{0}',
      errInvalidResponse: '上游返回了无法解析的内容，这个地址可能不是兼容 OpenAI 的图像接口。',
      errNoImage: '上游没有返回图片，换个提示词或换个模型再试。',
      errDownload: '图片生成成功，但下载失败，请检查宿主机的网络。',
      errTooLarge: '生成的图片超过 32MB 上限。',
      errEmptyPrompt: '请先填写提示词。',
      errRemote: '该接口默认只允许本机访问；如果手机要经局域网访问宿主机，请在「偏好」里打开「允许远程访问」。',
      resultRunning: '生成中…',
      resultDone: '已生成',
      resultFailed: '生成失败',
      resultOpen: '打开原图',
      resultAlt: '生成的图片',
      resultLoading: '正在加载图片…',
      remove: '删除',
      removeConfirm: '确定删除这个渠道？',
      tapToAdd: '点击加入',
      preferences: '偏好',
      defaultChannel: '默认渠道',
      defaultModel: '默认模型',
      defaultModelAuto: '自动（用渠道里的第一个）',
      size: '画面尺寸',
      sizeAuto: '自动',
      count: '每次张数',
      timeout: '超时（秒）',
      timeoutHint: '上游较慢时可调大；url 格式通常 30～60 秒。',
      allowRemote: '允许远程访问',
      allowRemoteHint: '默认只允许本机。手机通过局域网访问宿主时才需要打开。',
      generate: '试画',
      generateHint: '用当前配置出一张，验证渠道是否可用。预览图只写到系统临时目录，不会留在你的用户目录里，下一次试画会把它替换掉。',
      prompt: '提示词',
      promptPlaceholder: '描述你想要的画面…',
      // Prefilled so "试画" is genuinely one click: the box exists to answer
      // "does this channel work?", and making the operator invent a prompt
      // first defeats that.
      promptDefault: '一只橘猫坐在洒满阳光的窗台上，日系插画风格，柔和自然光，背景略微虚化，无文字',
      generateRun: '开始生成',
      generating: '生成中…（通常 30～60 秒）',
      generateCancel: '取消',
      generateEmptyPrompt: '请先填写提示词。',
      generateDone: '生成完成',
      generatePartial: '部分成功：{0}',
      generateFailed: '生成失败：{0}',
      download: '下载',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败：{0}',
      reset: '撤销改动',
      dirty: '有未保存的改动',
      clean: '配置已同步',
      dataDir: '数据目录',
    }

    const en = {
      title: 'Image generation',
      subtitle: 'Manage image channels: endpoint, key and models. Keys stay on the host and are never sent back to the browser.',
      statusLoading: 'Reading configuration…',
      statusReady: 'Ready',
      statusNoChannel: 'No channel yet',
      statusDisabled: 'Disabled',
      statusError: 'Cannot reach the host ({0})',
      enabled: 'Enable image generation',
      enabledHint: 'Turning this off stops generation here; your channels stay.',
      channels: 'Channels',
      channelsHint: 'One channel = one endpoint + one key + a set of models.',
      addChannel: 'Add channel',
      noChannels: 'No channels yet. Tap “Add channel” and fill in the endpoint and key.',
      channelName: 'Name',
      channelNamePlaceholder: 'e.g. gpt-img',
      baseUrl: 'Endpoint',
      baseUrlPlaceholder: 'https://example.com/v1',
      baseUrlHint: 'A channel with no endpoint is not saved. A trailing slash is trimmed.',
      apiKey: 'API key',
      apiKeyHint: 'Stored on the host only and never sent back to the browser.',
      apiKeySet: 'A key is configured; leave blank to keep it.',
      apiKeyUnset: 'No key yet.',
      apiKeyEnv: 'Environment variable (optional)',
      apiKeyEnvHint: 'When set it wins over the stored key, keeping the secret out of the file.',
      models: 'Models',
      modelsPlaceholder: 'One per line, or comma separated',
      modelsHint: 'Leave empty, then use “Test connection” to list the image models.',
      responseFormat: 'Response format',
      responseFormatHint: '“url” is the reliable one; switch if your gateway is base64-only.',
      responseFormatAuto: 'Auto (url, then base64)',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connected. {0} image model(s) found',
      testOkNone: 'Connected, but no image model was recognised',
      testFailed: 'Test failed: {0}',
      errMissingKey: 'This channel has no usable key yet: fill in “API key” above, or name an environment variable that exists.',
      errTimeout: 'The upstream did not answer within the deadline ({0}). A rate-limited relay behaves exactly like this: retry once, or try again later; if you know the channel itself is healthy, raise the timeout under Preferences.',
      errUnreachable: 'Could not reach this endpoint ({0}). Check the URL and whether the host machine can reach it.',
      errRejected: 'The upstream rejected the request: {0}',
      errInvalidResponse: 'The upstream returned something unparseable; this URL is probably not an OpenAI-compatible image endpoint.',
      errNoImage: 'The upstream returned no image. Try another prompt or model.',
      errDownload: 'The image was generated but could not be downloaded; check the host machine’s network.',
      errTooLarge: 'The generated image exceeds the 32MB limit.',
      errEmptyPrompt: 'Enter a prompt first.',
      errRemote: 'This surface is loopback-only by default. To reach the host from a phone over the LAN, enable “Allow remote access” under Preferences.',
      resultRunning: 'Generating…',
      resultDone: 'Generated',
      resultFailed: 'Failed',
      resultOpen: 'Open full size',
      resultAlt: 'generated image',
      resultLoading: 'Loading image…',
      remove: 'Remove',
      removeConfirm: 'Remove this channel?',
      tapToAdd: 'Tap to add',
      preferences: 'Preferences',
      defaultChannel: 'Default channel',
      defaultModel: 'Default model',
      defaultModelAuto: 'Auto (first model on the channel)',
      size: 'Image size',
      sizeAuto: 'Auto',
      count: 'Images per run',
      timeout: 'Timeout (seconds)',
      timeoutHint: 'Raise it for slow gateways; the url format usually takes 30–60s.',
      allowRemote: 'Allow remote access',
      allowRemoteHint: 'Loopback only by default. Enable when a phone reaches the host over the LAN.',
      generate: 'Try it',
      generateHint: 'Generate one image with the current configuration to check the channel. Previews are written to the system temp area only — nothing is left in your home directory, and the next preview replaces them.',
      prompt: 'Prompt',
      promptPlaceholder: 'Describe the image you want…',
      promptDefault: 'An orange tabby cat on a sunlit windowsill, Japanese illustration style, soft natural light, gently blurred background, no text',
      generateRun: 'Generate',
      generating: 'Generating… (usually 30–60s)',
      generateCancel: 'Cancel',
      generateEmptyPrompt: 'Enter a prompt first.',
      generateDone: 'Done',
      generatePartial: 'Partly succeeded: {0}',
      generateFailed: 'Generation failed: {0}',
      download: 'Download',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Save failed: {0}',
      reset: 'Discard changes',
      dirty: 'Unsaved changes',
      clean: 'Configuration in sync',
      dataDir: 'Data directory',
    }

    // ---------------------------------------------------------------------
    // host client
    // ---------------------------------------------------------------------

    /** POST JSON to the host and unwrap its `{ok, value|message}` envelope. */
    async function call(path, body) {
      let response
      try {
        response = await fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (payload.ok !== true) {
        // The machine code rides along so the page can show localized copy
        // instead of echoing the host's English sentence verbatim.
        const failure = new Error(payload.message ?? `HTTP ${response.status}`)
        failure.code = payload.code
        throw failure
      }
      return payload.value
    }

    /**
     * Turn a host failure into copy the operator can act on.
     *
     * Known codes get a localized explanation that names the fix. Anything else
     * falls back to the host's own message — which, when the failure came from
     * the gateway, is the upstream's wording, and that wording is the single
     * most useful thing available in that case.
     *
     * @param error - the thrown failure, possibly carrying a `code`.
     * @param t - the page's locale reader.
     * @returns the message to render.
     */
    function describeError(error, t) {
      const code = error?.code ?? ''
      const upstream = error instanceof Error ? error.message : String(error)
      const known = {
        'missing-key': t('errMissingKey'),
        'download-failed': t('errDownload'),
        'image-too-large': t('errTooLarge'),
        'no-image': t('errNoImage'),
        'invalid-response': t('errInvalidResponse'),
        'empty-prompt': t('errEmptyPrompt'),
        'remote-refused': t('errRemote'),
      }
      if (known[code] !== undefined) return known[code]
      // These three keep the host's own detail, because it is the most concrete
      // fact available: the timeout in seconds, the transport's wording, or the
      // gateway's own rejection reason.
      if (code === 'timeout') return fill(t('errTimeout'), upstream)
      if (code === 'unreachable') return fill(t('errUnreachable'), upstream)
      if (code === 'upstream-rejected') return fill(t('errRejected'), upstream)
      return upstream
    }

    /** Format `{0}`-style copy without pulling in a formatting dependency. */
    function fill(template, ...values) {
      return String(template).replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''))
    }

    /** Split the models textarea into ids, accepting commas and newlines. */
    function parseModels(text) {
      return [...new Set(String(text).split(/[\n,]+/).map((part) => part.trim()).filter((part) => part.length > 0))]
    }

    /** A stable identity for a channel draft, so React keys survive renames. */
    function newId() {
      return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    // ---------------------------------------------------------------------
    // styles
    // ---------------------------------------------------------------------

    const CSS = `
.dis-root {
  --dis-radius: 12px;
  --dis-gap: 14px;
  font-family: var(--dsw-font-family, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  color: var(--dsw-alias-label-primary, #f2f3f5);
  display: flex; flex-direction: column; gap: var(--dis-gap);
  padding: 4px 2px calc(96px + env(safe-area-inset-bottom, 0px));
  max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box;
}
.dis-root *, .dis-root *::before, .dis-root *::after { box-sizing: border-box; }
.dis-head { display: flex; flex-direction: column; gap: 6px; }
.dis-title { font-size: 20px; font-weight: 650; margin: 0; letter-spacing: .2px; }
.dis-sub { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #8b8f96); margin: 0; }
.dis-pill {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; padding: 4px 10px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  color: var(--dsw-alias-label-secondary, #b6bac0);
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04));
}
.dis-pill[data-tone="ready"] { color: var(--dsw-alias-state-success-primary, #4ec97a); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #4ec97a) 40%, transparent); }
.dis-pill[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #e0a83c); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e0a83c) 40%, transparent); }
.dis-pill[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #e2635f); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e2635f) 40%, transparent); }

.dis-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.09));
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03));
  border-radius: var(--dis-radius); overflow: hidden;
}
.dis-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));
}
.dis-card-title { font-size: 15px; font-weight: 600; margin: 0; }
.dis-card-hint { font-size: 12px; color: var(--dsw-alias-label-quaternary, #7b7f86); margin: 3px 0 0; line-height: 1.5; }
.dis-card-body { padding: 16px; display: flex; flex-direction: column; gap: 16px; }

.dis-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; }
.dis-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dis-row-label { font-size: 14px; font-weight: 500; }
.dis-row-hint { font-size: 12px; color: var(--dsw-alias-label-quaternary, #7b7f86); line-height: 1.5; }

.dis-field { display: flex; flex-direction: column; gap: 6px; }
.dis-label { font-size: 13px; font-weight: 550; color: var(--dsw-alias-label-secondary, #b6bac0); }
.dis-help { font-size: 12px; color: var(--dsw-alias-label-quaternary, #7b7f86); line-height: 1.5; }
.dis-input, .dis-textarea, .dis-select {
  width: 100%; min-height: 44px; padding: 10px 12px;
  font-size: 16px; font-family: inherit; line-height: 1.4;
  color: var(--dsw-alias-label-primary, #f2f3f5);
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.18));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  border-radius: 10px; outline: none; appearance: none;
}
.dis-textarea { min-height: 96px; resize: vertical; line-height: 1.6; }
.dis-input:focus, .dis-textarea:focus, .dis-select:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dis-select { background-image: none; }
.dis-input::placeholder, .dis-textarea::placeholder { color: var(--dsw-alias-label-dimmed, #6a6e75); }

.dis-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; padding: 0 16px; font-size: 14px; font-weight: 550; font-family: inherit;
  border-radius: 10px; cursor: pointer; white-space: nowrap;
  color: var(--dsw-alias-label-primary, #f2f3f5);
  background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,.07));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
}
.dis-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.12)); }
.dis-btn:disabled { opacity: .5; cursor: default; }
.dis-btn[data-variant="primary"] { background: var(--dsw-alias-brand-primary, #4d6bfe); border-color: transparent; color: #fff; }
.dis-btn[data-variant="danger"] { color: var(--dsw-alias-state-error-primary, #e2635f); }
.dis-btn[data-size="sm"] { min-height: 36px; padding: 0 12px; font-size: 13px; }
.dis-btn[data-block="1"] { width: 100%; }

.dis-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.dis-channel { border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.09)); border-radius: 12px; overflow: hidden; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.03)); }
.dis-channel-head {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 12px 14px; min-height: 52px; text-align: left; cursor: pointer;
  background: none; border: 0; color: inherit; font-family: inherit;
}
.dis-channel-head:hover { background: var(--dsw-alias-bg-hover, rgba(255,255,255,.05)); }
.dis-channel-name { font-size: 14px; font-weight: 600; }
.dis-channel-sub { font-size: 12px; color: var(--dsw-alias-label-quaternary, #7b7f86); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dis-grow { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dis-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-label-dimmed, #6a6e75); }
.dis-dot[data-on="1"] { background: var(--dsw-alias-state-success-primary, #4ec97a); }
.dis-channel-body { padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 14px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07)); }

.dis-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.dis-chip {
  min-height: 36px; padding: 0 12px; display: inline-flex; align-items: center;
  font-size: 13px; font-family: inherit; cursor: pointer;
  border-radius: 999px; border: 1px dashed var(--dsw-alias-border-l2, rgba(255,255,255,.16));
  background: transparent; color: var(--dsw-alias-label-secondary, #b6bac0);
}
.dis-chip:hover { border-style: solid; background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,.07)); }

.dis-switch { position: relative; width: 46px; height: 28px; flex: 0 0 auto; }
.dis-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.dis-switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,.14)); transition: background .16s ease; pointer-events: none; }
.dis-switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: transform .16s ease; }
.dis-switch input:checked + span { background: var(--dsw-alias-brand-primary, #4d6bfe); }
.dis-switch input:checked + span::after { transform: translateX(18px); }
.dis-switch input:focus-visible + span { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 2px; }

.dis-note { font-size: 13px; line-height: 1.55; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04)); }
.dis-note[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #4ec97a); }
.dis-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #e2635f); }
.dis-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #e0a83c); }

.dis-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.dis-shot { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1)); border-radius: 12px; overflow: hidden; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.03)); }
.dis-shot img { width: 100%; height: auto; display: block; background: var(--dsw-alias-bg-base, #000); }
.dis-shot-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-quaternary, #7b7f86); }
.dis-shot-bar a { color: var(--dsw-alias-brand-primary, #4d6bfe); text-decoration: none; font-weight: 550; }

.dis-sticky {
  position: sticky; bottom: 0; z-index: 2;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 14px calc(12px + env(safe-area-inset-bottom, 0px));
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1));
  border-radius: var(--dis-radius);
  background: var(--dsw-alias-bg-module-poped, var(--dsw-alias-bg-layer-1, #1b1c1f));
  backdrop-filter: blur(8px);
}
.dis-sticky-text { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-quaternary, #7b7f86); }
.dis-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; word-break: break-all; color: var(--dsw-alias-label-quaternary, #7b7f86); }

/* Inline result view for the generate_image tool. The generic tool card does
   not draw image blocks, so this view is the only thing that makes a generated
   picture visible in the transcript. */
.dis-tv {
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.09));
  border-radius: 12px; overflow: hidden; margin: 6px 0;
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03));
}
.dis-tv-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; font-size: 13px; color: var(--dsw-alias-label-secondary, #b6bac0); }
.dis-tv-head strong { font-weight: 600; color: var(--dsw-alias-label-primary, #f2f3f5); }
.dis-tv-status { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-quaternary, #7b7f86); }
.dis-tv[data-state="failed"] .dis-tv-status { color: var(--dsw-alias-state-error-primary, #e2635f); }
.dis-tv-note { margin: 0; padding: 0 12px 10px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #8b8f96); white-space: pre-wrap; word-break: break-word; }
.dis-tv-images { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; padding: 0 12px 12px; }
.dis-tv-images a { display: block; border-radius: 10px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.09)); }
.dis-tv-images img { display: block; width: 100%; height: auto; }

@media (max-width: 560px) {
  .dis-card-body { padding: 14px 12px; }
  .dis-card-head { padding: 12px 12px; }
  .dis-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .dis-actions .dis-btn { flex: 1 1 auto; }
  .dis-sticky .dis-btn { flex: 1 1 auto; }
}
`

    /** Inject the stylesheet once per page. */
    let stylesReady = false
    function ensureStyles() {
      if (stylesReady || typeof document === 'undefined') return
      stylesReady = true
      const style = document.createElement('style')
      style.setAttribute('data-dsh-image-studio', '')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ---------------------------------------------------------------------
    // small presentational pieces
    // ---------------------------------------------------------------------

    /** A labelled control wrapper. */
    function Field(props) {
      return h('label', { className: 'dis-field' },
        h('span', { className: 'dis-label' }, props.label),
        props.children,
        props.help ? h('span', { className: 'dis-help' }, props.help) : null,
      )
    }

    /** A switch row; the input is the whole row's hit target on touch. */
    function SwitchRow(props) {
      return h('div', { className: 'dis-row' },
        h('div', { className: 'dis-row-text' },
          h('span', { className: 'dis-row-label' }, props.label),
          props.hint ? h('span', { className: 'dis-row-hint' }, props.hint) : null,
        ),
        h('label', { className: 'dis-switch' },
          h('input', { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: (e) => props.onChange(e.target.checked) }),
          h('span', null),
        ),
      )
    }

    /** A card with a title, a hint, and an optional header action. */
    function Card(props) {
      return h('section', { className: 'dis-card' },
        h('div', { className: 'dis-card-head' },
          h('div', { className: 'dis-grow' },
            h('h3', { className: 'dis-card-title' }, props.title),
            props.hint ? h('p', { className: 'dis-card-hint' }, props.hint) : null,
          ),
          props.action ?? null,
        ),
        h('div', { className: 'dis-card-body' }, props.children),
      )
    }

    /** A transient message line. */
    function Note(props) {
      if (!props.children) return null
      return h('div', { className: 'dis-note', 'data-tone': props.tone ?? 'neutral', role: props.tone === 'error' ? 'alert' : 'status' }, props.children)
    }

    // ---------------------------------------------------------------------
    // channel editor
    // ---------------------------------------------------------------------

    /** One channel: collapsed summary, expanded editor, live probe. */
    function ChannelEditor(props) {
      const { t, channel, index, open, onToggle, onChange, onRemove, defaultChannel, savedChannel } = props
      const [probe, setProbe] = useState({ state: 'idle', models: [], message: '' })
      const [keyDraft, setKeyDraft] = useState('')

      // How to probe depends on what actually changed:
      //
      //   * nothing endpoint-related, and the operator did not type a key — ask
      //     the host about the SAVED channel, so it authenticates with the key
      //     it already holds. The page was never given that literal, so a draft
      //     would arrive with an empty key and look unauthenticated.
      //   * a new/edited endpoint, or a freshly typed key — probe the draft, so
      //     an endpoint can be tested before it is saved.
      const endpointChanged = savedChannel === undefined || savedChannel.baseUrl !== channel.baseUrl
      const keyTyped = keyDraft.length > 0
      const probeBySavedId = !endpointChanged && !keyTyped && channel.hasKey === true

      const runProbe = useCallback(async () => {
        setProbe({ state: 'busy', models: [], message: '' })
        try {
          const value = probeBySavedId
            ? await call('/channel/models', { channelId: channel.id })
            : await call('/channel/models', {
              channel: {
                id: channel.id,
                name: channel.name,
                baseUrl: channel.baseUrl,
                apiKey: keyDraft,
                apiKeyEnv: channel.apiKeyEnv,
                models: channel.models,
                responseFormat: channel.responseFormat,
              },
            })
          const imageModels = value.imageModels ?? []
          setProbe({
            state: 'done',
            models: imageModels,
            message: imageModels.length > 0 ? fill(t('testOk'), imageModels.length) : t('testOkNone'),
          })
        } catch (error) {
          setProbe({ state: 'error', models: [], message: fill(t('testFailed'), describeError(error, t)) })
        }
      }, [channel, keyDraft, t, probeBySavedId])

      const addModel = (id) => {
        if (channel.models.includes(id)) return
        onChange({ ...channel, models: [...channel.models, id] })
      }

      const sub = channel.baseUrl || t('baseUrlPlaceholder')
      const keyState = channel.hasKey ? t('apiKeySet') : t('apiKeyUnset')

      return h('div', { className: 'dis-channel' },
        h('button', { type: 'button', className: 'dis-channel-head', onClick: onToggle, 'aria-expanded': open },
          h('span', { className: 'dis-dot', 'data-on': channel.hasKey && channel.baseUrl ? '1' : '0', 'aria-hidden': 'true' }),
          h('span', { className: 'dis-grow' },
            h('span', { className: 'dis-channel-name' }, channel.name || `${t('channels')} ${index + 1}`),
            h('span', { className: 'dis-channel-sub' }, sub),
          ),
          defaultChannel ? h('span', { className: 'dis-pill' }, t('defaultChannel')) : null,
          h('span', { className: 'dis-channel-sub', 'aria-hidden': 'true' }, open ? '⌃' : '⌄'),
        ),
        open ? h('div', { className: 'dis-channel-body' },
          h(Field, { label: t('channelName') },
            h('input', {
              className: 'dis-input', type: 'text', value: channel.name,
              placeholder: t('channelNamePlaceholder'),
              onChange: (e) => onChange({ ...channel, name: e.target.value }),
            }),
          ),
          h(Field, { label: t('baseUrl'), help: t('baseUrlHint') },
            h('input', {
              className: 'dis-input', type: 'url', inputMode: 'url', value: channel.baseUrl,
              placeholder: t('baseUrlPlaceholder'), autoComplete: 'off', spellCheck: false,
              onChange: (e) => onChange({ ...channel, baseUrl: e.target.value }),
            }),
          ),
          h(Field, { label: t('apiKey'), help: keyState },
            h('input', {
              className: 'dis-input', type: 'password', value: keyDraft,
              placeholder: channel.hasKey ? '••••••••' : 'sk-…',
              autoComplete: 'new-password', spellCheck: false,
              onChange: (e) => {
                setKeyDraft(e.target.value)
                // A typed key is staged onto the draft so Save persists it, and
                // the host reports presence from then on.
                onChange({ ...channel, apiKey: e.target.value, hasKey: e.target.value.length > 0 })
              },
            }),
          ),
          h(Field, { label: t('apiKeyEnv'), help: t('apiKeyEnvHint') },
            h('input', {
              className: 'dis-input', type: 'text', value: channel.apiKeyEnv,
              placeholder: 'MY_IMAGE_API_KEY', autoComplete: 'off', spellCheck: false,
              onChange: (e) => onChange({ ...channel, apiKeyEnv: e.target.value }),
            }),
          ),
          h(Field, { label: t('models'), help: t('modelsHint') },
            h('textarea', {
              className: 'dis-textarea', value: channel.models.join('\n'),
              placeholder: t('modelsPlaceholder'), spellCheck: false,
              onChange: (e) => onChange({ ...channel, models: parseModels(e.target.value) }),
            }),
          ),
          h(Field, { label: t('responseFormat'), help: t('responseFormatHint') },
            h('select', {
              className: 'dis-select', value: channel.responseFormat,
              onChange: (e) => onChange({ ...channel, responseFormat: e.target.value }),
            },
              h('option', { value: 'url' }, 'url'),
              h('option', { value: 'b64_json' }, 'b64_json'),
              h('option', { value: 'auto' }, t('responseFormatAuto')),
            ),
          ),
          h('div', { className: 'dis-actions' },
            h('button', {
              type: 'button', className: 'dis-btn', disabled: probe.state === 'busy' || channel.baseUrl === '',
              onClick: runProbe,
            }, probe.state === 'busy' ? t('testing') : t('test')),
            h('button', {
              type: 'button', className: 'dis-btn', 'data-variant': 'danger',
              onClick: () => { if (window.confirm(t('removeConfirm'))) onRemove() },
            }, t('remove')),
          ),
          probe.state === 'error' ? h(Note, { tone: 'error' }, probe.message) : null,
          probe.state === 'done' ? h(Note, { tone: probe.models.length > 0 ? 'ok' : 'warn' }, probe.message) : null,
          probe.models.length > 0 ? h('div', { className: 'dis-chips' },
            probe.models
              .filter((id) => !channel.models.includes(id))
              .map((id) => h('button', {
                key: id, type: 'button', className: 'dis-chip', title: t('tapToAdd'),
                onClick: () => addModel(id),
              }, `+ ${id}`)),
          ) : null,
        ) : null,
      )
    }

    // ---------------------------------------------------------------------
    // page
    // ---------------------------------------------------------------------

    /** The Image Studio settings page. */
    function ImageStudioPage(props) {
      const t = props.t ?? ((key) => key)
      const [saved, setSaved] = useState(null)
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState({ kind: 'loading' })
      const [openId, setOpenId] = useState(null)
      const [saveState, setSaveState] = useState({ kind: 'idle' })
      // Seeded with a ready-made prompt so the channel check really is one
      // click; the operator can clear it and write their own.
      const [gen, setGen] = useState({ prompt: t('promptDefault'), busy: false, images: [], notes: [], error: null, message: '' })
      const abortRef = useRef(null)

      const load = useCallback(async () => {
        setStatus({ kind: 'loading' })
        try {
          const value = await call('/config/get')
          setSaved(value.config)
          setDraft(JSON.parse(JSON.stringify(value.config)))
          setStatus({ kind: 'ready', root: value.root })
        } catch (error) {
          setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      useEffect(() => { void load() }, [load])

      if (status.kind === 'loading') {
        return h('div', { className: 'dis-root' }, h(Note, null, t('statusLoading')))
      }
      if (status.kind === 'error') {
        return h('div', { className: 'dis-root' },
          h(Note, { tone: 'error' }, fill(t('statusError'), status.message)),
          h('div', { className: 'dis-actions' }, h('button', { type: 'button', className: 'dis-btn', onClick: () => void load() }, t('test'))),
        )
      }

      const dirty = JSON.stringify(saved) !== JSON.stringify(draft)
      const channels = draft.channels ?? []

      const patch = (next) => setDraft((current) => ({ ...current, ...next }))
      const patchPrefs = (next) => setDraft((current) => ({ ...current, preferences: { ...current.preferences, ...next } }))

      const activeChannel = channels.find((entry) => entry.id === draft.defaultChannelId) ?? channels[0]
      const modelOptions = activeChannel?.models ?? []

      const save = async () => {
        setSaveState({ kind: 'busy' })
        try {
          const value = await call('/config/set', { config: draft })
          const next = { ...value.config, preferences: { ...value.config.preferences, allowRemote: draft.preferences.allowRemote } }
          setSaved(next)
          setDraft(JSON.parse(JSON.stringify(next)))
          setSaveState({ kind: 'saved' })
        } catch (error) {
          setSaveState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }

      const generate = async () => {
        const prompt = gen.prompt.trim()
        if (prompt.length === 0) {
          setGen((current) => ({ ...current, error: t('generateEmptyPrompt'), message: '' }))
          return
        }
        const controller = new AbortController()
        abortRef.current = controller
        setGen((current) => ({ ...current, busy: true, error: null, notes: [], message: '' }))
        try {
          // The page's own fetch cannot ride `call`, because cancellation has to
          // reach the socket for the host to abort the upstream request too.
          const response = await fetch(`${API}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channelId: draft.defaultChannelId,
              model: draft.preferences.defaultModel,
              prompt,
              size: draft.preferences.size,
              count: draft.preferences.count,
              // This page is a channel check, not a gallery: keep its output in
              // the system temp area instead of the operator's home.
              temporary: true,
            }),
            signal: controller.signal,
          })
          const payload = await response.json()
          if (payload.ok !== true) {
            // Carry the machine code so the failure can be explained in the
            // operator's language, exactly like every other call on this page.
            const failure = new Error(payload.message ?? `HTTP ${response.status}`)
            failure.code = payload.code
            throw failure
          }
          setGen((current) => ({
            ...current,
            busy: false,
            images: payload.value.images,
            notes: payload.value.notes ?? [],
            message: payload.value.notes?.length > 0 ? fill(t('generatePartial'), payload.value.notes.join('；')) : t('generateDone'),
          }))
        } catch (error) {
          const aborted = error instanceof DOMException && error.name === 'AbortError'
          setGen((current) => ({
            ...current,
            busy: false,
            error: aborted ? null : fill(t('generateFailed'), describeError(error, t)),
            message: aborted ? t('generateCancel') : '',
          }))
        } finally {
          abortRef.current = null
        }
      }

      const headline = status.kind === 'error' ? t('statusError')
        : channels.length === 0 ? t('statusNoChannel')
          : draft.enabled === false ? t('statusDisabled')
            : t('statusReady')
      const tone = channels.length === 0 ? 'warn' : draft.enabled === false ? 'warn' : 'ready'

      return h('div', { className: 'dis-root' },
        h('header', { className: 'dis-head' },
          h('h2', { className: 'dis-title' }, t('title')),
          h('p', { className: 'dis-sub' }, t('subtitle')),
          h('span', { className: 'dis-pill', 'data-tone': tone }, headline),
        ),

        // ---- master switch -------------------------------------------------
        h(Card, { title: t('enabled'), hint: t('enabledHint') },
          h(SwitchRow, {
            label: t('enabled'), hint: '',
            checked: draft.enabled !== false,
            onChange: (checked) => patch({ enabled: checked }),
          }),
        ),

        // ---- channels ------------------------------------------------------
        h(Card, {
          title: t('channels'),
          hint: t('channelsHint'),
          action: h('button', {
            type: 'button', className: 'dis-btn', 'data-size': 'sm',
            onClick: () => {
              const id = newId()
              patch({
                channels: [...channels, { id, name: '', baseUrl: '', apiKey: '', apiKeyEnv: '', models: [], responseFormat: 'url', hasKey: false }],
                defaultChannelId: draft.defaultChannelId || id,
              })
              setOpenId(id)
            },
          }, `+ ${t('addChannel')}`),
        },
          channels.length === 0
            ? h(Note, null, t('noChannels'))
            : channels.map((channel, index) => h(ChannelEditor, {
              key: channel.id,
              t,
              channel,
              index,
              open: openId === channel.id,
              defaultChannel: channel.id === draft.defaultChannelId,
              // The saved counterpart, so the editor can tell an edited endpoint
              // from an untouched one and probe the right thing.
              savedChannel: (saved.channels ?? []).find((entry) => entry.id === channel.id),
              onToggle: () => setOpenId(openId === channel.id ? null : channel.id),
              onChange: (next) => patch({ channels: channels.map((entry) => (entry.id === next.id ? next : entry)) }),
              onRemove: () => {
                const remaining = channels.filter((entry) => entry.id !== channel.id)
                patch({
                  channels: remaining,
                  defaultChannelId: draft.defaultChannelId === channel.id ? (remaining[0]?.id ?? '') : draft.defaultChannelId,
                })
              },
            })),
        ),

        // ---- preferences ---------------------------------------------------
        h(Card, { title: t('preferences'), hint: null },
          channels.length > 1 ? h(Field, { label: t('defaultChannel') },
            h('select', {
              className: 'dis-select', value: draft.defaultChannelId,
              onChange: (e) => patch({ defaultChannelId: e.target.value, preferences: { ...draft.preferences, defaultModel: '' } }),
            }, channels.map((channel) => h('option', { key: channel.id, value: channel.id }, channel.name || channel.baseUrl))),
          ) : null,
          h(Field, { label: t('defaultModel') },
            h('select', {
              className: 'dis-select', value: draft.preferences.defaultModel,
              onChange: (e) => patchPrefs({ defaultModel: e.target.value }),
            },
              h('option', { value: '' }, t('defaultModelAuto')),
              modelOptions.map((model) => h('option', { key: model, value: model }, model)),
            ),
          ),
          h(Field, { label: t('size') },
            h('select', {
              className: 'dis-select', value: draft.preferences.size,
              onChange: (e) => patchPrefs({ size: e.target.value }),
            },
              h('option', { value: '1024x1024' }, '1024 × 1024'),
              h('option', { value: '1024x1536' }, '1024 × 1536 (竖)'),
              h('option', { value: '1536x1024' }, '1536 × 1024 (横)'),
              h('option', { value: '' }, t('sizeAuto')),
            ),
          ),
          h(Field, { label: t('count') },
            h('select', {
              className: 'dis-select', value: String(draft.preferences.count),
              onChange: (e) => patchPrefs({ count: Number(e.target.value) }),
            }, [1, 2, 3, 4].map((n) => h('option', { key: n, value: String(n) }, String(n)))),
          ),
          h(Field, { label: t('timeout'), help: t('timeoutHint') },
            h('input', {
              className: 'dis-input', type: 'number', inputMode: 'numeric', min: 30, max: 1800, step: 30,
              value: Math.round(draft.preferences.timeoutMs / 1000),
              onChange: (e) => patchPrefs({ timeoutMs: Math.max(30, Number(e.target.value) || 300) * 1000 }),
            }),
          ),
          h(SwitchRow, {
            label: t('allowRemote'), hint: t('allowRemoteHint'),
            checked: draft.preferences.allowRemote === true,
            onChange: (checked) => patchPrefs({ allowRemote: checked }),
          }),
        ),

        // ---- generation ----------------------------------------------------
        h(Card, { title: t('generate'), hint: t('generateHint') },
          h(Field, { label: t('prompt') },
            h('textarea', {
              className: 'dis-textarea', value: gen.prompt,
              placeholder: t('promptPlaceholder'),
              onChange: (e) => setGen((current) => ({ ...current, prompt: e.target.value })),
            }),
          ),
          h('div', { className: 'dis-actions' },
            h('button', {
              type: 'button', className: 'dis-btn', 'data-variant': 'primary', 'data-block': gen.busy ? undefined : '1',
              disabled: gen.busy || channels.length === 0 || draft.enabled === false,
              onClick: () => void generate(),
            }, gen.busy ? t('generating') : t('generateRun')),
            gen.busy ? h('button', {
              type: 'button', className: 'dis-btn',
              onClick: () => abortRef.current?.abort(),
            }, t('generateCancel')) : null,
          ),
          gen.error ? h(Note, { tone: 'error' }, gen.error) : null,
          !gen.error && gen.message ? h(Note, { tone: 'ok' }, gen.message) : null,
          gen.notes.length > 0 ? h(Note, { tone: 'warn' }, gen.notes.join('；')) : null,
          gen.images.length > 0 ? h('div', { className: 'dis-grid' },
            gen.images.map((image) => h('figure', { key: image.name, className: 'dis-shot', style: { margin: 0 } },
              h('img', { src: image.url, alt: gen.prompt.slice(0, 80), loading: 'lazy' }),
              h('figcaption', { className: 'dis-shot-bar' },
                h('span', null, `${image.width ?? '?'}×${image.height ?? '?'} · ${(image.bytes / 1024).toFixed(0)} KB`),
                h('a', { href: image.url, download: image.name }, t('download')),
              ),
            )),
          ) : null,
        ),

        // ---- sticky save bar ----------------------------------------------
        h('div', { className: 'dis-sticky' },
          h('span', { className: 'dis-sticky-text' },
            saveState.kind === 'error' ? fill(t('saveFailed'), saveState.message)
              : dirty ? t('dirty')
                : saveState.kind === 'saved' ? t('saved')
                  : t('clean'),
          ),
          dirty ? h('button', {
            type: 'button', className: 'dis-btn',
            onClick: () => setDraft(JSON.parse(JSON.stringify(saved))),
          }, t('reset')) : null,
          h('button', {
            type: 'button', className: 'dis-btn', 'data-variant': 'primary',
            disabled: !dirty || saveState.kind === 'busy',
            onClick: () => void save(),
          }, saveState.kind === 'busy' ? t('saving') : t('save')),
        ),

        status.root ? h('p', { className: 'dis-mono' }, `${t('dataDir')}: ${status.root}`) : null,
      )
    }

    // ---------------------------------------------------------------------
    // inline result view
    // ---------------------------------------------------------------------

    /** The same-origin URL that serves one durable attachment by reference. */
    function attachmentUrl(ref) {
      const query = new URLSearchParams({
        attachment_id: String(ref.attachmentId),
        media_type: String(ref.mediaType),
        bytes: String(ref.bytes),
        width: String(ref.width),
        height: String(ref.height),
      })
      return `${API}/attachment?${query.toString()}`
    }

    /** Image references carried by one settled tool call. */
    function imageRefsOf(block) {
      if (block === undefined || block === null || block.kind !== 'tool-result') return []
      if (!Array.isArray(block.content)) return []
      return block.content.flatMap((part) => (part?.type === 'image' && part.attachment !== undefined ? [part.attachment] : []))
    }

    /** The text a settled tool call carries. */
    function textOf(block) {
      if (block === undefined || block === null || block.kind !== 'tool-result') return ''
      if (!Array.isArray(block.content)) return ''
      return block.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
    }

    /**
     * The transcript row for `generate_image`.
     *
     * The generic tool card renders a result's text but not its image blocks, so
     * without this view a successful generation is invisible: the picture exists
     * and the model received it, yet the transcript shows nothing. The image
     * references are read straight off the settled result and resolved through
     * the plugin's own attachment route, because tool-result images are
     * deliberately absent from the session content the harness's own loader
     * serves.
     *
     * @param props - the owner's call identity, phase block, and locale reader.
     * @returns the running, generated, or failed row.
     */
    function GenerateImageView(props) {
      const t = props.t ?? ((key) => key)
      const block = props.block
      // A running call is `kind: 'tool-call'`; only a settled result carries
      // content, which is also the only stage an image can exist in.
      const settled = block !== undefined && block !== null && block.kind === 'tool-result'
      const failed = settled && block.isError === true
      const refs = imageRefsOf(block)
      const note = textOf(block)

      return h('section', { className: 'dis-tv', 'data-state': failed ? 'failed' : settled ? 'done' : 'running' },
        h('header', { className: 'dis-tv-head' },
          h('strong', null, props.toolName ?? 'generate_image'),
          h('span', { className: 'dis-tv-status' }, !settled ? t('resultRunning') : failed ? t('resultFailed') : t('resultDone')),
        ),
        // The harness already localizes its own failures into the result text;
        // echoing it is what makes an upstream message visible to the operator.
        note !== '' ? h('p', { className: 'dis-tv-note' }, note) : null,
        refs.length > 0
          ? h('div', { className: 'dis-tv-images' }, refs.map((ref) => {
            const url = attachmentUrl(ref)
            return h('a', {
              key: String(ref.attachmentId), className: 'dis-tv-image',
              href: url, target: '_blank', rel: 'noreferrer', title: t('resultOpen'),
            }, h('img', { src: url, alt: ref.name ?? t('resultAlt'), loading: 'lazy' }))
          }))
          : null,
        settled && !failed && refs.length === 0 ? h('p', { className: 'dis-tv-note' }, t('resultLoading')) : null,
      )
    }

    // ---------------------------------------------------------------------
    // plugin
    // ---------------------------------------------------------------------

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale']

    /**
     * Mount the Image Studio page.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ensureStyles()
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-image-studio: dictionaries')
      // `slots.inject` consumes a GENERATOR of disposers, not a plain callback.
      // Handed a function that merely RETURNS a disposer it never runs the
      // registration at all — and because an unclaimed key silently falls back
      // to the generic tool row, the only symptom is a picture that never
      // appears, with nothing in the console to explain it.
      ctx.effect(() => ctx.slots.inject('tool.call.toolview', function* () {
        yield ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'generate_image',
          locale: NS,
        }, GenerateImageView)
      }), 'dsh-image-studio: image result view')
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'image-studio',
        order: 17,
        label: () => t('title'),
        locale: NS,
        inject: () => ({}),
      }, ImageStudioPage)), 'dsh-image-studio: settings page')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
