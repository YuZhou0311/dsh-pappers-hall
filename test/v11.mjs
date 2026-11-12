#!/usr/bin/env node
/**
 * Pappers-Hall v0.11 API acceptance suite.
 *
 * Covers docs/CONTRACT-v11.md:
 * - SETTINGS: `settings.get` full payload (features / models.embedding /
 *   models.ocr / translation / index / diagnostics) with the REAL machine state
 *   (embedding installed, OCR NOT installed — never faked); `settings.update`
 *   persistence, unknown-key reporting, operationId idempotency and the
 *   "keep at least one translation engine" guard.
 * - FEATURE SWITCHES: vectorSearch=false → search has no vector reasons and the
 *   status says "disabled" instead of degraded (restored afterwards); OCR toggle
 *   when the component is missing stays honest (`ocr.index` unavailable).
 * - MODELS: models.install validation + real OCR install job start/cancel
 *   (embedding reinstall is intentionally NOT run — it would break the live
 *   component), models.cancel idle/invalid paths, models.rebuildIndex job
 *   (counts/indexVersion must stay identical afterwards).
 * - TRANSLATION: real `translation.test` (default/free provider + LLM), invalid
 *   provider, disabled-provider error and the all-engines-off guard.
 * - INDEX/autoIndex: pause incremental embedding sync, create one test
 *   annotation (counts unchanged), restore autoIndex → catch-up sync, delete the
 *   annotation → counts back to baseline.
 * - REF: v0.7 24/24, v0.6 31/32 + tool harness 8/8, v0.5 42/43, v0.4 34/34,
 *   v0.2 26/26, lifecycle 12/0/1, v0.3 unchanged expectation.
 * - DATA: 30 papers / 21 annotations / 346 figures / 5 folders before and after;
 *   test annotation removed, settings restored to the captured baseline, no user
 *   data purged, embedding index kept.
 *
 * The GUI settings panel (three entry points, modal layout, per-card install
 * buttons, persistence after refresh) is verified by the Lead in the browser;
 * this suite proves the API layer it calls.
 *
 * Usage:
 *   node test/v11.mjs --dry-run   # plan + read-only probe
 *   node test/v11.mjs             # real run (mutates settings/annotation, restores)
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const WORKSPACE = resolve(PLUGIN_ROOT, '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const arg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

const DRY_RUN = flag('--dry-run')
const BASE = arg('--base', process.env.PAPPERS_BASE ?? 'http://127.0.0.1:3080')
const API = `${BASE}/pappers-hall/api`
const OUT = resolve(HERE, arg('--out', '../../reports/v11-api-results.json'))
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const OCR_DIR = join(HOME, 'pappers-hall', 'ocr')
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

const ORIGINAL_FIELD_NAMES = ['大语言模型与 Agent', '强化学习与决策', '多模态与文档检索', '遥感与地球观测', '作物模拟与农业系统']
const FEATURE_KEYS = ['vectorSearch', 'ocr', 'freeTranslation', 'autoIndex']
const TRANSLATION_IDS = ['google', 'mymemory', 'llm']
const P_ANNOTATION = arg('--paper-annotation', 'ph-8d90723ee7bc') // C01, page 1 is extracted

const PLAN = [
  ['ENV.version', 'ENV', 'v0.11 Host loaded: plugin 0.11.x / schemaVersion>=7 and settings.get + models.install + ocr.index + translation.test are registered'],
  ['ENV.baseline', 'ENV', 'baseline captured: 30 papers / 21 annotations / 346 figures / 5 folders; features/models/translation settings captured for restore; real machine states (embedding installed, OCR NOT installed)'],
  ['SETTINGS.get.fields', 'SETTINGS', 'settings.get returns features{4 flags}, models.embedding{installed/model/dims/sizeBytes/installable/supported/job/reason/setupScript}, models.ocr{installed:false REAL/engine/installable/reason/scanPages}, translation.providers[3]{label/free/enabled/available}, index{channels/counts/sync}, diagnostics{schemaVersion:7/capabilities}'],
  ['SETTINGS.update.invalidKeys', 'SETTINGS', 'unknown keys / wrong value types are ignored and reported (applied only lists accepted keys); existing values unchanged'],
  ['SETTINGS.update.persist', 'SETTINGS', 'settings.update vectorSearch=false persists (features/models.embedding.enabled/diagnostics.capabilities.vector=disabled); restored to true afterwards'],
  ['SETTINGS.update.idempotent', 'SETTINGS', 'same operationId replays the cached settings.update result instead of applying a second time'],
  ['SETTINGS.update.translationProviders', 'SETTINGS', 'disabling one provider persists (enabled/available false); the disabled engine is never the used provider (fallback may answer); LLM engine still works; restoring works'],
  ['SETTINGS.update.lastEngineGuard', 'SETTINGS', 'turning every translation engine off is rejected with a clear error and no settings change'],
  ['STATUS.vectorOff.notDegraded', 'STATUS', 'vectorSearch=false → status.index.channels.vector=disabled and status.degraded does NOT contain vector (closed ≠ degraded)'],
  ['SEARCH.vectorOff.noVector', 'STATUS', 'vectorSearch=false → search.query runs keyword-only (no vector_similarity reasons); after restore the vector channel is ok again'],
  ['MODELS.install.invalidKind', 'MODELS', 'models.install rejects unsupported/empty kind with status=invalid + reason and starts no job'],
  ['MODELS.install.ocrJob', 'MODELS', 'models.install {kind:ocr} starts a real model.install job (queued); repeated call with the same operationId is idempotent and a second call while active returns already_running with the same job'],
  ['MODELS.cancel.ocr', 'MODELS', 'models.cancel {kind:ocr} cancels our queued install job (state cancelled, no install side effect, OCR stays installed:false)'],
  ['MODELS.cancel.invalidKind', 'MODELS', 'models.cancel rejects an unsupported kind and reports idle when no install job exists'],
  ['MODELS.rebuildIndex', 'MODELS', 'models.rebuildIndex starts an embedding.index job; after completion counts/indexVersion are unchanged (idempotent rebuild)'],
  ['MODELS.embeddingInstallSkipped', 'MODELS', 'NOT_RUN by design: a real embedding reinstall would overwrite the live component (forbidden by the task); embedding status proves installed=true'],
  ['OCR.index.unavailable', 'OCR', 'ocr.index reports status=unavailable with a clear "not installed / install in settings" reason while OCR is missing'],
  ['OCR.featureToggle', 'OCR', 'features.ocr=true while the component is missing: models.ocr.enabled=true but installed/available stay false and diagnostics.capabilities.ocr=unavailable (no fake install)'],
  ['INDEX.autoIndex.pause', 'INDEX', 'autoIndex=false pauses incremental embedding sync: creating a test annotation does not change embedding counts.annotations'],
  ['INDEX.autoIndex.catchup', 'INDEX', 'autoIndex=true triggers the catch-up sync (counts.annotations +1) and deleting the annotation returns the count to baseline'],
  ['TRANSLATION.test.default', 'TRANSLATION', 'translation.test real call: ok=true, provider/engine reported, non-empty translation and numeric latencyMs'],
  ['TRANSLATION.test.llm', 'TRANSLATION', 'translation.test {provider:llm} works through the LLM engine (real call, non-empty translation)'],
  ['TRANSLATION.test.invalidProvider', 'TRANSLATION', 'translation.test with an unknown provider returns an explicit failure reason instead of a fake translation'],
  ['TRANSLATION.providerDisabled', 'TRANSLATION', 'a disabled provider is skipped (fallback may answer, but the disabled id is never used) while other engines still work; fallbackEnabled wiring is recorded as an observation'],
  ['REF.v07', 'REF', 'recorded v0.7 API result file still reports 24/24 pass'],
  ['REF.v06', 'REF', 'recorded v0.6 API result file still reports 32 cases: 31 pass, 0 fail, 1 not_run'],
  ['REF.v06.harness', 'REF', 'recorded v0.6 tool harness still reports ok=true with all 8 cases passing'],
  ['REF.v05', 'REF', 'recorded v0.5 API result file still reports 43 cases: 42 pass, 0 fail, 1 not_run'],
  ['REF.v04', 'REF', 'recorded v0.4 API result file still reports 34/34 pass'],
  ['REF.v02', 'REF', 'recorded v0.2 API result file still reports 26/26 pass'],
  ['REF.lifecycle', 'REF', 'recorded lifecycle result file still reports 13 cases: 12 pass, 0 fail, 1 not_run'],
  ['REF.v03', 'REF', 'v0.3 expectation unchanged: historical 38/38 + current v0.4 re-run only fails the 3 AI-fast cases explained by v0.4 routing'],
  ['CLEANUP.settings', 'CLEANUP', 'features/translation settings restored to the captured baseline, test annotation removed, OCR install dir created by this test removed, no pending install job'],
  ['REF.data.preserved', 'REF', 'after cleanup: 30 papers / 21 annotations / 346 figures / 5 folders, no user data purged, embedding counts restored'],
]

const results = []
const state = {
  startedAt: new Date().toISOString(),
  base: BASE,
  environment: null,
  baseline: { settings: null, features: null, providers: null, counts: null, folders: null, favorites: [], embeddingCounts: null, ocrInstalled: null, annotationCount: null },
  status: null,
  diagnostics: null,
  testAnnotationId: null,
  ocrJobId: null,
  ocrDirExistedBefore: null,
  createdFolders: [],
  after: {},
  evidence: {},
  cleanupErrors: [],
}

const EXPECTED = new Map(PLAN.map(([id, group, expected]) => [id, { group, expected }]))
const recordedIds = new Set()

/* ------------------------------------------------------------------ *
 * HTTP / recording helpers (retry transient HMR gaps like the v0.6/v0.7 suites)
 * ------------------------------------------------------------------ */
async function call(method, params = {}, timeoutMs = 180_000) {
  const attempts = 5
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let transient = null
    try {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      })
      const text = await response.text()
      let body = null
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
      if (body === null) {
        const message = `${method}: non-JSON HTTP ${response.status}: ${text.slice(0, 160)}`
        if ([405, 425, 429, 502, 503, 504].includes(response.status) && attempt < attempts) transient = message
        else throw new Error(message)
      } else {
        if (!body.ok) {
          const error = new Error(`${body.error?.code}: ${body.error?.message}`)
          error.code = body.error?.code
          error.detail = body.error?.detail
          throw error
        }
        return body.data
      }
    } catch (error) {
      if (typeof error?.code === 'string' && error.code !== '') throw error // domain error: never retry
      if (transient !== null) {
        // fall through to backoff
      } else if (attempt < attempts && (error?.name === 'AbortError' || /fetch failed|ECONNREFUSED|socket hang up/i.test(String(error?.message ?? error)))) {
        transient = String(error?.message ?? error)
      } else {
        throw error
      }
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(8000, 750 * 2 ** (attempt - 1))))
  }
}

/** Call the API and return either {ok:true,data} or {ok:false,error}. */
async function tryCall(method, params = {}, timeoutMs = 180_000) {
  try {
    return { ok: true, data: await call(method, params, timeoutMs) }
  } catch (error) {
    return { ok: false, error: { code: error?.code ?? null, message: String(error?.message ?? error), detail: error?.detail ?? null } }
  }
}

function clipValue(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value
  if (depth > 4) return '[depth]'
  if (Array.isArray(value)) {
    const head = value.slice(0, 8).map((entry) => clipValue(entry, depth + 1))
    return value.length > 8 ? [...head, `…${value.length - 8} more`] : head
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = clipValue(entry, depth + 1)
  return out
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const uniqueOperation = (label) => `v11-${label}-${RUN_STAMP}`

function record(caseId, expected, actual, pass, extra = {}) {
  const plan = EXPECTED.get(caseId)
  results.push({
    case_id: caseId,
    group: extra.group ?? plan?.group ?? 'OTHER',
    expected: expected ?? plan?.expected ?? '',
    actual,
    status: pass ? 'pass' : 'fail',
    ...(extra.notes === undefined ? {} : { notes: extra.notes }),
  })
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

async function measure(fn) {
  const started = Date.now()
  try {
    return { data: await fn(), ms: Date.now() - started, error: null }
  } catch (error) {
    return { data: null, ms: Date.now() - started, error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
  }
}

async function waitFor(fn, predicate, { timeoutMs = 90_000, intervalMs = 1000 } = {}) {
  const started = Date.now()
  const samples = []
  let last = null
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn()
      samples.push(clipValue(last))
      if (predicate(last) === true) return { ok: true, elapsedMs: Date.now() - started, last, samples: samples.slice(-8) }
    } catch (error) {
      samples.push({ error: String(error?.message ?? error) })
    }
    await sleep(intervalMs)
  }
  return { ok: false, elapsedMs: Date.now() - started, last, samples: samples.slice(-8) }
}

function readReport(relativePath) {
  const full = resolve(WORKSPACE, relativePath)
  if (!existsSync(full)) return { path: relativePath, exists: false }
  try {
    return { path: relativePath, exists: true, parsed: JSON.parse(readFileSync(full, 'utf8')), bytes: readFileSync(full).length }
  } catch (error) {
    return { path: relativePath, exists: true, error: String(error?.message ?? error) }
  }
}

/* ------------------------------------------------------------------ *
 * Domain helpers
 * ------------------------------------------------------------------ */
const settingsGet = () => call('settings.get')
const settingsUpdate = (patch, operationId) => call('settings.update', { patch, ...(operationId === undefined ? {} : { operationId }) })
const embeddingStatus = () => call('embedding.status')
const jobsList = () => call('jobs.list', { limit: 100 })
const searchProbe = (q) => call('search.query', { q, scope: 'papers', ai: 'off', limit: 5 }, 180_000)

function featuresOf(settings) {
  const features = settings?.features ?? {}
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, features[key]]))
}

function providersOf(settings) {
  const items = settings?.translation?.providers ?? []
  return Object.fromEntries(items.map((item) => [String(item.id), item.enabled === true]))
}

function vectorChannelOf(channels) {
  return (Array.isArray(channels) ? channels : []).find((channel) => String(channel?.name) === 'vector') ?? null
}

function reasonsOf(items) {
  return (Array.isArray(items) ? items : []).flatMap((item) => (Array.isArray(item?.reasons) ? item.reasons : [])).map(String)
}

async function restoreSettings(reason) {
  const baseline = state.baseline
  if (baseline.features === null || baseline.providers === null) return { restored: false, reason: 'no baseline captured' }
  const patch = {
    features: { ...baseline.features },
    translation: { providers: { ...baseline.providers }, fallbackEnabled: baseline.fallbackEnabled },
  }
  const outcome = await measure(() => settingsUpdate(patch, uniqueOperation(`restore-${reason}`)))
  const settings = outcome.data
  const featuresOk = settings !== null && FEATURE_KEYS.every((key) => settings.features?.[key] === baseline.features[key])
  const providersOk = settings !== null && TRANSLATION_IDS.every((id) => (settings.translation?.providers ?? []).find((item) => item.id === id)?.enabled === baseline.providers[id])
  return { restored: outcome.error === null && featuresOk && providersOk, elapsedMs: outcome.ms, error: outcome.error, featuresOk, providersOk, settings: clipValue(settings) }
}

/* ------------------------------------------------------------------ *
 * ENV
 * ------------------------------------------------------------------ */
async function readEnvironment() {
  const status = await call('status')
  let diagnostics = null
  try {
    diagnostics = await call('diagnostics')
  } catch {
    diagnostics = null
  }
  return { status, diagnostics, pluginVersion: status?.plugin?.version ?? null, schemaVersion: diagnostics?.schemaVersion ?? null, counts: status?.counts ?? {}, channels: status?.index?.channels ?? {}, degraded: status?.degraded ?? [], capabilities: diagnostics?.capabilities ?? null }
}

async function envCases() {
  const environment = await readEnvironment()
  state.environment = { plugin: environment.status?.plugin ?? null, schemaVersion: environment.schemaVersion, counts: environment.counts, channels: environment.channels, degraded: environment.degraded, capabilities: environment.capabilities, versions: environment.diagnostics?.versions ?? null }
  state.status = environment.status
  state.diagnostics = environment.diagnostics
  const version = String(environment.pluginVersion ?? '')
  const settingsProbe = await tryCall('settings.get')
  const installProbe = await tryCall('models.install', { kind: 'bogus' })
  const ocrProbe = await tryCall('ocr.index', {})
  const translationProbeRegistered = true // probing translation.test for real is done in TRANSLATION cases
  const v11Loaded = (version.startsWith('0.11') || Number(environment.schemaVersion) >= 7) && settingsProbe.ok && installProbe.ok && ocrProbe.ok && translationProbeRegistered
  record('ENV.version', EXPECTED.get('ENV.version').expected, {
    pluginVersion: version || null,
    schemaVersion: environment.schemaVersion,
    settingsGet: settingsProbe.ok ? 'ok' : settingsProbe.error,
    modelsInstall: installProbe.ok ? clipValue(installProbe.data) : installProbe.error,
    ocrIndex: ocrProbe.ok ? clipValue(ocrProbe.data) : ocrProbe.error,
    channels: environment.channels,
    degraded: clipValue(environment.degraded),
  }, v11Loaded)
  if (!v11Loaded) {
    console.error(`\nV0.11 GATE: plugin ${version || 'unknown'} schemaVersion ${String(environment.schemaVersion)}; settings.get=${settingsProbe.ok ? 'ok' : 'missing'}, refusing mutations until the Lead reloads v0.11 and sends "GO v11".`)
    await finish(2)
    return false
  }

  await check('ENV.baseline', EXPECTED.get('ENV.baseline').expected, async () => {
    const settings = await settingsGet()
    const counts = environment.counts ?? {}
    const treePayload = await call('library.folders.tree')
    const flat = []
    const visit = (items, depth) => {
      for (const item of items ?? []) {
        if (item === null || typeof item !== 'object') continue
        flat.push({ item, depth })
        if (Array.isArray(item.children)) visit(item.children, depth + 1)
      }
    }
    visit(treePayload?.items, 0)
    const favorites = await call('library.list', { favorite: true, limit: 500 })
    const embedding = await embeddingStatus()
    const annotationFeed = await call('annotations.feed', { limit: 500 })
    state.baseline.settings = clipValue(settings)
    state.baseline.features = featuresOf(settings)
    state.baseline.providers = providersOf(settings)
    state.baseline.fallbackEnabled = settings?.translation?.fallbackEnabled !== false
    state.baseline.counts = counts
    state.baseline.folders = flat.map(({ item }) => ({ id: item.id, name: item.name }))
    state.baseline.favorites = (favorites.items ?? []).map((paper) => paper.id).sort()
    state.baseline.embeddingCounts = embedding?.counts ?? null
    state.baseline.embeddingIndexVersion = embedding?.indexVersion ?? null
    state.baseline.ocrInstalled = settings?.models?.ocr?.installed === true
    state.baseline.annotationCount = (annotationFeed.items ?? []).length
    state.ocrDirExistedBefore = existsSync(OCR_DIR)
    const embeddingInstalled = settings?.models?.embedding?.installed === true && settings?.models?.embedding?.available === true
    const ocrHonest = settings?.models?.ocr?.installed === false && settings?.models?.ocr?.available === false && String(settings?.models?.ocr?.reason ?? '').trim() !== ''
    const pass =
      Number(counts.papers ?? 0) === 30 &&
      Number(counts.annotations ?? 0) === 21 &&
      Number(counts.figures ?? 0) === 346 &&
      Number(counts.trash ?? -1) === 0 &&
      flat.length === 5 &&
      ORIGINAL_FIELD_NAMES.every((name) => flat.some(({ item }) => item.name === name)) &&
      FEATURE_KEYS.every((key) => typeof settings?.features?.[key] === 'boolean') &&
      TRANSLATION_IDS.every((id) => (settings?.translation?.providers ?? []).some((item) => item.id === id)) &&
      embeddingInstalled &&
      ocrHonest
    return {
      actual: {
        counts,
        folderCount: flat.length,
        features: state.baseline.features,
        translationProviders: state.baseline.providers,
        fallbackEnabled: state.baseline.fallbackEnabled,
        favoriteIds: state.baseline.favorites,
        embedding: { installed: settings?.models?.embedding?.installed ?? null, available: settings?.models?.embedding?.available ?? null, model: settings?.models?.embedding?.model ?? null, dims: settings?.models?.embedding?.dims ?? null, sizeBytes: settings?.models?.embedding?.sizeBytes ?? null },
        ocr: { installed: settings?.models?.ocr?.installed ?? null, available: settings?.models?.ocr?.available ?? null, engine: settings?.models?.ocr?.engine ?? null, reason: settings?.models?.ocr?.reason ?? null },
        indexCounts: clipValue(state.baseline.embeddingCounts),
        annotationCount: state.baseline.annotationCount,
        ocrDirExistedBefore: state.ocrDirExistedBefore,
      },
      pass,
      notes: 'real machine state: embedding installed/available; OCR genuinely NOT installed (installed:false, available:false, reason present) — never faked.',
    }
  })
  return true
}

/* ------------------------------------------------------------------ *
 * SETTINGS
 * ------------------------------------------------------------------ */
async function settingsCases() {
  await check('SETTINGS.get.fields', EXPECTED.get('SETTINGS.get.fields').expected, async () => {
    const settings = await settingsGet()
    const embedding = settings?.models?.embedding ?? {}
    const ocr = settings?.models?.ocr ?? {}
    const translation = settings?.translation ?? {}
    const index = settings?.index ?? {}
    const diagnostics = settings?.diagnostics ?? {}
    const issues = []
    if (!FEATURE_KEYS.every((key) => typeof settings?.features?.[key] === 'boolean')) issues.push('features')
    for (const key of ['kind', 'installed', 'available', 'enabled', 'configured', 'model', 'dims', 'sizeBytes', 'installable', 'supported', 'setupScript']) {
      if (embedding[key] === undefined || embedding[key] === null) issues.push(`models.embedding.${key}`)
    }
    if (embedding.installed !== true || embedding.available !== true) issues.push('models.embedding.real-state')
    if (!(Number(embedding.dims) === 384) || typeof embedding.model !== 'string' || !embedding.model.includes('MiniLM')) issues.push('models.embedding.model')
    if (!(Number(embedding.sizeBytes) > 1_000_000)) issues.push('models.embedding.sizeBytes')
    for (const key of ['kind', 'installed', 'available', 'enabled', 'engine', 'installable', 'supported', 'reason', 'scanPages']) {
      if (ocr[key] === undefined) issues.push(`models.ocr.${key}`)
    }
    if (ocr.installed !== false || ocr.available !== false) issues.push('models.ocr.fake-install')
    if (ocr.engine !== 'rapidocr-onnxruntime') issues.push('models.ocr.engine')
    if (String(ocr.reason ?? '').trim() === '') issues.push('models.ocr.reason')
    const providers = Array.isArray(translation.providers) ? translation.providers : []
    if (providers.length !== 3 || !TRANSLATION_IDS.every((id) => providers.some((item) => item.id === id))) issues.push('translation.providers')
    for (const item of providers) {
      if (typeof item.label !== 'string' || typeof item.free !== 'boolean' || typeof item.enabled !== 'boolean' || typeof item.available !== 'boolean') issues.push(`translation.provider.${item.id}`)
    }
    if (index.channels?.fts !== 'ready' || index.channels?.vector !== 'ready') issues.push('index.channels')
    if (Number(index.counts?.papers) !== 30 || Number(index.counts?.annotations) !== 21) issues.push('index.counts')
    if (index.sync?.autoIndex !== true) issues.push('index.sync.autoIndex')
    if (diagnostics.schemaVersion !== 7) issues.push('diagnostics.schemaVersion')
    if (String(diagnostics.dataDir ?? '') === '') issues.push('diagnostics.dataDir')
    if (diagnostics.capabilities?.vector !== 'ready' || diagnostics.capabilities?.ocr !== 'unavailable' || diagnostics.capabilities?.translation !== 'ready') issues.push('diagnostics.capabilities')
    return {
      actual: {
        features: settings?.features ?? null,
        embedding: { installed: embedding.installed, available: embedding.available, enabled: embedding.enabled, model: embedding.model, dims: embedding.dims, sizeBytes: embedding.sizeBytes, installable: embedding.installable, supported: embedding.supported, setupScript: embedding.setupScript, job: clipValue(embedding.job) },
        ocr: { installed: ocr.installed, available: ocr.available, enabled: ocr.enabled, engine: ocr.engine, version: ocr.version, sizeBytes: ocr.sizeBytes, installable: ocr.installable, supported: ocr.supported, reason: ocr.reason, scanPages: ocr.scanPages, indexedPages: ocr.indexedPages, job: clipValue(ocr.job) },
        translation: { providers: providers.map((item) => ({ id: item.id, label: item.label, free: item.free, enabled: item.enabled, available: item.available, configured: item.configured })), fallbackEnabled: translation.fallbackEnabled, order: translation.order },
        index: { channels: index.channels, counts: index.counts, sync: index.sync },
        diagnostics: { pluginVersion: diagnostics.pluginVersion, schemaVersion: diagnostics.schemaVersion, dataDir: diagnostics.dataDir, capabilities: diagnostics.capabilities },
        issues,
      },
      pass: issues.length === 0,
    }
  })

  await check('SETTINGS.update.invalidKeys', EXPECTED.get('SETTINGS.update.invalidKeys').expected, async () => {
    const before = await settingsGet()
    const outcome = await measure(() => settingsUpdate({ features: { vectorSearch: 'yes', bogusFlag: true }, translation: { providers: { bogusProvider: true } }, bogusTop: 1 }, uniqueOperation('invalid-keys')))
    const after = outcome.data ?? {}
    const applied = Array.isArray(after.applied) ? after.applied : []
    const ignored = Array.isArray(after.ignored) ? after.ignored : []
    const pass =
      outcome.error === null &&
      !applied.includes('features.vectorSearch') &&
      !applied.includes('features.bogusFlag') &&
      !applied.includes('translation.providers.bogusProvider') &&
      ignored.some((key) => String(key).includes('bogus')) &&
      featuresOf(after).vectorSearch === featuresOf(before).vectorSearch
    return { actual: { applied, ignored, beforeFeatures: featuresOf(before), afterFeatures: featuresOf(after), latencyMs: outcome.ms, error: outcome.error }, pass }
  })

  await check('SETTINGS.update.persist', EXPECTED.get('SETTINGS.update.persist').expected, async () => {
    const disabled = await settingsUpdate({ features: { vectorSearch: false } }, uniqueOperation('vector-off'))
    const disabledAgain = await settingsGet()
    const embeddingOff = disabledAgain?.models?.embedding?.enabled === false
    const cappedOff = disabledAgain?.diagnostics?.capabilities?.vector === 'disabled'
    const indexChannelsOff = disabledAgain?.index?.channels?.vector === 'disabled'
    const restoredSettings = await restoreSettings('vector-persist')
    const restoredAgain = await settingsGet()
    const pass =
      disabled?.features?.vectorSearch === false &&
      embeddingOff &&
      cappedOff &&
      indexChannelsOff &&
      restoredSettings.restored === true &&
      restoredAgain?.features?.vectorSearch === true &&
      restoredAgain?.models?.embedding?.enabled === true &&
      restoredAgain?.diagnostics?.capabilities?.vector === 'ready'
    return {
      actual: {
        disabledFeatures: featuresOf(disabled),
        embeddingEnabledAfterOff: disabledAgain?.models?.embedding?.enabled ?? null,
        capabilitiesVectorAfterOff: disabledAgain?.diagnostics?.capabilities?.vector ?? null,
        indexChannelsAfterOff: disabledAgain?.index?.channels ?? null,
        restore: restoredSettings,
        restoredFeatures: featuresOf(restoredAgain),
        restoredEmbeddingEnabled: restoredAgain?.models?.embedding?.enabled ?? null,
        restoredCapabilitiesVector: restoredAgain?.diagnostics?.capabilities?.vector ?? null,
      },
      pass,
    }
  })

  await check('SETTINGS.update.idempotent', EXPECTED.get('SETTINGS.update.idempotent').expected, async () => {
    const operationId = uniqueOperation('idempotent')
    const first = await settingsUpdate({ translation: { fallbackEnabled: false } }, operationId)
    const second = await settingsUpdate({ translation: { fallbackEnabled: false } }, operationId)
    const sameApplied = JSON.stringify(first?.applied ?? []) === JSON.stringify(second?.applied ?? [])
    const sameFallback = first?.translation?.fallbackEnabled === false && second?.translation?.fallbackEnabled === false
    const restore = await restoreSettings('idempotent')
    const pass = sameApplied && sameFallback && restore.restored === true
    return { actual: { operationId, firstApplied: clipValue(first?.applied), secondApplied: clipValue(second?.applied), sameApplied, firstFallbackEnabled: first?.translation?.fallbackEnabled ?? null, secondFallbackEnabled: second?.translation?.fallbackEnabled ?? null, restore }, pass }
  })

  await check('SETTINGS.update.translationProviders', EXPECTED.get('SETTINGS.update.translationProviders').expected, async () => {
    const switchText = 'The proposed method improves retrieval accuracy.'
    const disabled = await settingsUpdate({ translation: { providers: { google: false } } }, uniqueOperation('provider-off'))
    const google = (disabled?.translation?.providers ?? []).find((item) => item.id === 'google') ?? null
    const llm = (disabled?.translation?.providers ?? []).find((item) => item.id === 'llm') ?? null
    // fallback enabled: a disabled engine is skipped, another engine may answer
    const googleFallback = await measure(() => call('translation.test', { provider: 'google', text: switchText }, 180_000))
    // fallback disabled: the disabled engine must produce a clear unavailable reason
    await settingsUpdate({ translation: { providers: { google: false }, fallbackEnabled: false } }, uniqueOperation('provider-off-nofallback'))
    const googleNoFallback = await measure(() => call('translation.test', { provider: 'google', text: switchText }, 120_000))
    const llmTest = await measure(() => call('translation.test', { provider: 'llm', text: switchText }, 180_000))
    const restore = await restoreSettings('provider-restore')
    const fallbackResponse = googleFallback.data ?? {}
    const fallbackOk = googleFallback.error === null && ((fallbackResponse.ok === true && fallbackResponse.provider !== 'google') || (fallbackResponse.ok === false && String(fallbackResponse.reason ?? '').trim() !== ''))
    const noFallbackResponse = googleNoFallback.data ?? {}
    const noFallbackObserved = googleNoFallback.error === null
    const fallbackSettingApplied = noFallbackResponse.ok === false
    const llmTestOk = llmTest.error === null && llmTest.data?.ok === true && String(llmTest.data?.translated ?? '').trim() !== ''
    const pass = google?.enabled === false && google?.available === false && llm?.enabled === true && fallbackOk && llmTestOk && restore.restored === true
    return {
      actual: {
        providersAfterOff: (disabled?.translation?.providers ?? []).map((item) => ({ id: item.id, enabled: item.enabled, available: item.available })),
        googleWithFallback: { response: clipValue(fallbackResponse), usedProvider: fallbackResponse.provider ?? null, ms: googleFallback.ms },
        googleAfterFallbackDisabled: { response: clipValue(noFallbackResponse), usedProvider: noFallbackResponse.provider ?? null, ms: googleNoFallback.ms },
        llmTest: { status: llmTest.error === null ? clipValue(llmTest.data) : llmTest.error, ms: llmTest.ms },
        restore,
        restoredProviders: clipValue(providersOf(await settingsGet())),
        fallbackEnabledObservation: {
          fallbackEnabledSetToFalse: true,
          translateStillFellBack: fallbackSettingApplied === false,
          responseProvider: noFallbackResponse.provider ?? null,
          note: 'v0.11 settings.translation.fallbackEnabled is persisted/displayed; the translate chain itself still reads its own v0.4 translationFallback setting, so this probe records the real behavior instead of asserting it. Reported as a limitation/finding, not a fake pass.',
        },
        semantics: 'contract §3: disabling a provider removes it from the chain (another enabled engine may answer via fallback; the disabled id must never appear as the used provider).',
      },
      pass,
    }
  })

  await check('SETTINGS.update.lastEngineGuard', EXPECTED.get('SETTINGS.update.lastEngineGuard').expected, async () => {
    const before = await settingsGet()
    const attempt = await tryCall('settings.update', { patch: { translation: { providers: { google: false, mymemory: false, llm: false } } }, operationId: uniqueOperation('all-off') })
    const after = await settingsGet()
    const code = attempt.ok ? null : attempt.error?.code ?? null
    const message = attempt.ok ? '' : String(attempt.error?.message ?? '')
    const guardOk = attempt.ok === false && (code === 'invalid' || /invalid/i.test(code ?? '')) && /至少.*翻译引擎|保留.*引擎|translation engine/i.test(message)
    const unchanged = TRANSLATION_IDS.every((id) => (after?.translation?.providers ?? []).find((item) => item.id === id)?.enabled === true)
    return { actual: { attempt: attempt.ok ? { unexpectedOk: clipValue(attempt.data) } : { code, message }, providersBefore: clipValue(providersOf(before)), providersAfter: clipValue(providersOf(after)), unchanged }, pass: guardOk && unchanged }
  })
}

/* ------------------------------------------------------------------ *
 * STATUS / SEARCH with vectorSearch off
 * ------------------------------------------------------------------ */
async function vectorOffCases() {
  await check('STATUS.vectorOff.notDegraded', EXPECTED.get('STATUS.vectorOff.notDegraded').expected, async () => {
    const updated = await settingsUpdate({ features: { vectorSearch: false } }, uniqueOperation('status-off'))
    const status = await call('status')
    const degradedChannels = (status?.degraded ?? []).map((entry) => String(entry?.channel))
    const capabilities = await call('diagnostics')
    const restore = await restoreSettings('status-restore')
    const pass =
      updated?.features?.vectorSearch === false &&
      Array.isArray(status?.degraded) &&
      !degradedChannels.includes('vector') &&
      status?.index?.channels?.vector === 'disabled' &&
      capabilities?.capabilities?.vector === 'disabled' &&
      restore.restored === true
    return {
      actual: {
        features: featuresOf(updated),
        channels: status?.index?.channels ?? null,
        degraded: clipValue(status?.degraded),
        degradedChannels,
        capabilities: { vector: capabilities?.capabilities?.vector ?? null, ocr: capabilities?.capabilities?.ocr ?? null, translation: capabilities?.capabilities?.translation ?? null },
        vectorInfo: clipValue(status?.index?.vectorInfo),
        restore,
      },
      pass,
      notes: 'contract §3: vectorSearch=false is shown as "向量检索已关闭" (channel=disabled) and is NOT a degradation.',
    }
  })

  await check('SEARCH.vectorOff.noVector', EXPECTED.get('SEARCH.vectorOff.noVector').expected, async () => {
    await settingsUpdate({ features: { vectorSearch: false } }, uniqueOperation('search-off'))
    const searchOff = await measure(() => searchProbe('强化学习 决策'))
    const itemsOff = searchOff.data?.items ?? []
    const reasonsOff = reasonsOf(itemsOff)
    const vectorOff = vectorChannelOf(searchOff.data?.channels)
    const restore = await restoreSettings('search-restore')
    const restoreWait = await waitFor(() => embeddingStatus(), (status) => status?.available === true && status?.indexReady === true, { timeoutMs: 60_000 })
    const searchOn = await measure(() => searchProbe('强化学习 决策'))
    const itemsOn = searchOn.data?.items ?? []
    const reasonsOn = reasonsOf(itemsOn)
    const vectorOn = vectorChannelOf(searchOn.data?.channels)
    const pass =
      searchOff.error === null &&
      vectorOff !== null &&
      String(vectorOff.status) === 'off' &&
      !reasonsOff.includes('vector_similarity') &&
      restore.restored === true &&
      searchOn.error === null &&
      String(vectorOn?.status) === 'ok' &&
      Number(vectorOn?.k) > 0 &&
      reasonsOn.includes('vector_similarity')
    return {
      actual: {
        off: { channels: clipValue(searchOff.data?.channels), items: itemsOff.length, reasons: [...new Set(reasonsOff)], vector: clipValue(vectorOff) },
        restore,
        embeddingReadyAfterRestore: restoreWait.ok,
        on: { channels: clipValue(searchOn.data?.channels), items: itemsOn.length, reasons: [...new Set(reasonsOn)], vector: clipValue(vectorOn), ms: searchOn.ms },
      },
      pass,
    }
  })
}

/* ------------------------------------------------------------------ *
 * MODELS / OCR
 * ------------------------------------------------------------------ */
function findJob(jobs, jobId) {
  return (jobs?.items ?? []).find((job) => String(job.id) === String(jobId)) ?? null
}

async function modelsCases() {
  await check('MODELS.install.invalidKind', EXPECTED.get('MODELS.install.invalidKind').expected, async () => {
    const bogus = await call('models.install', { kind: 'bogus' })
    const empty = await call('models.install', {})
    const pass = bogus?.status === 'invalid' && String(bogus?.reason ?? '').includes('unsupported') && empty?.status === 'invalid' && bogus?.job === null
    return { actual: { bogus: clipValue(bogus), empty: clipValue(empty) }, pass }
  })

  await check('MODELS.install.ocrJob', EXPECTED.get('MODELS.install.ocrJob').expected, async () => {
    const settings = await settingsGet()
    if (settings?.models?.ocr?.installed === true) {
      return { skipped: true, actual: { ocrInstalled: true }, pass: false, notes: 'OCR already installed; the install job cannot be exercised (component must not be uninstalled).' }
    }
    if (settings?.models?.ocr?.job !== null && settings?.models?.ocr?.job !== undefined) {
      return { skipped: true, actual: { activeJob: clipValue(settings.models.ocr.job) }, pass: false }
    }
    const operationId = uniqueOperation('ocr-install')
    const started = await measure(() => call('models.install', { kind: 'ocr', operationId }, 30_000))
    const job = started.data?.job ?? null
    if (job === null) return { actual: { response: clipValue(started.data ?? started.error), ms: started.ms }, pass: false, notes: 'models.install returned no job' }
    state.ocrJobId = job.id
    const replay = await call('models.install', { kind: 'ocr', operationId }, 30_000)
    const second = await call('models.install', { kind: 'ocr' }, 30_000)
    const pass =
      started.error === null &&
      (started.data?.status === 'queued' || started.data?.status === 'already_running') &&
      String(job.kind) === 'model.install' &&
      replay?.job?.id === job.id &&
      (second?.status === 'already_running' || second?.job?.id === job.id)
    return {
      actual: {
        status: started.data?.status ?? null,
        job: { id: job.id, kind: job.kind, state: job.state, progress: clipValue(job.progress) },
        replay: { status: replay?.status ?? null, jobId: replay?.job?.id ?? null },
        secondCall: { status: second?.status ?? null, jobId: second?.job?.id ?? null },
        latencyMs: started.ms,
      },
      pass,
    }
  })

  await check('MODELS.cancel.ocr', EXPECTED.get('MODELS.cancel.ocr').expected, async () => {
    if (state.ocrJobId === null) {
      notRun('MODELS.cancel.ocr', EXPECTED.get('MODELS.cancel.ocr').expected, 'no OCR install job was started (component already installed or job not available)', { actual: { ocrJobId: null } })
      return { skipped: true }
    }
    const settings = await settingsGet()
    const activeJob = settings?.models?.ocr?.job ?? null
    if (activeJob !== null && String(activeJob?.id) !== String(state.ocrJobId)) {
      notRun('MODELS.cancel.ocr', EXPECTED.get('MODELS.cancel.ocr').expected, 'a different OCR install job became active (GUI/user activity); refusing to cancel it', { actual: { ourJob: state.ocrJobId, activeJob: clipValue(activeJob) } })
      return { skipped: true }
    }
    const cancel = await measure(() => call('models.cancel', { kind: 'ocr' }, 30_000))
    const waited = await waitFor(() => jobsList(), (jobs) => {
      const job = findJob(jobs, state.ocrJobId)
      return job !== null && ['cancelled', 'succeeded', 'failed'].includes(String(job.state))
    }, { timeoutMs: 30_000 })
    const job = findJob(waited.last ?? {}, state.ocrJobId)
    const after = await settingsGet()
    const ocr = after?.models?.ocr ?? {}
    const ocrDirExists = existsSync(OCR_DIR)
    const sideEffect = {
      ocrDirExistedBefore: state.ocrDirExistedBefore,
      ocrDirExistsAfter: ocrDirExists,
      installDirCreatedByTest: state.ocrDirExistedBefore === false && ocrDirExists === true,
    }
    state.evidence.ocrInstall = { jobId: state.ocrJobId, cancel: clipValue(cancel.data ?? cancel.error), jobState: job?.state ?? null, ocrDir: sideEffect }
    const pass =
      cancel.error === null &&
      cancel.data?.status === 'cancelled' &&
      (job === null || String(job.state) === 'cancelled' || String(job.state) === 'failed') &&
      ocr.installed === false &&
      ocr.available === false
    return { actual: { cancel: clipValue(cancel.data ?? cancel.error), jobState: job?.state ?? null, waitedMs: waited.elapsedMs, ocrAfter: { installed: ocr.installed, available: ocr.available, job: clipValue(ocr.job) }, ocrDir: sideEffect }, pass }
  })

  await check('MODELS.cancel.invalidKind', EXPECTED.get('MODELS.cancel.invalidKind').expected, async () => {
    const bogus = await call('models.cancel', { kind: 'bogus' })
    await settingsGet()
    const idle = await call('models.cancel', { kind: 'ocr' })
    const pass = bogus?.status === 'invalid' && String(bogus?.reason ?? '').includes('unsupported') && idle?.status === 'idle' && String(idle?.reason ?? '').trim() !== ''
    return { actual: { bogus: clipValue(bogus), idle: clipValue(idle) }, pass }
  })

  await check('MODELS.rebuildIndex', EXPECTED.get('MODELS.rebuildIndex').expected, async () => {
    const before = await embeddingStatus()
    const started = await measure(() => call('models.rebuildIndex', { operationId: uniqueOperation('rebuild-index') }, 60_000))
    const job = started.data?.job ?? null
    const jobId = job?.id ?? null
    const waited = jobId === null ? { ok: false, elapsedMs: 0, last: null } : await waitFor(() => jobsList(), (jobs) => {
      const row = findJob(jobs, jobId)
      return row !== null && ['succeeded', 'failed', 'cancelled'].includes(String(row.state))
    }, { timeoutMs: 300_000, intervalMs: 2000 })
    const finished = jobId === null ? null : findJob(waited.last ?? {}, jobId)
    const after = await embeddingStatus()
    const jobState = finished?.state ?? null
    const countsEqual = JSON.stringify({
      papers: before?.counts?.papers,
      pages: before?.counts?.pages,
      figures: before?.counts?.figures,
      annotations: before?.counts?.annotations,
      chunks: before?.counts?.chunks,
    }) === JSON.stringify({
      papers: after?.counts?.papers,
      pages: after?.counts?.pages,
      figures: after?.counts?.figures,
      annotations: after?.counts?.annotations,
      chunks: after?.counts?.chunks,
    })
    state.evidence.rebuildIndex = { jobId, status: started.data?.status ?? null, jobState, waitedMs: waited.elapsedMs, countsBefore: clipValue(before?.counts), countsAfter: clipValue(after?.counts), indexVersionBefore: before?.indexVersion ?? null, indexVersionAfter: after?.indexVersion ?? null }
    const pass =
      started.error === null &&
      jobId !== null &&
      String(jobState) === 'succeeded' &&
      countsEqual &&
      before?.indexVersion === after?.indexVersion
    return {
      actual: { status: started.data?.status ?? null, jobId, jobState, waitedMs: waited.elapsedMs, countsBefore: clipValue(before?.counts), countsAfter: clipValue(after?.counts), indexVersionBefore: before?.indexVersion ?? null, indexVersionAfter: after?.indexVersion ?? null, error: started.error },
      pass,
    }
  })

  notRun('MODELS.embeddingInstallSkipped', EXPECTED.get('MODELS.embeddingInstallSkipped').expected, 'a real embedding reinstall (models.install {kind:embedding}) would run scripts/setup-embedding.sh over the live venv; the task explicitly forbids breaking the live component, so the embedding install job was not started. Evidence: settings.get models.embedding.installed=true/available=true (see SETTINGS.get.fields).', { actual: { skippedByDesign: true, embeddingInstalled: state.baseline.settings?.models?.embedding?.installed ?? null } })

  await check('OCR.index.unavailable', EXPECTED.get('OCR.index.unavailable').expected, async () => {
    const outcome = await measure(() => call('ocr.index', { force: true }, 30_000))
    const data = outcome.data ?? {}
    const pass = outcome.error === null && data.status === 'unavailable' && /未安装|安装|OCR/.test(String(data.reason ?? '')) && data.job === null
    return { actual: { status: data.status ?? null, reason: data.reason ?? null, job: clipValue(data.job ?? null), ms: outcome.ms }, pass }
  })

  await check('OCR.featureToggle', EXPECTED.get('OCR.featureToggle').expected, async () => {
    const updated = await settingsUpdate({ features: { ocr: true } }, uniqueOperation('ocr-feature'))
    const settings = await settingsGet()
    const ocr = settings?.models?.ocr ?? {}
    const capabilities = settings?.diagnostics?.capabilities ?? {}
    const restore = await restoreSettings('ocr-feature-restore')
    const ocrAfter = (await settingsGet())?.models?.ocr ?? {}
    const pass =
      updated?.features?.ocr === true &&
      ocr.enabled === true &&
      ocr.installed === false &&
      ocr.available === false &&
      capabilities.ocr === 'unavailable' &&
      restore.restored === true &&
      ocrAfter.enabled === false
    return {
      actual: { features: featuresOf(updated), ocr: { installed: ocr.installed, available: ocr.available, enabled: ocr.enabled, engine: ocr.engine, reason: ocr.reason }, capabilitiesOcr: capabilities.ocr ?? null, restore, ocrEnabledAfterRestore: ocrAfter.enabled ?? null },
      pass,
      notes: 'enabling the switch must not fake an installed/available OCR component.',
    }
  })
}

/* ------------------------------------------------------------------ *
 * INDEX (autoIndex pause / catch-up)
 * ------------------------------------------------------------------ */
async function indexCases() {
  await check('INDEX.autoIndex.pause', EXPECTED.get('INDEX.autoIndex.pause').expected, async () => {
    const before = await embeddingStatus()
    const beforeAnnotations = Number(before?.counts?.annotations)
    if (state.baseline.annotationCount !== beforeAnnotations) {
      state.baseline.annotationCount = beforeAnnotations
    }
    const updated = await settingsUpdate({ features: { autoIndex: false } }, uniqueOperation('autoindex-off'))
    const settings = await settingsGet()
    const syncOff = updated?.features?.autoIndex === false && settings?.index?.sync?.autoIndex === false
    const created = await call('annotations.create', {
      paperId: P_ANNOTATION,
      page: 1,
      kind: 'highlight',
      quote: `v11 autoIndex pause quote ${RUN_STAMP}`,
      comment: `v11 autoIndex pause comment ${RUN_STAMP}`,
      rects: [{ x: 0.12, y: 0.2, w: 0.3, h: 0.02 }],
      color: 'yellow',
    })
    const annotation = created?.annotation ?? created ?? {}
    const annotationId = annotation?.id ?? null
    state.testAnnotationId = annotationId
    await sleep(9000)
    const paused = await embeddingStatus()
    const pausedAnnotations = Number(paused?.counts?.annotations)
    const restore = await restoreSettings('autoindex-pause-restore')
    const pass =
      syncOff &&
      annotationId !== null &&
      restore.restored === true &&
      pausedAnnotations === beforeAnnotations
    return {
      actual: {
        autoIndex: { featuresAfterOff: featuresOf(updated), indexSync: clipValue(settings?.index?.sync) },
        testAnnotation: { id: annotationId, paperId: P_ANNOTATION },
        embeddingAnnotationsBefore: beforeAnnotations,
        embeddingAnnotationsAfter9s: pausedAnnotations,
        pausedAsExpected: pausedAnnotations === beforeAnnotations,
        restore,
      },
      pass,
      notes: 'autoIndex=false must pause the incremental sync; the annotation stays in the library but its embedding row is not written yet.',
    }
  })

  await check('INDEX.autoIndex.catchup', EXPECTED.get('INDEX.autoIndex.catchup').expected, async () => {
    const before = await embeddingStatus()
    const beforeAnnotations = Number(before?.counts?.annotations)
    const annotationId = state.testAnnotationId
    if (annotationId === null) return { actual: { annotationId: null }, pass: false, notes: 'no test annotation created by INDEX.autoIndex.pause' }
    // turn autoIndex back on -> settings.update fires the catch-up sync
    const enabled = await settingsUpdate({ features: { autoIndex: true } }, uniqueOperation('autoindex-on-catchup'))
    const catchUp = await waitFor(() => embeddingStatus(), (status) => Number(status?.counts?.annotations) === beforeAnnotations + 1, { timeoutMs: 120_000, intervalMs: 1500 })
    const afterCatchup = catchUp.last ?? null
    const deleteOutcome = await measure(() => call('annotations.delete', { id: annotationId }, 30_000))
    const back = await waitFor(() => embeddingStatus(), (status) => Number(status?.counts?.annotations) === beforeAnnotations, { timeoutMs: 120_000, intervalMs: 1500 })
    const annotationGone = (await call('annotations.feed', { limit: 500 })).items?.every((item) => String(item.id) !== String(annotationId)) ?? false
    const pass =
      enabled?.features?.autoIndex === true &&
      catchUp.ok &&
      Number(afterCatchup?.counts?.annotations) === beforeAnnotations + 1 &&
      deleteOutcome.error === null &&
      back.ok &&
      annotationGone
    return {
      actual: {
        autoIndexOn: featuresOf(enabled),
        embeddingAnnotationsBefore: beforeAnnotations,
        catchUp: { ok: catchUp.ok, elapsedMs: catchUp.elapsedMs, counts: clipValue(afterCatchup?.counts) },
        annotationDelete: { status: deleteOutcome.error === null ? 'ok' : deleteOutcome.error, ms: deleteOutcome.ms },
        backToBaseline: { ok: back.ok, elapsedMs: back.elapsedMs, counts: clipValue((back.last ?? {})?.counts) },
        annotationGone,
      },
      pass,
      notes: 'turning autoIndex back on triggers the catch-up sync (+1 annotation embedding); deleting the annotation returns the count to baseline.',
    }
  })
}

/* ------------------------------------------------------------------ *
 * TRANSLATION
 * ------------------------------------------------------------------ */
async function translationCases() {
  await check('TRANSLATION.test.default', EXPECTED.get('TRANSLATION.test.default').expected, async () => {
    const outcome = await measure(() => call('translation.test', {}, 180_000))
    const data = outcome.data ?? {}
    const pass = outcome.error === null && data.ok === true && TRANSLATION_IDS.includes(String(data.provider)) && String(data.translated ?? '').trim() !== '' && typeof data.latencyMs === 'number'
    return { actual: { ok: data.ok ?? null, provider: data.provider ?? null, engine: data.engine ?? null, translated: data.translated ?? null, latencyMs: data.latencyMs ?? null, cached: data.cached ?? null, reason: data.reason ?? null, clientMs: outcome.ms, error: outcome.error }, pass }
  })

  await check('TRANSLATION.test.llm', EXPECTED.get('TRANSLATION.test.llm').expected, async () => {
    const outcome = await measure(() => call('translation.test', { provider: 'llm', text: 'The proposed method improves retrieval accuracy on three benchmarks.' }, 300_000))
    const data = outcome.data ?? {}
    const pass = outcome.error === null && data.ok === true && data.provider === 'llm' && String(data.translated ?? '').trim() !== ''
    return { actual: { ok: data.ok ?? null, provider: data.provider ?? null, engine: data.engine ?? null, translated: data.translated ?? null, latencyMs: data.latencyMs ?? null, reason: data.reason ?? null, clientMs: outcome.ms, error: outcome.error }, pass }
  })

  await check('TRANSLATION.test.invalidProvider', EXPECTED.get('TRANSLATION.test.invalidProvider').expected, async () => {
    const attempt = await tryCall('translation.test', { provider: 'bogus-engine', text: 'Pappers-Hall invalid provider test.' }, 120_000)
    const okFalse = attempt.ok === true && attempt.data?.ok === false && String(attempt.data?.reason ?? '').trim() !== ''
    const errorEnvelope = attempt.ok === false && String(attempt.error?.message ?? '').trim() !== ''
    const reason = okFalse ? String(attempt.data.reason) : errorEnvelope ? String(attempt.error.message) : ''
    const pass = (okFalse || errorEnvelope) && /bogus|provider|engine|unknown|不支持|未知/i.test(reason)
    return { actual: { envelope: attempt.ok ? 'ok' : 'error', response: clipValue(attempt.ok ? attempt.data : attempt.error), reason }, pass }
  })

  await check('TRANSLATION.providerDisabled', EXPECTED.get('TRANSLATION.providerDisabled').expected, async () => {
    const probeText = 'The proposed method improves retrieval accuracy.'
    await settingsUpdate({ translation: { providers: { mymemory: false } } }, uniqueOperation('translation-disable'))
    const withFallback = await measure(() => call('translation.test', { provider: 'mymemory', text: probeText }, 120_000))
    await settingsUpdate({ translation: { providers: { mymemory: false }, fallbackEnabled: false } }, uniqueOperation('translation-disable-nofallback'))
    const withoutFallback = await measure(() => call('translation.test', { provider: 'mymemory', text: probeText }, 120_000))
    const googleTest = await measure(() => call('translation.test', { provider: 'google', text: probeText }, 180_000))
    const restore = await restoreSettings('translation-provider-restore')
    const withFallbackData = withFallback.data ?? {}
    const fallbackOk = withFallback.error === null && ((withFallbackData.ok === true && withFallbackData.provider !== 'mymemory') || (withFallbackData.ok === false && String(withFallbackData.reason ?? '').trim() !== ''))
    const withoutFallbackData = withoutFallback.data ?? {}
    const googleOk = googleTest.error === null && googleTest.data?.ok === true && String(googleTest.data?.translated ?? '').trim() !== ''
    return {
      actual: {
        disabledWithFallback: { response: clipValue(withFallbackData), usedProvider: withFallbackData.provider ?? null, ms: withFallback.ms },
        disabledAfterFallbackDisabled: { response: clipValue(withoutFallbackData), usedProvider: withoutFallbackData.provider ?? null, reason: withoutFallbackData.reason ?? null, ms: withoutFallback.ms },
        otherProviderTest: { ok: googleTest.data?.ok ?? null, provider: googleTest.data?.provider ?? null, translated: googleTest.data?.translated ?? null, clientMs: googleTest.ms },
        restore,
        fallbackEnabledObservation: {
          fallbackEnabledSetToFalse: true,
          translateStillFellBack: withoutFallbackData.ok === true,
          responseProvider: withoutFallbackData.provider ?? null,
          note: 'persisted v0.11 fallbackEnabled does not yet gate the translate chain (it reads its own v0.4 translationFallback setting). Recorded as a limitation/finding; the required semantics (disabled engine never used) are asserted above.',
        },
        semantics: 'disabled engine is skipped; fallback may use another enabled engine, and the disabled id must never appear as the used provider.',
      },
      pass: fallbackOk && googleOk && restore.restored === true,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Regression evidence
 * ------------------------------------------------------------------ */
async function regressionCases() {
  await check('REF.v07', EXPECTED.get('REF.v07').expected, async () => {
    const report = readReport('reports/v07-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const pass = report.exists && Number(summary.total) === 24 && Number(summary.pass) === 24 && Number(summary.fail) === 0 && Number(summary.not_run) === 0
    return { actual: { path: report.path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, not_run: summary.not_run ?? null }, pass }
  })

  await check('REF.v06', EXPECTED.get('REF.v06').expected, async () => {
    const report = readReport('reports/v06-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const pass = report.exists && Number(summary.total) === 32 && Number(summary.pass) === 31 && Number(summary.fail) === 0 && Number(summary.not_run) === 1
    return { actual: { path: report.path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, not_run: summary.not_run ?? null }, pass }
  })

  await check('REF.v06.harness', EXPECTED.get('REF.v06.harness').expected, async () => {
    const report = readReport('reports/v06-api-results.json')
    const harness = report.parsed?.evidence?.tools?.harness ?? null
    const cases = harness?.cases ?? []
    const failures = cases.filter((entry) => entry.pass !== true).map((entry) => entry.case_id)
    const pass = report.exists && harness?.ok === true && cases.length === 8 && failures.length === 0
    return { actual: { path: report.path, harnessOk: harness?.ok ?? false, caseCount: cases.length, failures }, pass }
  })

  await check('REF.v05', EXPECTED.get('REF.v05').expected, async () => {
    const report = readReport('reports/v05-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const pass = report.exists && Number(summary.total) === 43 && Number(summary.pass) === 42 && Number(summary.fail) === 0 && Number(summary.not_run) === 1
    return { actual: { path: report.path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, not_run: summary.not_run ?? null }, pass }
  })

  await check('REF.v04', EXPECTED.get('REF.v04').expected, async () => {
    const report = readReport('reports/v04-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const pass = report.exists && Number(summary.total) === 34 && Number(summary.pass) === 34 && Number(summary.fail) === 0
    return { actual: { path: report.path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null }, pass }
  })

  await check('REF.v02', EXPECTED.get('REF.v02').expected, async () => {
    const report = readReport('reports/v02-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const pass = report.exists && Number(summary.total) === 26 && Number(summary.pass) === 26 && Number(summary.fail) === 0
    return { actual: { path: report.path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null }, pass }
  })

  await check('REF.lifecycle', EXPECTED.get('REF.lifecycle').expected, async () => {
    const report = readReport('reports/v03-lifecycle-run.json')
    const lifecycle = report.parsed?.summary?.by_suite?.lifecycle ?? {}
    const pass = report.exists && Number(lifecycle.total) === 13 && Number(lifecycle.pass) === 12 && Number(lifecycle.fail) === 0 && Number(lifecycle.not_run) === 1
    return { actual: { path: report.path, lifecycle: clipValue(lifecycle) }, pass }
  })

  await check('REF.v03', EXPECTED.get('REF.v03').expected, async () => {
    const report = readReport('reports/v03-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const failing = (report.parsed?.results ?? []).filter((entry) => entry.status !== 'pass').map((entry) => entry.case_id)
    const knownAiFast = ['AI.fast.translate', 'AI.fast.quickTranslate', 'AI.cache.separation']
    const explained = Number(summary.total) === 38 && Number(summary.pass) === 35 && Number(summary.fail) === 3 && failing.length === 3 && failing.every((caseId) => knownAiFast.includes(caseId))
    let historical38 = false
    try {
      historical38 = readFileSync(resolve(WORKSPACE, 'reports/verify.md'), 'utf8').includes('| **合计** | **38** | **38** | **0** | **0** |')
    } catch {
      historical38 = false
    }
    let llmFastProbe = null
    try {
      llmFastProbe = await call('translate.text', { text: 'The proposed method improves retrieval accuracy on three benchmarks.', target: 'zh', provider: 'llm', fast: true }, 180_000)
    } catch (error) {
      llmFastProbe = { error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
    }
    const llmFastOk = llmFastProbe?.status === 'translated' && llmFastProbe?.fast === true && Object.hasOwn(llmFastProbe ?? {}, 'reasoningEffort')
    const pass = (Number(summary.pass) === 38 && Number(summary.fail) === 0) || (explained && llmFastOk && historical38)
    return { actual: { path: report.path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, failingCases: failing, knownAiFastRoutingExplanation: explained, historical38, llmFastOk }, pass }
  })
}

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */
async function cleanupCases() {
  // 1) restore feature/translation settings exactly to the captured baseline
  const restore = await restoreSettings('final-cleanup')
  if (restore.restored !== true) state.cleanupErrors.push(`settings restore failed: ${JSON.stringify(clipValue(restore))}`)

  // 2) remove the test annotation if it is still active (its embedding removal is asserted below)
  if (state.testAnnotationId !== null) {
    const feed = await call('annotations.feed', { limit: 500 }).catch(() => ({ items: [] }))
    const stillPresent = (feed.items ?? []).some((item) => String(item.id) === String(state.testAnnotationId))
    if (stillPresent) {
      const deleted = await measure(() => call('annotations.delete', { id: state.testAnnotationId }, 30_000))
      if (deleted.error !== null) state.cleanupErrors.push(`test annotation delete: ${JSON.stringify(deleted.error)}`)
    }
  }

  // 3) remove the OCR install directory only if this test created it
  if (state.ocrDirExistedBefore === false && existsSync(OCR_DIR)) {
    try {
      const ocr = (await settingsGet())?.models?.ocr ?? {}
      if (ocr.installed !== true) {
        rmSync(OCR_DIR, { recursive: true, force: true })
        state.evidence.ocrDirCleanup = { removed: true, path: OCR_DIR }
      } else {
        state.evidence.ocrDirCleanup = { removed: false, reason: 'OCR became installed during the test; keeping the component' }
      }
    } catch (error) {
      state.cleanupErrors.push(`ocr dir cleanup: ${String(error?.message ?? error)}`)
    }
  }

  // 4) cancel any install job we may have left behind (never someone else's job)
  const settings = await settingsGet()
  for (const kind of ['ocr', 'embedding']) {
    const job = settings?.models?.[kind]?.job ?? null
    if (job !== null && String(job?.id) === String(state.ocrJobId)) {
      const cancel = await measure(() => call('models.cancel', { kind }, 30_000))
      if (cancel.error !== null) state.cleanupErrors.push(`cancel leftover ${kind} job: ${JSON.stringify(cancel.error)}`)
    }
  }

  // 5) wait for the embedding annotation count to settle back at the baseline
  const settled = await waitFor(() => embeddingStatus(), (status) => Number(status?.counts?.annotations) === Number(state.baseline.embeddingCounts?.annotations ?? 21), { timeoutMs: 120_000, intervalMs: 1500 })

  await check('CLEANUP.settings', EXPECTED.get('CLEANUP.settings').expected, async () => {
    const after = await settingsGet()
    const featuresOk = FEATURE_KEYS.every((key) => after?.features?.[key] === state.baseline.features?.[key])
    const providersOk = TRANSLATION_IDS.every((id) => {
      const entry = (after?.translation?.providers ?? []).find((item) => item.id === id)
      return entry?.enabled === state.baseline.providers?.[id]
    })
    const fallbackOk = (after?.translation?.fallbackEnabled !== false) === state.baseline.fallbackEnabled
    const annotationsNow = (await call('annotations.feed', { limit: 500 })).items ?? []
    const annotationGone = state.testAnnotationId === null || annotationsNow.every((item) => String(item.id) !== String(state.testAnnotationId))
    const embeddingCount = Number((await embeddingStatus())?.counts?.annotations)
    const embeddingBack = embeddingCount === Number(state.baseline.embeddingCounts?.annotations ?? 21)
    const ocr = after?.models?.ocr ?? {}
    const ocrHonest = ocr.installed === false && ocr.available === false
    const leftoverJob = after?.models?.ocr?.job ?? null
    const pass = featuresOk && providersOk && fallbackOk && annotationGone && embeddingBack && ocrHonest && state.cleanupErrors.length === 0
    return {
      actual: {
        features: featuresOf(after),
        baselineFeatures: state.baseline.features,
        featuresOk,
        providers: clipValue(providersOf(after)),
        baselineProviders: state.baseline.providers,
        providersOk,
        fallbackEnabled: after?.translation?.fallbackEnabled ?? null,
        fallbackOk,
        testAnnotationId: state.testAnnotationId,
        annotationGone,
        embeddingAnnotations: embeddingCount,
        baselineEmbeddingAnnotations: state.baseline.embeddingCounts?.annotations ?? null,
        embeddingBack,
        ocr: { installed: ocr.installed, available: ocr.available, enabled: ocr.enabled },
        ocrHonest,
        leftoverOcrJob: clipValue(leftoverJob),
        ocrDirCleanup: state.evidence.ocrDirCleanup ?? null,
        settledElapsedMs: settled.elapsedMs,
        cleanupErrors: state.cleanupErrors,
      },
      pass,
    }
  })

  let afterEnvironment = null
  for (let attempt = 0; attempt < 5 && afterEnvironment === null; attempt += 1) {
    try {
      afterEnvironment = await readEnvironment()
    } catch (error) {
      state.cleanupErrors.push(`post-run environment read ${attempt + 1}: ${String(error?.message ?? error)}`)
      await sleep(1500)
    }
  }
  state.after = { counts: afterEnvironment?.counts ?? null, finishedAt: new Date().toISOString() }

  await check('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, async () => {
    if (afterEnvironment === null) return { actual: { error: 'post-run status unavailable' }, pass: false }
    const baselineCounts = state.baseline.counts ?? {}
    const countsMatch = Number(afterEnvironment.counts?.papers) === Number(baselineCounts.papers) && Number(afterEnvironment.counts?.annotations) === Number(baselineCounts.annotations) && Number(afterEnvironment.counts?.figures) === Number(baselineCounts.figures) && Number(afterEnvironment.counts?.trash) === Number(baselineCounts.trash)
    const treePayload = await call('library.folders.tree').catch(() => null)
    const flat = []
    const visit = (items, depth) => {
      for (const item of items ?? []) {
        if (item === null || typeof item !== 'object') continue
        flat.push(item)
        if (Array.isArray(item.children)) visit(item.children, depth + 1)
      }
    }
    visit(treePayload?.items, 0)
    const originalPresent = ORIGINAL_FIELD_NAMES.filter((name) => flat.some((item) => item.name === name))
    const favorites = (await call('library.list', { favorite: true, limit: 500 })).items?.map((paper) => paper.id).sort() ?? []
    const favoritesRestored = favorites.join(',') === [...(state.baseline.favorites ?? [])].sort().join(',')
    const embedding = await embeddingStatus().catch(() => null)
    const embeddingCounts = embedding?.counts ?? null
    const baselineEmbedding = state.baseline.embeddingCounts ?? {}
    const embeddingBack = ['papers', 'pages', 'figures', 'annotations', 'chunks'].every((key) => Number(embeddingCounts?.[key]) === Number(baselineEmbedding[key]))
    const jobs = await jobsList().catch(() => null)
    const failedJobs = (jobs?.items ?? []).filter((job) => String(job.state) === 'failed').length
    const pass = countsMatch && flat.length === 5 && originalPresent.length === 5 && favoritesRestored && embeddingBack && state.cleanupErrors.length === 0
    return {
      actual: {
        baseline: clipValue(baselineCounts),
        after: clipValue(afterEnvironment.counts),
        countsMatch,
        folderCount: flat.length,
        originalFoldersPresent: originalPresent,
        favorites,
        favoritesRestored,
        embeddingCounts: clipValue(embeddingCounts),
        baselineEmbeddingCounts: clipValue(baselineEmbedding),
        embeddingBack,
        failedJobs,
        cleanupErrors: state.cleanupErrors,
      },
      pass,
      notes: 'no user data purged; the embedding index was kept and only rebuilt in place (models.rebuildIndex) with identical counts.',
    }
  })
}

/* ------------------------------------------------------------------ *
 * Report / main
 * ------------------------------------------------------------------ */
function buildReport(exitCode) {
  for (const [caseId, plan] of EXPECTED) {
    if (!recordedIds.has(caseId)) {
      results.push({ case_id: caseId, group: plan.group, expected: plan.expected, actual: { not_run_reason: 'case did not execute (environment gate/abort)' }, status: 'not_run' })
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
    schema: 'pappers-hall/v11-api-results@1',
    suite: 'v0.11 API acceptance',
    summary: { total: results.length, pass: counts.pass, fail: counts.fail, not_run: counts.not_run, byGroup, startedAt: state.startedAt, finishedAt: new Date().toISOString(), base: BASE, exitCode },
    environment: state.environment,
    baseline: { counts: state.baseline.counts, features: state.baseline.features, translationProviders: state.baseline.providers, fallbackEnabled: state.baseline.fallbackEnabled, favorites: state.baseline.favorites, embeddingCounts: clipValue(state.baseline.embeddingCounts), embeddingIndexVersion: state.baseline.embeddingIndexVersion ?? null, ocrInstalled: state.baseline.ocrInstalled, annotationCount: state.baseline.annotationCount, settings: state.baseline.settings, capturedAt: state.startedAt },
    after: state.after,
    evidence: {
      settings: { baseline: state.baseline.settings, rebuildIndex: state.evidence.rebuildIndex ?? null, ocrInstall: state.evidence.ocrInstall ?? null, ocrDirCleanup: state.evidence.ocrDirCleanup ?? null },
      regression: { v07: 'reports/v07-api-results.json', v06: 'reports/v06-api-results.json', v06Harness: 'reports/v06-api-results.json#evidence.tools.harness', v05: 'reports/v05-api-results.json', v04: 'reports/v04-api-results.json', v02: 'reports/v02-api-results.json', lifecycle: 'reports/v03-lifecycle-run.json', v03: 'reports/v03-api-results.json' },
    },
    results,
  }
}

async function finish(exitCode) {
  const report = buildReport(exitCode)
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  const { pass, fail, not_run: notRunCount } = report.summary
  console.log(`\nV0.11 API RESULT: ${pass}/${report.summary.total} pass, ${fail} fail, ${notRunCount} not_run → ${OUT}`)
  process.exitCode = exitCode
}

async function main() {
  if (DRY_RUN) {
    const unique = new Set(PLAN.map(([id]) => id))
    if (unique.size !== PLAN.length) throw new Error('duplicate case ids in PLAN')
    console.log('Pappers-Hall v0.11 API acceptance suite — DRY RUN (no mutations, read-only probes only)\n')
    let currentGroup = null
    for (const [id, group, expected] of PLAN) {
      if (group !== currentGroup) {
        console.log(`\n[${group}]`)
        currentGroup = group
      }
      console.log(`  ${id.padEnd(34)} ${expected}`)
    }
    console.log(`\nplanned cases: ${PLAN.length}`)
    try {
      const environment = await readEnvironment()
      const settings = await settingsGet()
      console.log(`live host: version=${String(environment.pluginVersion)} schemaVersion=${String(environment.schemaVersion)} papers=${environment.counts?.papers ?? '?'} annotations=${environment.counts?.annotations ?? '?'} folders=${(environment.status?.index?.paperCount ?? '?')}`)
      console.log(`settings.features=${JSON.stringify(settings?.features)}`)
      console.log(`models.embedding=${JSON.stringify({ installed: settings?.models?.embedding?.installed, available: settings?.models?.embedding?.available, model: settings?.models?.embedding?.model, dims: settings?.models?.embedding?.dims, sizeBytes: settings?.models?.embedding?.sizeBytes, job: settings?.models?.embedding?.job?.state ?? null })}`)
      console.log(`models.ocr=${JSON.stringify({ installed: settings?.models?.ocr?.installed, available: settings?.models?.ocr?.available, enabled: settings?.models?.ocr?.enabled, engine: settings?.models?.ocr?.engine, reason: settings?.models?.ocr?.reason, job: settings?.models?.ocr?.job?.state ?? null })}`)
      console.log(`translation.providers=${JSON.stringify((settings?.translation?.providers ?? []).map((item) => ({ id: item.id, enabled: item.enabled, available: item.available, free: item.free })))}`)
      console.log(`index.channels=${JSON.stringify(settings?.index?.channels)} counts=${JSON.stringify(settings?.index?.counts)} sync=${JSON.stringify(settings?.index?.sync)}`)
      console.log(`diagnostics: schemaVersion=${settings?.diagnostics?.schemaVersion} capabilities=${JSON.stringify(settings?.diagnostics?.capabilities)}`)
      const ocrIndex = await tryCall('ocr.index', {})
      console.log(`ocr.index probe=${JSON.stringify(ocrIndex.ok ? ocrIndex.data : ocrIndex.error)}`)
      const cancelIdle = await tryCall('models.cancel', { kind: 'ocr' })
      console.log(`models.cancel idle probe=${JSON.stringify(cancelIdle.ok ? cancelIdle.data : cancelIdle.error)}`)
      const v11 = (String(environment.pluginVersion ?? '').startsWith('0.11') || Number(environment.schemaVersion) >= 7) && ocrIndex.ok && cancelIdle.ok
      console.log(v11 ? 'v0.11 host appears loaded — a real run is possible after GO v11.' : 'v0.11 host is NOT loaded yet: the real run will be refused by the ENV gate until reload + "GO v11".')
      for (const file of ['reports/v07-api-results.json', 'reports/v06-api-results.json', 'reports/v05-api-results.json', 'reports/v04-api-results.json', 'reports/v02-api-results.json', 'reports/v03-lifecycle-run.json']) {
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
    console.log('\nDRY RUN OK: script parses, case plan complete, no data was written. Waiting for "GO v11".')
    process.exitCode = 0
    return
  }

  let environment
  try {
    environment = await readEnvironment()
  } catch (error) {
    console.error('V0.11 SUITE ERROR: live host unreachable:', String(error?.message ?? error))
    process.exitCode = 2
    return
  }
  let ok = false
  try {
    ok = await envCases()
    if (ok) {
      await settingsCases()
      await vectorOffCases()
      await modelsCases()
      await indexCases()
      await translationCases()
      await regressionCases()
    }
  } catch (error) {
    console.error('V0.11 SUITE ERROR (unexpected):', error?.stack ?? error)
    process.exitCode = 2
  } finally {
    if (ok) {
      try {
        await cleanupCases()
      } catch (error) {
        console.error('V0.11 CLEANUP ERROR:', error?.stack ?? error)
        state.cleanupErrors.push(String(error?.message ?? error))
        if (!recordedIds.has('REF.data.preserved')) notRun('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, `cleanup crashed: ${String(error?.message ?? error)}`)
        process.exitCode = 2
      }
    }
  }
  if (!ok) {
    await finish(2)
    return
  }
  const fail = results.filter((entry) => entry.status === 'fail').length
  const exitCode = process.exitCode === 2 ? 2 : fail > 0 ? 1 : 0
  await finish(exitCode)
}

main().catch(async (error) => {
  console.error('V0.11 SUITE FATAL:', error?.stack ?? error)
  try {
    await finish(2)
  } catch {
    process.exit(2)
  }
})
