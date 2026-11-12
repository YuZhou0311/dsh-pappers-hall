/**
 * Pappers-Hall v0.4 free translation engine chain.
 *
 * Engines (real, public endpoints — no API keys):
 * - `google`  : unofficial free gtx endpoint (`translate_a/single`), fast & good
 *               quality, marked `unofficial:true, free:true` everywhere.
 * - `mymemory`: free public API with daily quota; per-request length limit 450.
 * - `llm`     : the existing AI channel (`ai.translateText`, fast/deep), quality
 *               fallback. Never presented as a free engine.
 * - `libretranslate`: optional, only when config.libreUrl is provided.
 *
 * The chain never fabricates a translation: each provider either returns real
 * engine output (cached per provider+text) or a concrete `reason`; `auto` walks
 * google → mymemory → llm. Failures are persisted in `mt_events` and surfaced in
 * `translate.providers`.
 *
 * @module pappers-hall/host/translate
 */
import { createHash } from 'node:crypto'
import { readSetting, writeSetting } from './db.js'
import { assessTextQuality, looksLikeCipherText } from './text-quality.js'

/** Engine catalogue with honest provenance flags. */
export const ENGINES = [
  { id: 'tencent', label: '腾讯交互翻译（免费）', free: true, unofficial: true, needsConfig: false },
  { id: 'google', label: 'Google 翻译（非官方免费接口）', free: true, unofficial: true, needsConfig: false },
  { id: 'mymemory', label: 'MyMemory（免费额度）', free: true, unofficial: false, needsConfig: false },
  { id: 'llm', label: 'AI 精译（LLM）', free: false, unofficial: false, needsConfig: false },
  { id: 'libretranslate', label: 'LibreTranslate（需自建）', free: true, unofficial: false, needsConfig: true },
]

/** Default auto chain order (contract §1.2). */
export const AUTO_CHAIN = ['tencent', 'google', 'mymemory', 'llm']

/** Browser-like UA: the public endpoints are meant for web clients. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** SHA-256 hex of one text. */
function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** Clamp a numeric option. */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

/**
 * Detect the dominant language of one text with simple character ratios.
 * Not a real classifier: used only to avoid translating Chinese into Chinese.
 * @param {string} text input text.
 * @returns {'zh'|'en'|'unknown'} detected language.
 */
export function detectLanguage(text) {
  const value = String(text ?? '')
  const han = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
  const latin = (value.match(/[A-Za-z]/g) ?? []).length
  const total = han + latin
  if (total === 0) return 'unknown'
  if (han / total >= 0.25) return 'zh'
  if (latin / total >= 0.6) return 'en'
  return 'unknown'
}

/**
 * Normalize whitespace before any machine translation.
 *
 * Selected quotes are usually multi-line PDF text ("...performance\nacross
 * tasks...\n(e.g."). Free engines translate each line as a separate fragment when
 * newlines survive, producing word-by-word garbage; collapsing every newline to a
 * single space keeps one sentence for the engine. Paragraph boundaries remain the
 * caller's job (`translate.blocks` translates each block separately).
 * @param {string} text raw text.
 * @returns {string} single-space normalized text.
 */
export function normalizeTranslationInput(text) {
  return String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Cheap post-translation sanity check.
 *
 * Flags empty/too-short output and English-to-Chinese translations that still
 * read mostly English (typical of word-by-word engine garbage). Used by the auto
 * chain to try the next provider instead of showing a broken translation.
 * @param {string} source source text.
 * @param {string} translation engine output.
 * @returns {{suspicious:boolean, reason?:string}} quality verdict.
 */
export function evaluateTranslationQuality(source, translation) {
  const sourceText = String(source ?? '').trim()
  const text = String(translation ?? '').trim()
  if (text === '') return { suspicious: true, reason: 'empty_translation' }
  const lengthRatio = text.length / Math.max(1, sourceText.length)
  if (lengthRatio < 0.08) return { suspicious: true, reason: `too_short:${lengthRatio.toFixed(3)}` }
  const sourceLetters = (sourceText.match(/[A-Za-z]/g) ?? []).length
  const sourceHan = (sourceText.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
  const englishSource = sourceLetters >= 20 && sourceLetters / Math.max(1, sourceLetters + sourceHan) > 0.6
  if (!englishSource) return { suspicious: false }
  const translatedLetters = (text.match(/[A-Za-z]/g) ?? []).length
  const translatedHan = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
  const total = translatedLetters + translatedHan
  if (total > 0 && translatedLetters / total > 0.55) {
    return { suspicious: true, reason: `english_like:${(translatedLetters / total).toFixed(2)}` }
  }
  // Untranslated English leakage: most distinct source words still present verbatim.
  const sourceWords = [...new Set((sourceText.toLowerCase().match(/[a-z]{3,}/g) ?? []))]
  if (sourceWords.length >= 8) {
    const translatedWords = new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? [])
    const leaked = sourceWords.filter((word) => translatedWords.has(word)).length / sourceWords.length
    if (leaked > 0.45) return { suspicious: true, reason: `english_leak:${leaked.toFixed(2)}` }
  }
  return { suspicious: false }
}

/** Turn a thrown engine/network error into a compact client-facing reason. */
export function engineFailureReason(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code !== '') return error.code
  const message = String(error?.message ?? error ?? 'unknown engine failure')
  return message.slice(0, 200)
}

/**
 * Split text into sentence-preserving chunks no longer than `maxChars`.
 * Paragraph breaks stay as separators so the translated text keeps structure.
 * @param {string} text source text.
 * @param {number} maxChars max chunk length.
 * @returns {string[]} chunks.
 */
export function splitTextChunks(text, maxChars) {
  const paragraphs = String(text ?? '').split(/\n{2,}/)
  const chunks = []
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim()
    if (trimmed === '') continue
    if (trimmed.length <= maxChars) {
      chunks.push(trimmed)
      continue
    }
    const sentences = trimmed.match(/[^.!?;。！？；]+[.!?;。！？；]*\s*/g) ?? [trimmed]
    let current = ''
    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        if (current !== '') {
          chunks.push(current.trim())
          current = ''
        }
        // Word-safe split: never cut in the middle of a word unless one word alone
        // exceeds the engine limit.
        let remainder = sentence.trim()
        while (remainder.length > maxChars) {
          let cut = remainder.lastIndexOf(' ', maxChars)
          if (cut < Math.floor(maxChars * 0.5)) cut = remainder.indexOf(' ', maxChars)
          if (cut <= 0) cut = maxChars
          chunks.push(remainder.slice(0, cut).trim())
          remainder = remainder.slice(cut).trim()
        }
        if (remainder !== '') chunks.push(remainder)
        continue
      }
      if (current.length + sentence.length > maxChars) {
        if (current.trim() !== '') chunks.push(current.trim())
        current = sentence
      } else {
        current += sentence
      }
    }
    if (current.trim() !== '') chunks.push(current.trim())
  }
  return chunks.filter((chunk) => chunk !== '')
}

/** Parse the unofficial Google gtx nested-array response into plain text. */
export function parseGoogleResponse(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) throw Object.assign(new Error('unexpected google response'), { code: 'google_parse_error' })
  const parts = []
  for (const segment of payload[0]) {
    if (Array.isArray(segment) && typeof segment[0] === 'string' && segment[0] !== '') parts.push(segment[0])
  }
  if (parts.length === 0) throw Object.assign(new Error('google returned no translation segments'), { code: 'google_empty' })
  return parts.join('')
}

/** Tiny promise semaphore used to cap per-engine network concurrency. */
function createSemaphore(max) {
  let active = 0
  const waiters = []
  const acquire = () =>
    new Promise((resolve) => {
      const attempt = () => {
        if (active < max) {
          active += 1
          resolve(() => {
            active -= 1
            const next = waiters.shift()
            if (next !== undefined) next()
          })
          return
        }
        waiters.push(attempt)
      }
      attempt()
    })
  return { acquire }
}

/**
 * Create the translation service.
 * @param {object} options service dependencies.
 * @param {object} options.store domain store (db + page structure).
 * @param {object} [options.ai] AI service (LLM fallback).
 * @param {object} [options.config] host config.
 * @param {object} [options.logger] logger.
 * @param {object} [options.ctx] cordis context (unused, kept for parity).
 * @returns {object} translation service.
 */
export function createTranslate({ store, ai, config = {}, logger, ctx, settings: settingsService }) {
  const db = store.db
  const networkTimeoutMs = clampInt(config.translationTimeoutMs ?? 6_000, 1_000, 30_000, 6_000)
  // v0.13: quick translation is free-engine-only with a hard overall deadline.
  const quickDeadlineMs = clampInt(config.translationQuickDeadlineMs ?? 6_000, 1_000, 6_000, 6_000)
  const llmTimeoutMs = clampInt(config.aiTimeoutMs ?? 25_000, 2_000, 180_000, 25_000)
  const libreUrl = typeof config.libreUrl === 'string' && config.libreUrl.trim() !== '' ? config.libreUrl.trim().replace(/\/+$/, '') : null
  const libreApiKey = typeof config.libreApiKey === 'string' ? config.libreApiKey : undefined
  const forcedFailures = new Set(
    [
      ...(Array.isArray(config.translationForcedFailures) ? config.translationForcedFailures : []),
      ...(typeof process.env.PAPPERS_HALL_FAIL_TRANSLATE === 'string' ? process.env.PAPPERS_HALL_FAIL_TRANSLATE.split(',') : []),
    ]
      .map((entry) => String(entry).trim())
      .filter((entry) => entry !== ''),
  )
  const cacheTtlMs = clampInt(config.translationCacheTtlHours ?? 720, 1, 8_760, 720) * 60 * 60 * 1000
  const networkSemaphore = createSemaphore(clampInt(config.translationMaxConcurrency ?? 2, 1, 4, 2))
  /** In-process last-run stats per provider: {latencyMs, error, at}. */
  const lastStats = new Map()

  const engineById = new Map(ENGINES.map((engine) => [engine.id, engine]))

  /** Engine metadata plus configured/available/last-run facts. */
  function engineInfo(id) {
    const engine = engineById.get(id)
    if (engine === undefined) return null
    const stats = lastStats.get(id) ?? {}
    const configured = id === 'libretranslate' ? libreUrl !== null : id === 'llm' ? ai !== undefined && typeof ai.available === 'boolean' : true
    const llmAvailable = id === 'llm' ? ai !== undefined && ai.available === true : true
    const recentError = typeof stats.error === 'string' && Number.isFinite(stats.at) && Date.now() - stats.at < 60_000
    return {
      id,
      label: engine.label,
      free: engine.free,
      unofficial: engine.unofficial === true,
      configured,
      available: configured && llmAvailable && !recentError,
      lastLatencyMs: Number.isFinite(stats.latencyMs) ? stats.latencyMs : null,
      lastError: stats.error ?? null,
    }
  }

  /** Persisted provider setting (config supplies defaults; API updates persist). */
  function readSettings() {
    const storedProvider = readSetting(db, 'translationProvider')
    const storedFallback = readSetting(db, 'translationFallback')
    const provider =
      typeof storedProvider === 'string' && storedProvider !== ''
        ? storedProvider
        : typeof config.translationProvider === 'string' && config.translationProvider !== ''
          ? config.translationProvider
          : 'auto'
    // v0.11: the settings panel owns `translation.fallbackEnabled`; the legacy
    // `translationFallback` setting remains as a fallback for old clients.
    let fallback = typeof storedFallback === 'boolean' ? storedFallback : config.translationFallback !== false
    if (settingsService !== undefined && settingsService !== null && typeof settingsService.fallbackEnabled === 'function') {
      try {
        fallback = settingsService.fallbackEnabled() === true
      } catch { /* keep legacy value */ }
    }
    return { provider, fallback }
  }

  /** Whether a provider is enabled by the v0.11 settings panel. */
  function providerEnabled(id) {
    if (settingsService === undefined || settingsService === null || typeof settingsService.providerEnabled !== 'function') return true
    try {
      return settingsService.providerEnabled(id) === true
    } catch {
      return true
    }
  }

  /** Resolve the provider chain for one request (disabled engines filtered out). */
  function resolveChain(requested) {
    const settings = readSettings()
    const provider = typeof requested === 'string' && requested !== '' ? requested : settings.provider
    let chain
    let fallback
    if (provider === 'auto') {
      // fallbackEnabled=false means: use only the first available engine, never
      // silently degrade to another one.
      chain = settings.fallback ? [...AUTO_CHAIN] : [AUTO_CHAIN[0]]
      if (settings.fallback && libreUrl !== null) chain.push('libretranslate')
      chain = chain.filter((id) => providerEnabled(id))
      fallback = settings.fallback
    } else {
      if (!engineById.has(provider)) throw Object.assign(new Error(`unknown translation provider ${provider}`), { code: 'invalid_provider' })
      // An explicit user choice must be attempted even if the provider toggle is
      // off for the automatic chain. Do NOT silently cross-fall back to a free
      // engine here: selecting "AI 精译" must either return the LLM translation or
      // an honest failure, never a surprise Tencent result.
      chain = [provider]
      fallback = false
    }
    return { provider, chain, fallback }
  }

  /* ----------------------------- caching ----------------------------- */

  /** Legacy v0.4 cache key (no fast/deep segment) for reusing old real results. */
  function legacyCacheKey(provider, sourceLang, targetLang, text) {
    return `${provider}:${sourceLang}:${targetLang}:${hashText(text)}`
  }

  function cacheKey(provider, sourceLang, targetLang, text, fast = false) {
    // The fast/deep intent is part of the key: a fast result must never satisfy a
    // deep request (v0.3 cache-separation contract), even when both use the same
    // free engine.
    return `${provider}:${fast ? 'fast' : 'deep'}:${sourceLang}:${targetLang}:${hashText(text)}`
  }

  function cacheGet(key) {
    try {
      const row = db.prepare('SELECT value_json, expires_at FROM mt_cache WHERE key = ?').get(key)
      if (row === undefined) return undefined
      if (typeof row.expires_at === 'string' && row.expires_at !== '' && Date.parse(row.expires_at) < Date.now()) {
        db.prepare('DELETE FROM mt_cache WHERE key = ?').run(key)
        return undefined
      }
      return JSON.parse(row.value_json)
    } catch {
      return undefined
    }
  }

  function cacheSet(key, provider, sourceLang, targetLang, text, value) {
    try {
      const now = new Date()
      db.prepare(
        'INSERT OR REPLACE INTO mt_cache(key, provider, source_lang, target_lang, text_hash, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        key,
        provider,
        sourceLang,
        targetLang,
        hashText(text),
        JSON.stringify(value),
        now.toISOString(),
        new Date(now.getTime() + cacheTtlMs).toISOString(),
      )
    } catch (error) {
      logger?.debug?.(`pappers-hall: mt_cache write failed: ${String(error?.message ?? error)}`)
    }
  }

  /* ----------------------------- events ------------------------------ */

  function recordEvent(provider, chars, elapsedMs, status, reason) {
    try {
      db.prepare('INSERT INTO mt_events(at, provider, chars, elapsed_ms, status, reason) VALUES (?, ?, ?, ?, ?, ?)').run(
        new Date().toISOString(),
        provider,
        Math.max(0, Math.round(chars)),
        Math.max(0, Math.round(elapsedMs)),
        status,
        reason ?? null,
      )
    } catch (error) {
      logger?.debug?.(`pappers-hall: mt_event write failed: ${String(error?.message ?? error)}`)
    }
  }

  function markStat(provider, latencyMs, error) {
    lastStats.set(provider, { latencyMs: Number.isFinite(latencyMs) ? latencyMs : null, error: error ?? null, at: Date.now() })
  }

  /* ----------------------------- network ----------------------------- */

  async function fetchOnce(url, init, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, headers: { 'user-agent': BROWSER_UA, ...(init.headers ?? {}) } })
      if (!response.ok) {
        const code = `http_${response.status}`
        throw Object.assign(new Error(`translation endpoint returned ${response.status}`), { code, status: response.status })
      }
      return await response.json()
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'timeout') throw Object.assign(new Error('translation request timed out'), { code: 'timeout' })
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** One network call with a bounded retry for network errors and 5xx. */
  async function fetchWithRetry(url, init, timeoutMs, attempts = 2) {
    let lastError
    const maxAttempts = Math.max(1, Math.min(2, Number(attempts) || 2))
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fetchOnce(url, init, timeoutMs)
      } catch (error) {
        lastError = error
        const retryable = error?.code === 'timeout' || error?.code === 'network_error' || /^http_5\d\d$/.test(String(error?.code ?? ''))
        if (!retryable || attempt === maxAttempts) break
      }
    }
    throw lastError
  }

  /* ----------------------------- engines ----------------------------- */

  async function translateGoogle(text, sourceLang, options = {}) {
    const target = 'zh-CN'
    const source = sourceLang === 'zh' ? 'zh-CN' : sourceLang === 'auto' || sourceLang === 'en' ? sourceLang : 'auto'
    const callTimeoutMs = Math.max(150, Math.min(networkTimeoutMs, Number(options.timeoutMs) || networkTimeoutMs))
    const chunks = splitTextChunks(text, 4_500)
    const translated = []
    for (const chunk of chunks) {
      const query = `client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(chunk)}`
      const payload = await networkSemaphore.acquire().then(async (release) => {
        try {
          return await fetchWithRetry(
            'https://translate.googleapis.com/translate_a/single',
            {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
              body: query,
            },
            callTimeoutMs,
            options.retries ?? 2,
          )
        } finally {
          release()
        }
      })
      translated.push(parseGoogleResponse(payload))
    }
    return { translation: translated.join(' '), chunks: chunks.length }
  }

  async function translateMyMemory(text, sourceLang, options = {}) {
    const source = sourceLang === 'en' || sourceLang === 'auto' ? 'en' : 'en'
    const callTimeoutMs = Math.max(150, Math.min(networkTimeoutMs, Number(options.timeoutMs) || networkTimeoutMs))
    const chunks = splitTextChunks(text, 450)
    const translated = []
    for (const chunk of chunks) {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(`${source}|zh-CN`)}`
      const payload = await networkSemaphore.acquire().then(async (release) => {
        try {
          return await fetchWithRetry(url, { method: 'GET' }, callTimeoutMs, options.retries ?? 2)
        } finally {
          release()
        }
      })
      const status = Number(payload?.responseStatus ?? 200)
      const translatedText = typeof payload?.responseData?.translatedText === 'string' ? payload.responseData.translatedText : ''
      if (status >= 400 || translatedText === '' || /MYMEMORY WARNING/i.test(translatedText)) {
        throw Object.assign(new Error(`mymemory rejected the request (status ${status})`), { code: `mymemory_${status}` })
      }
      translated.push(translatedText)
    }
    return { translation: translated.join(' '), chunks: chunks.length }
  }

  /**
   * Tencent Transmart (腾讯交互翻译) free web API — stable inside mainland China,
   * no API key. The same endpoint family is used by open-source clients such as
   * Bob/Pot/immersive-translate plugins. Batch text_list, JSON in/out.
   */
  async function translateTencent(text, sourceLang, options = {}) {
    const source = sourceLang === 'zh' ? 'zh' : sourceLang === 'en' ? 'en' : 'auto'
    const target = 'zh'
    const callTimeoutMs = Math.max(150, Math.min(networkTimeoutMs, Number(options.timeoutMs) || networkTimeoutMs))
    const chunks = splitTextChunks(text, 1_800)
    const translated = []
    for (const chunk of chunks) {
      const payload = await networkSemaphore.acquire().then(async (release) => {
        try {
          return await fetchWithRetry(
            'https://transmart.qq.com/api/imt',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                header: {
                  fn: 'auto_translation',
                  client_key: 'browser-chrome-120.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487',
                },
                type: 'plain',
                model_category: 'normal',
                text_domain: '',
                source: { lang: source, text_list: [chunk] },
                target: { lang: target },
              }),
            },
            callTimeoutMs,
            options.retries ?? 2,
          )
        } finally {
          release()
        }
      })
      const retCode = payload && payload.header && payload.header.ret_code
      if (retCode !== undefined && retCode !== 'succ') {
        throw Object.assign(new Error(`tencent ret_code ${retCode}`), { code: `tencent_${String(retCode)}` })
      }
      const items = payload && Array.isArray(payload.auto_translation) ? payload.auto_translation : []
      const joined = items.map((item) => (typeof item === 'string' ? item : '')).join(' ').trim()
      if (joined === '') throw Object.assign(new Error('tencent returned an empty translation'), { code: 'tencent_empty' })
      translated.push(joined)
    }
    return { translation: translated.join(' '), chunks: chunks.length }
  }

  async function translateLibre(text, sourceLang) {
    if (libreUrl === null) throw Object.assign(new Error('libretranslate is not configured (config.libreUrl)'), { code: 'not_configured' })
    const payload = await networkSemaphore.acquire().then(async (release) => {
      try {
        return await fetchWithRetry(
          `${libreUrl}/translate`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              q: text,
              source: sourceLang === 'zh' ? 'zh' : 'en',
              target: 'zh',
              format: 'text',
              ...(libreApiKey === undefined ? {} : { api_key: libreApiKey }),
            }),
          },
          networkTimeoutMs,
        )
      } finally {
        release()
      }
    })
    if (typeof payload?.translatedText !== 'string' || payload.translatedText === '') {
      throw Object.assign(new Error('libretranslate returned no translation'), { code: 'libre_empty' })
    }
    return { translation: payload.translatedText, chunks: 1 }
  }

  async function translateLlm(text, target, params) {
    if (ai === undefined || ai.available !== true) throw Object.assign(new Error('LLM channel is unavailable'), { code: 'llm_unavailable' })
    const result = await ai.translateText({
      text,
      target: target === 'zh-CN' || target === 'zh' ? 'zh' : target,
      // AI 精译 is the deep path: request the model's medium thinking level;
      // ai.js falls back to the model default when no medium option exists.
      fast: params.fast === true,
      ...(params.fast === true ? {} : { reasoningEffort: 'medium' }),
      sessionId: params.sessionId,
      ...(params.context !== undefined && params.context !== null ? { context: params.context } : {}),
    })
    if (result.status !== 'translated' || typeof result.translation !== 'string') {
      throw Object.assign(new Error(result?.provenance?.reason ?? 'LLM translation failed'), { code: 'llm_error' })
    }
    return {
      translation: result.translation,
      chunks: 1,
      model: result.provenance?.model ?? null,
      promptVersion: result.provenance?.promptVersion ?? null,
      reasoningEffort: result.reasoningEffort ?? null,
      reasoningEffortRequested: result.reasoningEffortRequested ?? null,
      fast: result.fast === true,
    }
  }

  /** Run one engine; throws with a compact reason on failure. */
  async function runEngine(provider, text, sourceLang, target, params, options) {
    if (forcedFailures.has(provider)) throw Object.assign(new Error('forced failure (test hook)'), { code: 'forced_failure' })
    if (provider === 'tencent') return translateTencent(text, sourceLang, options)
    if (provider === 'google') return translateGoogle(text, sourceLang, options)
    if (provider === 'mymemory') return translateMyMemory(text, sourceLang, options)
    if (provider === 'libretranslate') return translateLibre(text, sourceLang)
    if (provider === 'llm') return translateLlm(text, target, params)
    throw Object.assign(new Error(`unknown translation provider ${provider}`), { code: 'invalid_provider' })
  }

  /** Resolve the source language once per request. */
  function resolveSourceLang(params, text) {
    const requested = typeof params.source === 'string' && params.source !== '' ? params.source : 'auto'
    if (requested === 'auto') return detectLanguage(text)
    if (requested === 'zh') return 'zh'
    return 'en'
  }

  /** Public payload for one successful engine call. */
  function successPayload(provider, translation, latencyMs, cached, chunks, extra = {}) {
    const engine = engineInfo(provider) ?? { id: provider, label: provider, free: true, unofficial: false }
    return {
      status: 'translated',
      translation,
      provider,
      engine: { id: engine.id, label: engine.label, free: engine.free, unofficial: engine.unofficial === true },
      latencyMs: Math.max(0, Math.round(latencyMs)),
      cached,
      chunks,
      ...extra,
      // Backwards compatible v0.3 fields (fast/precision consumers/tests).
      provenance: {
        model: typeof extra.model === 'string' && extra.model !== '' ? extra.model : `${provider}/${engine.label}`,
        provider,
        engine: engine.id,
        latencyMs: Math.max(0, Math.round(latencyMs)),
        cached,
        ...(extra.promptVersion === undefined ? {} : { promptVersion: extra.promptVersion }),
        ...(extra.fast === true ? { fast: true } : {}),
        ...(extra.reasoningEffort === undefined ? {} : { reasoningEffort: extra.reasoningEffort }),
      },
      elapsedMs: Math.max(0, Math.round(latencyMs)),
      fast: extra.fast === true,
      reasoningEffort: extra.reasoningEffort ?? null,
    }
  }

  /* ----------------------------- public API -------------------------- */

  /**
   * `translate.providers` — engine availability metadata (no real LLM probe).
   * @returns {{preferred:string, fallback:boolean, items:object[], disclaimer:string}}
   */
  function providers() {
    const settings = readSettings()
    let chain
    try {
      chain = resolveChain(settings.provider).chain
    } catch {
      chain = [...AUTO_CHAIN]
    }
    return {
      preferred: settings.provider,
      // Contract v0.4 §1.2: `fallback` is the degradation CHAIN; the on/off switch
      // is `fallbackEnabled`.
      fallback: chain,
      fallbackEnabled: settings.fallback,
      items: ENGINES.map((engine) => engineInfo(engine.id))
        .filter((item) => item !== null)
        .map((item) => ({ ...item, enabled: providerEnabled(item.id) })),
      disclaimer:
        'google 为非官方免费接口（unofficial），可能限流或随时变更；mymemory 有匿名日额度；免费引擎结果不代表 LLM 精译质量。',
      events: countEvents(),
      cacheEntries: countCache(),
    }
  }

  function countEvents() {
    try {
      return Number(db.prepare('SELECT COUNT(*) AS count FROM mt_events').get()?.count ?? 0)
    } catch {
      return 0
    }
  }

  function countCache() {
    try {
      return Number(db.prepare('SELECT COUNT(*) AS count FROM mt_cache').get()?.count ?? 0)
    } catch {
      return 0
    }
  }

  /**
   * `translate.settings` — read or persist provider preference.
   * @param {{provider?:string, fallback?:boolean}} [params] patch (omit for GET).
   * @returns {{preferred:string, fallback:boolean, items:object[]}}
   */
  function settings(params = {}) {
    const hasProvider = Object.hasOwn(params, 'provider')
    const hasFallback = Object.hasOwn(params, 'fallback')
    if (hasProvider || hasFallback) {
      if (hasProvider) {
        const provider = String(params.provider)
        if (provider !== 'auto' && !engineById.has(provider)) throw Object.assign(new Error(`unknown translation provider ${provider}`), { code: 'invalid_provider' })
        writeSetting(db, 'translationProvider', provider)
      }
      if (hasFallback) writeSetting(db, 'translationFallback', params.fallback !== false)
      recordEvent('settings', 0, 0, 'ok', hasProvider ? String(params.provider) : 'fallback')
    }
    const current = readSettings()
    const info = providers()
    // Contract v0.4 §1.2: GET/SET return {provider, fallback:boolean,...}; the full
    // engine metadata rides along in `providers`.
    return {
      provider: current.provider,
      fallback: current.fallback,
      providers: info,
      items: info.items,
      disclaimer: info.disclaimer,
    }
  }

  /**
   * `translate.text` — translate one text through the provider chain.
   *
   * v0.13 adds `quick:true` (alias `freeOnly:true`): ONLY the free engines
   * (google → mymemory) are tried under a hard ≤6s deadline; the LLM is never
   * called silently. When the free engines fail the result is `unavailable` with
   * `suggestAi:true` and a user-facing reason so the UI can offer AI 精译.
   * @param {object} params text/paperId/page/target/source/provider/fast/quick/sessionId/context.
   * @returns {Promise<object>} translation payload (never fabricated).
   */
  async function text(params = {}) {
    const startedAt = Date.now()
    const quick = params.quick === true || params.freeOnly === true
    const deadlineAt = quick ? startedAt + quickDeadlineMs : null
    const target = typeof params.target === 'string' && params.target !== '' ? params.target : 'zh'
    let sourceText = typeof params.text === 'string' ? params.text.trim() : ''
    if (sourceText === '' && typeof params.paperId === 'string' && params.paperId !== '') {
      const record = store.paperRow(params.paperId)
      if (record === undefined) throw Object.assign(new Error(`paper ${params.paperId} does not exist`), { code: 'not_found' })
      const page = clampInt(params.page ?? 1, 1, 100_000, 1)
      const row = store.pageRow(params.paperId, page)
      if (row === undefined) throw Object.assign(new Error(`page ${page} of paper ${params.paperId} was not extracted`), { code: 'not_found' })
      sourceText = String(row.text ?? '').trim()
    }
    if (sourceText === '') throw Object.assign(new Error('translate.text requires text or an extracted page'), { code: 'invalid' })
    // Newlines inside selected quotes break every engine (esp. MyMemory); all MT
    // happens on one normalized sentence stream. Blocks keep their paragraph split
    // because each block is translated separately.
    sourceText = normalizeTranslationInput(sourceText)
    const sourceLang = resolveSourceLang(params, sourceText)
    const targetLang = target === 'zh' || target === 'zh-CN' ? 'zh-CN' : target
    // A selection taken from a broken font encoding is not translatable text.
    // Refuse honestly instead of returning a confident translation of glyph codes.
    let textRepair = null
    if (looksLikeCipherText(sourceText)) {
      // Region-level repair: if the client sent selection rects, OCR the page and
      // read the text that actually sits inside the selection (figure labels,
      // scanned pages) before giving up on translation.
      if (typeof params.paperId === 'string' && params.paperId !== '' && Number.isInteger(params.page) && Array.isArray(params.rects)) {
        try {
          const repaired = await store.repairQuoteFromOcr(params.paperId, params.page, params.rects, sourceText)
          if (repaired !== null && typeof repaired.text === 'string' && repaired.text.trim() !== '') {
            sourceText = normalizeTranslationInput(repaired.text)
            textRepair = repaired.source
          }
        } catch (error) { /* optional OCR capability */ }
      }
    }
    if (looksLikeCipherText(sourceText)) {
      return {
        status: 'unavailable',
        translation: null,
        provider: null,
        engine: null,
        latencyMs: Math.max(0, Date.now() - startedAt),
        cached: false,
        chunks: 0,
        reason: '所选文字来自损坏的 PDF 文本层（乱码），无法可靠翻译；请用 OCR/重新框选，或升级该页文本层',
        failures: [],
        mode: 'none',
        freeOnly: false,
        suggestAi: false,
        provenance: { model: 'none', provider: 'none', engine: 'none', latencyMs: 0, cached: false, promptVersion: 'mt-engine-v1' },
        elapsedMs: Math.max(0, Date.now() - startedAt),
        fast: false,
        reasoningEffort: null,
      }
    }
    if (sourceLang === 'zh' && targetLang === 'zh-CN') {
      return {
        status: 'translated',
        translation: sourceText,
        provider: 'none',
        engine: { id: 'none', label: '无需翻译（源已是中文）', free: true, unofficial: false },
        latencyMs: Math.max(0, Date.now() - startedAt),
        cached: false,
        skipped: true,
        chunks: 1,
        mode: 'none',
        freeOnly: quick,
        suggestAi: false,
        provenance: { model: 'none', provider: 'none', engine: 'none', latencyMs: 0, cached: false },
        elapsedMs: Math.max(0, Date.now() - startedAt),
        fast: quick || params.fast === true,
        reasoningEffort: null,
      }
    }
    const requested = typeof params.provider === 'string' && params.provider !== '' ? params.provider : undefined

    /** Quick-mode failure payload: honest, user-facing, never fakes a translation. */
    const quickUnavailable = (reason, failures = [], requestedProvider = null) => ({
      status: 'unavailable',
      translation: null,
      provider: requestedProvider,
      engine: null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      cached: false,
      chunks: 0,
      reason,
      failures,
      mode: 'free',
      freeOnly: true,
      suggestAi: true,
      provenance: { model: 'none', provider: 'none', engine: 'none', latencyMs: 0, cached: false, promptVersion: 'mt-engine-v1', quick: true },
      elapsedMs: Math.max(0, Date.now() - startedAt),
      fast: true,
      reasoningEffort: null,
    })

    if (quick && (requested === 'llm' || requested === 'libretranslate')) {
      return quickUnavailable('快速翻译只使用免费引擎（腾讯/Google/MyMemory）；需要 AI 精译请点击「用 AI 精译」', [], requested)
    }
    const { chain, fallback: chainFallback } = resolveChain(requested)
    // Explicit AI 精译 must never silently become a free-engine translation when
    // the LLM channel itself is unavailable; report it honestly instead.
    if (requested === 'llm' && (ai === undefined || ai.available !== true)) {
      return {
        status: 'unavailable',
        translation: null,
        provider: 'llm',
        engine: null,
        latencyMs: Math.max(0, Date.now() - startedAt),
        cached: false,
        chunks: 0,
        reason: 'AI 精译不可用：LLM 通道未就绪（请检查 DSH 模型设置）',
        failures: [{ provider: 'llm', reason: 'llm_unavailable', latencyMs: 0 }],
        mode: 'ai',
        freeOnly: false,
        suggestAi: false,
        provenance: { model: 'none', provider: 'llm', engine: 'llm', latencyMs: 0, cached: false, promptVersion: 'mt-engine-v1' },
        elapsedMs: Math.max(0, Date.now() - startedAt),
        fast: false,
        reasoningEffort: null,
      }
    }
    let effectiveChain = chain
    if (quick) {
      const freeOrder = requested === 'tencent' ? ['tencent', 'google', 'mymemory'] : requested === 'mymemory' ? ['mymemory', 'google', 'tencent'] : requested === 'google' ? ['google', 'tencent', 'mymemory'] : ['tencent', 'google', 'mymemory']
      effectiveChain = freeOrder.filter((id) => chain.includes(id) && providerEnabled(id))
      if (effectiveChain.length === 0) {
        return quickUnavailable('免费引擎暂不可用（已在设置中关闭或未配置），可改用 AI 精译', [], null)
      }
    }
    if (effectiveChain.length === 0) {
      const requestedDisabled = requested !== undefined && requested !== 'auto' && !providerEnabled(requested)
      const reason = requestedDisabled
        ? `请求的翻译引擎 ${requested} 已在设置中关闭${chainFallback ? '' : '，且回退已关闭'}；请在设置中启用该引擎${chainFallback ? '' : '或开启回退'}`
        : '所有翻译引擎已在设置中关闭；请在设置中至少启用一个翻译引擎'
      return {
        status: 'unavailable',
        translation: null,
        provider: null,
        engine: null,
        latencyMs: 0,
        cached: false,
        chunks: 0,
        reason,
        failures: [],
        mode: quick ? 'free' : 'none',
        freeOnly: quick,
        suggestAi: quick,
        provenance: { model: 'none', provider: 'none', engine: 'none', latencyMs: 0, cached: false, promptVersion: 'mt-engine-v1' },
        elapsedMs: Date.now() - startedAt,
        fast: quick || params.fast === true,
        reasoningEffort: null,
      }
    }
    const failures = []
    for (const provider of effectiveChain) {
      if (quick && deadlineAt !== null && Date.now() >= deadlineAt - 50) {
        failures.push({ provider, reason: 'deadline_exceeded', latencyMs: 0 })
        break
      }
      const mode = provider === 'llm' ? 'ai' : 'free'
      const key = cacheKey(provider, sourceLang, targetLang, sourceText, quick || params.fast === true)
      let cachedResult = cacheGet(key)
      // Quick mode may reuse a previously fetched real translation for the same
      // text/engine (the deep-key entry) instead of hammering a rate-limited
      // public endpoint again. It is reported as cached=true, never as fresh.
      if (cachedResult === undefined && quick) cachedResult = cacheGet(cacheKey(provider, sourceLang, targetLang, sourceText, false))
      if (cachedResult === undefined && quick) cachedResult = cacheGet(legacyCacheKey(provider, sourceLang, targetLang, sourceText))
      const cachedQuality = cachedResult === undefined ? { suspicious: true } : evaluateTranslationQuality(sourceText, cachedResult.translation)
      if (cachedResult !== undefined && typeof cachedResult.translation === 'string' && cachedQuality.suspicious !== true) {
        markStat(provider, cachedResult.latencyMs ?? 0, null)
        return successPayload(provider, cachedResult.translation, 0, true, cachedResult.chunks ?? 1, {
          cachedProvider: provider,
          translationLatencyMs: cachedResult.latencyMs ?? null,
          fast: quick || params.fast === true,
          mode,
          freeOnly: quick,
          suggestAi: false,
        })
      }
      const attemptStarted = Date.now()
      try {
        let result
        if (quick) {
          const remaining = Math.max(150, deadlineAt - Date.now())
          const engineOptions = { timeoutMs: Math.min(networkTimeoutMs, remaining), retries: 1 }
          let timer = null
          result = await Promise.race([
            runEngine(provider, sourceText, sourceLang, targetLang, params, engineOptions),
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(Object.assign(new Error('quick translation deadline exceeded'), { code: 'deadline_exceeded' })), remaining + 80)
            }),
          ]).finally(() => {
            if (timer !== null) clearTimeout(timer)
          })
        } else {
          result = await runEngine(provider, sourceText, sourceLang, targetLang, params)
        }
        const latencyMs = Date.now() - attemptStarted
        const quality = evaluateTranslationQuality(sourceText, result.translation)
        if (quality.suspicious === true) {
          markStat(provider, latencyMs, `low_quality:${quality.reason}`)
          recordEvent(provider, sourceText.length, latencyMs, 'low_quality', `low_quality_fallback:${quality.reason}`)
          failures.push({ provider, reason: `low_quality_fallback:${quality.reason}`, latencyMs })
          logger?.debug?.(`pappers-hall: translation from ${provider} looked broken (${quality.reason}); trying next engine`)
          continue
        }
        markStat(provider, latencyMs, null)
        recordEvent(provider, sourceText.length, latencyMs, 'ok', null)
        cacheSet(key, provider, sourceLang, targetLang, sourceText, { translation: result.translation, chunks: result.chunks ?? 1, latencyMs })
        return successPayload(provider, result.translation, latencyMs, false, result.chunks ?? 1, {
          ...(result.model === undefined ? {} : { model: result.model }),
          ...(result.promptVersion === undefined ? {} : { promptVersion: result.promptVersion }),
          ...(result.reasoningEffort === undefined ? {} : { reasoningEffort: result.reasoningEffort }),
          ...(result.reasoningEffortRequested === undefined ? {} : { reasoningEffortRequested: result.reasoningEffortRequested }),
          ...(textRepair === null ? {} : { textRepair }),
          // A free engine is inherently "fast"; report the requested mode truthfully
          // so legacy fast-translation consumers see fast=true with reasoningEffort=null.
          fast: quick || params.fast === true || result.fast === true,
          mode,
          freeOnly: quick,
          suggestAi: false,
          ...(failures.length === 0 ? {} : { fallbacks: failures }),
        })
      } catch (error) {
        const reason = engineFailureReason(error)
        const latencyMs = Date.now() - attemptStarted
        markStat(provider, latencyMs, reason)
        recordEvent(provider, sourceText.length, latencyMs, 'error', reason)
        failures.push({ provider, reason, latencyMs })
        logger?.debug?.(`pappers-hall: translation provider ${provider} failed: ${reason}`)
      }
    }
    if (quick) {
      const failureDetail = failures.map((failure) => `${failure.provider}(${failure.reason})`).join('; ')
      return quickUnavailable(
        `免费引擎暂不可用（限流/网络${failureDetail === '' ? '' : `：${failureDetail}`}），可改用 AI 精译`,
        failures,
        failures[0]?.provider ?? null,
      )
    }
    return {
      status: 'unavailable',
      translation: null,
      provider: null,
      engine: null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      cached: false,
      chunks: 0,
      reason:
        failures.length === 0
          ? 'no translation provider is configured'
          : `all providers failed: ${failures.map((failure) => `${failure.provider}(${failure.reason})`).join('; ')}`,
      failures,
      mode: effectiveChain.includes('llm') ? 'ai' : 'free',
      freeOnly: false,
      suggestAi: false,
      provenance: { model: null, provider: null, engine: null, latencyMs: 0, cached: false, reason: 'all providers failed' },
      elapsedMs: Math.max(0, Date.now() - startedAt),
      fast: params.fast === true,
      reasoningEffort: null,
    }
  }

  /**
   * `translate.detect` — lightweight language detection for the UI/agent.
   * @param {{text:string}} params request.
   * @returns {{language:'zh'|'en'|'unknown', han:number, latin:number, ratio:number}}
   */
  function detect(params = {}) {
    const text = typeof params.text === 'string' ? params.text : ''
    const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
    const latin = (text.match(/[A-Za-z]/g) ?? []).length
    const total = han + latin
    return { language: detectLanguage(text), han, latin, ratio: total === 0 ? 0 : Number((han / total).toFixed(3)) }
  }

  async function title(params = {}) {
    const ids = Array.isArray(params.ids) ? params.ids.map(String) : []
    if (ids.length === 0) throw Object.assign(new Error('translate.title requires ids'), { code: 'invalid' })
    const target = typeof params.target === 'string' && params.target !== '' ? params.target : 'zh'
    const results = []
    for (const id of ids) {
      const row = store.paperRow(id)
      if (row === undefined) {
        results.push({ id, titleZh: null, status: 'unavailable', reason: 'paper_not_found' })
        continue
      }
      const existing = typeof row.title_zh === 'string' && row.title_zh.trim() !== '' ? row.title_zh.trim() : null
      const source = row.title_zh_source ?? 'metadata'
      if (existing !== null && params.force !== true) {
        const metadata = source === 'human' || source === 'metadata'
        results.push({
          id,
          titleZh: existing,
          status: metadata ? 'from_metadata' : 'translated',
          provider: metadata ? 'metadata' : (source === 'machine' ? 'machine' : 'llm'),
          engine: { id: metadata ? 'metadata' : source === 'machine' ? 'machine' : 'llm', label: metadata ? '已有译名' : '已缓存译名', free: true, unofficial: false },
          latencyMs: 0,
          provenance: { model: null, provider: metadata ? 'metadata' : source, source: 'stored' },
        })
        continue
      }
      const translated = await text({
        text: row.title,
        target,
        source: detectLanguage(row.title) === 'zh' ? 'zh' : 'en',
        provider: params.provider,
        fast: params.fast,
        sessionId: params.sessionId,
      })
      if (translated.status === 'translated' && typeof translated.translation === 'string') {
        const value = translated.translation.trim()
        const storeSource = translated.provider === 'llm' ? 'ai' : 'machine'
        store.writePaperTitle?.(id, value, storeSource) ??
          db.prepare('UPDATE papers SET title_zh = ?, title_zh_source = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(
            value,
            storeSource,
            new Date().toISOString(),
            id,
          )
        store.reindexPaper?.(id)
        results.push({
          id,
          titleZh: value,
          status: 'translated',
          provider: translated.provider,
          engine: translated.engine,
          latencyMs: translated.latencyMs,
          cached: translated.cached,
          provenance: translated.provenance,
        })
      } else {
        results.push({
          id,
          titleZh: null,
          status: 'unavailable',
          provider: null,
          engine: null,
          latencyMs: translated.latencyMs ?? 0,
          reason: translated.reason ?? 'translation failed',
          provenance: translated.provenance,
        })
      }
    }
    const first = results.find((result) => result.status === 'translated')
    return { results, provider: first?.engine ?? null }
  }

  /**
   * `translate.blocks` — bilingual page translation through the engine chain.
   * @param {{paperId:string, page:number, target?:string, provider?:string, fast?:boolean, sessionId?:string}} params request.
   * @returns {Promise<object>} per-block translations with provider per block.
   */
  async function blocks(params = {}) {
    const paperId = String(params.paperId ?? '')
    const page = Number(params.page)
    if (paperId === '') throw Object.assign(new Error('translate.blocks requires paperId'), { code: 'invalid' })
    if (!Number.isInteger(page) || page < 1) throw Object.assign(new Error('translate.blocks requires a positive page'), { code: 'invalid' })
    const target = typeof params.target === 'string' && params.target !== '' ? params.target : 'zh'
    const provider = typeof params.provider === 'string' && params.provider !== '' ? params.provider : readSettings().provider
    const row = store.paperRow(paperId)
    if (row === undefined) throw Object.assign(new Error(`paper ${paperId} does not exist`), { code: 'not_found' })
    if (row.state !== 'active') throw Object.assign(new Error(`paper ${paperId} is not available`), { code: 'not_found' })
    const pageRecord = store.pageRow(paperId, page)
    const structure = pageRecord?.layout_json === undefined || pageRecord.layout_json === null ? undefined : JSON.parse(pageRecord.layout_json)
    if (structure === undefined || !Array.isArray(structure.blocks)) {
      return {
        blocks: [],
        provenance: { model: null, provider, promptVersion: 'mt-engine-v1', sourceHash: null, fast: params.fast === true, reasoningEffort: null },
        cached: false,
        status: 'unavailable',
        reason: 'page structure is not ready yet; retry after the background layout job finishes',
        fast: params.fast === true,
        reasoningEffort: null,
      }
    }
    const eligible = structure.blocks.filter(
      (block) => typeof block.text === 'string' && block.text.trim().length >= 2 && ['body', 'heading', 'list', 'caption'].includes(block.role),
    )
    const qualityById = new Map(eligible.map((block) => [block.id, { ...assessTextQuality(block.text), ok: assessTextQuality(block.text).ok !== false && !looksLikeCipherText(block.text) }]))
    const usable = eligible.filter((block) => qualityById.get(block.id)?.ok !== false)
    const lowQualityBlocks = eligible.filter((block) => qualityById.get(block.id)?.ok === false)
    const sourceText = eligible.map((block) => block.text).join('\n')
    const sourceHash = hashText(sourceText)
    const blockResults = []
    const usedProviders = new Set()
    const reasons = new Set()
    // Explicit LLM provider keeps the v0.3 batched AI translation path.
    if (provider === 'llm') {
      if (ai === undefined || ai.available !== true) {
        return {
          blocks: eligible.map((block) => ({
            id: block.id,
            text: block.text,
            translation: null,
            status: 'unavailable',
            provider: 'llm',
            reason: 'llm_unavailable',
            cached: false,
          })),
          provenance: { model: null, provider: 'llm', promptVersion: 'mt-engine-v1', sourceHash, fast: params.fast === true, reasoningEffort: null },
          cached: false,
          status: 'unavailable',
          reason: 'LLM channel is unavailable',
          fast: params.fast === true,
          reasoningEffort: null,
        }
      }
      const llmResult = await ai.translateBlocks({ paperId, page, target, fast: params.fast === true, sessionId: params.sessionId })
      const decorated = (llmResult.blocks ?? []).map((block) => ({
        id: block.id,
        text: block.text,
        translation: block.translation ?? null,
        status: block.status,
        provider: 'llm',
        reason: block.reason ?? null,
        cached: block.cached === true,
      }))
      const allTranslated = decorated.length > 0 && decorated.every((block) => block.status === 'translated')
      return {
        blocks: decorated,
        provenance: { ...(llmResult.provenance ?? {}), provider: 'llm', promptVersion: 'mt-engine-v1', sourceHash, fast: params.fast === true },
        cached: llmResult.cached === true,
        status: llmResult.status,
        ...(llmResult.reason === undefined ? {} : { reason: llmResult.reason }),
        fast: params.fast === true,
        reasoningEffort: llmResult.reasoningEffort ?? null,
        engine: engineInfo('llm'),
        allTranslated,
      }
    }
    const translateOne = async (block) => {
      const result = await text({
        text: block.text,
        target,
        source: detectLanguage(block.text) === 'zh' ? 'zh' : 'en',
        provider: params.provider,
        fast: params.fast,
        sessionId: params.sessionId,
      })
      if (result.status === 'translated') {
        usedProviders.add(result.provider)
        return { id: block.id, text: block.text, translation: result.translation, status: 'translated', provider: result.provider, cached: result.cached === true }
      }
      reasons.add(result.reason ?? 'translation failed')
      return { id: block.id, text: block.text, translation: null, status: 'unavailable', provider: null, reason: result.reason ?? 'translation failed' }
    }
    for (let index = 0; index < usable.length; index += 2) {
      const chunk = usable.slice(index, index + 2)
      const settled = await Promise.all(chunk.map((block) => translateOne(block)))
      blockResults.push(...settled)
    }
    for (const block of lowQualityBlocks) {
      blockResults.push({ id: block.id, text: block.text, translation: null, status: 'unavailable', provider: null, reason: `low_quality_text_layer:${qualityById.get(block.id)?.kind ?? 'unknown'}`, cached: false })
    }
    const normalizedBlocks = blockResults.map((block) => ({
      id: block.id,
      text: block.text,
      translation: block.translation ?? null,
      status: block.status,
      provider: block.provider ?? null,
      reason: block.reason ?? null,
      cached: block.cached === true,
    }))
    const translated = normalizedBlocks.filter((block) => block.status === 'translated').length
    return {
      blocks: normalizedBlocks,
      provenance: {
        model: [...usedProviders].join(', ') || null,
        provider: [...usedProviders].join(', ') || ('auto'),
        promptVersion: 'mt-engine-v1',
        sourceHash,
        fast: params.fast === true,
      },
      cached: normalizedBlocks.length > 0 && normalizedBlocks.every((block) => block.cached === true),
      status: translated === 0 ? 'unavailable' : translated === normalizedBlocks.length ? 'ok' : 'partial',
      ...(reasons.size === 0 ? {} : { reason: [...reasons].join('; ') }),
      fast: params.fast === true,
      reasoningEffort: null,
    }
  }

  /**
   * `translation.test` — one real translation call for the settings panel.
   * @param {{provider?:string,text?:string,target?:string}} params request.
   * @returns {Promise<object>} {ok,provider,translated,latencyMs,reason?}
   */
  async function test(params = {}) {
    const requested = typeof params.provider === 'string' && params.provider !== '' ? params.provider : undefined
    const probe = typeof params.text === 'string' && params.text.trim() !== '' ? params.text : 'Pappers-Hall translation test: the local paper library is ready.'
    const detected = detectLanguage(probe)
    const target = typeof params.target === 'string' && params.target !== '' ? params.target : detected === 'zh' ? 'en' : 'zh'
    const started = Date.now()
    try {
      const result = await text({ text: probe, target, source: detected === 'zh' ? 'zh' : 'en', provider: requested, fast: true })
      return {
        ok: result.status === 'translated' && typeof result.translation === 'string' && result.translation.trim() !== '',
        provider: result.provider ?? requested ?? 'auto',
        engine: result.engine?.id ?? null,
        translated: result.translation ?? null,
        latencyMs: result.latencyMs ?? Date.now() - started,
        cached: result.cached === true,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      }
    } catch (error) {
      return { ok: false, provider: requested ?? 'auto', translated: null, latencyMs: Date.now() - started, reason: String(error?.message ?? error) }
    }
  }

  /** Translation diagnostics block for `diagnostics`. */
  function diagnostics() {
    const info = providers()
    return {
      preferred: info.preferred,
      fallback: info.fallback,
      fallbackEnabled: info.fallbackEnabled,
      providers: info.items,
      events: info.events,
      cacheEntries: info.cacheEntries,
      disclaimer: info.disclaimer,
      forcedFailures: [...forcedFailures],
      libreConfigured: libreUrl !== null,
    }
  }

  /** Recent translation events (diagnostics/testing). */
  function recentEvents(limit = 20) {
    const rows = db
      .prepare('SELECT at, provider, chars, elapsed_ms, status, reason FROM mt_events ORDER BY id DESC LIMIT ?')
      .all(clampInt(limit, 1, 100, 20))
    return { items: rows.map((row) => ({ at: row.at, provider: row.provider, chars: Number(row.chars), elapsedMs: Number(row.elapsed_ms ?? 0), status: row.status, reason: row.reason ?? null })) }
  }

  return {
    providers,
    settings,
    text,
    test,
    title,
    blocks,
    detect,
    diagnostics,
    recentEvents,
    countCache,
    countEvents,
    engines: ENGINES,
    close() {},
  }
}
