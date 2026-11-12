/**
 * Translation-engine helpers (v0.4): provider labels, engine metadata badges,
 * a preference hook over the shared client `translationStore`, and a small
 * language-detection fallback.
 *
 * Host v0.4 returns for translate.*:
 *   provider: 'google' | 'mymemory' | 'llm' | 'libretranslate'
 *   engine: { id, label, free, unofficial? }
 *   latencyMs, cached
 * The reader never invents an engine: when the Host omits the metadata the UI
 * says “翻译引擎” / “AI” based on the requested provider and keeps going.
 */
import React from 'react'

export const PROVIDER_IDS = ['auto', 'google', 'mymemory', 'llm', 'libretranslate']

export const PROVIDER_LABELS = {
  auto: '自动（Google → MyMemory → AI）',
  google: 'Google 翻译',
  mymemory: 'MyMemory',
  llm: 'AI',
  libretranslate: 'LibreTranslate',
}

const ENGINE_LABELS = {
  google: 'Google 翻译',
  mymemory: 'MyMemory',
  llm: 'AI',
  libretranslate: 'LibreTranslate',
}

/** Human label for a provider preference (settings / tooltips). */
export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || PROVIDER_LABELS.auto
}

/** Read the engine descriptor out of one translate.* result. */
export function readEngine(result, fallbackProvider) {
  const source = (result && result.engine) || null
  const provider = String((result && result.provider) || (source && source.id) || fallbackProvider || 'auto')
  const id = String((source && (source.id || source.provider)) || provider)
  // Keep the Host's full label for tooltips, but use the canonical short name in
  // badges so the UI reads `Google 翻译 · 0.4 s` instead of a long disclaimer.
  const hostLabel = String((source && source.label) || '')
  const label = ENGINE_LABELS[id] || ENGINE_LABELS[provider] || hostLabel || '翻译引擎'
  return {
    id,
    label,
    hostLabel,
    provider,
    free: source && source.free != null ? Boolean(source.free) : id === 'google' || id === 'mymemory' || id === 'libretranslate',
    unofficial: Boolean(source && source.unofficial),
    model: id === 'llm' ? '' : '',
  }
}

/** Drop Host cache placeholders such as `llm/AI 精译（LLM）` from model names. */
export function cleanModel(model, engine) {
  let value = String(model || '').trim()
  if (!value) return ''
  value = value.split('/').pop()
  if (engine && value === engine.label) return ''
  if (/^AI 精译/.test(value)) return ''
  return value
}

/** Short badge: `Google 翻译`, `MyMemory`, `AI·model`, `AI 精译`. */
export function engineTitle(engine, model) {
  if (!engine) return ENGINE_LABELS.llm
  if (engine.id === 'llm' || engine.provider === 'llm') {
    const name = cleanModel(model || engine.model, engine)
    return name ? 'AI·' + name : 'AI 精译'
  }
  return engine.label || '翻译引擎'
}

/** `Google 翻译 · 0.4 s` (+ ` · 缓存`). */
export function formatLatency(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return ''
  return value >= 1000 ? (value / 1000).toFixed(1) + ' s' : Math.round(value) + ' ms'
}

export function engineBadge(engine, model, latencyMs, cached) {
  const title = engineTitle(engine, model)
  const latency = cached && !(Number(latencyMs) > 0) ? '' : formatLatency(latencyMs)
  const parts = [title]
  if (latency) parts.push(latency)
  if (cached) parts.push('缓存')
  return parts.join(' · ')
}

/** Long tooltip text: full Host label + free/unofficial disclosure. */
export function engineDetails(engine, model) {
  const title = engineTitle(engine, model)
  const host = engine && engine.hostLabel && engine.hostLabel !== title ? '（' + engine.hostLabel + '）' : ''
  const free = engine && engine.free ? ' · 免费' : ''
  const unofficial = engine && engine.unofficial ? ' · 非官方接口' : ''
  return title + host + free + unofficial
}

/** One-letter marker used in the bilingual per-paragraph chips. */
export function engineInitial(engine, provider, cached) {
  const id = String((engine && engine.id) || (engine && engine.provider) || provider || '')
  let letter = 'A'
  if (id === 'google') letter = 'G'
  else if (id === 'mymemory') letter = 'M'
  else if (id === 'libretranslate') letter = 'L'
  else if (id === 'llm') letter = 'AI'
  return cached ? letter + '·缓存' : letter
}

/** Rough Chinese detection used when translate.detect is unavailable. */
export function isProbablyChinese(text) {
  const value = String(text || '')
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length
  const latin = (value.match(/[A-Za-z]/g) || []).length
  if (cjk === 0) return false
  return cjk >= 2 && cjk >= latin
}

/**
 * Read the shared translation preference. Accepts the client `translationStore`
 * (getSnapshot/subscribe) from center, or falls back to translate.settings.
 */
export function useTranslationPreference(context, apiCall) {
  const [snapshot, setSnapshot] = React.useState(() => {
    try {
      return (context && typeof context.getSnapshot === 'function' && context.getSnapshot()) || null
    } catch {
      return null
    }
  })

  React.useEffect(() => {
    if (!context || typeof context.subscribe !== 'function') return undefined
    let unsubscribe = () => {}
    try {
      unsubscribe = context.subscribe(() => {
        try {
          setSnapshot(context.getSnapshot() || null)
        } catch {
          /* a broken store must not break reading */
        }
      }) || (() => {})
    } catch {
      unsubscribe = () => {}
    }
    try {
      setSnapshot(context.getSnapshot() || null)
    } catch {
      /* ignore */
    }
    return () => {
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
    }
  }, [context])

  React.useEffect(() => {
    if (context) return undefined
    let alive = true
    Promise.resolve()
      .then(() => apiCall('translate.settings', {}))
      .then((result) => {
        if (!alive) return
        setSnapshot({ provider: result && result.provider, fallback: result && result.fallback, settings: result })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [apiCall, context])

  const settings = (snapshot && snapshot.settings) || snapshot || {}
  const provider = String((settings && settings.provider) || 'auto')
  const fallback = settings && settings.fallback !== undefined ? Boolean(settings.fallback) : true
  return { provider, fallback, settings, snapshot }
}
