/**
 * Plugin-level pending store shared by the conversation drawer, the composer
 * dock, the library details pane and the reader.
 *
 * `references.commit` returns a durable bundle; nothing here sends a message.
 * The store lives in this module so it survives surface remounts, and
 * `createPendingStore()` is idempotent: index.jsx creates one instance while the
 * tool cards import `pendingStore`, and both must observe the same bundles.
 */

/** Readable text for a `references.commit` display value. */
export function displayTextOf(display) {
  if (typeof display === 'string') return display
  if (Array.isArray(display)) return display.filter((part) => typeof part === 'string').join(' · ')
  return ''
}

/** Normalise one committed material, keeping locally known titles. */
export function normalizeMaterial(item, fallback) {
  const base = fallback || {}
  const kind = String((item && item.kind) || base.kind || 'paper')
  const id = String((item && (item.id || item.paperId)) || base.id || '')
  if (!id) return null
  const material = { kind, id }
  const pageValue = item && item.page != null ? Number(item.page) : base.page
  if (Number.isFinite(pageValue) && pageValue > 0) material.page = pageValue
  const title = String((item && (item.title || item.titleZh)) || base.title || '')
  if (title) material.title = title
  const figureLabel = (item && (item.figureLabel || item.label)) || base.figureLabel
  if (figureLabel) material.figureLabel = String(figureLabel)
  if (item && item.paperId) material.paperId = String(item.paperId)
  return material
}

/** Merge a commit result's materials with locally known titles. */
export function normalizeMaterials(materials, fallback) {
  const fallbackList = Array.isArray(fallback) ? fallback.filter(Boolean) : []
  const list = Array.isArray(materials) ? materials : []
  if (list.length === 0) return fallbackList
  const result = []
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    const fallbackItem =
      fallbackList[index] ||
      fallbackList.find(
        (candidate) =>
          candidate &&
          candidate.kind === (item && item.kind) &&
          String(candidate.id) === String((item && (item.id || item.paperId)) || ''),
      )
    const material = normalizeMaterial(item, fallbackItem)
    if (material) result.push(material)
  }
  return result.length > 0 ? result : fallbackList
}

function createStore() {
  let state = { bundles: [], revision: 0 }
  const listeners = new Set()

  function publish(bundles) {
    state = { bundles: bundles, revision: state.revision + 1 }
    listeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        console.error('[pappers-hall] pending listener failed', error)
      }
    })
  }

  function update(bundleId, transform) {
    let changed = false
    const bundles = []
    state.bundles.forEach((bundle) => {
      if (bundle.bundleId !== bundleId) {
        bundles.push(bundle)
        return
      }
      const next = transform(bundle)
      if (next === null) {
        changed = true
        return
      }
      if (next !== bundle) changed = true
      bundles.push(next || bundle)
    })
    if (changed) publish(bundles)
  }

  return {
    getSnapshot() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /**
     * Add one committed bundle (deduplicated by bundleId).
     * @param {object} result `references.commit` result.
     * @param {Array|undefined} fallbackMaterials locally known materials for titles.
     * @returns {object|null} the stored entry.
     */
    add(result, fallbackMaterials, options) {
      if (!result || !result.bundleId) return null
      const opts = options || {}
      const bundleId = String(result.bundleId)
      const entry = {
        bundleId: bundleId,
        token: typeof result.token === 'string' ? result.token : '',
        display: displayTextOf(result.display),
        materials: normalizeMaterials(result.materials, fallbackMaterials),
        added: false,
        createdAt: Date.now(),
        sessionId: opts.sessionId ? String(opts.sessionId) : null,
        autoInsert: opts.autoInsert === true,
        targetLabel: opts.targetLabel ? String(opts.targetLabel) : '',
      }
      const existing = state.bundles.find((bundle) => bundle.bundleId === bundleId)
      if (existing) {
        publish(state.bundles.map((bundle) => (bundle.bundleId === bundleId ? Object.assign({}, entry, { added: bundle.added }) : bundle)))
      } else {
        publish([entry].concat(state.bundles))
      }
      return entry
    },
    /** Alias used by older callers/readers. */
    addBundle(result, fallbackMaterials) {
      return this.add(result, fallbackMaterials)
    },
    remove(bundleId) {
      publish(state.bundles.filter((bundle) => bundle.bundleId !== bundleId))
    },
    removeMaterial(bundleId, index) {
      update(bundleId, (bundle) => {
        const materials = bundle.materials.filter((material, materialIndex) => materialIndex !== index)
        return materials.length === 0 ? null : Object.assign({}, bundle, { materials: materials })
      })
    },
    markAdded(bundleId) {
      update(bundleId, (bundle) => (bundle.added ? bundle : Object.assign({}, bundle, { added: true })))
    },
    clear() {
      publish([])
    },
  }
}

/** The one pending store every surface shares. */
export const pendingStore = createStore()

/** Idempotent factory used by index.jsx. */
export function createPendingStore() {
  return pendingStore
}
