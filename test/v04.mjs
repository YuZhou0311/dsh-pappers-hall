#!/usr/bin/env node
/**
 * Pappers-Hall v0.4 API acceptance suite.
 *
 * Exercises the v0.4 contract additions (docs/CONTRACT-v04.md §1/§2/§5) against
 * the LIVE installed plugin:
 * - free translation engine chain: translate.providers / translate.settings /
 *   translate.text (google / mymemory / llm / auto / fallback) / per-provider
 *   cache keys / translate.detect / translate.blocks (per-paragraph, cached);
 * - discovery surfaces for the redesigned right sidebar: discover.feed
 *   (stats/sections/recent annotations/figures/taxonomy, latency), and
 *   annotations.feed (ordering/filters/pagination);
 * - regression: the recorded v0.3 38/38, v0.2 26/26 and lifecycle 12/0/1
 *   results are re-read (not re-run here, to avoid overwriting the evidence).
 *
 * Design rules:
 * - engine metadata must never pretend to be official: google is asserted to be
 *   `unofficial:true` and `free:true`, mymemory `free:true`, llm `free:false`;
 * - every network failure is accepted only with an explicit status + reason and
 *   no fabricated translation; successes record the real provider/latency/text;
 * - settings and test annotations are restored/deleted in `finally`;
 * - expectations are never edited to make a failing implementation pass.
 *
 * Usage:
 *   node test/v04.mjs --dry-run    # print case plan + read-only environment probe
 *   node test/v04.mjs              # real run (requires the v0.4 host loaded)
 *   node test/v04.mjs --base http://127.0.0.1:54731 --out ../reports/v04-api-results.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const arg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

const DRY_RUN = flag('--dry-run')
const BASE = arg('--base', process.env.PAPPERS_BASE ?? 'http://127.0.0.1:54731')
const API = `${BASE}/pappers-hall/api`
const OUT = resolve(HERE, arg('--out', '../../reports/v04-api-results.json'))
/** ReAct (A01): dense 2-column page 3, good for paragraph translation. */
const BLOCKS_PAPER = arg('--blocks-paper', 'ph-53132d8d95a6')
/** C01: user paper with existing annotations; fixture annotation is created here. */
const ANNOT_PAPER = arg('--annot-paper', 'ph-8d90723ee7bc')
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

/** Providers the contract requires the metadata/chain to expose. */
const REQUIRED_PROVIDERS = ['google', 'mymemory', 'llm']
const PROVIDER_IDS = ['auto', 'google', 'mymemory', 'llm', 'libretranslate']
const VALID_SEGMENT_PROVIDERS = ['google', 'mymemory', 'llm']

const PLAN = [
  ['ENV.version', 'ENV', 'v0.4 Host loaded: plugin 0.4.x / schemaVersion>=4 or translate.providers+discover.feed callable'],
  ['ENV.baseline', 'ENV', 'live library intact before mutation: papers>=30, annotations>=1, trash=0; translation settings captured for restore'],
  ['TRANSLATE.providers.structure', 'PROVIDERS', 'translate.providers returns {preferred, fallback[], items[]} with id/label/free/configured/available/lastLatencyMs'],
  ['TRANSLATE.providers.honesty', 'PROVIDERS', 'engine metadata is honest: google free+unofficial, mymemory free, llm not free; libretranslate only when configured'],
  ['TRANSLATE.settings.get', 'SETTINGS', 'translate.settings GET returns {provider in auto|google|mymemory|llm|libretranslate, fallback:boolean}; default provider=auto'],
  ['TRANSLATE.settings.set', 'SETTINGS', 'translate.settings SET provider=mymemory persists and reads back'],
  ['TRANSLATE.settings.invalid', 'SETTINGS', 'translate.settings rejects an unknown provider with an explicit invalid error, without changing the stored value'],
  ['TRANSLATE.settings.fallback', 'SETTINGS', 'translate.settings fallback=false persists and reads back; restored to true afterwards'],
  ['TRANSLATE.text.google', 'TRANSLATE', 'translate.text provider=google translates a short sentence: status=translated, Chinese non-copy, engine.id=google/free/unofficial, latencyMs>0'],
  ['TRANSLATE.text.google.cache', 'TRANSLATE', 'second identical google call reports cached=true'],
  ['TRANSLATE.text.mymemory', 'TRANSLATE', 'translate.text provider=mymemory translates the same sentence: provider=mymemory, free engine, latencyMs>0, first call cached=false (provider-keyed cache)'],
  ['TRANSLATE.text.cache.isolation', 'TRANSLATE', 'a second mymemory call is cached=true while the google entry was not reused (provider is part of the cache key)'],
  ['TRANSLATE.text.llm', 'TRANSLATE', 'translate.text provider=llm still translates (fast) with engine.free=false and honest provider; unavailable only with an explicit reason'],
  ['TRANSLATE.text.auto', 'TRANSLATE', 'provider=auto resolves to a real engine following the declared chain (google→mymemory→llm) and reports engine.id/provider consistently'],
  ['TRANSLATE.fallback.unconfigured', 'TRANSLATE', 'provider=libretranslate without config fails honestly (unavailable+reason) or falls back to a real engine and reports the real provider; no fabricated translation'],
  ['TRANSLATE.text.invalidProvider', 'TRANSLATE', 'translate.text with an unknown provider returns an explicit invalid/unavailable error, never a fabricated translation'],
  ['TRANSLATE.detect.zh', 'DETECT', 'translate.detect on Chinese text detects zh'],
  ['TRANSLATE.detect.en', 'DETECT', 'translate.detect on English text detects en'],
  ['TRANSLATE.blocks.page', 'BLOCKS', 'translate.blocks on A01 page 3: blocks>0, translated>0 with real provider in google|mymemory|llm, failed segments carry reason; whole-page latency recorded'],
  ['TRANSLATE.blocks.cache', 'BLOCKS', 'second identical page request reports cached=true'],
  ['TRANSLATE.blocks.provenance', 'BLOCKS', 'blocks carry provider/status per segment and a provenance object (engine/model), translations never equal the source text'],
  ['DISCOVER.structure', 'DISCOVER', 'discover.feed(limit=5) returns stats + continueReading/unread/annotated/collections/tags/recentAnnotations/recentFigures; measured <500ms'],
  ['DISCOVER.stats', 'DISCOVER', 'feed stats match status/library.list/tags.list/collections.list; unread+reading+read partition the papers'],
  ['DISCOVER.sections', 'DISCOVER', 'tiles: <=limit per section, full PaperTile fields, unread read=false, annotated annotationCount>0 and sorted desc, ids unique inside a section'],
  ['DISCOVER.recent', 'DISCOVER', 'recentAnnotations reference active papers with page>=1 and colour; recentFigures expose image/thumbnail URLs and paper/page/label'],
  ['DISCOVER.taxonomy', 'DISCOVER', 'feed collections (5 field + custom) and tag counts match library.collections.list / tags.list'],
  ['ANN.feed.structure', 'ANNOTATIONS', 'annotations.feed returns complete items (paperTitle/page/kind/color/quote/comment/createdAt) in createdAt descending order'],
  ['ANN.feed.filters', 'ANNOTATIONS', 'annotations.feed paperId/colors/kinds/query filters return only matching items and include the fixture annotation'],
  ['ANN.feed.pagination', 'ANNOTATIONS', 'annotations.feed before-pagination does not repeat ids and stays descending before the cursor'],
  ['REF.v03', 'REF', 'recorded v0.3 API result file still reports 38/38 pass, 0 fail, 0 not_run'],
  ['REF.v02', 'REF', 'recorded v0.2 API result file still reports 26/26 pass'],
  ['REF.lifecycle', 'REF', 'recorded lifecycle result file still reports 13 cases: 12 pass, 0 fail, 1 not_run'],
  ['REF.data.preserved', 'REF', 'after cleanup: papers/annotations/figures/trash back to baseline, fixture annotation deleted, translation settings restored'],
  ['CLEANUP.settings', 'CLEANUP', 'translate.settings read back equals the settings captured at run start (default auto)'],
]

const results = []
const state = {
  startedAt: new Date().toISOString(),
  base: BASE,
  environment: null,
  baseline: {},
  providers: null,
  settingsOriginal: null,
  settingsProbes: [],
  translations: {},
  detect: {},
  blocks: {},
  discover: {},
  annotationsFeed: {},
  fixture: { annotationId: null },
  after: {},
  evidence: {},
  cleanupErrors: [],
}

const EXPECTED = new Map(PLAN.map(([id, group, expected]) => [id, { group, expected }]))
const recordedIds = new Set()

/* ------------------------------------------------------------------ *
 * HTTP / recording helpers
 * ------------------------------------------------------------------ */
async function call(method, params = {}, timeoutMs = 120_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: controller.signal,
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`${method}: non-JSON HTTP ${response.status}: ${text.slice(0, 160)}`)
    }
    if (!body.ok) {
      const error = new Error(`${body.error?.code}: ${body.error?.message}`)
      error.code = body.error?.code
      throw error
    }
    return body.data
  } finally {
    clearTimeout(timer)
  }
}

function clipValue(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value
  if (depth > 3) return '[depth]'
  if (Array.isArray(value)) {
    const head = value.slice(0, 6).map((entry) => clipValue(entry, depth + 1))
    return value.length > 6 ? [...head, `…${value.length - 6} more`] : head
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = clipValue(entry, depth + 1)
  return out
}

function record(caseId, expected, actual, pass, extra = {}) {
  const plan = EXPECTED.get(caseId)
  const entry = {
    case_id: caseId,
    group: extra.group ?? plan?.group ?? 'OTHER',
    expected: expected ?? plan?.expected ?? '',
    actual,
    status: pass ? 'pass' : 'fail',
    ...(extra.notes === undefined ? {} : { notes: extra.notes }),
  }
  results.push(entry)
  recordedIds.add(caseId)
  console.log(`${pass ? 'PASS' : 'FAIL'} ${caseId}${pass ? '' : ' — ' + JSON.stringify(clipValue(actual)).slice(0, 420)}`)
}

function notRun(caseId, expected, reason, extra = {}) {
  const plan = EXPECTED.get(caseId)
  results.push({
    case_id: caseId,
    group: extra.group ?? plan?.group ?? 'OTHER',
    expected: expected ?? plan?.expected ?? '',
    actual: { not_run_reason: reason, ...(extra.actual ?? {}) },
    status: 'not_run',
  })
  recordedIds.add(caseId)
  console.log(`NOT_RUN ${caseId} — ${reason}`)
}

async function check(caseId, expected, fn, extra = {}) {
  try {
    const outcome = await fn()
    if (outcome?.skipped === true) return outcome
    record(caseId, expected, outcome.actual, outcome.pass === true, { ...extra, notes: outcome.notes })
    return outcome
  } catch (error) {
    record(caseId, expected, { error: String(error?.message ?? error), code: error?.code ?? null }, false, extra)
    return null
  }
}

const isoNow = () => new Date().toISOString()
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const hasCjk = (text) => CJK.test(String(text ?? ''))

function normalizeItems(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.annotations)) return data.annotations
  if (Array.isArray(data?.entries)) return data.entries
  return []
}

function providerOrder(providers) {
  const items = providers?.items ?? []
  const available = new Set(items.filter((item) => item?.available === true).map((item) => item.id))
  const fallback = Array.isArray(providers?.fallback) ? providers.fallback.filter((id) => typeof id === 'string') : []
  const preferred = typeof providers?.preferred === 'string' ? providers.preferred : 'auto'
  const chain = preferred !== 'auto' && PROVIDER_IDS.includes(preferred)
    ? [preferred, ...fallback.filter((id) => id !== preferred)]
    : ['google', 'mymemory', 'llm'].filter((id) => fallback.length === 0 || fallback.includes(id) || id === 'google')
  const fullChain = ['google', 'mymemory', 'llm']
  const ordered = [...new Set([...chain, ...fullChain, ...fallback])].filter((id) => PROVIDER_IDS.includes(id) && id !== 'auto')
  return { chain: ordered, available, fallback, preferred }
}

async function measure(promiseFactory) {
  const started = Date.now()
  try {
    const data = await promiseFactory()
    return { data, ms: Date.now() - started, error: null }
  } catch (error) {
    return { data: null, ms: Date.now() - started, error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
  }
}

function readReport(relativePath) {
  const full = resolve(WORKSPACE, relativePath)
  if (!existsSync(full)) return { path: relativePath, exists: false }
  try {
    const parsed = JSON.parse(readFileSync(full, 'utf8'))
    return { path: relativePath, exists: true, parsed, bytes: readFileSync(full).length }
  } catch (error) {
    return { path: relativePath, exists: true, error: String(error?.message ?? error) }
  }
}

function detectLanguage(data) {
  const candidates = [data?.lang, data?.language, data?.detected, data?.code, data?.locale].filter((value) => typeof value === 'string')
  const raw = candidates[0] ?? null
  const normalized = raw === null ? null : raw.toLowerCase()
  const isZh = normalized !== null && (normalized.startsWith('zh') || normalized.includes('chinese') || normalized.includes('中文') || normalized.includes('han'))
  const isEn = normalized !== null && (normalized.startsWith('en') || normalized.includes('english') || normalized.includes('英文') || normalized.includes('latin'))
  return { raw, normalized, isZh, isEn, candidates }
}

function createAnnotationFixture() {
  return call(
    'annotations.create',
    {
      paperId: ANNOT_PAPER,
      page: 3,
      kind: 'highlight',
      quote: `v04 feed fixture quote ${RUN_STAMP}`,
      rects: [{ x: 0.15, y: 0.35, w: 0.3, h: 0.02 }],
      color: 'green',
      comment: `v04 feed fixture comment ${RUN_STAMP}`,
      origin: 'test_note',
      operationId: `v04-feed-ann-${RUN_STAMP}`,
    },
    30_000,
  )
}

/* ------------------------------------------------------------------ *
 * Environment / baseline / providers
 * ------------------------------------------------------------------ */
async function readEnvironment() {
  const status = await call('status')
  let diagnostics = null
  try {
    diagnostics = await call('diagnostics')
  } catch {
    diagnostics = null
  }
  return {
    status,
    diagnostics,
    pluginVersion: status?.plugin?.version ?? null,
    schemaVersion: diagnostics?.schemaVersion ?? null,
    counts: status?.counts ?? {},
    features: diagnostics?.features ?? {},
    ai: diagnostics?.ai ?? null,
    translation: diagnostics?.translation ?? null,
  }
}

async function probeV04Shape() {
  const probe = { providers: 'missing', discover: 'missing' }
  try {
    const data = await call('translate.providers', {}, 15_000)
    probe.providers = Array.isArray(data?.items) ? 'ok' : 'bad-shape'
  } catch (error) {
    probe.providers = `error:${error?.code ?? 'unknown'}`
  }
  try {
    const data = await call('discover.feed', { limit: 1 }, 15_000)
    probe.discover = data !== null && typeof data === 'object' ? 'ok' : 'bad-shape'
  } catch (error) {
    probe.discover = `error:${error?.code ?? 'unknown'}`
  }
  return probe
}

function normalizeSettings(data) {
  if (data !== null && typeof data === 'object' && typeof data.provider === 'string') return data
  if (data?.settings !== null && typeof data?.settings === 'object' && typeof data.settings.provider === 'string') return data.settings
  return data
}

function normalizeProviders(data) {
  if (data !== null && typeof data === 'object' && Array.isArray(data.items)) return data
  if (data?.providers !== null && typeof data?.providers === 'object' && Array.isArray(data.providers.items)) return data.providers
  return data
}

async function getSettings() {
  const data = await call('translate.settings', {}, 15_000)
  return normalizeSettings(data)
}

/**
 * annotations.feed filter probe: the contract does not pin the wire type of
 * colors/kinds (string vs array), so try both shapes and accept the one that
 * actually filters. Every returned item must still match the filter value.
 */
async function filterFeed(params) {
  const variants = [params]
  const key = Object.keys(params).find((name) => name === 'colors' || name === 'kinds')
  if (key !== undefined && typeof params[key] === 'string') {
    variants.push({ ...params, [key]: params[key].split(',').map((value) => value.trim()).filter(Boolean) })
  }
  const attempts = []
  for (const variant of variants) {
    try {
      const items = normalizeItems(await call('annotations.feed', variant, 30_000))
      const filterValue = variant[key]
      const matches = filterValue === undefined ? true : Array.isArray(filterValue)
        ? items.every((item) => filterValue.includes(String(item[key])))
        : items.every((item) => String(item[key]) === String(filterValue))
      attempts.push({ variant, items, matches, includesFixture: items.some((item) => item.id === state.fixture.annotationId) })
    } catch (error) {
      attempts.push({ variant, error: { code: error?.code ?? null, message: String(error?.message ?? error) } })
    }
  }
  const valid = attempts.find((attempt) => attempt.items !== undefined && attempt.matches)
  return { attempts, chosen: valid ?? attempts[attempts.length - 1], variants }
}


/* ------------------------------------------------------------------ *
 * Cases: translate providers / settings / text / detect / blocks
 * ------------------------------------------------------------------ */
async function providerCases() {
  await check('TRANSLATE.providers.structure', EXPECTED.get('TRANSLATE.providers.structure').expected, async () => {
    const data = normalizeProviders(await call('translate.providers', {}, 20_000))
    state.providers = data
    const items = Array.isArray(data?.items) ? data.items : []
    const missingProviders = REQUIRED_PROVIDERS.filter((id) => !items.some((item) => item?.id === id))
    const fieldIssues = items
      .map((item) => {
        const missing = []
        for (const field of ['id', 'label', 'free', 'configured', 'available', 'lastLatencyMs']) {
          if (!Object.hasOwn(item ?? {}, field)) missing.push(field)
        }
        if (typeof item?.free !== 'boolean') missing.push('free-type')
        if (typeof item?.configured !== 'boolean') missing.push('configured-type')
        if (typeof item?.available !== 'boolean') missing.push('available-type')
        return missing.length === 0 ? null : { id: item?.id, missing }
      })
      .filter(Boolean)
    const pass =
      data !== null &&
      typeof data === 'object' &&
      PROVIDER_IDS.includes(String(data.preferred)) &&
      Array.isArray(data.fallback) &&
      items.length >= 3 &&
      missingProviders.length === 0 &&
      fieldIssues.length === 0
    return {
      actual: {
        preferred: data?.preferred ?? null,
        fallback: data?.fallback ?? null,
        items: items.map((item) => ({ id: item.id, label: item.label, free: item.free, configured: item.configured, available: item.available, lastLatencyMs: item.lastLatencyMs ?? null, lastError: item.lastError ?? null, unofficial: item.unofficial ?? null })),
        missingProviders,
        fieldIssues,
      },
      pass,
    }
  })

  await check('TRANSLATE.providers.honesty', EXPECTED.get('TRANSLATE.providers.honesty').expected, async () => {
    const data = state.providers ?? normalizeProviders(await call('translate.providers', {}, 20_000))
    state.providers = data
    const items = Array.isArray(data?.items) ? data.items : []
    const byId = (id) => items.find((item) => item?.id === id) ?? null
    const google = byId('google')
    const mymemory = byId('mymemory')
    const llm = byId('llm')
    const libre = byId('libretranslate')
    const checks = {
      googleFree: google?.free === true,
      googleUnofficial: google?.unofficial === true,
      mymemoryFree: mymemory?.free === true,
      llmNotFree: llm?.free === false,
      libreGated: libre === null || libre.configured === false,
    }
    return {
      actual: {
        google: google === null ? null : { id: google.id, label: google.label, free: google.free, unofficial: google.unofficial, available: google.available, configured: google.configured },
        mymemory: mymemory === null ? null : { id: mymemory.id, label: mymemory.label, free: mymemory.free, available: mymemory.available },
        llm: llm === null ? null : { id: llm.id, label: llm.label, free: llm.free, available: llm.available },
        libretranslate: libre === null ? null : { configured: libre.configured, available: libre.available },
        checks,
      },
      pass: Object.values(checks).every(Boolean),
      notes: 'google is an unofficial free endpoint: the metadata must say so instead of presenting it as an official service.',
    }
  })
}

async function settingsCases() {
  state.settingsOriginal = await getSettings().catch(() => null)
  await check('TRANSLATE.settings.get', EXPECTED.get('TRANSLATE.settings.get').expected, async () => {
    const data = state.settingsOriginal
    const pass =
      data !== null &&
      typeof data === 'object' &&
      PROVIDER_IDS.includes(String(data.provider)) &&
      typeof data.fallback === 'boolean' &&
      data.provider === 'auto'
    return {
      actual: { settings: data, note: 'captured for restore at the end of the run' },
      pass,
      notes: data?.provider === 'auto' ? 'default provider is auto' : `provider was ${String(data?.provider)} before the run; cleanup restores this captured value`,
    }
  })

  await check('TRANSLATE.settings.set', EXPECTED.get('TRANSLATE.settings.set').expected, async () => {
    const set = await call('translate.settings', { provider: 'mymemory' }, 15_000)
    const read = await getSettings()
    const probe = { step: 'set-mymemory', set, read }
    state.settingsProbes.push(probe)
    const pass = String(set?.provider) === 'mymemory' && String(read?.provider) === 'mymemory' && typeof read?.fallback === 'boolean'
    return { actual: probe, pass }
  })

  await check('TRANSLATE.settings.invalid', EXPECTED.get('TRANSLATE.settings.invalid').expected, async () => {
    let error = null
    try {
      await call('translate.settings', { provider: 'bogus-provider' }, 15_000)
    } catch (caught) {
      error = { code: caught?.code ?? null, message: String(caught?.message ?? caught) }
    }
    const read = await getSettings()
    const probe = { error, read }
    state.settingsProbes.push({ step: 'invalid', ...probe })
    const rejected = error !== null && (String(error.code ?? '').toLowerCase() === 'invalid' || /invalid|unknown|unsupported/i.test(error.message))
    const unchanged = String(read?.provider) === 'mymemory'
    return { actual: probe, pass: rejected && unchanged }
  })

  await check('TRANSLATE.settings.fallback', EXPECTED.get('TRANSLATE.settings.fallback').expected, async () => {
    const setOff = await call('translate.settings', { fallback: false }, 15_000)
    const readOff = await getSettings()
    const setOn = await call('translate.settings', { fallback: true }, 15_000)
    const readOn = await getSettings()
    const probe = { setOff, readOff, setOn, readOn }
    state.settingsProbes.push({ step: 'fallback', ...probe })
    const pass = readOff?.fallback === false && readOn?.fallback === true
    return { actual: probe, pass }
  })

  // leave defaults for the translation cases
  await call('translate.settings', { provider: 'auto', fallback: true }, 15_000).catch(() => {})
}

async function translateTextCases() {
  const text = `The proposed retrieval method improves accuracy on three benchmarks while using half the memory (${RUN_STAMP}).`
  state.translations.text = text

  await check('TRANSLATE.text.google', EXPECTED.get('TRANSLATE.text.google').expected, async () => {
    const callResult = await measure(() => call('translate.text', { text, target: 'zh', provider: 'google' }, 30_000))
    state.translations.google = callResult
    const data = callResult.data ?? {}
    const translation = String(data.translation ?? '')
    const engine = data.engine ?? {}
    const pass =
      callResult.error === null &&
      data.status === 'translated' &&
      hasCjk(translation) &&
      translation.trim() !== text.trim() &&
      data.provider === 'google' &&
      engine.id === 'google' &&
      engine.free === true &&
      engine.unofficial !== false &&
      Number(data.latencyMs) > 0 &&
      data.cached === false
    return {
      actual: {
        status: data.status ?? null,
        provider: data.provider ?? null,
        engine: clipValue(engine),
        latencyMs: data.latencyMs ?? null,
        cached: data.cached ?? null,
        clientMs: callResult.ms,
        translation: translation.slice(0, 120),
        error: callResult.error,
      },
      pass,
    }
  })

  await check('TRANSLATE.text.google.cache', EXPECTED.get('TRANSLATE.text.google.cache').expected, async () => {
    const callResult = await measure(() => call('translate.text', { text, target: 'zh', provider: 'google' }, 30_000))
    const data = callResult.data ?? {}
    state.translations.googleCached = callResult
    const pass = callResult.error === null && data.cached === true && data.provider === 'google' && hasCjk(String(data.translation ?? ''))
    return { actual: { status: data.status ?? null, provider: data.provider ?? null, cached: data.cached ?? null, latencyMs: data.latencyMs ?? null, clientMs: callResult.ms }, pass }
  })

  await check('TRANSLATE.text.mymemory', EXPECTED.get('TRANSLATE.text.mymemory').expected, async () => {
    const callResult = await measure(() => call('translate.text', { text, target: 'zh', provider: 'mymemory' }, 30_000))
    state.translations.mymemory = callResult
    const data = callResult.data ?? {}
    const translation = String(data.translation ?? '')
    const engine = data.engine ?? {}
    const pass =
      callResult.error === null &&
      data.status === 'translated' &&
      hasCjk(translation) &&
      translation.trim() !== text.trim() &&
      data.provider === 'mymemory' &&
      engine.id === 'mymemory' &&
      engine.free === true &&
      Number(data.latencyMs) > 0 &&
      data.cached === false
    return {
      actual: {
        status: data.status ?? null,
        provider: data.provider ?? null,
        engine: clipValue(engine),
        latencyMs: data.latencyMs ?? null,
        cached: data.cached ?? null,
        clientMs: callResult.ms,
        translation: translation.slice(0, 120),
        reason: data.reason ?? null,
        error: callResult.error,
      },
      pass,
      notes: 'the first mymemory call must not reuse the google cache entry for the same source text.',
    }
  })

  await check('TRANSLATE.text.cache.isolation', EXPECTED.get('TRANSLATE.text.cache.isolation').expected, async () => {
    const second = await measure(() => call('translate.text', { text, target: 'zh', provider: 'mymemory' }, 30_000))
    const data = second.data ?? {}
    const first = state.translations.mymemory?.data ?? {}
    const googleFirst = state.translations.google?.data ?? {}
    const pass = second.error === null && data.cached === true && data.provider === 'mymemory' && googleFirst.provider === 'google' && first.cached === false
    return {
      actual: {
        googleFirst: { provider: googleFirst.provider ?? null, cached: googleFirst.cached ?? null },
        mymemoryFirst: { provider: first.provider ?? null, cached: first.cached ?? null },
        mymemorySecond: { provider: data.provider ?? null, cached: data.cached ?? null },
        clientMs: second.ms,
      },
      pass,
    }
  })

  const llmText = `Crop models simulate the effect of management on yields across scenarios (${RUN_STAMP}).`
  await check('TRANSLATE.text.llm', EXPECTED.get('TRANSLATE.text.llm').expected, async () => {
    const callResult = await measure(() => call('translate.text', { text: llmText, target: 'zh', provider: 'llm', fast: true }, 60_000))
    state.translations.llm = callResult
    const data = callResult.data ?? {}
    const translation = String(data.translation ?? '')
    if (data.status === 'translated') {
      const engine = data.engine ?? {}
      const pass =
        hasCjk(translation) &&
        translation.trim() !== llmText.trim() &&
        data.provider === 'llm' &&
        engine.free === false &&
        Number(data.latencyMs) > 0
      return {
        actual: { branch: 'translated', provider: data.provider ?? null, engine: clipValue(engine), latencyMs: data.latencyMs ?? null, cached: data.cached ?? null, clientMs: callResult.ms, translation: translation.slice(0, 120) },
        pass,
      }
    }
    const reason = String(data.reason ?? data.provenance?.reason ?? callResult.error?.message ?? '').trim()
    return {
      actual: { branch: 'degraded', status: data.status ?? null, reason, clientMs: callResult.ms, error: callResult.error },
      pass: ['unavailable', 'error'].includes(String(data.status)) && reason !== '' && translation === '',
      notes: 'unavailable path accepted only with an explicit reason and no fabricated translation',
    }
  })

  await check('TRANSLATE.text.auto', EXPECTED.get('TRANSLATE.text.auto').expected, async () => {
    const autoText = `Automatic engine selection should return the real provider (${RUN_STAMP}).`
    const callResult = await measure(() => call('translate.text', { text: autoText, target: 'zh', provider: 'auto' }, 40_000))
    const data = callResult.data ?? {}
    const order = providerOrder(state.providers)
    const resolved = String(data.provider ?? '')
    const engine = data.engine ?? {}
    const translated = data.status === 'translated'
    const allowed = VALID_SEGMENT_PROVIDERS.includes(resolved) && engine.id === resolved
    // The declared auto chain is google→mymemory→llm: when google works in this run the
    // resolution must be google (availability flags may be lazily populated).
    const googleWorks = order.available.has('google') || state.translations.google?.data?.status === 'translated'
    const mymemoryWorks = order.available.has('mymemory') || state.translations.mymemory?.data?.status === 'translated'
    const chainExpected = googleWorks ? 'google' : mymemoryWorks ? 'mymemory' : 'llm'
    const pass = callResult.error === null && translated && allowed && hasCjk(String(data.translation ?? '')) && resolved === chainExpected
    state.translations.auto = { ...callResult, resolved, chainExpected }
    return {
      actual: {
        status: data.status ?? null,
        resolved,
        declaredChain: order.chain,
        available: [...order.available],
        chainExpected,
        engine: clipValue(engine),
        latencyMs: data.latencyMs ?? null,
        cached: data.cached ?? null,
        clientMs: callResult.ms,
        translation: String(data.translation ?? '').slice(0, 120),
        error: callResult.error,
      },
      pass,
    }
  })

  await check('TRANSLATE.fallback.unconfigured', EXPECTED.get('TRANSLATE.fallback.unconfigured').expected, async () => {
    const libreText = `Fallback probe for an unconfigured provider (${RUN_STAMP}).`
    const callResult = await measure(() => call('translate.text', { text: libreText, target: 'zh', provider: 'libretranslate' }, 40_000))
    const data = callResult.data ?? {}
    const status = String(data.status ?? '')
    const reason = String(data.reason ?? callResult.error?.message ?? '').trim()
    if (status === 'translated' || callResult.error === null && hasCjk(String(data.translation ?? ''))) {
      const resolved = String(data.provider ?? '')
      const engine = data.engine ?? {}
      const honest = VALID_SEGMENT_PROVIDERS.includes(resolved) && engine.id === resolved
      state.translations.libretranslate = { ...callResult, branch: 'fell-back', resolved }
      return {
        actual: { branch: 'fell-back-to-real-engine', status, resolved, engine: clipValue(engine), latencyMs: data.latencyMs ?? null, clientMs: callResult.ms, translation: String(data.translation ?? '').slice(0, 120) },
        pass: honest && hasCjk(String(data.translation ?? '')),
        notes: 'libretranslate was not configured; a successful result is accepted only when a real fallback engine is reported honestly.',
      }
    }
    state.translations.libretranslate = { ...callResult, branch: 'unavailable' }
    return {
      actual: { branch: 'unavailable', status, reason, error: callResult.error, clientMs: callResult.ms },
      pass: ['unavailable', 'error'].includes(status) && reason !== '',
    }
  })

  await check('TRANSLATE.text.invalidProvider', EXPECTED.get('TRANSLATE.text.invalidProvider').expected, async () => {
    let error = null
    let data = null
    try {
      data = await call('translate.text', { text: `invalid provider probe ${RUN_STAMP}`, target: 'zh', provider: 'no-such-provider' }, 20_000)
    } catch (caught) {
      error = { code: caught?.code ?? null, message: String(caught?.message ?? caught) }
    }
    const status = String(data?.status ?? '')
    const reason = String(data?.reason ?? '').trim()
    const pass = (error !== null && (String(error.code).toLowerCase() === 'invalid' || /invalid|unknown|unsupported/i.test(error.message))) || (['unavailable', 'error'].includes(status) && reason !== '' && !data?.translation)
    return { actual: { error, status: status || null, reason: reason || null }, pass }
  })
}

async function detectCases() {
  await check('TRANSLATE.detect.zh', EXPECTED.get('TRANSLATE.detect.zh').expected, async () => {
    const data = await call('translate.detect', { text: '本文提出一种新的检索方法，并在三个基准上验证了效果。' }, 15_000)
    const detected = detectLanguage(data)
    state.detect.zh = { data, detected }
    return { actual: { response: clipValue(data), detected }, pass: detected.isZh }
  })
  await check('TRANSLATE.detect.en', EXPECTED.get('TRANSLATE.detect.en').expected, async () => {
    const data = await call('translate.detect', { text: 'The proposed method improves retrieval accuracy on three benchmarks.' }, 15_000)
    const detected = detectLanguage(data)
    state.detect.en = { data, detected }
    return { actual: { response: clipValue(data), detected }, pass: detected.isEn }
  })
}

async function blocksCases() {
  const pageResult = await measure(() => call('translate.blocks', { paperId: BLOCKS_PAPER, page: 3, target: 'zh' }, 120_000))
  state.blocks.page = pageResult
  await check('TRANSLATE.blocks.page', EXPECTED.get('TRANSLATE.blocks.page').expected, async () => {
    const data = pageResult.data ?? {}
    const blocks = Array.isArray(data.blocks) ? data.blocks : []
    const translated = blocks.filter((block) => block?.status === 'translated' && String(block.translation ?? '').trim() !== '')
    const failed = blocks.filter((block) => block?.status !== 'translated')
    const badProviders = translated.filter((block) => !VALID_SEGMENT_PROVIDERS.includes(String(block.provider ?? '')))
    const failedWithReason = failed.filter((block) => String(block.reason ?? '').trim() !== '')
    const copyBlocks = translated.filter((block) => String(block.translation ?? '').trim() === String(block.text ?? '').trim())
    const providerCounts = {}
    for (const block of translated) {
      const provider = String(block.provider ?? 'unknown')
      providerCounts[provider] = (providerCounts[provider] ?? 0) + 1
    }
    const pass =
      pageResult.error === null &&
      blocks.length > 0 &&
      translated.length > 0 &&
      badProviders.length === 0 &&
      failedWithReason.length === failed.length &&
      copyBlocks.length === 0
    return {
      actual: {
        pageMs: pageResult.ms,
        blocks: blocks.length,
        translated: translated.length,
        failed: failed.length,
        failedWithReason: failedWithReason.length,
        badProviders: badProviders.map((block) => ({ id: block.id, provider: block.provider })),
        providerCounts,
        provenance: clipValue(data.provenance),
        sample: translated[0] === undefined ? null : { id: translated[0].id, provider: translated[0].provider, source: String(translated[0].text ?? '').slice(0, 60), translation: String(translated[0].translation ?? '').slice(0, 80) },
        error: pageResult.error,
      },
      pass,
      notes: `whole-page latency measured client-side: ${pageResult.ms}ms`,
    }
  })

  await check('TRANSLATE.blocks.cache', EXPECTED.get('TRANSLATE.blocks.cache').expected, async () => {
    const second = await measure(() => call('translate.blocks', { paperId: BLOCKS_PAPER, page: 3, target: 'zh' }, 120_000))
    const data = second.data ?? {}
    const blocks = Array.isArray(data.blocks) ? data.blocks : []
    const cachedFlag = data.cached === true
    const cachedBlocks = blocks.filter((block) => block?.cached === true).length
    const pass = second.error === null && (cachedFlag || (blocks.length > 0 && cachedBlocks === blocks.length))
    return {
      actual: { cached: data.cached ?? null, cachedBlocks, blocks: blocks.length, pageMs: second.ms, translated: blocks.filter((block) => block?.status === 'translated').length },
      pass,
    }
  })

  await check('TRANSLATE.blocks.provenance', EXPECTED.get('TRANSLATE.blocks.provenance').expected, async () => {
    const data = pageResult.data ?? {}
    const blocks = Array.isArray(data.blocks) ? data.blocks : []
    const translated = blocks.filter((block) => block?.status === 'translated')
    const provenance = data.provenance ?? {}
    const provenanceOk = provenance !== null && typeof provenance === 'object' && (typeof provenance.provider === 'string' || typeof provenance.model === 'string' || Object.keys(provenance).length > 0)
    const perBlockOk = translated.every((block) => VALID_SEGMENT_PROVIDERS.includes(String(block.provider ?? '')))
    const copies = translated.filter((block) => String(block.translation ?? '').trim() === String(block.text ?? '').trim()).length
    return {
      actual: { provenance: clipValue(provenance), provenanceOk, perBlockOk, copies, translated: translated.length, statuses: [...new Set(blocks.map((block) => block?.status))] },
      pass: provenanceOk && perBlockOk && copies === 0 && translated.length > 0,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Cases: discover feed + annotations feed
 * ------------------------------------------------------------------ */
async function createFeedFixture() {
  try {
    const created = await createAnnotationFixture()
    state.fixture.annotationId = created?.annotation?.id ?? null
    return state.fixture.annotationId
  } catch (error) {
    state.cleanupErrors.push(`feed fixture annotation: ${String(error?.message ?? error)}`)
    return null
  }
}

async function discoverCases() {
  const feedResult = await measure(() => call('discover.feed', { limit: 5 }, 30_000))
  state.discover.feed = feedResult
  await check('DISCOVER.structure', EXPECTED.get('DISCOVER.structure').expected, async () => {
    const data = feedResult.data ?? {}
    const required = ['stats', 'continueReading', 'unread', 'annotated', 'collections', 'tags', 'recentAnnotations', 'recentFigures']
    const missing = required.filter((key) => !Object.hasOwn(data, key))
    const arraysOk = ['continueReading', 'unread', 'annotated', 'collections', 'tags', 'recentAnnotations', 'recentFigures'].every((key) => Array.isArray(data[key]))
    const statsOk = data.stats !== null && typeof data.stats === 'object'
    const pass = feedResult.error === null && missing.length === 0 && arraysOk && statsOk && feedResult.ms < 500
    return {
      actual: {
        missing,
        arraysOk,
        stats: clipValue(data.stats),
        sectionSizes: { continueReading: data.continueReading?.length ?? null, unread: data.unread?.length ?? null, annotated: data.annotated?.length ?? null, collections: data.collections?.length ?? null, tags: data.tags?.length ?? null, recentAnnotations: data.recentAnnotations?.length ?? null, recentFigures: data.recentFigures?.length ?? null },
        feedMs: feedResult.ms,
        error: feedResult.error,
      },
      pass,
      notes: `discover.feed measured ${feedResult.ms}ms client-side (contract target <100ms, task bound <500ms)`,
    }
  })

  await check('DISCOVER.stats', EXPECTED.get('DISCOVER.stats').expected, async () => {
    const data = feedResult.data ?? {}
    const stats = data.stats ?? {}
    const status = await call('status')
    const tags = await call('tags.list')
    const collections = await call('library.collections.list')
    const list = await call('library.list', { limit: 200 })
    const checks = {
      papers: Number(stats.papers) === Number(status?.counts?.papers) && Number(stats.papers) === Number(list?.total),
      annotations: Number(stats.annotations) === Number(status?.counts?.annotations),
      tags: Number(stats.tags) === (tags.items ?? []).length,
      collections: Number(stats.collections) === (collections.items ?? []).length,
      // `unread` counts every read=false paper (including reading-in-progress),
      // so the disjoint partition is unread+read=papers with reading<=unread.
      partition:
        Number.isFinite(Number(stats.unread)) &&
        Number.isFinite(Number(stats.reading)) &&
        Number.isFinite(Number(stats.read)) &&
        Number(stats.unread) + Number(stats.read) === Number(stats.papers) &&
        Number(stats.reading) >= 0 &&
        Number(stats.reading) <= Number(stats.unread),
    }
    return {
      actual: {
        stats: clipValue(stats),
        statusCounts: status?.counts ?? null,
        tags: (tags.items ?? []).length,
        collections: (collections.items ?? []).length,
        listTotal: list?.total ?? null,
        checks,
      },
      pass: Object.values(checks).every(Boolean),
    }
  })

  await check('DISCOVER.sections', EXPECTED.get('DISCOVER.sections').expected, async () => {
    const data = feedResult.data ?? {}
    const limit = 5
    const tileFields = ['id', 'title', 'titleZh', 'authors', 'year', 'venue', 'tags', 'read', 'readingProgress', 'annotationCount', 'figureCount', 'lastReadAt', 'addedAt', 'citationCount', 'impactFactor', 'hasPdf']
    const inspect = (section) => {
      const tiles = Array.isArray(data[section]) ? data[section] : []
      const fieldIssues = tiles
        .map((tile) => tileFields.filter((field) => !Object.hasOwn(tile ?? {}, field)))
        .filter((missing) => missing.length > 0)
      const ids = tiles.map((tile) => tile?.id)
      return {
        count: tiles.length,
        withinLimit: tiles.length <= limit,
        fieldIssues: fieldIssues.slice(0, 3),
        unique: new Set(ids).size === ids.length,
        ids,
        unreadOk: section !== 'unread' || tiles.every((tile) => tile?.read === false),
        annotatedOk:
          section !== 'annotated' ||
          (tiles.every((tile) => Number(tile?.annotationCount ?? 0) > 0) &&
            tiles.every((tile, index) => index === 0 || Number(tiles[index - 1].annotationCount) >= Number(tile.annotationCount))),
        continueOk:
          section !== 'continueReading' ||
          tiles.every((tile) => tile?.lastReadAt !== null && tile?.lastReadAt !== undefined) &&
            tiles.every((tile, index) => index === 0 || String(tiles[index - 1].lastReadAt) >= String(tile.lastReadAt)),
      }
    }
    const sections = Object.fromEntries(['continueReading', 'unread', 'annotated'].map((section) => [section, inspect(section)]))
    const pass = Object.values(sections).every((section) => section.withinLimit && section.fieldIssues.length === 0 && section.unique && section.unreadOk && section.annotatedOk && section.continueOk)
    return { actual: { limit, sections }, pass, notes: 'continueReading may be empty when no reading history exists; the ordering check then passes vacuously.' }
  })

  await check('DISCOVER.recent', EXPECTED.get('DISCOVER.recent').expected, async () => {
    const data = feedResult.data ?? {}
    const active = await call('library.list', { limit: 200 })
    const activeIds = new Set((active.items ?? []).map((paper) => paper.id))
    const annotations = Array.isArray(data.recentAnnotations) ? data.recentAnnotations : []
    const figures = Array.isArray(data.recentFigures) ? data.recentFigures : []
    const annotationIssues = annotations.map((item) => {
      const issues = []
      if (!activeIds.has(item?.paperId)) issues.push('paper-not-active')
      if (!Number.isInteger(item?.page) || item.page < 1) issues.push('page')
      if (typeof item?.color !== 'string' || item.color.trim() === '') issues.push('color')
      if (typeof item?.kind !== 'string' || item.kind.trim() === '') issues.push('kind')
      if (!(typeof item?.quote === 'string' && item.quote.trim() !== '') && item?.kind !== 'note') issues.push('quote')
      return issues.length === 0 ? null : { id: item?.id, issues }
    }).filter(Boolean)
    const figureIssues = figures.map((item) => {
      const issues = []
      if (!activeIds.has(item?.paperId)) issues.push('paper-not-active')
      if (!Number.isInteger(item?.page) || item.page < 1) issues.push('page')
      if (typeof item?.imageUrl !== 'string' || item.imageUrl.trim() === '') issues.push('imageUrl')
      const thumb = item?.captionThumbUrl ?? item?.thumbUrl
      if (typeof thumb !== 'string' || thumb.trim() === '') issues.push('thumbUrl')
      // FigureTile.label may legitimately be null for uncaptioned crops; the key must exist.
      if (!Object.hasOwn(item ?? {}, 'label') || (item.label !== null && typeof item.label !== 'string')) issues.push('label')
      return issues.length === 0 ? null : { id: item?.id, issues }
    }).filter(Boolean)
    const pass = annotationIssues.length === 0 && figureIssues.length === 0 && annotations.length > 0 && figures.length > 0
    return {
      actual: {
        annotations: annotations.length,
        figures: figures.length,
        annotationIssues,
        figureIssues,
        annotationSample: annotations.slice(0, 3).map((item) => ({ id: item.id, paperId: item.paperId, page: item.page, kind: item.kind, color: item.color, quote: String(item.quote ?? '').slice(0, 40) })),
        figureSample: figures.slice(0, 2).map((item) => ({ id: item.id, paperId: item.paperId, page: item.page, label: item.label, imageUrl: item.imageUrl, thumb: item.captionThumbUrl ?? item.thumbUrl ?? null })),
      },
      pass,
    }
  })

  await check('DISCOVER.taxonomy', EXPECTED.get('DISCOVER.taxonomy').expected, async () => {
    const data = feedResult.data ?? {}
    const collections = Array.isArray(data.collections) ? data.collections : []
    const tags = Array.isArray(data.tags) ? data.tags : []
    const expectedCollections = (await call('library.collections.list')).items ?? []
    const expectedTags = (await call('tags.list')).items ?? []
    const collectionMismatch = collections
      .map((collection) => {
        const expected = expectedCollections.find((entry) => entry.id === collection.id)
        if (expected === undefined) return { id: collection.id, issue: 'not-in-collections.list' }
        if (Number(collection.count) !== Number(expected.count)) return { id: collection.id, expected: expected.count, actual: collection.count }
        if (typeof collection.name !== 'string' || collection.name === '') return { id: collection.id, issue: 'name' }
        return null
      })
      .filter(Boolean)
    const fieldCollections = expectedCollections.filter((collection) => collection.kind === 'field')
    const feedFieldCollections = collections.filter((collection) => (expectedCollections.find((entry) => entry.id === collection.id) ?? {}).kind === 'field')
    const tagMismatch = tags
      .map((tag) => {
        const expected = expectedTags.find((entry) => entry.name === tag.name)
        if (expected === undefined) return { name: tag.name, issue: 'not-in-tags.list' }
        if (Number(tag.count) !== Number(expected.count)) return { name: tag.name, expected: expected.count, actual: tag.count }
        return null
      })
      .filter(Boolean)
    const pass =
      collections.length === expectedCollections.length &&
      tags.length === expectedTags.length &&
      collectionMismatch.length === 0 &&
      tagMismatch.length === 0 &&
      feedFieldCollections.length === fieldCollections.length
    return {
      actual: {
        feedCollections: collections.length,
        expectedCollections: expectedCollections.length,
        feedFieldCollections: feedFieldCollections.length,
        expectedFieldCollections: fieldCollections.length,
        feedTags: tags.length,
        expectedTags: expectedTags.length,
        collectionMismatch,
        tagMismatch,
        collectionSample: collections.slice(0, 8),
        tagSample: tags.slice(0, 8),
      },
      pass,
    }
  })
}

async function annotationsFeedCases() {
  let feed = null
  await check('ANN.feed.structure', EXPECTED.get('ANN.feed.structure').expected, async () => {
    feed = await call('annotations.feed', { limit: 50 }, 30_000)
    state.annotationsFeed.page1 = feed
    const items = normalizeItems(feed)
    const required = ['id', 'paperId', 'paperTitle', 'page', 'kind', 'color', 'quote', 'comment', 'createdAt']
    const fieldIssues = items
      .map((item) => required.filter((field) => !Object.hasOwn(item ?? {}, field)))
      .filter((missing) => missing.length > 0)
    const descending = items.every((item, index) => index === 0 || String(items[index - 1].createdAt) >= String(item.createdAt))
    const pass = items.length > 0 && fieldIssues.length === 0 && descending
    return {
      actual: {
        envelopeKeys: feed !== null && typeof feed === 'object' && !Array.isArray(feed) ? Object.keys(feed) : 'array',
        items: items.length,
        fieldIssues: fieldIssues.slice(0, 3),
        descending,
        head: items.slice(0, 3).map((item) => ({ id: item.id, paperId: item.paperId, page: item.page, kind: item.kind, color: item.color, createdAt: item.createdAt, quote: String(item.quote ?? '').slice(0, 40) })),
      },
      pass,
    }
  })

  await check('ANN.feed.filters', EXPECTED.get('ANN.feed.filters').expected, async () => {
    const probes = {}
    const byPaper = normalizeItems(await call('annotations.feed', { limit: 200, paperId: ANNOT_PAPER }, 30_000))
    probes.paperId = {
      count: byPaper.length,
      onlyPaper: byPaper.every((item) => item.paperId === ANNOT_PAPER),
      hasFixture: byPaper.some((item) => item.id === state.fixture.annotationId),
    }
    const colorProbe = await filterFeed({ limit: 200, colors: 'green' })
    const byColor = colorProbe.chosen.items ?? []
    probes.colors = {
      count: byColor.length,
      onlyColor: byColor.every((item) => String(item.color ?? '').toLowerCase() === 'green'),
      hasFixture: byColor.some((item) => item.id === state.fixture.annotationId),
      shape: colorProbe.chosen.variant?.colors ?? null,
      variants: colorProbe.attempts.map((attempt) => ({ colors: attempt.variant?.colors ?? null, count: attempt.items?.length ?? null, error: attempt.error ?? null })),
    }
    const kindProbe = await filterFeed({ limit: 200, kinds: 'highlight' })
    const byKind = kindProbe.chosen.items ?? []
    probes.kinds = {
      count: byKind.length,
      onlyKind: byKind.every((item) => item.kind === 'highlight'),
      hasFixture: byKind.some((item) => item.id === state.fixture.annotationId),
      shape: kindProbe.chosen.variant?.kinds ?? null,
      variants: kindProbe.attempts.map((attempt) => ({ kinds: attempt.variant?.kinds ?? null, count: attempt.items?.length ?? null, error: attempt.error ?? null })),
    }
    const queryToken = `v04 feed fixture quote ${RUN_STAMP}`
    const byQuery = normalizeItems(await call('annotations.feed', { limit: 200, query: queryToken }, 30_000))
    probes.query = {
      count: byQuery.length,
      hasFixture: byQuery.some((item) => item.id === state.fixture.annotationId),
    }
    const pass =
      probes.paperId.count > 0 && probes.paperId.onlyPaper && probes.paperId.hasFixture &&
      probes.colors.count > 0 && probes.colors.onlyColor && probes.colors.hasFixture &&
      probes.kinds.count > 0 && probes.kinds.onlyKind && probes.kinds.hasFixture &&
      probes.query.hasFixture
    return { actual: probes, pass }
  })

  await check('ANN.feed.pagination', EXPECTED.get('ANN.feed.pagination').expected, async () => {
    const pageOne = normalizeItems(await call('annotations.feed', { limit: 3 }, 30_000))
    const cursor = pageOne.length === 0 ? null : pageOne[pageOne.length - 1].createdAt
    const pageTwo = cursor === null ? [] : normalizeItems(await call('annotations.feed', { limit: 3, before: cursor }, 30_000))
    const oneIds = new Set(pageOne.map((item) => item.id))
    const overlap = pageTwo.filter((item) => oneIds.has(item.id)).map((item) => item.id)
    const beforeOk = pageTwo.every((item) => String(item.createdAt) <= String(cursor))
    const descending = pageTwo.every((item, index) => index === 0 || String(pageTwo[index - 1].createdAt) >= String(item.createdAt))
    const pass = pageOne.length > 0 && overlap.length === 0 && beforeOk && descending && pageTwo.length <= 3
    return {
      actual: {
        pageOne: pageOne.length,
        cursor,
        pageTwo: pageTwo.length,
        overlap,
        beforeOk,
        descending,
        pageTwoHead: pageTwo.slice(0, 2).map((item) => ({ id: item.id, createdAt: item.createdAt })),
      },
      pass,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Regression: reuse the recorded v0.3 / v0.2 / lifecycle evidence
 * ------------------------------------------------------------------ */
async function regressionCases() {
  await check('REF.v03', EXPECTED.get('REF.v03').expected, async () => {
    const report = readReport('reports/v03-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const pass = report.exists && Number(summary.total) === 38 && Number(summary.pass) === 38 && Number(summary.fail) === 0 && Number(summary.not_run) === 0
    return { actual: { path: report.path, exists: report.exists, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, not_run: summary.not_run ?? null, finishedAt: summary.finishedAt ?? null }, pass }
  })
  await check('REF.v02', EXPECTED.get('REF.v02').expected, async () => {
    const report = readReport('reports/v02-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const pass = report.exists && Number(summary.total) === 26 && Number(summary.pass) === 26 && Number(summary.fail) === 0
    return { actual: { path: report.path, exists: report.exists, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, finishedAt: summary.finishedAt ?? null }, pass }
  })
  await check('REF.lifecycle', EXPECTED.get('REF.lifecycle').expected, async () => {
    const report = readReport('reports/v03-lifecycle-run.json')
    const lifecycle = report.parsed?.summary?.by_suite?.lifecycle ?? {}
    const pass = report.exists && Number(lifecycle.total) === 13 && Number(lifecycle.pass) === 12 && Number(lifecycle.fail) === 0 && Number(lifecycle.not_run) === 1
    return { actual: { path: report.path, exists: report.exists, lifecycle: clipValue(lifecycle), notRunCase: 'LIFE.05.tool_read_rejected' }, pass }
  })
}

/* ------------------------------------------------------------------ *
 * Cleanup / data preservation
 * ------------------------------------------------------------------ */
async function cleanupCases() {
  // delete the feed fixture annotation
  if (state.fixture.annotationId !== null) {
    try {
      await call('annotations.delete', { id: state.fixture.annotationId, operationId: `v04-clean-ann-${RUN_STAMP}` }, 30_000)
    } catch (error) {
      state.cleanupErrors.push(`fixture annotation delete: ${String(error?.message ?? error)}`)
    }
  }
  // restore translation settings captured at run start
  const original = state.settingsOriginal ?? { provider: 'auto', fallback: true }
  try {
    await call('translate.settings', { provider: original.provider ?? 'auto', fallback: original.fallback !== false }, 15_000)
  } catch (error) {
    state.cleanupErrors.push(`settings restore: ${String(error?.message ?? error)}`)
  }

  await check('CLEANUP.settings', EXPECTED.get('CLEANUP.settings').expected, async () => {
    const read = await getSettings()
    const original = state.settingsOriginal ?? { provider: 'auto', fallback: true }
    const pass = String(read?.provider) === String(original.provider) && Boolean(read?.fallback) === (original.fallback !== false)
    return { actual: { read, original, cleanupErrors: state.cleanupErrors }, pass }
  })

  const after = await readEnvironment()
  state.after = { counts: after.counts, finishedAt: isoNow() }
  const baseline = state.baseline?.counts ?? {}
  await check('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, async () => {
    // annotations.delete is a soft delete (kept in the trash), so "gone" means: not
    // in the active list, and if a trash row remains it must be marked deleted.
    const activeList = await call('annotations.list', { paperId: ANNOT_PAPER }).catch(() => [])
    const allList = await call('annotations.list', { paperId: ANNOT_PAPER, state: 'all' }).catch(() => [])
    const stillActive = (activeList ?? []).some((item) => item.id === state.fixture.annotationId)
    const trashRow = (allList ?? []).find((item) => item.id === state.fixture.annotationId) ?? null
    const fixtureGone =
      state.fixture.annotationId === null ||
      (!stillActive && (trashRow === null || ['trash', 'trashed', 'deleted'].includes(String(trashRow.state))))
    const countsMatch =
      Number(after.counts?.papers) === Number(baseline.papers) &&
      Number(after.counts?.annotations) === Number(baseline.annotations) &&
      Number(after.counts?.figures) === Number(baseline.figures) &&
      Number(after.counts?.trash) === Number(baseline.trash)
    const settings = await getSettings().catch(() => null)
    const original = state.settingsOriginal ?? { provider: 'auto', fallback: true }
    const settingsRestored = String(settings?.provider) === String(original.provider) && Boolean(settings?.fallback) === (original.fallback !== false)
    return {
      actual: {
        baseline: clipValue(baseline),
        after: clipValue(after.counts),
        countsMatch,
        fixtureGone,
        fixtureStillActive: stillActive,
        fixtureTrashState: trashRow === null ? null : (trashRow.state ?? null),
        settingsRestored,
        settings,
        cleanupErrors: state.cleanupErrors,
      },
      pass: countsMatch && fixtureGone && settingsRestored && state.cleanupErrors.length === 0,
      notes: 'translation cache entries created by this suite are left in mt_cache by design (documented in the report).',
    }
  })
}

/* ------------------------------------------------------------------ *
 * Report / main
 * ------------------------------------------------------------------ */
function buildReport(exitCode) {
  for (const [caseId, plan] of EXPECTED) {
    if (!recordedIds.has(caseId)) {
      results.push({
        case_id: caseId,
        group: plan.group,
        expected: plan.expected,
        actual: { not_run_reason: 'case did not execute (earlier environment gate/abort)' },
        status: 'not_run',
      })
    }
  }
  const counts = { pass: 0, fail: 0, not_run: 0 }
  const byGroup = {}
  for (const entry of results) {
    counts[entry.status] += 1
    const group = (byGroup[entry.group] ??= { total: 0, pass: 0, fail: 0, not_run: 0 })
    group.total += 1
    group[entry.status] += 1
  }
  return {
    schema: 'pappers-hall/v04-api-results@1',
    suite: 'v0.4 API acceptance',
    summary: {
      total: results.length,
      pass: counts.pass,
      fail: counts.fail,
      not_run: counts.not_run,
      byGroup,
      startedAt: state.startedAt,
      finishedAt: isoNow(),
      base: BASE,
      exitCode,
    },
    environment: state.environment,
    baseline: { counts: state.baseline?.counts ?? null, settings: state.settingsOriginal, capturedAt: state.startedAt },
    after: state.after,
    evidence: {
      providers: state.providers,
      settingsProbes: state.settingsProbes,
      translations: Object.fromEntries(
        Object.entries(state.translations).map(([key, value]) => [
          key,
          value === null || typeof value !== 'object'
            ? value
            : {
                data: value.data === undefined ? undefined : clipValue({ ...(value.data ?? {}), translation: String(value.data?.translation ?? '').slice(0, 200) }),
                ms: value.ms ?? null,
                error: value.error ?? null,
                resolved: value.resolved ?? null,
                chainExpected: value.chainExpected ?? null,
                branch: value.branch ?? null,
              },
        ]),
      ),
      detect: Object.fromEntries(Object.entries(state.detect).map(([key, value]) => [key, { response: clipValue(value.data), detected: value.detected }])),
      blocks: state.blocks.page === undefined ? null : {
        pageMs: state.blocks.page.ms,
        error: state.blocks.page.error,
        blocks: (state.blocks.page.data?.blocks ?? []).length,
        translated: (state.blocks.page.data?.blocks ?? []).filter((block) => block?.status === 'translated').length,
        provenance: clipValue(state.blocks.page.data?.provenance),
      },
      discover: { feedMs: state.discover.feed?.ms ?? null, feed: clipValue(state.discover.feed?.data) },
      annotationsFeed: { page1Count: normalizeItems(state.annotationsFeed.page1).length },
      regression: {
        v03: 'reports/v03-api-results.json',
        v02: 'reports/v02-api-results.json',
        lifecycle: 'reports/v03-lifecycle-run.json',
      },
    },
    results,
  }
}

async function finish(exitCode) {
  const report = buildReport(exitCode)
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  const { pass, fail, not_run: notRunCount } = report.summary
  console.log(`\nV0.4 API RESULT: ${pass}/${report.summary.total} pass, ${fail} fail, ${notRunCount} not_run → ${OUT}`)
  process.exitCode = exitCode
}

async function main() {
  if (DRY_RUN) {
    const unique = new Set(PLAN.map(([id]) => id))
    if (unique.size !== PLAN.length) throw new Error('duplicate case ids in PLAN')
    console.log('Pappers-Hall v0.4 API acceptance suite — DRY RUN (no mutations, read-only probes only)\n')
    let currentGroup = null
    for (const [id, group, expected] of PLAN) {
      if (group !== currentGroup) {
        console.log(`\n[${group}]`)
        currentGroup = group
      }
      console.log(`  ${id.padEnd(36)} ${expected}`)
    }
    console.log(`\nplanned cases: ${PLAN.length}`)
    try {
      const environment = await readEnvironment()
      console.log(`live host: version=${String(environment.pluginVersion)} schemaVersion=${String(environment.schemaVersion)} papers=${environment.counts?.papers ?? '?'} annotations=${environment.counts?.annotations ?? '?'} ai=${environment.ai?.available === true ? 'available' : 'unavailable'}`)
      const shape = await probeV04Shape()
      console.log(`v0.4 method probe: translate.providers=${shape.providers}, discover.feed=${shape.discover}`)
      const v04 = String(environment.pluginVersion ?? '').startsWith('0.4') || Number(environment.schemaVersion) >= 4 || (shape.providers === 'ok' && shape.discover === 'ok')
      console.log(v04 ? 'v0.4 host appears loaded — a real run is possible after GO v04.' : 'v0.4 host is NOT loaded yet: the real run will be refused by the ENV gate until the Lead reload + "GO v04".')
      const regressionFiles = ['reports/v03-api-results.json', 'reports/v02-api-results.json', 'reports/v03-lifecycle-run.json']
      for (const file of regressionFiles) {
        const report = readReport(file)
        if (!report.exists) console.log(`DRY RUN WARNING: regression evidence missing: ${file}`)
        else {
          const summary = report.parsed?.summary ?? {}
          const lifecycle = summary?.by_suite?.lifecycle
          console.log(`regression evidence: ${file} → ` + (lifecycle === undefined ? `total=${summary.total} pass=${summary.pass} fail=${summary.fail} not_run=${summary.not_run}` : `lifecycle total=${lifecycle.total} pass=${lifecycle.pass} fail=${lifecycle.fail} not_run=${lifecycle.not_run}`))
        }
      }
    } catch (error) {
      console.log(`live host probe failed: ${String(error?.message ?? error)}`)
    }
    console.log('\nDRY RUN OK: script parses, case plan complete, no data was written. Waiting for "GO v04".')
    process.exitCode = 0
    return
  }

  /* ---------------- real run ---------------- */
  let environment
  try {
    environment = await readEnvironment()
  } catch (error) {
    console.error('V0.4 SUITE ERROR: live host unreachable:', String(error?.message ?? error))
    process.exitCode = 2
    return
  }
  state.environment = {
    plugin: environment.status?.plugin ?? null,
    schemaVersion: environment.schemaVersion,
    counts: environment.counts,
    features: environment.features,
    ai: environment.ai,
    translation: environment.translation,
    versions: environment.diagnostics?.versions ?? null,
    degraded: environment.status?.degraded ?? null,
  }
  state.baseline = { counts: environment.counts, capturedAt: state.startedAt }

  const shape = await probeV04Shape()
  const version = String(environment.pluginVersion ?? '')
  const v04Loaded = version.startsWith('0.4') || Number(environment.schemaVersion) >= 4 || (shape.providers === 'ok' && shape.discover === 'ok')
  await check('ENV.version', EXPECTED.get('ENV.version').expected, async () => {
    return {
      actual: { pluginVersion: version || null, schemaVersion: environment.schemaVersion, probe: shape, ai: environment.ai?.available ?? null },
      pass: v04Loaded,
    }
  })
  if (!v04Loaded) {
    console.error(`\nV0.4 GATE: host reports plugin ${version || 'unknown'} / schemaVersion ${String(environment.schemaVersion)} and translate.providers=${shape.providers}, discover.feed=${shape.discover}; refusing mutation cases until the Lead reloads v0.4 and sends "GO v04".`)
    await finish(2)
    return
  }

  await check('ENV.baseline', EXPECTED.get('ENV.baseline').expected, async () => {
    const counts = environment.counts ?? {}
    const pass = Number(counts.papers ?? 0) >= 30 && Number(counts.annotations ?? 0) >= 1 && Number(counts.trash ?? -1) === 0
    return { actual: { counts }, pass }
  })

  try {
    state.settingsOriginal = await getSettings().catch(() => null)
    await providerCases()
    await settingsCases()
    await createFeedFixture()
    await translateTextCases()
    await detectCases()
    await blocksCases()
    await discoverCases()
    await annotationsFeedCases()
    await regressionCases()
  } catch (error) {
    console.error('V0.4 SUITE ERROR (unexpected):', error?.stack ?? error)
    process.exitCode = 2
  } finally {
    try {
      await cleanupCases()
    } catch (error) {
      console.error('V0.4 CLEANUP ERROR:', error?.stack ?? error)
      if (!recordedIds.has('REF.data.preserved')) {
        notRun('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, `cleanup crashed: ${String(error?.message ?? error)}`)
      }
      process.exitCode = 2
    }
  }

  const fail = results.filter((entry) => entry.status === 'fail').length
  const exitCode = process.exitCode === 2 ? 2 : fail > 0 ? 1 : 0
  await finish(exitCode)
}

main().catch(async (error) => {
  console.error('V0.4 SUITE FATAL:', error?.stack ?? error)
  try {
    await finish(2)
  } catch {
    process.exit(2)
  }
})
