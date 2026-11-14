/**
 * Host-half contract probe for the parent-instructions bundle.
 *
 * `verify` runs this file in a fresh process. The probe mounts the Host half
 * against a stubbed Cordis context, captures the runtime-context registration,
 * and exercises the discovery rules against temporary parent/child workspaces:
 *
 *   - only the chain strictly above the built-in `.git` root is read;
 *   - the nearest ancestor carrying the marker wins;
 *   - candidates are deduplicated by trimmed content;
 *   - invalid/empty markers and absent markers contribute nothing;
 *   - the rendered section stays under the byte budget and owns no
 *     `<system-reminder>` wrapper (the runtime-context producer supplies it).
 *
 * @module scripts/host-contract
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runProbe } from './lib/probe-runner.mjs'

/**
 * Mount one Config value against a fresh stub context.
 * @param mod - imported Host module.
 * @param rawMarker - Config override; omitted uses the schema default.
 * @returns captured context registration, call log, and controllable working directory.
 */
function mount(mod, rawMarker) {
  const config = mod.Config(rawMarker === undefined ? {} : { parentRootMarker: rawMarker })
  const registrations = []
  const calls = []
  const fiber = { name: 'probe-fiber' }
  const workingDirectory = {
    current: '',
    get() {
      return this.current
    },
  }

  const ctx = {
    fiber,
    logger: { warn() {} },
    workingDirectory,
    inject(dependencies, callback) {
      calls.push(['inject', dependencies])
      callback({
        effect(effect) {
          calls.push(['settings-effect'])
          return effect()
        },
        settings: {
          configure(options, owner) {
            calls.push(['configure', options, owner])
            return () => {}
          },
        },
      })
    },
    effect(effect, label) {
      calls.push(['effect', label])
      return effect()
    },
    systemPrompt: {
      context(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
  }

  mod.apply(ctx, config)
  return { registrations, calls, workingDirectory, config }
}

/**
 * Run the Host-half probe.
 * @param context - plugin root, bundle patch id, and assertion collector.
 * @returns the identity string `verify` compares against the patch id.
 */
export async function probeHost({ root, patchId, check }) {
  const mod = await import(pathToFileURL(join(root, 'index.js')).href)

  check('exports apply()', typeof mod.apply === 'function')
  check('exports Config', typeof mod.Config === 'function')
  const strings = Object.entries(mod).filter(([, value]) => typeof value === 'string')
  check(
    `an exported id constant equals the patch id (${patchId})`,
    strings.some(([, value]) => value === patchId),
    `exported strings: ${strings.map(([name]) => name).join(', ') || 'none'}`,
  )
  check(
    'inject waits for systemPrompt and workingDirectory',
    Array.isArray(mod.inject) && mod.inject.join(',') === 'systemPrompt,workingDirectory',
    JSON.stringify(mod.inject),
  )

  const defaults = mod.Config({})
  check(
    'Config defaults the marker to .dsh-parent-root',
    defaults.parentRootMarker?.get?.() === '.dsh-parent-root',
    JSON.stringify(defaults.parentRootMarker?.get?.()),
  )

  const mounted = mount(mod)
  check(
    'apply() injects the settings service',
    mounted.calls.some(call => call[0] === 'inject' && JSON.stringify(call[1]) === '["settings"]'),
    JSON.stringify(mounted.calls),
  )
  check(
    'apply() configures the settings namespace with auto:false and its own fiber',
    mounted.calls.some(call => call[0] === 'configure' && call[1]?.auto === false),
    JSON.stringify(mounted.calls),
  )
  check('apply() registers exactly one runtime context', mounted.registrations.length === 1, `got ${mounted.registrations.length}`)

  const definition = mounted.registrations[0]
  check(
    'context definition carries the contract',
    definition?.name === mod.PARENT_CONTEXT_NAME
      && definition?.order === mod.PARENT_CONTEXT_ORDER
      && definition?.required === true
      && definition?.interpolate === false
      && typeof definition?.text === 'function',
    definition === undefined ? 'no definition' : `${definition.name}/${definition.order}/${definition.required}/${definition.interpolate}`,
  )

  const fixture = mkdtempSync(join(tmpdir(), 'dsh-parent-probe-'))
  try {
    const family = join(fixture, 'family')
    const plugins = join(family, 'plugins')
    const child = join(plugins, 'dsh-demo')

    mkdirSync(join(child, '.git'), { recursive: true })
    writeFileSync(join(family, '.dsh-parent-root'), '')
    writeFileSync(join(family, 'AGENTS.md'), 'PARENT_RULE\n')
    writeFileSync(join(family, 'CLAUDE.md'), 'PARENT_RULE\n')
    writeFileSync(join(plugins, 'AGENTS.md'), 'MID_RULE\n')
    writeFileSync(join(child, 'AGENTS.md'), 'CHILD_RULE\n')

    const first = mount(mod, '.dsh-parent-root')
    first.workingDirectory.current = child
    const text = first.registrations[0].text({ agent: { session: {} } })

    check('reads the parent root candidate', text.includes('PARENT_RULE'))
    check('reads the intermediate candidate', text.includes('MID_RULE'))
    check('leaves the built-in chain to the shipped plugin', !text.includes('CHILD_RULE'))
    check('deduplicates trimmed content in the supplement', (text.match(/PARENT_RULE/gu) ?? []).length === 1)
    check('uses absolute source paths', text.includes(join(family, 'AGENTS.md')))
    check('does not own a system-reminder frame', !text.includes('<system-reminder>'))

    writeFileSync(join(plugins, '.dsh-parent-root'), '')
    const nearer = mount(mod, '.dsh-parent-root')
    nearer.workingDirectory.current = child
    const nearerText = nearer.registrations[0].text({ agent: { session: {} } })
    check('the nearest marker wins', nearerText.includes('MID_RULE') && !nearerText.includes('PARENT_RULE'))
    rmSync(join(plugins, '.dsh-parent-root'))

    const absent = mount(mod, 'MISSING_MARKER')
    absent.workingDirectory.current = child
    check('an absent marker contributes nothing', absent.registrations[0].text({ agent: { session: {} } }) === '')

    const invalid = mount(mod, '../escape')
    invalid.workingDirectory.current = child
    check('an invalid marker contributes nothing', invalid.registrations[0].text({ agent: { session: {} } }) === '')

    const disabled = mount(mod, '')
    disabled.workingDirectory.current = child
    check('an empty marker disables the supplement', disabled.registrations[0].text({ agent: { session: {} } }) === '')

    writeFileSync(join(child, '.inner-parent'), '')
    const below = mount(mod, '.inner-parent')
    below.workingDirectory.current = child
    check('a marker inside the built-in root is ignored', below.registrations[0].text({ agent: { session: {} } }) === '')

    mkdirSync(join(family, '.directory-marker'), { recursive: true })
    const directoryMarker = mount(mod, '.directory-marker')
    directoryMarker.workingDirectory.current = child
    const directoryText = directoryMarker.registrations[0].text({ agent: { session: {} } })
    check('a directory marker is accepted', directoryText.includes('PARENT_RULE'))

    const plain = join(family, 'plain')
    const deeper = join(plain, 'deeper')
    mkdirSync(deeper, { recursive: true })
    writeFileSync(join(plain, 'AGENTS.md'), 'PLAIN_RULE\n')
    writeFileSync(join(deeper, 'AGENTS.md'), 'DEEPER_RULE\n')
    const noGit = mount(mod, '.dsh-parent-root')
    noGit.workingDirectory.current = deeper
    const noGitText = noGit.registrations[0].text({ agent: { session: {} } })
    check('without .git the built-in root is cwd', noGitText.includes('PLAIN_RULE') && !noGitText.includes('DEEPER_RULE'))

    writeFileSync(join(family, 'AGENTS.md'), 'PARENT_RULE\n'.repeat(5000))
    const budgeted = mount(mod, '.dsh-parent-root')
    budgeted.workingDirectory.current = child
    const budgetedText = budgeted.registrations[0].text({ agent: { session: {} } })
    check(
      'rendered section stays within 32 KiB',
      Buffer.byteLength(budgetedText, 'utf8') <= 32 * 1024,
      String(Buffer.byteLength(budgetedText, 'utf8')),
    )

    return { identity: strings.find(([, value]) => value === patchId)?.[1] }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

runProbe(import.meta.url, probeHost)
