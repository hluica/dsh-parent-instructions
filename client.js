/**
 * Client half of the parent-workspace instruction bundle.
 *
 * Registers one row in Settings → General. The row edits the Host plugin's
 * volatile `parentRootMarker` field through the shared settings form. The Host
 * half reads the accepted value on the next prompt assembly and contributes the
 * parent-workspace section; this half owns no discovery and no persistence.
 *
 * The row deliberately keeps the edit local until Save: the settings form may
 * reject a write when a higher layer overrides the entry, and the UI must show
 * that rejection instead of claiming the value was stored.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-parent-instructions',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Settings namespace owned by the Host half; equals the Loader entry id. */
    const SETTINGS_NAMESPACE = 'dsh-parent-instructions'
    /** Host Config field carrying the marker. */
    const FIELD = 'parentRootMarker'
    /** Schema default, mirrored so an empty form is still understandable. */
    const DEFAULT_MARKER = '.dsh-parent-root'
    /** Dictionary namespace carrying this row's copy. */
    const DICT_NAMESPACE = 'settings.parentInstructions'
    /** Row position: after user CSS (11.5), before transcript view (12). */
    const ROW_ORDER = 11.6
    /** Matches the Host schema's accepted marker length. */
    const MAX_MARKER_LENGTH = 128

    const CSS = `
      .dpi-entry{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:6px;container-type:inline-size}
      .dpi-head{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap}
      .dpi-title{flex:1 1 140px;min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
      .dpi-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;max-width:100%}
      .dpi-control{display:flex;align-items:center;gap:8px;flex:0 1 auto;min-width:0;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
      .dpi-input{box-sizing:border-box;width:200px;min-width:0;max-width:100%;height:32px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px;line-height:20px}
      .dpi-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
      .dpi-input:disabled{opacity:.6;cursor:default}
      .dpi-button{box-sizing:border-box;flex:0 0 auto;height:32px;padding:0 14px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
      .dpi-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
      .dpi-button:disabled{opacity:.5;cursor:default}
      .dpi-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}
      .dpi-buttonPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
      .dpi-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
      .dpi-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dpi-statusDirty{color:var(--dsw-alias-brand-primary)}
      .dpi-statusError{color:var(--dsw-alias-state-error-primary)}
      @container (max-width:540px){
        .dpi-head{flex-direction:column;align-items:stretch;gap:8px}
        .dpi-title{flex:0 0 auto}
        .dpi-control{margin-left:0;justify-content:flex-start}
        .dpi-input{flex:1 1 160px;width:auto;min-width:120px}
      }
    `

    const zh = {
      'row.title': '父工作区标记',
      'row.description': '在父工作区根放置同名文件或目录。子工作区（含独立 .git）会额外获得该父根到子工作区之上的 AGENTS.md 指导；留空关闭。',
      'field.label': '父工作区标记名',
      'field.placeholder': '.dsh-parent-root',
      'action.save': '保存',
      'action.reset': '恢复默认',
      'status.active': '已启用：{marker}',
      'status.disabled': '已禁用',
      'status.dirty': '有未保存的修改',
      'status.saving': '正在保存…',
      'status.saved': '已保存',
      'status.reset': '已恢复默认',
      'status.failed': '保存失败：设置可能被更高层覆盖',
      'error.length': '标记名不能超过 128 个字符',
      'error.separator': '标记名不能包含路径分隔符',
      'error.control': '标记名不能包含控制字符',
      'error.dot': '标记名不能是 . 或 ..',
    }

    const en = {
      'row.title': 'Parent workspace marker',
      'row.description': 'Place a file or directory with this name at the parent workspace root. A nested workspace with its own .git then also receives the AGENTS.md chain from that parent root down to, but not including, its own root. Leave empty to disable.',
      'field.label': 'Parent workspace marker name',
      'field.placeholder': '.dsh-parent-root',
      'action.save': 'Save',
      'action.reset': 'Reset',
      'status.active': 'Active: {marker}',
      'status.disabled': 'Disabled',
      'status.dirty': 'Unsaved changes',
      'status.saving': 'Saving…',
      'status.saved': 'Saved',
      'status.reset': 'Reset to default',
      'status.failed': 'Save failed: a higher profile layer may override this setting',
      'error.length': 'The marker must be at most 128 characters',
      'error.separator': 'The marker must not contain path separators',
      'error.control': 'The marker must not contain control characters',
      'error.dot': 'The marker must not be . or ..',
    }

    /** Minimal external store so the row and its form subscription share state. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        update(patch) {
          value = { ...value, ...patch }
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    /** Re-render when the active locale changes, so bound copy follows it. */
    function useLocaleRevision(ctx) {
      const [, bump] = React.useReducer(count => count + 1, 0)
      React.useEffect(() => ctx.locale.subscribe(bump), [ctx])
    }

    /**
     * Validate one marker draft. An empty value is valid and means "disabled".
     * @param raw - draft text.
     * @returns normalized value or a translation key for the first problem.
     */
    function normalizeMarker(raw) {
      const value = String(raw ?? '').trim()
      if (value === '') return { ok: true, value: '', error: undefined }
      if (value.length > MAX_MARKER_LENGTH) return { ok: false, value, error: 'error.length' }
      if (value === '.' || value === '..') return { ok: false, value, error: 'error.dot' }
      if (value.includes('/') || value.includes('\\')) return { ok: false, value, error: 'error.separator' }
      if (/[\u0000-\u001f\u007f]/u.test(value)) return { ok: false, value, error: 'error.control' }
      return { ok: true, value, error: undefined }
    }

    /**
     * Read the accepted marker from the shared form, falling back to the schema
     * default when the field is absent (or the form is not readable yet).
     * @param form - settings form for this plugin's entry.
     * @returns the current marker string.
     */
    function readSaved(form) {
      try {
        const snapshot = form.getSnapshot()
        const value = snapshot !== undefined && snapshot !== null
          && typeof snapshot.value === 'object' && snapshot.value !== null
          ? snapshot.value
          : {}
        return typeof value[FIELD] === 'string' ? value[FIELD] : DEFAULT_MARKER
      } catch {
        return DEFAULT_MARKER
      }
    }

    /**
     * Build the row component from the form and its shared store.
     * @param ctx - client cordis context.
     * @param deps - form read/write paths and shared state.
     * @returns the React row component.
     */
    function createRow(ctx, deps) {
      return function ParentRootMarkerRow() {
        const state = useStore(deps.store)
        useLocaleRevision(ctx)
        const t = ctx.locale.bind(DICT_NAMESPACE)

        const [draft, setDraft] = React.useState(null)
        const busy = state.busy
        const value = draft === null ? state.marker : draft
        const verdict = normalizeMarker(value)
        const dirty = verdict.ok && verdict.value !== state.marker
        const base = verdict.ok ? verdict.value : state.marker

        const onSave = () => {
          if (busy || !verdict.ok || !dirty) return
          deps.store.update({ busy: true, notice: undefined })
          void deps.save(verdict.value).then((ok) => {
            deps.store.update({ busy: false, notice: ok ? 'saved' : 'failed' })
            if (ok) setDraft(null)
          })
        }

        const onReset = () => {
          if (busy) return
          deps.store.update({ busy: true, notice: undefined })
          void deps.reset().then((ok) => {
            deps.store.update({ busy: false, notice: ok ? 'reset' : 'failed' })
            if (ok) setDraft(null)
          })
        }

        const status = !verdict.ok
          ? { className: 'dpi-status dpi-statusError', text: t(verdict.error) }
          : busy
            ? { className: 'dpi-status', text: t('status.saving') }
            : state.notice === 'failed'
              ? { className: 'dpi-status dpi-statusError', text: t('status.failed') }
              : dirty
                ? { className: 'dpi-status dpi-statusDirty', text: t('status.dirty') }
                : base === ''
                  ? { className: 'dpi-status', text: t('status.disabled') }
                  : state.notice === 'saved'
                    ? { className: 'dpi-status', text: t('status.saved') }
                    : state.notice === 'reset'
                      ? { className: 'dpi-status', text: t('status.reset') }
                      : { className: 'dpi-status', text: t('status.active', { marker: base }) }

        return h(
          'div',
          { className: 'dpi-entry' },
          h(
            'div',
            { className: 'dpi-head' },
            h('div', { className: 'dpi-title' }, t('row.title')),
            h(
              'div',
              { className: 'dpi-control' },
              h('input', {
                type: 'text',
                className: 'dpi-input',
                value,
                placeholder: DEFAULT_MARKER,
                maxLength: 256,
                disabled: busy,
                'aria-label': t('field.label'),
                'aria-invalid': verdict.ok ? undefined : true,
                'aria-describedby': 'dpi-parent-marker-desc dpi-parent-marker-status',
                onChange: event => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !(event.nativeEvent !== undefined && event.nativeEvent.isComposing)) {
                    event.preventDefault()
                    onSave()
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpi-button dpi-buttonPrimary',
                  disabled: busy || !verdict.ok || !dirty,
                  onClick: onSave,
                },
                t('action.save'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpi-button',
                  disabled: busy,
                  onClick: onReset,
                },
                t('action.reset'),
              ),
            ),
          ),
          h('div', { className: 'dpi-desc', id: 'dpi-parent-marker-desc' }, t('row.description')),
          h('div', { className: status.className, id: 'dpi-parent-marker-status', 'aria-live': 'polite' }, status.text),
        )
      }
    }

    /**
     * Client plugin body.
     * @param ctx - client cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@local/dsh-parent-instructions'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'parent-instructions: row styles')

      ctx.effect(() => ctx.locale.register(DICT_NAMESPACE, { zh, en }), 'parent-instructions: dictionaries')

      let form
      try {
        form = ctx.configForms.get(SETTINGS_NAMESPACE)
      } catch {
        return
      }
      if (form === undefined || form === null) return

      const store = createStore({
        marker: readSaved(form),
        busy: false,
        notice: undefined,
      })

      ctx.effect(
        () => form.subscribe(() => store.update({ marker: readSaved(form) })),
        'parent-instructions: accepted setting',
      )

      const deps = {
        store,
        save: async (value) => {
          try {
            return (await form.set(FIELD, value)) !== false
          } catch {
            return false
          }
        },
        reset: async () => {
          try {
            if (typeof form.unset === 'function') return (await form.unset(FIELD)) !== false
            return (await form.set(FIELD, DEFAULT_MARKER)) !== false
          } catch {
            return false
          }
        },
      }

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          { name: 'settings.general.item', id: 'parent-root-marker', order: ROW_ORDER },
          createRow(ctx, deps),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply,
      __test: { normalizeMarker, readSaved },
    }
  },
})
