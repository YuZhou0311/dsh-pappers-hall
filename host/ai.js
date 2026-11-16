/**
 * AI capabilities for the Pappers-Hall v0.2 Host (contract v0.2 §1.4).
 *
 * The Host calls the composed DSH LLM service directly — no DSH package imports,
 * no second chat log:
 *
 *   agentDefaultModel.currentSelection() → {provider, model}
 *   ctx.llm.prepareCall({provider, model, maxTokens}, signal) → call.config + call.stream
 *   for await (chunk of call.stream({...call.config, messages, system, purpose, signal}))
 *
 * Every capability is honest about availability: a missing service, an unknown
 * provider, a text-only model asked for real pixels, a timeout or a malformed
 * model answer returns `unavailable`/`error` with a reason instead of inventing
 * a translation or an answer. All calls have a deadline, a concurrency cap, an
 * in-memory LRU + SQLite cache, and an `ai_events` row (hashes only, never user
 * text).
 *
 * @module pappers-hall/host/ai
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { assessTextQuality } from './text-quality.js'
import path from 'node:path'

/** Prompt versions are part of every cache key; bump on wording changes. */
export const PROMPT_VERSIONS = {
  translateBlocks: 'translate-blocks-v2',
  translateText: 'translate-text-v2',
  translateTitle: 'translate-title-v1',
  expandQuery: 'expand-query-v2',
  rerank: 'rerank-v2',
  ask: 'ask-v1',
  folderName: 'folder-name-v1',
}

/** One stable AI failure carrying a client-facing reason. */
export class AiFailure extends Error {
  /**
   * @param {string} code unavailable|timeout|error|unsupported_input
   * @param {string} message human-readable reason.
   * @param {object} [meta] extra facts.
   */
  constructor(code, message, meta = {}) {
    super(message)
    this.name = 'AiFailure'
    this.code = code
    this.meta = meta
  }
}

/** sha256 of a UTF-8 string, used for cache keys and event rows. */
/**
 * Classify one AI failure into a compact client-facing reason token.
 * @param {unknown} error thrown failure.
 * @returns {string} reason token (timeout / provider_error:... / empty-response / error:...).
 */
export function aiFailureReason(error) {
  const message = String(error?.message ?? error ?? 'unknown AI failure')
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'timeout' || /timeout|timed out|timed-out/i.test(message)) return 'timeout'
  if (code === 'unsupported_input') return `provider_error:${message.slice(0, 160)}`
  if (/empty/i.test(message)) return 'empty-response'
  if (code === 'unavailable' || /provider|\b(?:400|401|403|404|408|429|500|502|503)\b|session/i.test(message)) {
    return `provider_error:${message.slice(0, 160)}`
  }
  return `error:${message.slice(0, 160)}`
}

/** Hash text for cache keys and provenance. */
export function hashText(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

/** Parse a JSON column defensively. */
function parseJsonColumn(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

/** Extract the first JSON object/array from a model answer that may wrap it in prose or fences. */
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'how', 'in', 'into', 'is', 'it', 'its', 'may', 'not', 'of', 'on', 'or', 'our', 'should', 'that', 'the', 'their',
  'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'will',
  'with', 'would', 'you', 'your', 'using', 'based', 'paper', 'papers', 'study', 'studies',
])

/** Collect every string value inside a parsed JSON value (arrays/objects). */
function collectJsonStrings(value, output) {
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonStrings(entry, output)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) collectJsonStrings(entry, output)
  }
}

/** Extract the first balanced `[...]` or `{...}` segment from free-form model text. */
function firstBalancedSegment(text) {
  const source = String(text ?? '')
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const start = source.indexOf(open)
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < source.length; index += 1) {
      const char = source[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === open) depth += 1
      else if (char === close) {
        depth -= 1
        if (depth === 0) return source.slice(start, index + 1)
      }
    }
  }
  return undefined
}

/** Keep one candidate term if it is a usable English academic phrase. */
function normalizeTerm(value) {
  let term = String(value ?? '')
    .replace(/[`*_#>]/g, ' ')
    .replace(/[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'“”‘’()\[\]{}:;,.!?，。：；、—-]+/, '')
    .replace(/[\s"'“”‘’()\[\]{}:;,.!?，。：；、—-]+$/, '')
  if (term === '') return undefined
  if (!/[A-Za-z]/.test(term)) return undefined
  if (term.length < 2 || term.length > 60) return undefined
  const words = term.split(' ').filter((word) => word !== '')
  if (words.length > 6) return undefined
  while (words.length > 1 && QUERY_STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop()
  if (words.length === 0) return undefined
  if (words.every((word) => QUERY_STOPWORDS.has(word.toLowerCase()))) return undefined
  return words.join(' ')
}

/**
 * Extract usable English search terms from free-form LLM output.
 *
 * Models sometimes wrap JSON in prose/code fences, return a Chinese bullet list
 * with English terms, or add explanations. Strategy: JSON values → first balanced
 * JSON segment → regex English phrases; then a deterministic fallback built from
 * Latin proper nouns in the original query plus generic academic keywords.
 * @param {string} text raw model output.
 * @param {string} [query] original user query.
 * @returns {{terms:string[], source:'model'|'fallback', reason?:string, rawCount:number}} terms and their origin.
 */
export function extractQueryTerms(text, query = '') {
  const out = []
  const push = (value) => {
    const term = normalizeTerm(value)
    if (term !== undefined) out.push(term)
  }
  const parsed = parseModelJson(text)
  if (parsed !== undefined) {
    const strings = []
    collectJsonStrings(parsed, strings)
    for (const value of strings) push(value)
  }
  if (out.length === 0) {
    const segment = firstBalancedSegment(text)
    if (segment !== undefined) {
      try {
        const strings = []
        collectJsonStrings(JSON.parse(segment), strings)
        for (const value of strings) push(value)
      } catch {
        // not valid JSON; fall through to the regex pass
      }
    }
  }
  if (out.length === 0) {
    const source = String(text ?? '').replace(/```[a-zA-Z]*/g, ' ')
    for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9+#/.-]*(?:\s+[A-Za-z][A-Za-z0-9+#/.-]*){0,3}/g)) push(match[0])
  }
  const seen = new Set()
  const terms = []
  for (const term of out) {
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= 8) break
  }
  if (terms.length > 0) return { terms, source: 'model', rawCount: out.length }
  // Deterministic last resort: Latin proper nouns in the query + generic academic
  // keywords. These are expanded into FTS keywords, never presented as AI output.
  const queryTerms = []
  for (const match of String(query ?? '').matchAll(/[A-Za-z][A-Za-z0-9+#/.-]{1,}/g)) queryTerms.push(match[0])
  const fallback = [...new Set([...queryTerms.map((term) => term.toLowerCase()), 'model', 'method', 'experiment'])].slice(0, 6)
  return {
    terms: fallback,
    source: 'fallback',
    reason: 'model output produced no usable English phrase',
    rawCount: out.length,
  }
}

export function parseModelJson(text) {
  const source = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const objectStart = source.indexOf('{')
  const arrayStart = source.indexOf('[')
  let start = -1
  if (objectStart < 0) start = arrayStart
  else if (arrayStart < 0) start = objectStart
  else start = Math.min(objectStart, arrayStart)
  if (start < 0) return undefined
  const end = source.lastIndexOf(source[start] === '{' ? '}' : ']')
  if (end <= start) return undefined
  try {
    return JSON.parse(source.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** Bounded LRU cache of resolved AI values. */
class LruCache {
  /** @param {number} capacity maximum entries. */
  constructor(capacity = 200) {
    this.capacity = Math.max(8, capacity)
    this.map = new Map()
  }
  get(key) {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value)
  }
  clear() {
    this.map.clear()
  }
}

/** Simple FIFO concurrency gate with a hard cap. */
class Semaphore {
  /** @param {number} max maximum concurrent holders. */
  constructor(max) {
    this.max = Math.max(1, max)
    this.active = 0
    this.waiters = []
  }
  async acquire() {
    if (this.active < this.max) {
      this.active += 1
      return
    }
    await new Promise((resolve) => this.waiters.push(resolve))
    this.active += 1
  }
  release() {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }
}

/**
 * Create the AI service bound to one mounted Host.
 *
 * @param {object} options AI options.
 * @param {object} options.ctx Cordis context (optional services resolved per call).
 * @param {object} options.store domain store (DB, paper/page/figure reads).
 * @param {object} options.layout path table (page/figure cache files).
 * @param {object} options.pdf poppler facade (page/figure rendering).
 * @param {object} [options.config] resolved plugin config.
 * @param {object} [options.logger] logger.
 * @returns {object} AI service.
 */
export function createAi({ ctx, store, layout, pdf, config = {}, logger }) {
  // v0.17: deep paper Q&A over OCR-corrected pages can legitimately take longer
  // than 25s; keep fast translation bounded separately (9s) and blocks at 20s.
  const timeoutMs = Number.isFinite(config.aiTimeoutMs) ? config.aiTimeoutMs : 45_000
  const rerankTimeoutMs = Number.isFinite(config.aiRerankTimeoutMs) ? config.aiRerankTimeoutMs : 8_000
  const maxInputChars = Number.isFinite(config.aiMaxInputChars) ? config.aiMaxInputChars : 6000
  const maxOutputTokens = Number.isFinite(config.aiMaxOutputTokens) ? config.aiMaxOutputTokens : 1600
  const cacheTtlHours = Number.isFinite(config.aiCacheTtlHours) ? config.aiCacheTtlHours : 72
  const maxConcurrency = Number.isFinite(config.aiMaxConcurrency) ? config.aiMaxConcurrency : 2
  const memory = new LruCache(240)
  const semaphore = new Semaphore(maxConcurrency)
  let closed = false

  /** Resolve the current provider/model route. */
  function currentRoute() {
    const overrideProvider = typeof config.aiProvider === 'string' ? config.aiProvider.trim() : ''
    const overrideModel = typeof config.aiModel === 'string' ? config.aiModel.trim() : ''
    let selection
    try {
      const service = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
      selection = service?.currentSelection?.()
    } catch {
      selection = undefined
    }
    const provider = overrideProvider !== '' ? overrideProvider : selection?.provider
    const model = overrideModel !== '' ? overrideModel : selection?.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
    return {
      provider,
      model,
      ...(typeof selection?.reasoningEffort === 'string' && overrideProvider === '' && overrideModel === ''
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    }
  }

  /** Resolve the LLM service once per call. */
  function llmService() {
    try {
      return typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
    } catch {
      return undefined
    }
  }

  /** Fallback session label when no live session exists (contract v0.2 §1.4). */
  const FALLBACK_SESSION_ID = 'session-pappers-hall-ai'

  /**
   * Resolve the Session id an auxiliary LLM call should carry.
   *
   * Some providers (opencode-go / pi-ai) require `sessionId` in GenerateOptions
   * and reject the request without it. Priority: explicit caller value (the
   * Client/session-aware tool passes it) → any live Session reported by the
   * mounted `sessions` service → a stable plugin-local fallback.
   * @param {string} [explicit] caller-provided Session id.
   * @returns {string} session id to pass into the LLM request.
   */
  function resolveSessionId(explicit) {
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
    try {
      const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined
      const live = typeof sessions?.list === 'function' ? sessions.list() : []
      for (const session of live) {
        if (typeof session?.id === 'string' && session.id !== '') return session.id
      }
    } catch {
      // A broken Sessions service must not break the AI channel; use the fallback.
    }
    return FALLBACK_SESSION_ID
  }

  /**
   * Cheap availability facts: no model request, no network.
   * @returns {{available:boolean, provider:string|null, model:string|null, reason:string|undefined, route:object|undefined}}
   */
  function availability() {
    const llm = llmService()
    if (llm === undefined || typeof llm.prepareCall !== 'function') {
      return { available: false, provider: null, model: null, reason: 'llm service is not composed in this profile', route: undefined }
    }
    const route = currentRoute()
    if (route === undefined) {
      return { available: false, provider: null, model: null, reason: 'no default model selection is configured', route: undefined }
    }
    try {
      if (typeof llm.listProviders === 'function') {
        const providers = llm.listProviders()
        if (Array.isArray(providers) && providers.length > 0 && !providers.some((entry) => entry?.id === route.provider)) {
          return {
            available: false,
            provider: route.provider,
            model: route.model,
            reason: `no LLM adapter is registered for provider "${route.provider}"`,
            route,
          }
        }
      }
    } catch {
      // A provider-list failure is not proof of absence; let a real call decide.
    }
    return { available: true, provider: route.provider, model: route.model, reason: undefined, route }
  }

  /**
   * Provider/model catalogue exposed to the settings surface. This is the same
   * registry the DSH chat uses (`llm.listProviders`) plus the DSH default
   * selection, so Pappers-Hall never invents a provider that the host cannot
   * actually call.
   */
  async function providers() {
    const llm = llmService()
    const selection = (() => {
      try {
        const service = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
        return service?.currentSelection?.() ?? null
      } catch {
        return null
      }
    })()
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      return { available: false, selection, providers: [], configurable: [], reason: 'llm service is not composed in this profile' }
    }
    let list = []
    let configurable = []
    try { list = llm.listProviders() || [] } catch (error) { list = [] }
    try { configurable = typeof llm.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() || [] : [] } catch { configurable = [] }
    const safe = (value) => {
      try { return JSON.parse(JSON.stringify(value)) } catch { return null }
    }
    const normalized = []
    for (const entry of Array.isArray(list) ? list : []) {
      const item = safe(entry)
      if (!item || typeof item.id !== 'string') continue
      let models = []
      try {
        if (typeof llm.listModels === 'function') {
          const discovered = await llm.listModels(item.id)
          models = Array.isArray(discovered) ? discovered.map(safe).filter(Boolean) : []
        }
      } catch {
        models = []
      }
      normalized.push(Object.assign({}, item, { models: models }))
    }
    return {
      available: normalized.length > 0,
      selection,
      providers: normalized,
      configurable: Array.isArray(configurable) ? configurable.map(safe).filter(Boolean) : [],
    }
  }

  /** Save the DSH default model route, so the plugin and DSH chat stay in sync. */
  async function setDefault(selection) {
    const service = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    if (service === undefined || typeof service.saveSelection !== 'function') {
      const failure = new AiFailure('unavailable', 'the DSH default-model service is not available in this profile')
      throw failure
    }
    const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
    const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
    if (provider === '' || model === '') throw new AiFailure('invalid', 'provider and model are required')
    const known = await providers()
    const providerEntry = known.providers.find((entry) => String(entry.id) === provider)
    if (known.providers.length > 0 && providerEntry === undefined) {
      throw new AiFailure('invalid', `provider "${provider}" is not registered in DSH`)
    }
    const models = Array.isArray(providerEntry?.models) ? providerEntry.models : []
    if (models.length > 0 && !models.some((entry) => String(entry && (entry.id || entry.model || entry)) === model)) {
      throw new AiFailure('invalid', `model "${model}" is not available for provider "${provider}"`)
    }
    const next = { provider, model }
    if (typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort !== '') next.reasoningEffort = selection.reasoningEffort
    await service.saveSelection(next)
    return { ok: true, selection: next }
  }

  /** Read one cached AI value (memory then SQLite). */
  function cacheGet(key) {
    const fromMemory = memory.get(key)
    if (fromMemory !== undefined) return fromMemory
    try {
      const row = store.db.prepare('SELECT value_json, expires_at FROM ai_cache WHERE key = ?').get(key)
      if (row === undefined) return undefined
      if (typeof row.expires_at === 'string' && row.expires_at !== '' && Date.parse(row.expires_at) < Date.now()) {
        store.db.prepare('DELETE FROM ai_cache WHERE key = ?').run(key)
        return undefined
      }
      const value = parseJsonColumn(row.value_json, undefined)
      if (value !== undefined) memory.set(key, value)
      return value
    } catch {
      return undefined
    }
  }

  /** Persist one AI value in memory and SQLite. */
  function cacheSet(key, kind, value) {
    memory.set(key, value)
    try {
      const now = new Date()
      const expires = new Date(now.getTime() + cacheTtlHours * 3600_000).toISOString()
      store.db
        .prepare('INSERT OR REPLACE INTO ai_cache(key, kind, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(key, kind, JSON.stringify(value), now.toISOString(), expires)
    } catch (error) {
      logger?.debug?.(`pappers-hall: ai cache write failed: ${String(error?.message ?? error)}`)
    }
  }

  /** Record one AI call outcome without storing user text. */
  function recordEvent({ kind, provider, model, inputHash, elapsedMs, status, sources }) {
    try {
      store.db
        .prepare('INSERT INTO ai_events(at, kind, provider, model, input_hash, elapsed_ms, status, sources_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nowIso(), kind, provider ?? null, model ?? null, inputHash ?? null, Math.max(0, Math.round(elapsedMs)), status, sources === undefined ? null : JSON.stringify(sources))
    } catch (error) {
      logger?.debug?.(`pappers-hall: ai event write failed: ${String(error?.message ?? error)}`)
    }
  }

  /** Current time helper kept local so this module has no clock dependency. */
  function nowIso() {
    return new Date().toISOString()
  }

  /**
   * One guarded model completion.
   *
   * @param {object} request completion request.
   * @param {string} request.kind task label (`translate-blocks`, `ai-ask`, ...).
   * @param {string} request.promptVersion prompt version for the cache key.
   * @param {string} [request.system] system prompt.
   * @param {string} request.promptText user text.
   * @param {object[]} [request.images] ImageAttachmentRef list appended as ImageBlocks.
   * @param {boolean} [request.requireImage] fail when the route cannot accept images.
   * @param {number} [request.maxTokens] output cap.
   * @param {number} [request.deadlineMs] per-call deadline.
   * @param {boolean} [request.fast] pick the lowest supported reasoning effort / smaller budget.
   * @param {boolean} [request.cache] cache the result (default true).
   * @param {number} [request.cacheTtlHours] per-entry TTL.
   * @param {object[]} [request.sources] sources recorded in the event row.
   * @returns {Promise<{text:string, provider:string, model:string, cached:boolean, elapsedMs:number}>} completion.
   * @throws {AiFailure} when AI is unavailable, times out, or the stream fails.
   */
  async function complete(request) {
    if (closed) throw new AiFailure('unavailable', 'AI service is disposed')
    const facts = availability()
    if (!facts.available || facts.route === undefined) throw new AiFailure('unavailable', facts.reason ?? 'AI is unavailable')
    const llm = llmService()
    const route = facts.route
    const fast = request.fast === true
    const requestedEffort = typeof request.reasoningEffort === 'string' && request.reasoningEffort !== '' ? request.reasoningEffort : null
    const inputHash = hashText(
      JSON.stringify({
        version: request.promptVersion,
        provider: route.provider,
        model: route.model,
        system: request.system ?? '',
        prompt: request.promptText ?? '',
        sessionId: resolveSessionId(request.sessionId),
        fast,
        reasoningEffort: fast ? 'fast' : (requestedEffort ?? 'default'),
        images: (request.images ?? []).map((image) => String(image?.attachmentId ?? '')),
      }),
    )
    const modeKey = fast ? 'fast' : `deep:${requestedEffort ?? 'default'}`
    const cacheKey = `${request.kind}:${modeKey}:${route.provider}:${route.model}:${request.promptVersion}:${inputHash}`
    const useCache = request.cache !== false
    if (useCache) {
      const cached = cacheGet(cacheKey)
      if (cached !== undefined && typeof cached?.text === 'string') {
        return {
          ...cached,
          cached: true,
          provider: route.provider,
          model: route.model,
          fast: cached.fast === true,
          reasoningEffort: cached.reasoningEffort ?? null,
        }
      }
    }
    const startedAt = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      const reason = new Error(`AI call timed out after ${request.deadlineMs ?? timeoutMs}ms`)
      reason.code = 'AI_TIMEOUT'
      controller.abort(reason)
    }, Math.max(1000, request.deadlineMs ?? timeoutMs))
    await semaphore.acquire()
    try {
      // Fast mode: choose the model's lowest supported reasoning effort through the
      // prepareCall configure callback (controls, modelInfo). Models without
      // reasoning metadata are left untouched; the actual chosen effort is
      // returned so the Client can label "fast" truthfully.
      const configureFast = (controls, modelInfo) => {
        const efforts = Array.isArray(modelInfo?.reasoning?.efforts) ? modelInfo.reasoning.efforts.map((effort) => effort.id) : []
        const wanted = ['none', 'minimal', 'low'].find((effort) => efforts.includes(effort))
        return wanted === undefined ? controls : { ...controls, reasoningEffort: wanted }
      }
      // AI 精译 wants the model's MEDIUM thinking level. When the model exposes
      // no reasoning metadata or has no medium option, leave the default
      // configuration untouched (do not invent an effort id), and the translation
      // chain's fallback still applies if the call fails.
      const configureMedium = (controls, modelInfo) => {
        const efforts = Array.isArray(modelInfo?.reasoning?.efforts) ? modelInfo.reasoning.efforts.map((effort) => effort.id) : []
        return efforts.includes('medium') ? { ...controls, reasoningEffort: 'medium' } : controls
      }
      const call = await llm.prepareCall(
        {
          provider: route.provider,
          model: route.model,
          maxTokens: request.maxTokens ?? maxOutputTokens,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        },
        controller.signal,
        fast ? configureFast : (requestedEffort === 'medium' ? configureMedium : undefined),
      )
      const reasoningEffort = typeof call.config.reasoningEffort === 'string' ? call.config.reasoningEffort : null
      const images = Array.isArray(request.images) ? request.images.filter((image) => image !== undefined && image !== null) : []
      if (images.length > 0) {
        const modalities = call.inputModalities
        if (!Array.isArray(modalities) || !modalities.includes('image')) {
          throw new AiFailure(
            'unsupported_input',
            `model ${route.provider}/${route.model} does not declare image input support; refusing to pretend pixels reached the model`,
            { provider: route.provider, model: route.model, inputModalities: modalities ?? null },
          )
        }
      }
      controller.signal.throwIfAborted()
      const content = [{ type: 'text', text: request.promptText }]
      for (const image of images) content.push({ type: 'image', attachment: image })
      const messages = [
        {
          id: randomUUID(),
          role: 'user',
          content,
          source: { kind: 'user' },
        },
      ]
      const sessionId = resolveSessionId(request.sessionId)
      const options = {
        ...call.config,
        messages,
        ...(typeof request.system === 'string' && request.system !== '' ? { system: request.system } : {}),
        purpose: 'pappers-hall',
        sessionId,
        signal: controller.signal,
      }
      let assembled = ''
      let finalText
      let finishReason
      for await (const chunk of call.stream(options)) {
        controller.signal.throwIfAborted()
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') assembled += chunk.text
        else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') finalText = chunk.block.text
        else if (chunk?.type === 'finish') finishReason = chunk.reason
      }
      controller.signal.throwIfAborted()
      if (finishReason?.kind === 'error' || finishReason?.kind === 'aborted') {
        const failure = finishReason.failure ?? {}
        throw new AiFailure('error', String(failure.message ?? 'model call failed'), {
          provider: route.provider,
          model: route.model,
          failureCode: failure.code ?? null,
        })
      }
      const text = String(finalText ?? assembled ?? '').trim()
      // Never accept or cache a truncated answer: an incomplete JSON layout is
      // useless and poisoning the cache would make every retry return the same
      // broken fragment. `length` is the provider's max-token finish reason.
      const finish = finishReason && typeof finishReason === 'object'
        ? String(finishReason.kind ?? finishReason.reason ?? finishReason.type ?? '')
        : String(finishReason ?? '')
      if (text !== '' && /^(length|max_tokens|max-output)$/i.test(finish)) {
        throw new AiFailure('error', `model output was truncated by the ${finish || 'max-token'} limit`, {
          provider: route.provider,
          model: route.model,
          finishReason: finish,
        })
      }
      if (text === '') throw new AiFailure('error', 'model returned an empty response')
      const elapsedMs = Date.now() - startedAt
      const value = { text, provider: route.provider, model: route.model, elapsedMs, fast, reasoningEffort, reasoningEffortRequested: fast ? null : requestedEffort }
      // Persist fast/reasoningEffort with the answer so a cache hit can still report
      // the real effort that produced the text (not null).
      if (useCache) cacheSet(cacheKey, request.kind, { text, elapsedMs, fast, reasoningEffort })
      recordEvent({
        kind: request.kind,
        provider: route.provider,
        model: route.model,
        inputHash,
        elapsedMs,
        status: 'ok',
        sources: request.sources,
      })
      return { ...value, cached: false }
    } catch (error) {
      const elapsedMs = Date.now() - startedAt
      const failure =
        error instanceof AiFailure
          ? error
          : timedOut || error?.name === 'AbortError' || error?.code === 'AI_TIMEOUT'
            ? new AiFailure('timeout', `AI call timed out after ${request.deadlineMs ?? timeoutMs}ms`, { provider: route.provider, model: route.model })
            : new AiFailure('error', String(error?.message ?? error), { provider: route.provider, model: route.model })
      recordEvent({
        kind: request.kind,
        provider: route.provider,
        model: route.model,
        inputHash,
        elapsedMs,
        status: failure.code,
        sources: request.sources,
      })
      throw failure
    } finally {
      clearTimeout(timer)
      semaphore.release()
    }
  }

  /* ---------------------------------------------------------------- */
  /* Public capabilities                                              */
  /* ---------------------------------------------------------------- */

  /** `ai.status` payload. */
  function status() {
    const facts = availability()
    return {
      available: facts.available,
      provider: facts.provider,
      model: facts.model,
      limits: { maxInputChars, timeoutMs, maxOutputTokens, maxConcurrency },
      ...(facts.available ? {} : { reason: facts.reason }),
      cacheEntries: countCacheRows(),
    }
  }

  /** Count cached AI values (diagnostics). */
  function countCacheRows() {
    try {
      return Number(store.db.prepare('SELECT COUNT(*) AS count FROM ai_cache').get()?.count ?? 0)
    } catch {
      return 0
    }
  }

  /** Read one page's reader blocks (structure JSON) or undefined. */
  function pageBlocks(paperId, page) {
    const row = store.pageRow(paperId, page)
    if (row === undefined) return undefined
    const layoutJson = parseJsonColumn(row.layout_json, undefined)
    if (layoutJson === undefined || !Array.isArray(layoutJson.blocks)) return undefined
    return layoutJson
  }

  /** Translate one page's blocks, paragraph by paragraph. */
  async function translateBlocks({ paperId, page, target = 'zh', sessionId, fast = false }) {
    const paper = store.paperRow(String(paperId ?? ''))
    if (paper === undefined) throw new AiFailure('error', `paper ${paperId} does not exist`)
    const pageNumber = Number(page)
    const structure = pageBlocks(paper.id, pageNumber)
    if (structure === undefined) {
      return {
        blocks: [],
        provenance: { model: null, promptVersion: PROMPT_VERSIONS.translateBlocks, sourceHash: hashText(''), fast, reasoningEffort: null },
        cached: false,
        fast,
        reasoningEffort: null,
        status: 'unavailable',
        reason: 'page structure is not ready yet; retry after the background layout job finishes',
      }
    }
    const sourceText = structure.blocks.map((block) => block.text).join('\n')
    const sourceHash = hashText(sourceText)
    const eligible = structure.blocks.filter(
      (block) => typeof block.text === 'string' && block.text.trim().length >= 2 && ['body', 'heading', 'list', 'caption'].includes(block.role),
    )
    // v0.17: a block whose text layer is glyph-code garbage must not be sent to
    // the model; report it as unavailable instead of translating nonsense.
    const qualityById = new Map(eligible.map((block) => [block.id, assessTextQuality(block.text)]))
    const usable = eligible.filter((block) => qualityById.get(block.id)?.ok !== false)
    const facts = availability()
    if (!facts.available) {
      return {
        blocks: eligible.map((block) => ({ id: block.id, text: block.text, translation: null, status: 'unavailable', reason: 'AI unavailable' })),
        provenance: { model: null, promptVersion: PROMPT_VERSIONS.translateBlocks, sourceHash, fast, reasoningEffort: null },
        cached: false,
        fast,
        reasoningEffort: null,
        status: 'unavailable',
        reason: facts.reason,
      }
    }
    // Bilingual cards retry per block, so keep every request small: at most six
    // blocks and 2400 characters per model call.
    const batches = []
    let current = []
    let chars = 0
    for (const block of usable) {
      const text = block.text.trim()
      if (current.length > 0 && (chars + text.length > 2400 || current.length >= 6)) {
        batches.push(current)
        current = []
        chars = 0
      }
      current.push({ id: block.id, text: text.slice(0, maxInputChars) })
      chars += text.length
    }
    if (current.length > 0) batches.push(current)
    const system =
      `You are a precise academic translator. Translate each block from the paper into ${target === 'zh' ? 'Simplified Chinese' : target}. ` +
      'Keep formulas, citation markers, numbers, units and proper nouns exactly as they appear. Do not add explanations. ' +
      'Return ONLY JSON of the form {"translations":{"<id>":"<translation>"}} and include every input id.'
    /** Translate one batch once; successful calls are cached by complete(). */
    const translateBatch = async (batch, attempt) => {
      const result = await complete({
        kind: 'translate-blocks',
        promptVersion: PROMPT_VERSIONS.translateBlocks,
        sessionId,
        fast,
        ...(fast ? {} : { reasoningEffort: 'medium' }),
        system,
        promptText: JSON.stringify({ target, blocks: batch }),
        maxTokens: fast
          ? Math.min(maxOutputTokens, 700)
          : Math.min(maxOutputTokens, 240 + batch.reduce((sum, block) => sum + block.text.length, 0) * 2),
        deadlineMs: fast ? Math.min(timeoutMs, 12_000) : Math.min(timeoutMs, 20_000 * attempt),
        sources: [{ kind: 'page', page: pageNumber }],
      })
      const parsed = parseModelJson(result.text)
      const table = parsed?.translations ?? parsed
      const found = new Map()
      if (table !== null && typeof table === 'object') {
        for (const [id, value] of Object.entries(table)) {
          if (typeof value === 'string' && value.trim() !== '') found.set(id, value.trim())
        }
      }
      if (found.size === 0) throw new AiFailure('unavailable', 'empty response from the model')
      return { found, result }
    }
    const translations = new Map()
    const blockReasons = new Map()
    const models = new Set()
    let actualEffort = null
    let anyCached = false
    let cachedCalls = 0
    const runBatch = async (batch) => {
      let lastError
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const outcome = await translateBatch(batch, attempt)
          models.add(`${outcome.result.provider}/${outcome.result.model}`)
          if (typeof outcome.result.reasoningEffort === 'string') actualEffort = outcome.result.reasoningEffort
          else if (outcome.result.reasoningEffort === null) actualEffort = null
          if (outcome.result.cached === true) cachedCalls += 1
          for (const block of batch) {
            const translation = outcome.found.get(block.id)
            if (translation === undefined) blockReasons.set(block.id, 'missing-translation')
            else translations.set(block.id, translation)
          }
          // Retry only the ids the model omitted, once.
          const missing = batch.filter((block) => translations.get(block.id) === undefined)
          if (missing.length > 0 && missing.length < batch.length && attempt === 1) {
            const retryOutcome = await translateBatch(missing, attempt).catch((error) => ({ error: aiFailureReason(error) }))
            if (retryOutcome?.found === undefined) {
              for (const block of missing) blockReasons.set(block.id, retryOutcome?.error ?? 'missing-translation')
            } else {
              for (const block of missing) {
                const translation = retryOutcome.found.get(block.id)
                if (translation === undefined) blockReasons.set(block.id, 'missing-translation')
                else translations.set(block.id, translation)
              }
            }
          }
          return
        } catch (error) {
          lastError = error
          if (attempt === 2) break
        }
      }
      const reason = aiFailureReason(lastError)
      for (const block of batch) if (translations.get(block.id) === undefined) blockReasons.set(block.id, reason)
    }
    // Concurrency 2: the shared semaphore still caps total model concurrency.
    for (let index = 0; index < batches.length; index += 2) {
      await Promise.all(batches.slice(index, index + 2).map((batch) => runBatch(batch)))
    }
    anyCached = cachedCalls > 0 && cachedCalls === batches.length
    const blocks = eligible.map((block) => {
      const translation = translations.get(block.id)
      if (translation !== undefined) {
        return { id: block.id, text: block.text, translation, status: 'translated' }
      }
      const quality = qualityById.get(block.id)
      if (quality !== undefined && quality.ok === false) {
        return { id: block.id, text: block.text, translation: null, status: 'unavailable', reason: `low_quality_text_layer:${quality.kind ?? 'unknown'}` }
      }
      return {
        id: block.id,
        text: block.text,
        translation: null,
        status: 'unavailable',
        reason: blockReasons.get(block.id) ?? 'missing-translation',
      }
    })
    const translated = blocks.filter((block) => block.status === 'translated').length
    const failedReasons = [...new Set(blocks.filter((block) => block.reason !== undefined).map((block) => block.reason))]
    return {
      blocks,
      provenance: {
        model: [...models].join(', ') || facts.model,
        promptVersion: PROMPT_VERSIONS.translateBlocks,
        sourceHash,
        fast,
        reasoningEffort: actualEffort,
      },
      cached: anyCached,
      fast,
      reasoningEffort: actualEffort,
      status: translated === 0 ? 'unavailable' : translated === blocks.length ? 'ok' : 'partial',
      ...(failedReasons.length === 0 ? {} : { reason: failedReasons.join('; ') }),
    }
  }

  /** Translate a batch of titles (ids with a title), returning per-id results. */
  async function translateTitles(entries, sessionId, fast = false) {
    const facts = availability()
    if (!facts.available) throw new AiFailure('unavailable', facts.reason ?? 'AI is unavailable')
    const wanted = entries.filter((entry) => typeof entry?.title === 'string' && entry.title.trim() !== '')
    if (wanted.length === 0) return { translations: new Map(), model: null, cached: false, fast, reasoningEffort: null }
    const system =
      'You translate academic paper titles into Simplified Chinese. Keep technical terms recognizable and avoid adding content. ' +
      'Return ONLY JSON of the form {"translations":{"<id>":"<Chinese title>"}} for every input id.'
    const translations = new Map()
    let cached = true
    let model
    let actualEffort = null
    for (let start = 0; start < wanted.length; start += 20) {
      const batch = wanted.slice(start, start + 20).map((entry) => ({ id: entry.id, title: entry.title }))
      const result = await complete({
        kind: 'translate-title',
        promptVersion: PROMPT_VERSIONS.translateTitle,
        sessionId,
        fast,
        system,
        promptText: JSON.stringify({ titles: batch }),
        maxTokens: fast ? Math.min(maxOutputTokens, 700) : Math.min(maxOutputTokens, 120 + batch.length * 90),
        deadlineMs: fast ? Math.min(timeoutMs, 12_000) : undefined,
      })
      model = `${result.provider}/${result.model}`
      actualEffort = result.reasoningEffort ?? actualEffort
      cached = cached && result.cached === true
      const parsed = parseModelJson(result.text)
      const table = parsed?.translations ?? parsed
      if (table !== null && typeof table === 'object') {
        for (const [id, value] of Object.entries(table)) {
          if (typeof value === 'string' && value.trim() !== '') translations.set(id, value.trim())
        }
      }
    }
    return { translations, model, cached, fast, reasoningEffort: actualEffort }
  }

  /** Build the text context and sources for one AI question. */
  async function buildAskContext(request) {
    const paper = store.paperRow(String(request.paperId ?? ''))
    if (paper === undefined) throw new AiFailure('error', `paper ${request.paperId} does not exist`)
    if (paper.state !== 'active') throw new AiFailure('unavailable', `paper ${request.paperId} is in the recycle bin`)
    const sources = []
    const parts = [`Paper: ${paper.title}${typeof paper.title_zh === 'string' && paper.title_zh !== '' ? ` (${paper.title_zh})` : ''}`]
    if (typeof request.quote === 'string' && request.quote.trim() !== '') {
      parts.push(`Selected quote:\n${request.quote.trim().slice(0, 1500)}`)
      sources.push({ kind: 'page', page: Number(request.page ?? 1) })
    }
    if (Number.isInteger(request.page)) {
      const pageText = await store.pageTextForAi(paper.id, request.page)
      if (pageText !== null && pageText.lowQuality !== true) {
        parts.push(`Page ${request.page} text (${pageText.source}):\n${pageText.text.slice(0, maxInputChars)}`)
        sources.push({ kind: 'page', page: request.page, textSource: pageText.source })
      } else if (pageText !== null) {
        // Never feed garbled text-layer content to the model as if it were paper
        // prose: state the extraction failure explicitly instead.
        parts.push(`Page ${request.page}: the PDF text layer is unreliable (${pageText.quality.reasons.join(', ')}); OCR is unavailable. Do not quote or rely on this page.`)
        sources.push({ kind: 'page', page: request.page, textSource: 'unreliable', lowQuality: true })
      }
      const structure = pageBlocks(paper.id, request.page)
      if (Array.isArray(request.blocks) && request.blocks.length > 0 && structure !== undefined) {
        const wanted = new Set(request.blocks.map(String))
        const selected = structure.blocks.filter((block) => wanted.has(block.id))
        if (selected.length > 0) parts.push(`Selected paragraphs:\n${selected.map((block) => block.text).join('\n').slice(0, maxInputChars)}`)
      }
    }
    if (typeof request.figureId === 'string' && request.figureId !== '') {
      const figure = store.figureRow(request.figureId)
      if (figure !== undefined && figure.paper_id === paper.id) {
        sources.push({ kind: 'figure', page: Number(figure.page), figureId: figure.id, label: figure.label ?? null })
        if (typeof figure.caption === 'string' && figure.caption !== '') parts.push(`Figure ${figure.label ?? ''} caption:\n${figure.caption.slice(0, 1200)}`)
      }
    }
    if (sources.length === 0) sources.push({ kind: 'page', page: 1 })
    return { paper, context: parts.join('\n\n'), sources }
  }

  /** Read/attach one PNG as a durable image attachment reference. */
  async function attachPng(filePath, name) {
    const attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined
    if (attachments === undefined || typeof attachments.saveImage !== 'function') {
      throw new AiFailure('unavailable', 'attachment service is not composed; real pixels cannot be attached')
    }
    const bytes = await readFile(filePath)
    return attachments.saveImage({ data: bytes, mediaType: 'image/png', name: name ?? path.basename(filePath) })
  }

  /** Render one page PNG into the page cache (reusing the asset route output). */
  async function ensurePagePng(paperId, page, width = 1400) {
    const version = store.latestVersion(paperId)
    if (version === undefined || typeof version.file_path !== 'string') throw new AiFailure('error', 'paper has no stored PDF')
    if (pdf === undefined || pdf.detection?.available !== true) throw new AiFailure('unavailable', 'poppler is not installed; page rendering is unavailable')
    const cachePath = path.join(layout.pagesCacheDir, `${paperId}-${page}-w${width}.png`)
    try {
      await readFile(cachePath)
    } catch {
      await pdf.renderPage({ filePath: version.file_path, page, width, outputPath: cachePath })
    }
    return cachePath
  }

  /** `ai.ask` — one grounded answer with real image attachment support. */
  async function ask(request = {}) {
    const startedAt = Date.now()
    const fast = request.fast === true || request.mode === 'fast'
    const facts = availability()
    if (!facts.available) {
      return { status: 'unavailable', reason: facts.reason, provider: facts.provider, model: facts.model, sources: [], elapsedMs: Date.now() - startedAt, fast, reasoningEffort: null }
    }
    let built
    try {
      built = await buildAskContext(request)
    } catch (error) {
      const code = error instanceof AiFailure ? error.code : 'error'
      return {
        status: code === 'unavailable' ? 'unavailable' : 'error',
        reason: String(error?.message ?? error),
        provider: facts.provider,
        model: facts.model,
        sources: [],
        elapsedMs: Date.now() - startedAt,
        fast,
        reasoningEffort: null,
      }
    }
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    if (prompt === '') {
      return { status: 'error', reason: 'prompt is required', provider: facts.provider, model: facts.model, sources: built.sources, elapsedMs: Date.now() - startedAt, fast, reasoningEffort: null }
    }
    let images = []
    const sources = [...built.sources]
    if (request.includeImage === true) {
      try {
        if (typeof request.figureId === 'string' && request.figureId !== '') {
          const figure = store.figureRow(request.figureId)
          if (figure === undefined || typeof figure.file_name !== 'string' || figure.file_name === '') {
            throw new AiFailure('error', 'figure image was not generated')
          }
          const filePath = path.join(layout.figuresDir, figure.file_name)
          images = [await attachPng(filePath, `${figure.id}.png`)]
        } else if (Number.isInteger(request.page)) {
          const filePath = await ensurePagePng(built.paper.id, request.page)
          images = [await attachPng(filePath, `${built.paper.id}-p${request.page}.png`)]
        }
      } catch (error) {
        return {
          status: 'unavailable',
          reason: `includeImage requested but the image cannot be attached: ${String(error?.message ?? error)}`,
          provider: facts.provider,
          model: facts.model,
          sources,
          elapsedMs: Date.now() - startedAt,
          fast,
          reasoningEffort: null,
        }
      }
    }
    const system =
      'You are the reading assistant inside Pappers-Hall, a paper library in DeepSeek Harness. ' +
      'Answer in the language the user used (Chinese by default). Ground every claim in the provided paper context; ' +
      'cite the page number when you use page content. When the context is insufficient or an image was requested but not provided, say so explicitly. ' +
      'Never invent numbers, figures, quotes or citations. Distinguish printed values, visual estimates and inferences.'
    const promptText = `${built.context}\n\n---\nQuestion: ${prompt.slice(0, 4000)}`
    try {
      const result = await complete({
        kind: 'ai-ask',
        promptVersion: PROMPT_VERSIONS.ask,
        system,
        promptText,
        images,
        requireImage: images.length > 0,
        fast,
        maxTokens: fast ? Math.min(maxOutputTokens, 800) : maxOutputTokens,
        deadlineMs: fast ? Math.min(timeoutMs, 12_000) : Number.isFinite(request.timeoutMs) ? request.timeoutMs : timeoutMs,
        sessionId: request.sessionId,
        cache: true,
        sources,
      })
      return {
        status: 'ok',
        answer: result.text,
        provider: result.provider,
        model: result.model,
        sources,
        // A cache hit is still a positive measured latency for the Client; report
        // at least 1ms so "elapsedMs > 0" stays meaningful without pretending a
        // fresh model call happened (cached:true is explicit).
        elapsedMs: Math.max(1, Date.now() - startedAt),
        fast,
        reasoningEffort: result.reasoningEffort ?? null,
        cached: result.cached === true,
      }
    } catch (error) {
      const code = error instanceof AiFailure ? error.code : 'error'
      return {
        status: code === 'unavailable' || code === 'unsupported_input' ? 'unavailable' : 'error',
        reason: String(error?.message ?? error),
        provider: facts.provider,
        model: facts.model,
        sources,
        elapsedMs: Date.now() - startedAt,
      }
    }
  }

  /** Expand a (usually Chinese) query into English keywords/synonyms for keyword search. */
  async function expandQuery(query, sessionId) {
    const text = String(query ?? '').trim()
    if (text === '') return undefined
    const facts = availability()
    if (!facts.available) return undefined
    const system =
      'You expand a paper-library search query into English academic search terms. ' +
      'Return 5-8 English academic noun phrases, method names or technical keywords that would appear in a relevant paper title, abstract or caption. ' +
      'Do not return sentences, explanations, questions or the user language; keep proper nouns (dataset/method names) in their original casing. ' +
      'Return ONLY JSON of the form {"terms":["term1","term2"]}.'
    try {
      const result = await complete({
        kind: 'expand-query',
        promptVersion: PROMPT_VERSIONS.expandQuery,
        sessionId,
        system,
        promptText: text.slice(0, 500),
        maxTokens: 260,
      })
      const extracted = extractQueryTerms(result.text, text)
      return {
        terms: extracted.terms,
        model: `${result.provider}/${result.model}`,
        cached: result.cached,
        fallback: extracted.source === 'fallback',
        ...(extracted.reason === undefined ? {} : { reason: extracted.reason }),
      }
    } catch (error) {
      logger?.debug?.(`pappers-hall: AI query expansion failed: ${String(error?.message ?? error)}`)
      return undefined
    }
  }

  /**
   * `ai.suggestFolderName` — propose a short Chinese thematic folder name.
   *
   * Used by v0.6 auto-classification when no existing folder is similar enough.
   * The model gets the paper's title/venue/keywords and returns only a 2–8 char
   * Chinese topic; callers always keep a deterministic fallback so a failed call
   * never yields an empty name.
   * @param {{title?:string,titleZh?:string,venue?:string,keywords?:string[],abstract?:string,sessionId?:string}} request paper facts.
   * @returns {Promise<object>} `{status:'ok',name,model,cached}` or `{status:'unavailable'|'error',reason}`.
   */
  async function suggestFolderName(request = {}) {
    const facts = availability()
    if (!facts.available) return { status: 'unavailable', reason: facts.reason, provider: facts.provider, model: facts.model }
    const system =
      'You name a small thematic folder in a paper library. Given one paper title (and optional venue/keywords/abstract), ' +
      'return a short Chinese topic name of 2 to 8 Chinese characters that groups related papers, for example "作物气候适应" or "多模态检索". ' +
      'No punctuation, no quotes, no explanation. Return ONLY JSON of the form {"name":"…"}.'
    const input = {
      title: String(request.title ?? '').slice(0, 300),
      titleZh: String(request.titleZh ?? '').slice(0, 120),
      venue: String(request.venue ?? '').slice(0, 120),
      keywords: Array.isArray(request.keywords) ? request.keywords.slice(0, 8).map(String) : [],
      abstract: String(request.abstract ?? '').slice(0, 600),
    }
    try {
      const result = await complete({
        kind: 'folder-name',
        promptVersion: PROMPT_VERSIONS.folderName,
        system,
        promptText: JSON.stringify(input),
        maxTokens: 80,
        sessionId: request.sessionId,
        cache: true,
      })
      const parsed = parseModelJson(result.text)
      const raw = parsed !== undefined && typeof parsed.name === 'string' ? parsed.name : ''
      const cleaned = String(raw)
        .replace(/[\s"'“”‘’《》【】()（）\[\]{}<>:：,，.。;；!！?？、/\\|-]+/g, '')
        .trim()
      if (cleaned === '') return { status: 'error', reason: 'model did not return a usable folder name', provider: result.provider, model: result.model }
      const chars = [...cleaned]
      let name = chars.slice(0, 8).join('')
      if (name.length < 2) name = cleaned
      return { status: 'ok', name, provider: result.provider, model: result.model, cached: result.cached === true }
    } catch (error) {
      logger?.debug?.(`pappers-hall: AI folder-name suggestion failed: ${String(error?.message ?? error)}`)
      return { status: 'error', reason: String(error?.message ?? error), provider: facts.provider, model: facts.model }
    }
  }

  /** Re-rank up to 20 keyword hits by relevance; returns id order or undefined. */
  async function rerank(query, hits, sessionId) {
    if (hits.length <= 1) return undefined
    const facts = availability()
    if (!facts.available) return { error: 'AI unavailable' }
    const system =
      'You score search results for relevance to a user query. Return ONLY JSON of the form ' +
      '{"scores":[{"id":"<id>","score":<0-100>},...]} with one entry per input id; higher means more relevant. ' +
      'Score only from the given title and snippet; do not invent papers.'
    const input = {
      query: String(query ?? '').slice(0, 500),
      hits: hits.slice(0, 20).map((hit) => ({ id: hit.paperId ?? hit.id, title: hit.title, snippet: String(hit.snippet ?? '').slice(0, 220) })),
    }
    try {
      const result = await complete({
        kind: 'rerank',
        promptVersion: PROMPT_VERSIONS.rerank,
        sessionId,
        system,
        promptText: JSON.stringify(input),
        maxTokens: 500,
        // A rerank is a UX improvement on top of deterministic keyword hits: never
        // let it hold a search for longer than the configured lightweight budget.
        deadlineMs: Math.min(Number.isFinite(rerankTimeoutMs) ? rerankTimeoutMs : 8_000, timeoutMs),
        cache: true,
      })
      const parsed = parseModelJson(result.text)
      const scores = Array.isArray(parsed?.scores) ? parsed.scores : undefined
      if (scores !== undefined) {
        const ranked = scores
          .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
          .map((entry, index) => ({ id: entry.id, score: Number(entry.score), index }))
          .filter((entry) => Number.isFinite(entry.score))
          .sort((left, right) => right.score - left.score || left.index - right.index)
        if (ranked.length === 0) return { error: 'empty-response' }
        return { order: ranked.map((entry) => entry.id), model: `${result.provider}/${result.model}` }
      }
      const order = Array.isArray(parsed?.order) ? parsed.order : undefined
      if (order === undefined) return { error: 'empty-response' }
      return { order: order.filter((id) => typeof id === 'string'), model: `${result.provider}/${result.model}` }
    } catch (error) {
      logger?.debug?.(`pappers-hall: AI rerank failed: ${String(error?.message ?? error)}`)
      return { error: aiFailureReason(error) }
    }
  }

  /** `translate.text` (v0.1 compatible) — one free text translation through AI. */
  async function translateText({ text, target = 'zh', sessionId, fast = false, reasoningEffort, context }) {
    const startedAt = Date.now()
    const facts = availability()
    if (!facts.available) return { translation: null, status: 'unavailable', fast, reasoningEffort: null, elapsedMs: 0, mode: 'ai', freeOnly: false, provenance: { reason: facts.reason, fast, promptVersion: PROMPT_VERSIONS.translateText } }
    const sourceHash = hashText(text)
    const targetLanguage = target === 'zh' ? 'Simplified Chinese' : String(target)
    // v0.13: academic-passage translation rules. A selected passage must read as a
    // faithful scholarly translation: complete sentences, preserved symbols and
    // citation markers, no omissions/summaries/explanations/added content.
    const system =
      `You translate a selected passage from an academic research paper into ${targetLanguage}. ` +
      'Rules:\n' +
      '1. Translate every sentence completely and in order. Never omit, merge, summarize, explain or add information that is not in the source.\n' +
      '2. Use accurate, consistent technical terminology. Preserve symbols, abbreviations, acronyms, variables, units, equations and citation markers exactly as written ' +
      '(for example ΔY, CA, GGCMs, CO2, R², [12], (Smith et al., 2020), Fig. 3, Eqs. (2)–(4)); do not translate or expand them.\n' +
      '3. Keep numbers, percentages, ranges, units and punctuation meaning unchanged.\n' +
      '4. Keep the original paragraph breaks; do not add headings, notes, prefaces or Markdown fences.\n' +
      '5. If a term has a standard translation in the target language, use it; otherwise keep the original term (optionally a short bracketed gloss) — never invent a meaning.\n' +
      '6. Output only the translated text.'
    const contextParts = []
    if (context !== null && typeof context === 'object') {
      if (typeof context.paperTitle === 'string' && context.paperTitle.trim() !== '') contextParts.push(`Paper title: ${context.paperTitle.trim().slice(0, 300)}`)
      if (typeof context.section === 'string' && context.section.trim() !== '') contextParts.push(`Section: ${context.section.trim().slice(0, 200)}`)
      if (Number.isInteger(context.page) && context.page > 0) contextParts.push(`Page: ${context.page}`)
    }
    const promptText =
      (contextParts.length === 0 ? '' : `Context (terminology reference only; do NOT translate or repeat it):\n${contextParts.join('\n')}\n\n`) +
      `Source passage:\n${String(text).slice(0, maxInputChars)}`
    // maxTokens must fit a COMPLETE translation (fast mode must not truncate):
    // Chinese output is roughly 1–2 chars per token; budget generously and clamp.
    const estimatedTokens = Math.ceil(String(text).length * 1.4) + 300
    const maxTokens = Math.min(maxOutputTokens, Math.max(900, estimatedTokens))
    try {
      const result = await complete({
        kind: 'translate-text',
        promptVersion: PROMPT_VERSIONS.translateText,
        sessionId,
        fast,
        ...(fast ? {} : { reasoningEffort: reasoningEffort ?? 'medium' }),
        system,
        promptText,
        maxTokens,
        // v0.13: fast AI translation must finish within 9s (was 12s).
        deadlineMs: fast ? Math.min(timeoutMs, 9_000) : undefined,
      })
      return {
        translation: result.text,
        status: 'translated',
        fast,
        mode: 'ai',
        freeOnly: false,
        reasoningEffort: result.reasoningEffort ?? null,
        reasoningEffortRequested: fast ? null : (reasoningEffort ?? 'medium'),
        elapsedMs: Number.isFinite(result.elapsedMs) ? Number(result.elapsedMs) : Math.max(1, Date.now() - startedAt),
        provenance: {
          model: `${result.provider}/${result.model}`,
          promptVersion: PROMPT_VERSIONS.translateText,
          sourceHash,
          fast,
          reasoningEffort: result.reasoningEffort ?? null,
          reasoningEffortRequested: fast ? null : (reasoningEffort ?? 'medium'),
          ...(contextParts.length === 0 ? {} : { context: { paperTitle: typeof context?.paperTitle === 'string' ? context.paperTitle : null, section: typeof context?.section === 'string' ? context.section : null, page: Number.isInteger(context?.page) ? context.page : null } }),
        },
        cached: result.cached,
        maxTokens,
      }
    } catch (error) {
      const code = error instanceof AiFailure ? error.code : 'error'
      return {
        translation: null,
        status: code === 'unavailable' ? 'unavailable' : 'error',
        fast,
        mode: 'ai',
        freeOnly: false,
        reasoningEffort: null,
        elapsedMs: Math.max(1, Date.now() - startedAt),
        provenance: { reason: String(error?.message ?? error), sourceHash, fast, promptVersion: PROMPT_VERSIONS.translateText },
      }
    }
  }


  /**
   * `ai.complete` — generic grounded-free completion for note beautification.
   *
   * Notes without a linked paper still need AI collaboration; `ai.ask` is
   * paper-grounded by design, so this primitive takes a self-contained prompt.
   * It returns the same honest availability/timeout/cache metadata as other
   * AI calls and never fabricates text.
   * @param {{prompt:string, system?:string, maxTokens?:number, fast?:boolean, reasoningEffort?:string, sessionId?:string, kind?:string, cache?:boolean}} request completion request.
   * @returns {Promise<object>} `{status, answer, provider, model, elapsedMs, reasoningEffort, cached, reason?}`.
   */
  async function completeText(request = {}) {
    const startedAt = Date.now()
    const prompt = String(request.prompt ?? '').trim()
    const facts = availability()
    if (!facts.available) {
      return { status: 'unavailable', answer: null, reason: facts.reason ?? 'AI is unavailable', provider: facts.provider, model: facts.model, elapsedMs: 0, reasoningEffort: null, cached: false }
    }
    if (prompt === '') return { status: 'error', answer: null, reason: 'prompt is required', elapsedMs: 0, cached: false }
    try {
      const result = await complete({
        kind: typeof request.kind === 'string' && request.kind !== '' ? request.kind : 'ai-complete',
        promptVersion: request.promptVersion ?? 'ai-complete-v1',
        sessionId: request.sessionId,
        system: request.system,
        promptText: prompt.slice(0, maxInputChars),
        // Note beautification returns structured JSON and can be long; do not let the
        // reasoning budget swallow the whole answer (the model's max thinking level
        // can consume several hundred tokens before the first text delta).
        maxTokens: Number.isFinite(request.maxTokens) ? Math.max(64, Math.min(4000, Number(request.maxTokens))) : 3000,
        fast: request.fast === true,
        ...(request.fast === true ? {} : { reasoningEffort: typeof request.reasoningEffort === 'string' && request.reasoningEffort !== '' ? request.reasoningEffort : 'medium' }),
        cache: request.cache !== false,
      })
      return {
        status: 'ok',
        answer: result.text,
        text: result.text,
        provider: result.provider,
        model: result.model,
        elapsedMs: result.elapsedMs,
        reasoningEffort: result.reasoningEffort ?? null,
        reasoningEffortRequested: result.reasoningEffortRequested ?? null,
        cached: result.cached === true,
      }
    } catch (error) {
      const code = error instanceof AiFailure ? error.code : 'error'
      return {
        status: code === 'unavailable' ? 'unavailable' : 'error',
        answer: null,
        reason: String(error?.message ?? error),
        provider: facts.provider,
        model: facts.model,
        elapsedMs: Math.max(1, Date.now() - startedAt),
        reasoningEffort: null,
        cached: false,
      }
    }
  }

  /** Dispose memory state (messages already returned stay valid). */
  function close() {
    closed = true
    memory.clear()
  }

  return {
    status,
    availability,
    providers,
    setDefault,
    complete,
    translateBlocks,
    translateTitles,
    translateText,
    ask,
    completeText,
    expandQuery,
    suggestFolderName,
    rerank,
    pageBlocks,
    countCacheRows,
    close,
    get available() {
      return availability().available
    },
    PROMPT_VERSIONS,
  }
}
