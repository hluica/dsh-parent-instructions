/**
 * Host half of the parent-workspace instruction bundle.
 *
 * The shipped `@deepseek-ai/dsh-agent-instructions` plugin loads the user-global
 * files and the project chain from the nearest `.git` root down to the session
 * working directory. A nested workspace that is itself a Git repository stops
 * that chain at its own root, so the guidance of the enclosing workspace is
 * never loaded.
 *
 * This plugin is additive: it leaves the shipped chain untouched and contributes
 * one runtime-context section holding the instruction files from the nearest
 * ancestor carrying the configured parent-root marker down to (but excluding)
 * the built-in project root. The section is a durable user-role snapshot owned
 * by the runtime-context producer, so it never enters the system prompt and
 * never uses the `agent-instructions` source kind the shipped plugin filters on.
 *
 * @module @local/dsh-parent-instructions
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin; equals this bundle's Loader entry id. */
export const SETTINGS_NAMESPACE = 'dsh-parent-instructions'

/** Unique runtime-context section name. */
export const PARENT_CONTEXT_NAME = 'parent-workspace-instructions'

/** Runtime-context position: after the shipped context rows. */
export const PARENT_CONTEXT_ORDER = 250

/** Host Config field carrying the global parent-root marker. */
export const CONFIG_FIELD = 'parentRootMarker'

/** Default marker a user can drop at the parent workspace root. */
export const DEFAULT_PARENT_ROOT_MARKER = '.dsh-parent-root'

/** Instruction candidates, matching the shipped plugin's defaults. */
const CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']

/** Marker that identifies the built-in project root in the shipped presets. */
const BUILTIN_ROOT_MARKER = '.git'

/** Largest single parent instruction file accepted before reading. */
const MAX_SOURCE_BYTES = 256 * 1024

/** Total byte budget for the rendered parent section. */
const MAX_TOTAL_BYTES = 32 * 1024

/** Longest accepted marker name. */
const MAX_MARKER_LENGTH = 128

/** Upper bound on rendered-text cache entries. */
const MAX_CACHE_ENTRIES = 64

/** Rendered text cache keyed by a probe signature (paths, mtimes, sizes). */
const renderCache = new Map()

/** Global parent-root marker, editable from Settings. */
export const Config = z.object({
  [CONFIG_FIELD]: z.string().default(DEFAULT_PARENT_ROOT_MARKER).volatile(),
})

/** Services the Host half needs before it can mount. */
export const inject = ['systemPrompt', 'workingDirectory']

function statOrUndefined(path) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

function exists(path) {
  return statOrUndefined(path) !== undefined
}

/**
 * Normalize a user-supplied marker name.
 *
 * A marker is a single directory entry: no path separators, no control
 * characters, and never `.` or `..`. An empty or invalid value disables the
 * supplement; the Host repeats this validation so a hand-edited profile patch
 * cannot escape the intended shape.
 * @param value - raw configured value.
 * @returns the usable marker name, or `''` when disabled/invalid.
 */
export function normalizeParentRootMarker(value) {
  if (typeof value !== 'string') return ''
  const marker = value.trim()
  if (marker === '' || marker === '.' || marker === '..') return ''
  if (marker.length > MAX_MARKER_LENGTH) return ''
  if (marker.includes('/') || marker.includes('\\')) return ''
  if (/[\u0000-\u001f\u007f]/u.test(marker)) return ''
  return marker
}

/**
 * Find the nearest ancestor (including `start`) containing `marker`.
 * @param start - absolute directory where the walk begins.
 * @param marker - directory entry name.
 * @returns the absolute directory, or `undefined` when no ancestor has it.
 */
function nearestAncestorWith(start, marker) {
  let directory = resolve(start)
  for (;;) {
    if (exists(join(directory, marker))) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Mirror the shipped plugin's project-root rule for the current presets.
 * @param cwd - absolute session working directory.
 * @returns the nearest `.git` ancestor, or `cwd` when none exists.
 */
export function findBuiltinProjectRoot(cwd) {
  const directory = resolve(cwd)
  return nearestAncestorWith(directory, BUILTIN_ROOT_MARKER) ?? directory
}

/**
 * Build the inclusive directory chain from `top` down to `leaf`.
 * @param top - broadest directory (an ancestor of `leaf`).
 * @param leaf - most specific directory.
 * @returns directories ordered broad to specific.
 */
function ancestorChain(top, leaf) {
  const chain = []
  let current = resolve(leaf)
  const stop = resolve(top)
  while (current !== stop) {
    chain.push(current)
    const parent = dirname(current)
    /* v8 ignore next -- parentRoot is always an ancestor of leaf by construction. */
    if (parent === current) break
    current = parent
  }
  chain.push(stop)
  return chain.reverse()
}

/**
 * Read the candidate files from `parentRoot` down to the parent of the built-in
 * project root, deduplicating trimmed content and recording a cache signature.
 * @param parentRoot - directory carrying the parent-root marker.
 * @param builtinRoot - project root the shipped plugin already covers.
 * @param marker - normalized marker name (part of the signature).
 * @returns loaded files (broad to specific) and their signature.
 */
function collectParentFiles(parentRoot, builtinRoot, marker) {
  const directories = ancestorChain(parentRoot, dirname(builtinRoot))
  const files = []
  const seen = new Set()
  const signature = [parentRoot, marker]

  for (const directory of directories) {
    for (const name of CANDIDATES) {
      const path = join(directory, name)
      const info = statOrUndefined(path)
      if (info === undefined) {
        signature.push(`${path}:absent`)
        continue
      }
      signature.push(`${path}:${info.mtimeMs}:${info.size}`)
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) continue
      let content
      try {
        content = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const trimmed = content.trim()
      if (trimmed === '' || seen.has(trimmed)) continue
      seen.add(trimmed)
      files.push({ path, content })
    }
  }

  return { files, signature: signature.join('\u0000') }
}

/**
 * Truncate UTF-8 text without cutting through a code point.
 * @param text - source text.
 * @param maxBytes - maximum UTF-8 bytes to keep.
 * @returns the truncated text.
 */
function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function sectionHeading(parentRoot, marker) {
  return `Parent workspace instructions (from ${marker} at ${parentRoot}; broader than the current workspace, so closer instructions take precedence):`
}

function composeSection(files, parentRoot, marker) {
  if (files.length === 0) return ''
  return [
    sectionHeading(parentRoot, marker),
    ...files.map(file => `From: ${file.path}\n\n${file.content}`),
  ].join('\n\n')
}

/**
 * Render the parent chain under the section budget, dropping broad files before
 * truncating the most specific one.
 * @param parentRoot - parent workspace root.
 * @param marker - normalized marker name.
 * @param files - candidate files ordered broad to specific.
 * @returns bounded section text, or `''` when nothing fits.
 */
function renderParentSection(parentRoot, marker, files) {
  let included = files
  let text = composeSection(included, parentRoot, marker)

  while (Buffer.byteLength(text, 'utf8') > MAX_TOTAL_BYTES && included.length > 1) {
    included = included.slice(1)
    text = composeSection(included, parentRoot, marker)
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_TOTAL_BYTES && included.length === 1) {
    const [only] = included
    const prefix = `${sectionHeading(parentRoot, marker)}\n\nFrom: ${only.path}\n\n`
    const room = MAX_TOTAL_BYTES - Buffer.byteLength(prefix, 'utf8')
    if (room <= 0) return ''
    return `${prefix}${truncateUtf8(only.content, room)}`
  }

  return text
}

/**
 * Compute the parent-instructions section for one assembly.
 *
 * Every failure returns `''` rather than throwing: this provider runs during
 * prompt assembly, where a throw would refuse the whole model request.
 * @param ctx - Host plugin context.
 * @param rawMarker - current raw `parentRootMarker` value.
 * @param agent - assembly agent, absent on diagnostics.
 * @returns the section text, or `''`.
 */
export function renderParentInstructions(ctx, rawMarker, agent) {
  const marker = normalizeParentRootMarker(rawMarker)
  if (marker === '' || agent === undefined) return ''

  let cwd
  try {
    cwd = ctx.workingDirectory.get(agent.session)
  } catch {
    return ''
  }
  if (typeof cwd !== 'string' || cwd === '') return ''

  try {
    const builtinRoot = findBuiltinProjectRoot(cwd)
    const parentRoot = nearestAncestorWith(dirname(builtinRoot), marker)
    if (parentRoot === undefined) return ''

    const { files, signature } = collectParentFiles(parentRoot, builtinRoot, marker)
    if (files.length === 0) return ''

    const cached = renderCache.get(signature)
    if (cached !== undefined) return cached

    const text = renderParentSection(parentRoot, marker, files)
    renderCache.set(signature, text)
    if (renderCache.size > MAX_CACHE_ENTRIES) {
      const oldest = renderCache.keys().next().value
      if (oldest !== undefined) renderCache.delete(oldest)
    }
    return text
  } catch (error) {
    try {
      ctx.logger?.warn?.('parent-instructions: discovery failed: %o', error)
    } catch {
      // Logging must never turn a failed discovery into a failed request.
    }
    return ''
  }
}

/**
 * Mount the Host half.
 * @param ctx - Host plugin context.
 * @param config - validated plugin Config.
 */
export function apply(ctx, config) {
  const rawMarker = () => {
    const field = config?.[CONFIG_FIELD]
    if (field === undefined) return DEFAULT_PARENT_ROOT_MARKER
    if (typeof field.get === 'function') return field.get()
    return field
  }

  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.effect(() => ctx.systemPrompt.context({
    name: PARENT_CONTEXT_NAME,
    order: PARENT_CONTEXT_ORDER,
    required: true,
    // Instruction prose may contain literal `{{name}}`; never interpolate it.
    interpolate: false,
    text: context => renderParentInstructions(ctx, rawMarker(), context?.agent),
  }), 'parent-instructions: runtime-context section')
}
