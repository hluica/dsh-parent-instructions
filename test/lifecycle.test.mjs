/**
 * Lifecycle and validation harness for the parent-instructions client half.
 *
 * Run:  node test/lifecycle.test.mjs
 *
 * Executes the real `client.js` under stub React / DOM / Cordis surfaces. The
 * DOM rendering itself needs a browser, so this test covers the contract:
 * module capture, injection list, one settings row, one style tag, the
 * configForms read/write wiring, and the pure marker validator the row uses.
 */

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function createElement(type, props, ...children) {
  const next = { ...(props || {}) }
  if (children.length === 1) next.children = children[0]
  else if (children.length > 1) next.children = children
  return { type, props: next }
}

const React = {
  createElement,
  useState: (init) => {
    const index = hookCursor++
    if (hookState[index] === undefined) hookState[index] = typeof init === 'function' ? init() : init
    return [
      hookState[index],
      (next) => {
        hookState[index] = typeof next === 'function' ? next(hookState[index]) : next
      },
    ]
  },
  useReducer: (_reducer, initial) => {
    hookCursor += 1
    return [initial, () => {}]
  },
  useEffect: (fn) => {
    const cleanup = fn()
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  useSyncExternalStore: (_subscribe, get) => get(),
}

let hookCursor = 0
const hookState = []

const styleTags = []
globalThis.document = {
  createElement: (tag) => ({ tag, dataset: {}, textContent: '', remove() {} }),
  head: {
    appendChild(node) {
      node.parentNode = this
      styleTags.push(node)
    },
  },
}

let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}

const clientPath = new URL('../client.js', import.meta.url)
await import(clientPath.href)

check('module registers a factory', definition !== null && typeof definition.factory === 'function')
check('factory id is the package name', definition?.id === '@local/dsh-parent-instructions', definition?.id)
check('module load has no visible side effect', styleTags.length === 0, `style tags: ${styleTags.length}`)

const dictionaries = new Map()
const effects = []
const slotInjections = []
const registrations = []
const localeRegistrations = []
const formGets = []
const subscribers = []
const writes = []

const form = {
  getSnapshot() {
    return { value: { parentRootMarker: '.dsh-parent-root' } }
  },
  subscribe(listener) {
    subscribers.push(listener)
    return () => {}
  },
  async set(field, value) {
    writes.push(['set', field, value])
    return true
  },
  async unset(field) {
    writes.push(['unset', field])
    return true
  },
}

const ctx = {
  effect(fn, label) {
    effects.push(label)
    const cleanup = fn()
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  slots: {
    inject(key, callback) {
      slotInjections.push(key)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register(namespace, dict) {
      localeRegistrations.push(namespace)
      dictionaries.set(namespace, dict)
      return () => {}
    },
    subscribe() {
      return () => {}
    },
    bind(namespace) {
      const registered = dictionaries.get(namespace) ?? {}
      const dict = registered.zh ?? registered
      return (key, params) => {
        let text = dict[key] ?? key
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) {
            text = text.replaceAll(`{${name}}`, String(value))
          }
        }
        return text
      }
    },
  },
  configForms: {
    get(namespace) {
      formGets.push(namespace)
      return form
    },
  },
}

const plugin = definition.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

check('declares the client injection list', JSON.stringify(plugin.inject) === '["slots","locale","configForms"]', JSON.stringify(plugin.inject))

plugin.apply(ctx)

check('appends one style tag', styleTags.length === 1, `got ${styleTags.length}`)
check('style is owned by this bundle', styleTags[0]?.dataset?.plugin === '@local/dsh-parent-instructions')
check('registers the locale dictionary', localeRegistrations.includes('settings.parentInstructions'))
check('reads its own settings namespace', formGets.includes('dsh-parent-instructions'), JSON.stringify(formGets))
check('subscribes to the shared form', subscribers.length === 1, `got ${subscribers.length}`)
check('injects into the General settings row slot', slotInjections.includes('settings.general.item'))
check('registers exactly one row', registrations.length === 1, `got ${registrations.length}`)
check('row id is parent-root-marker', registrations[0]?.options?.id === 'parent-root-marker', JSON.stringify(registrations[0]?.options))
check('row order is 11.6', registrations[0]?.options?.order === 11.6, String(registrations[0]?.options?.order))
check('row component is a function', typeof registrations[0]?.component === 'function')

function renderRow() {
  hookCursor = 0
  return registrations[0].component()
}

const tree = renderRow()
check('row root is an entry container', tree?.type === 'div' && tree?.props?.className === 'dpi-entry', JSON.stringify(tree?.type))

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}

const inputs = []
const buttons = []
const texts = []
walk(tree, (node) => {
  if (node.type === 'input') inputs.push(node)
  if (node.type === 'button') buttons.push(node)
  if (node.type === 'div' && typeof node.props?.children === 'string') texts.push(node.props.children)
})

check('renders one input', inputs.length === 1, `got ${inputs.length}`)
check('input mirrors the saved marker', inputs[0]?.props?.value === '.dsh-parent-root', JSON.stringify(inputs[0]?.props?.value))
check('input has an accessible label', typeof inputs[0]?.props?.['aria-label'] === 'string' && inputs[0].props['aria-label'] !== '')
check('renders save and reset', buttons.length === 2, `got ${buttons.length}`)
check('save is disabled while unchanged', buttons[0]?.props?.disabled === true)
check('reset stays available', buttons[1]?.props?.disabled === false)
check('status names the active marker', texts.some(text => text.includes('已启用：.dsh-parent-root')), JSON.stringify(texts))

// Simulate one edit and one reset through the actual row handlers.
inputs[0].props.onChange({ target: { value: 'CUSTOM_MARKER' } })
const edited = renderRow()
const editedInputs = []
const editedButtons = []
walk(edited, (node) => {
  if (node.type === 'input') editedInputs.push(node)
  if (node.type === 'button') editedButtons.push(node)
})
check('draft renders in the input', editedInputs[0]?.props?.value === 'CUSTOM_MARKER', JSON.stringify(editedInputs[0]?.props?.value))
check('save enables for a valid dirty draft', editedButtons[0]?.props?.disabled === false)
editedButtons[0].props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
check(
  'save writes through configForms',
  writes.some(write => write[0] === 'set' && write[1] === 'parentRootMarker' && write[2] === 'CUSTOM_MARKER'),
  JSON.stringify(writes),
)

const afterSave = renderRow()
const afterSaveButtons = []
walk(afterSave, (node) => {
  if (node.type === 'button') afterSaveButtons.push(node)
})
afterSaveButtons[1].props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
check(
  'reset clears the profile override',
  writes.some(write => write[0] === 'unset' && write[1] === 'parentRootMarker'),
  JSON.stringify(writes),
)

const { normalizeMarker, readSaved } = plugin.__test
check('empty marker is valid and disables', JSON.stringify(normalizeMarker('')) === JSON.stringify({ ok: true, value: '', error: undefined }))
check('default marker is valid', normalizeMarker('.dsh-parent-root').ok === true)
check('path separators are rejected', normalizeMarker('a/b').error === 'error.separator')
check('backslashes are rejected', normalizeMarker('a\\b').error === 'error.separator')
check('dot entries are rejected', normalizeMarker('..').error === 'error.dot')
check('oversized markers are rejected', normalizeMarker('x'.repeat(129)).error === 'error.length')
check('control characters are rejected', normalizeMarker('a\u0001b').error === 'error.control')
check('readSaved returns the form value', readSaved(form) === '.dsh-parent-root')
check(
  'readSaved falls back to the default',
  readSaved({ getSnapshot: () => ({ value: {} }) }) === '.dsh-parent-root',
)

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
