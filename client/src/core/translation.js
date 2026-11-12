/**
 * Shared translation-engine store (sidebar settings sheet + reader).
 *
 * The reader only observes the snapshot to label engines; requests keep using
 * `api('translate.text', { provider: 'auto' })` so the Host fallback chain stays
 * authoritative. Settings changes here broadcast to every subscriber.
 */
import { defaultApi } from './api.js'

let snapshot = {
  settings: { provider: 'auto', fallback: true },
  providers: [],
  status: 'idle',
  updatedAt: 0,
  lastTest: null,
}
const listeners = new Set()

function emit() {
  listeners.forEach((listener) => {
    try {
      listener()
    } catch (error) {
      console.warn('[pappers-hall] translation listener failed', error)
    }
  })
}

function publish(patch) {
  snapshot = Object.assign({}, snapshot, patch, { updatedAt: Date.now() })
  emit()
}

function mergeSettings(value) {
  const settings = value && typeof value === 'object' ? value : {}
  return {
    provider: typeof settings.provider === 'string' ? settings.provider : snapshot.settings.provider,
    fallback: settings.fallback !== false,
  }
}

export const translationStore = {
  getSnapshot() {
    return snapshot
  },
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  async refresh() {
    publish({ status: 'loading' })
    try {
      const [providersResult, settingsResult] = await Promise.allSettled([defaultApi('translate.providers', {}), defaultApi('translate.settings', {})])
      const providers =
        providersResult.status === 'fulfilled' && providersResult.value && Array.isArray(providersResult.value.items)
          ? providersResult.value.items
          : snapshot.providers
      const settings = settingsResult.status === 'fulfilled' ? mergeSettings(settingsResult.value) : snapshot.settings
      publish({ providers: providers, settings: settings, status: 'ready' })
      return snapshot
    } catch (error) {
      publish({ status: 'error' })
      throw error
    }
  },
  async setProvider(provider) {
    const next = String(provider || 'auto')
    publish({ settings: Object.assign({}, snapshot.settings, { provider: next }) })
    try {
      const value = await defaultApi('translate.settings', { provider: next })
      publish({ settings: mergeSettings(value || {}) })
    } catch (error) {
      publish({ status: 'error' })
      throw error
    }
    return snapshot.settings
  },
  async setFallback(enabled) {
    publish({ settings: Object.assign({}, snapshot.settings, { fallback: enabled !== false }) })
    try {
      const value = await defaultApi('translate.settings', { fallback: enabled !== false })
      publish({ settings: mergeSettings(value || {}) })
    } catch (error) {
      publish({ status: 'error' })
      throw error
    }
    return snapshot.settings
  },
  /** Test one short text through the Host auto chain; returns an honest result. */
  async test(text) {
    const sample = String(text || 'We propose a general paradigm that combines reasoning and acting.')
    const started = Date.now()
    try {
      const value = await defaultApi('translate.text', { text: sample, target: 'zh', provider: 'auto', fast: true })
      const latencyMs = Number(value && value.latencyMs) || Date.now() - started
      const ok = Boolean(value && value.status === 'translated' && value.translation)
      const result = {
        ok: ok,
        translation: ok ? String(value.translation) : '',
        provider: value && value.provider ? String(value.provider) : '',
        engine: (value && value.engine) || null,
        latencyMs: latencyMs,
        cached: Boolean(value && value.cached),
        reason: ok ? '' : String((value && value.reason) || 'unavailable'),
      }
      if (result.provider) {
        const providers = snapshot.providers.map((provider) => (provider.id === result.provider ? Object.assign({}, provider, { lastLatencyMs: latencyMs, available: true, lastError: '' }) : provider))
        publish({ providers: providers, lastTest: result })
      } else {
        publish({ lastTest: result })
      }
      return result
    } catch (error) {
      const result = { ok: false, translation: '', provider: '', engine: null, latencyMs: Date.now() - started, cached: false, reason: error && error.message ? error.message : String(error) }
      publish({ lastTest: result, status: 'error' })
      return result
    }
  },
}

/** Human label for a provider id (settings sheet + reader badges). */
export function providerLabel(t, provider) {
  const key = 'translation.provider.' + String(provider || 'auto')
  const text = t(key)
  return text === key ? String(provider || 'auto') : text
}

export function engineLabel(t, engine) {
  if (!engine) return ''
  if (engine.label) return String(engine.label)
  return providerLabel(t, engine.id)
}
