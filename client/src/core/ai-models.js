/**
 * DSH-aligned AI model catalogue.
 *
 * The Host exposes the real `llm.listProviders()`/`llm.listModels()` registry
 * and the current `agentDefaultModel` selection. Settings and error banners use
 * this one snapshot so Pappers-Hall never offers a provider that DSH cannot call.
 */
import { defaultApi } from './api.js'

let snapshot = {
  status: 'idle',
  available: false,
  selection: null,
  providers: [],
  error: null,
  saving: false,
  updatedAt: 0,
}
const listeners = new Set()

function emit() {
  listeners.forEach((listener) => {
    try { listener() } catch (error) { console.warn('[pappers-hall] ai-models listener failed', error) }
  })
}

function publish(patch) {
  snapshot = Object.assign({}, snapshot, patch, { updatedAt: Date.now() })
  emit()
}

function normalizeModel(model) {
  if (typeof model === 'string') return { id: model, name: model }
  if (!model || typeof model !== 'object') return null
  const id = String(model.id || model.model || '')
  if (id === '') return null
  return Object.assign({}, model, { id: id, name: String(model.name || model.label || id) })
}

function normalizeProvider(provider) {
  if (!provider || typeof provider !== 'object' || typeof provider.id !== 'string') return null
  const models = Array.isArray(provider.models) ? provider.models.map(normalizeModel).filter(Boolean) : []
  return Object.assign({}, provider, {
    id: provider.id,
    name: String(provider.name || provider.label || provider.id),
    models: models,
  })
}

export const aiModelsStore = {
  getSnapshot() { return snapshot },
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  async refresh() {
    publish({ status: snapshot.updatedAt === 0 ? 'loading' : 'refreshing', error: null })
    try {
      const value = await defaultApi('ai.providers', {})
      const providers = Array.isArray(value && value.providers) ? value.providers.map(normalizeProvider).filter(Boolean) : []
      publish({
        status: 'ready',
        available: Boolean(value && value.available),
        selection: value && value.selection ? value.selection : null,
        providers: providers,
        error: null,
      })
      return snapshot
    } catch (error) {
      publish({ status: 'error', error: error })
      throw error
    }
  },
  async setDefault(selection) {
    if (snapshot.saving) return snapshot
    publish({ saving: true, error: null })
    try {
      const value = await defaultApi('ai.setDefault', { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) })
      if (!value || value.ok === false) throw new Error((value && value.reason) || 'setDefault failed')
      publish({ saving: false, selection: value.selection || selection, error: null })
      return value
    } catch (error) {
      publish({ saving: false, error: error })
      throw error
    }
  },
}

/** Pick the model a provider should start with: the DSH selection when possible. */
export function modelForProvider(catalog, providerId) {
  const provider = (catalog && catalog.providers ? catalog.providers : []).find((entry) => entry.id === providerId)
  if (!provider) return ''
  const current = catalog && catalog.selection && catalog.selection.provider === providerId ? catalog.selection.model : ''
  if (current && (provider.models.length === 0 || provider.models.some((model) => model.id === current))) return current
  return provider.models.length > 0 ? provider.models[0].id : ''
}
