/**
 * A minimal React-shaped renderer, just enough to execute the plugin's browser
 * bundle outside a browser.
 *
 * The harness supplies `react` and `react/jsx-runtime` to client bundles at
 * runtime and neither is installed here, so the client half cannot be loaded in
 * Node without a stand-in. This one implements the four hooks the plugin uses —
 * `useState`, `useEffect`, `useRef`, `useCallback` — plus `createElement`, and
 * expands a function-component tree into a walkable element tree. That is
 * enough to prove the bundle parses, registers its slot, mounts, performs its
 * host round-trip, re-renders with the loaded configuration, and answers an
 * interaction.
 *
 * Hooks are keyed by component name plus occurrence index within a pass, which
 * holds because a re-render walks the same tree shape in the same order.
 */

/** Build a renderer instance. */
export function createMiniReact() {
  /** Persistent hook slots, keyed by component-instance + hook index. */
  const slots = new Map()
  let counts = new Map()
  let current = null
  let pending = []
  let dirty = false

  /** Open a component instance for the current pass. */
  function begin(type) {
    const name = type.displayName || type.name || 'anonymous'
    const occurrence = counts.get(name) ?? 0
    counts.set(name, occurrence + 1)
    current = { key: `${name}#${occurrence}`, cursor: 0 }
  }

  /** Take the next hook slot for the component being rendered. */
  function slot(init) {
    const key = `${current.key}:${current.cursor++}`
    if (!slots.has(key)) slots.set(key, typeof init === 'function' ? init() : init)
    return slots.get(key)
  }

  /** Whether a dependency list changed since the previous call. */
  function changed(previous, next) {
    if (previous === undefined) return true
    if (!Array.isArray(next)) return true
    return next.length !== previous.length || next.some((value, index) => value !== previous[index])
  }

  const react = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial) {
      const entry = slot({ value: typeof initial === 'function' ? initial() : initial })
      return [entry.value, (next) => {
        entry.value = typeof next === 'function' ? next(entry.value) : next
        dirty = true
      }]
    },
    useRef(initial) {
      return slot({ current: initial })
    },
    useCallback(fn, deps) {
      const entry = slot({ fn, deps })
      if (changed(entry.deps, deps)) {
        entry.fn = fn
        entry.deps = deps
      }
      return entry.fn
    },
    useEffect(fn, deps) {
      const entry = slot({ deps: undefined })
      if (changed(entry.deps, deps)) {
        entry.deps = deps
        pending.push(fn)
      }
    },
  }

  const jsxRuntime = { jsx: react.createElement, jsxs: react.createElement, Fragment: 'Fragment' }

  /** Expand one element into a tree of host nodes, resolving function components. */
  function expand(element) {
    if (element === null || element === undefined || typeof element === 'boolean') return null
    if (typeof element === 'string' || typeof element === 'number') return { type: '#text', value: String(element) }
    if (Array.isArray(element)) return { type: '#fragment', children: element.map(expand) }
    if (typeof element.type === 'function') {
      begin(element.type)
      const inner = expand(element.type(element.props))
      return inner === null ? null : { ...inner, owner: element.type }
    }
    return {
      type: element.type,
      props: element.props,
      component: element.props?.children === undefined ? null : expand(element.props.children),
    }
  }

  /** Begin a render pass: component occurrence numbering restarts each time,
   *  which is what keeps every hook slot keyed by the same component instance
   *  across re-renders. */
  function resetPass() {
    counts = new Map()
    current = null
  }

  /** Depth-first children of a node, whatever shape it took. */
  function childrenOf(node) {
    if (node === null || typeof node !== 'object') return []
    if (node.type === '#text') return []
    if (node.type === '#fragment') return node.children.filter(Boolean)
    const list = []
    if (node.component) list.push(node.component)
    return list
  }

  /** Every node in the tree, depth first. */
  function walk(node, visit) {
    if (node === null || typeof node !== 'object') return
    visit(node)
    for (const child of childrenOf(node)) walk(child, visit)
  }

  return {
    react,
    jsxRuntime,
    /** Expand an element tree. */
    expand(element) {
      resetPass()
      return expand(element)
    },
    /** Flatten a tree to its text, the way a reader would see it. */
    text(node) {
      let out = ''
      walk(node, (entry) => {
        if (entry.type === '#text') out += `${entry.value} `
      })
      return out.replace(/\s+/g, ' ').trim()
    },
    /** Every host node of one tag, in tree order. */
    hosts(node, tag) {
      const found = []
      walk(node, (entry) => {
        if (entry.type === tag) found.push(entry)
      })
      return found
    },
    /** Every node rendered by one component type, in tree order. */
    ownedBy(node, type) {
      const found = []
      walk(node, (entry) => {
        if (entry.owner === type) found.push(entry)
      })
      return found
    },
    /** Run queued effects, then re-expand until state settles. */
    async flush(element, passes = 20) {
      let tree = null
      for (let pass = 0; pass < passes; pass += 1) {
        const queued = pending
        pending = []
        dirty = false
        resetPass()
        tree = expand(element)
        for (const effect of queued) await effect()
        // Effects that start a host round trip do not await it, so yield to the
        // macrotask queue once to let those responses land before deciding the
        // tree has settled.
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (!dirty && pending.length === 0) return tree
      }
      throw new Error('effects did not settle; a hook dependency is probably unstable')
    },
  }
}
