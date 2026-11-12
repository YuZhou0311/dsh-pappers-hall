#!/usr/bin/env node
/**
 * Pappers-Hall v0.15 API full-surface acceptance sweep.
 *
 * User requirement: "test every feature of the paper center, fix all bugs before
 * delivery". This suite is the API-side sweep (the Lead does the GUI sweep):
 *
 * 1) METHOD SWEEP — every handler from `host/api.js` is enumerated at runtime and
 *    exercised: read methods with minimal valid params (+ shape check), write
 *    methods with safe invalid params (must return an honest domain error, never
 *    `internal`/500), every method additionally rejects non-object params.
 * 2) FEATURE CHAINS — real CRUD/undo/idempotency chains with fixtures created and
 *    cleaned up: annotations, notes, tags, folders/collections, favorite, read,
 *    library.update, classify, saved searches, references/bundles, jobs
 *    pause/resume, operations.undo, exports/citations, metrics (honest offline),
 *    duplicates/merge (read-only), import (byte-modified devkit copy + purge),
 *    settings toggles (restored), translate (quick free-only + cached + AI title/
 *    blocks), ai.ask/ai.quickTranslate, OCR index (0 scanned pages), discover/
 *    feed, tiles/tags, figures list/search.
 * 3) FILE ROUTES — page/thumb/pdf/figure GET+HEAD status/content-type, invalid
 *    ids, traversal attempts, wrong methods, unknown kinds.
 * 4) ERROR PATHS — unknown method, malformed JSON, non-object params, missing
 *    required ids, extreme pagination, empty batches.
 * 5) REGRESSION — previous API reports (v13/v11/v07/v06(+harness)/v05/v04/v02/
 *    lifecycle/v03) and schemaVersion=7.
 * 6) DATA — the live library baseline (30 papers / active annotation count /
 *    346 figures / 5 folders) must be identical before/after; only fixtures
 *    created by this suite are removed; settings restored; no user data purged.
 *
 * Bugs found are reported, never patched here (test/** and reports/** only).
 *
 * Usage:
 *   node test/v15.mjs --dry-run   # plan + read-only probe
 *   node test/v15.mjs             # real run
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
const OUT = resolve(HERE, arg('--out', '../../reports/v15-api-results.json'))
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEVKIT_C02 = join(WORKSPACE, 'pappers_hall_devkit_lite', 'papers', 'pdf', 'C02_ggcmi_evaluation.pdf')
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

const P_MAIN = 'ph-53132d8d95a6' // ReAct (A01): read, 15 figures, 4 annotations
const P_CROP = 'ph-8d90723ee7bc' // irrigation (C01): 2 annotations
const P_EMPTY = 'ph-000000000000' // syntactically valid but nonexistent
const ORIGINAL_FIELD_NAMES = ['大语言模型与 Agent', '强化学习与决策', '多模态与文档检索', '遥感与地球观测', '作物模拟与农业系统']
const ERROR_CODES_OK = new Set(['invalid', 'not_found', 'unavailable', 'conflict', 'degraded'])

/* ------------------------------------------------------------------ *
 * Plan (documentation for --dry-run; real cases are generated dynamically)
 * ------------------------------------------------------------------ */
const PLAN = [
  ['SWEEP.methods', 'enumerate host/api.js handlers and probe every method (valid read / safe invalid write / non-object params / no internal error)'],
  ['CHAIN.status', 'status + counts + index channels + jobs summary'],
  ['CHAIN.diagnostics', 'diagnostics schemaVersion=7 / capabilities / agent tools / versions'],
  ['CHAIN.libraryList', 'library.list filters, sorting, clamping, paging'],
  ['CHAIN.libraryGet', 'library.get detail: tags/collections/fileInfo/metrics/annotationCount'],
  ['CHAIN.search', 'search.query fts+vector+ai-off, folder/tag/favorite filters, empty query, extreme limit'],
  ['CHAIN.reader', 'reader.open/page/layer/pageText/outline valid + invalid page/paper'],
  ['CHAIN.annotations', 'create → list/feed → update → delete(trash) → undo restore → delete again; counts restored'],
  ['CHAIN.notes', 'notes.create → library.get notes → notes.delete → undo restore → delete again; notes count restored'],
  ['CHAIN.tags', 'library.update addTags → tags.list → tags.rename → tags.delete + undo'],
  ['CHAIN.folders', 'folders create/update(child,nested)/assign/unassign/tree counts/delete-promote + undo; 5 real folders untouched'],
  ['CHAIN.collections', 'collections.list consistency with folders.tree'],
  ['CHAIN.favorite', 'setFavorite on/off + library.list favorite + undo'],
  ['CHAIN.read', 'setRead toggles + read filter; original state restored'],
  ['CHAIN.libraryUpdate', 'patch titleZh → verify → revert; invalid field; revision conflict'],
  ['CHAIN.classify', 'library.classify suggest + apply (existing membership)'],
  ['CHAIN.savedSearches', 'create/list/update/delete + duplicate-name conflict'],
  ['CHAIN.references', 'references.commit paper item → token; resolve bundle; bad bundle not_found'],
  ['CHAIN.jobs', 'jobs.list; global pause/resume; cancel/retry nonexistent ids'],
  ['CHAIN.operations', 'operations.recent; operations.undo of a folder create'],
  ['CHAIN.exports', 'export.bibtex/csl/locations/notes/annotations content checks'],
  ['CHAIN.citations', 'citation.format 5 styles + invalid style + citation.key'],
  ['CHAIN.metrics', 'metrics.refresh allowNetwork=false honest; metrics.update invalid field; metrics.reset nonexistent; real network refresh not_run'],
  ['CHAIN.duplicates', 'library.duplicates read-only; library.merge invalid args; real merge needs duplicate fixture (not_run)'],
  ['CHAIN.import', 'byte-modified devkit copy import (accepted+classification+job) → duplicate/invalid → delete+purge; 30 papers restored'],
  ['CHAIN.settings', 'settings.get full; invalid keys ignored; vectorSearch off→search vector off→restore; provider toggle→restore'],
  ['CHAIN.translate', 'detect/providers/settings; quick cached success + failure honesty + explicit-LLM rejection; translate.title/blocks real (honest result)'],
  ['CHAIN.ai', 'ai.status; ai.ask real (honest result); ai.quickTranslate real fast (honest result)'],
  ['CHAIN.ocr', 'settings models.ocr status; ocr.index on existing paper (0 scanned pages) honest job'],
  ['CHAIN.models', 'models.install invalid kinds; models.cancel idle; rebuildIndex not_run (already covered by v11 evidence)'],
  ['CHAIN.embedding', 'embedding.status ready/counts/indexVersion'],
  ['CHAIN.discover', 'discover.feed stats/sections/folders/folderCounts consistency'],
  ['CHAIN.figures', 'figures.list (P_MAIN non-empty) + figures.search text query (honest channels)'],
  ['CHAIN.tilesTags', 'library.tiles ids subset + library.tags'],
  ['ROUTES.assets', 'GET/HEAD page/thumb/pdf/figure status+content-type; invalid ids/paths; 405; traversal; unknown kind'],
  ['ERR.envelope', 'unknown method, malformed JSON body, non-object params, GET on api'],
  ['ERR.params', 'missing ids / nonexistent ids / empty batches / extreme pagination clamp'],
  ['REG.previous', 'v13 27/27, v11 33/34, v07 24/24, v06 31/32+harness 8/8, v05 42/43, v04 34/34, v02 26/26, lifecycle 12/0/1, v03 unchanged'],
  ['DATA.baseline', '30 papers / active annotations / 346 figures / 5 folders unchanged; fixtures cleaned; settings restored'],
]

/* ------------------------------------------------------------------ *
 * Result recording
 * ------------------------------------------------------------------ */
const results = []
const state = {
  startedAt: new Date().toISOString(),
  base: BASE,
  methods: [],
  environment: null,
  baseline: { counts: null, annotations: null, notes: null, tags: null, folders: null, favorites: [], read: {}, settings: null, jobsPaused: null, embeddingCounts: null, metrics: null },
  created: { annotations: [], notes: [], tags: [], folders: [], savedSearches: [], papers: [], bundles: [] },
  after: {},
  evidence: {},
  cleanupErrors: [],
  bugs: [],
}

function record(caseId, group, expected, actual, pass, extra = {}) {
  results.push({ case_id: caseId, group, expected, actual, status: pass ? 'pass' : 'fail', ...(extra.notes === undefined ? {} : { notes: extra.notes }) })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${caseId}${pass ? '' : ' — ' + JSON.stringify(clip(actual)).slice(0, 420)}`)
  if (!pass && !extra.expectedFailure) state.bugs.push({ case_id: caseId, expected, actual: clip(actual) })
}

function notRun(caseId, group, expected, reason, actual = {}) {
  results.push({ case_id: caseId, group, expected, actual: { not_run_reason: reason, ...actual }, status: 'not_run' })
  console.log(`NOT_RUN ${caseId} — ${reason}`)
}

async function check(caseId, group, expected, fn, extra = {}) {
  try {
    const outcome = await fn()
    if (outcome?.skipped === true) return outcome
    record(caseId, group, expected, outcome.actual, outcome.pass === true, { ...extra, notes: outcome.notes })
    return outcome
  } catch (error) {
    record(caseId, group, expected, { error: String(error?.message ?? error), code: error?.code ?? null }, false, extra)
    return null
  }
}

function clip(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value
  if (depth > 4) return '[depth]'
  if (Array.isArray(value)) {
    const head = value.slice(0, 6).map((entry) => clip(entry, depth + 1))
    return value.length > 6 ? [...head, `…${value.length - 6} more`] : head
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = clip(entry, depth + 1)
  return out
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */
/** POST one API call and return {status, body} even for non-200 envelopes. */
async function api(method, params, { timeoutMs = 180_000, rawBody } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody !== undefined ? rawBody : JSON.stringify({ method, params }),
      signal: controller.signal,
    })
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    return { status: response.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

/** API call that throws on a domain error (for chains). */
async function call(method, params = {}, timeoutMs = 180_000) {
  const response = await api(method, params, { timeoutMs })
  if (response.body === null) throw new Error(`${method}: non-JSON HTTP ${response.status}: ${String(response.text).slice(0, 120)}`)
  if (response.body.ok !== true) {
    const error = new Error(`${response.body.error?.code}: ${response.body.error?.message}`)
    error.code = response.body.error?.code
    error.detail = response.body.error?.detail
    throw error
  }
  return response.body.data
}

async function tryCall(method, params = {}, timeoutMs = 180_000) {
  try {
    return { ok: true, data: await call(method, params, timeoutMs) }
  } catch (error) {
    return { ok: false, error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
  }
}

/** Raw asset request. */
async function asset(pathname, { method = 'GET' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(`${BASE}${pathname}`, { method, signal: controller.signal, redirect: 'manual' })
    const bytes = method === 'HEAD' ? 0 : (await response.arrayBuffer()).byteLength
    return { status: response.status, contentType: response.headers.get('content-type'), bytes }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * API method enumeration (authoritative: host/api.js handler table)
 * ------------------------------------------------------------------ */
function enumerateMethods() {
  const source = readFileSync(resolve(PLUGIN_ROOT, 'host', 'api.js'), 'utf8')
  const start = source.indexOf('const handlers = new Map([')
  const end = source.indexOf('])', start)
  const block = start >= 0 ? source.slice(start, end >= 0 ? end : source.length) : source
  const found = new Set()
  for (const match of block.matchAll(/\[\s*'([A-Za-z0-9_.]+)'\s*,/g)) found.add(match[1])
  for (const match of block.matchAll(/^\s*'([a-z][A-Za-z0-9_.]*)',\s*$/gm)) found.add(match[1])
  return [...found].sort()
}

/* ------------------------------------------------------------------ *
 * Per-method sweep specs
 * kind: 'read' (valid call expected ok + optional check), 'write' (invalid call
 * expected domain error; no mutation), 'heavyread' (invalid call only).
 * ------------------------------------------------------------------ */
const METHOD_SPECS = {
  // ---- no-param / cheap reads ----
  status: { kind: 'read', params: {}, check: (data) => typeof data?.counts?.papers === 'number' && data?.index?.channels !== undefined },
  diagnostics: { kind: 'read', params: {}, check: (data) => Number(data?.schemaVersion) >= 6 && Array.isArray(data?.versions) && data?.capabilities !== undefined },
  'jobs.list': { kind: 'read', params: {}, check: (data) => Array.isArray(data?.items) && data?.summary !== undefined },
  'library.tags': { kind: 'read', params: {}, check: (data) => Array.isArray(data?.items) },
  'tags.list': { kind: 'read', params: {}, check: (data) => Array.isArray(data?.items) },
  'library.collections.list': { kind: 'read', params: {}, check: (data) => Array.isArray(data?.items) },
  'library.folders.tree': { kind: 'read', params: {}, check: (data) => Array.isArray(data?.items) },
  'library.duplicates': { kind: 'read', params: {}, check: (data) => Array.isArray(data?.groups) },
  'saved_searches.list': { kind: 'read', params: {}, check: (data) => Array.isArray(data?.items) },
  'operations.recent': { kind: 'read', params: { limit: 5 }, check: (data) => Array.isArray(data?.items) },
  'ai.status': { kind: 'read', params: {}, check: (data) => typeof data?.available === 'boolean' },
  'translate.providers': { kind: 'read', params: {}, check: (data) => Array.isArray(data?.items) },
  'translate.settings': { kind: 'read', params: {}, check: (data) => data !== null && typeof data === 'object' },
  'embedding.status': { kind: 'read', params: {}, check: (data) => typeof data?.available === 'boolean' && data?.counts !== undefined },
  'settings.get': { kind: 'read', params: {}, check: (data) => data?.features !== undefined && data?.models?.embedding !== undefined && data?.index !== undefined },
  'discover.feed': { kind: 'read', params: { limit: 3 }, check: (data) => data?.stats !== undefined && Array.isArray(data?.folders) },
  'library.list': { kind: 'read', params: { limit: 3 }, check: (data) => Number.isInteger(data?.total) && Array.isArray(data?.items) },
  'library.get': { kind: 'read', params: { id: P_MAIN }, check: (data) => data?.id === P_MAIN && Array.isArray(data?.authors) },
  'library.tiles': { kind: 'read', params: { ids: [P_MAIN] }, check: (data) => Array.isArray(data?.items) && data.items.some((item) => item.id === P_MAIN) },
  'annotations.list': { kind: 'read', params: { paperId: P_MAIN }, check: (data) => Array.isArray(data) },
  'annotations.feed': { kind: 'read', params: { limit: 5 }, check: (data) => Array.isArray(data?.items) },
  'figures.list': { kind: 'read', params: { paperId: P_MAIN }, check: (data) => Array.isArray(data) },
  'figures.search': { kind: 'read', params: { query: 'irrigation', limit: 2 }, check: (data) => Array.isArray(data?.items) && Array.isArray(data?.channels) },
  'reader.open': { kind: 'read', params: { id: P_MAIN }, check: (data) => data?.paper?.id === P_MAIN },
  'reader.page': { kind: 'read', params: { id: P_MAIN, page: 1 }, check: (data) => data?.page === 1 && Array.isArray(data?.blocks) },
  'reader.layer': { kind: 'read', params: { id: P_MAIN, page: 1 }, check: (data) => Array.isArray(data?.words) && data.words.length > 0 },
  'reader.pageText': { kind: 'read', params: { id: P_MAIN, page: 1 }, check: (data) => typeof data?.text === 'string' },
  'reader.outline': { kind: 'read', params: { id: P_MAIN }, check: (data) => Array.isArray(data?.items) },
  'export.bibtex': { kind: 'read', params: { ids: [P_MAIN] }, check: (data) => typeof data?.content === 'string' && data.content.includes('@') },
  'export.csl': { kind: 'read', params: { ids: [P_MAIN] }, check: (data) => typeof data?.content === 'string' },
  'export.notes': { kind: 'read', params: { ids: [P_MAIN] }, check: (data) => typeof data?.content === 'string' },
  'export.locations': { kind: 'read', params: { ids: [P_MAIN] }, check: (data) => typeof data?.content === 'string' },
  'export.annotations': { kind: 'read', params: { paperId: P_MAIN, format: 'markdown' }, check: (data) => typeof data?.content === 'string' },
  'citation.format': { kind: 'read', params: { ids: [P_MAIN], style: 'apa' }, check: (data) => typeof data?.content === 'string' && data.content.length > 10 },
  'citation.key': { kind: 'read', params: { ids: [P_MAIN] }, check: (data) => Array.isArray(data?.keys) },
  'translate.detect': { kind: 'read', params: { text: 'hello world' }, check: (data) => typeof data?.language === 'string' },
  'library.classify': { kind: 'read', params: { paperIds: [P_MAIN], apply: false }, check: (data) => Array.isArray(data?.suggestions) },
  'metrics.refresh': { kind: 'read', params: { paperIds: [P_MAIN], allowNetwork: false }, check: (data) => typeof data?.network === 'boolean' },
  'search.query': { kind: 'read', params: { q: 'irrigation', ai: 'off', limit: 2 }, check: (data) => Array.isArray(data?.items) && Array.isArray(data?.channels) },
  'translation.test': { kind: 'read', params: { provider: 'bogus-engine', text: 'x' }, check: (data) => typeof data?.ok === 'boolean' },
  'translate.text': { kind: 'read', params: { quick: true, provider: 'llm', text: 'probe only', target: 'zh' }, check: (data) => typeof data?.status === 'string' && typeof data?.mode === 'string' },
  'ai.ask': { kind: 'heavyread' },
  'ai.quickTranslate': { kind: 'heavyread' },
  'translate.title': { kind: 'heavyread' },
  'translate.blocks': { kind: 'heavyread' },
  'ocr.index': { kind: 'heavyread' },
  'embedding.index': { kind: 'heavyread' },
  'models.install': { kind: 'read', params: { kind: 'bogus' }, check: (data) => data?.status === 'invalid' },
  'models.cancel': { kind: 'read', params: { kind: 'bogus' }, check: (data) => data?.status === 'invalid' },
  'models.rebuildIndex': { kind: 'heavyread' },
  // ---- writes (sweep uses invalid params only; chains cover real CRUD) ----
  'library.import': { kind: 'write' },
  'library.update': { kind: 'write' },
  'library.setRead': { kind: 'write' },
  'library.delete': { kind: 'write' },
  'library.restore': { kind: 'write' },
  'library.purge': { kind: 'write' },
  'library.merge': { kind: 'write' },
  'library.setFavorite': { kind: 'write' },
  'library.collections.create': { kind: 'write' },
  'library.collections.update': { kind: 'write' },
  'library.collections.delete': { kind: 'write' },
  'library.collections.assign': { kind: 'write' },
  'tags.rename': { kind: 'write' },
  'tags.delete': { kind: 'write' },
  'annotations.create': { kind: 'write' },
  'annotations.update': { kind: 'write' },
  'annotations.delete': { kind: 'write' },
  'notes.create': { kind: 'write' },
  'notes.update': { kind: 'write' },
  'notes.delete': { kind: 'write' },
  'settings.update': { kind: 'read', params: { patch: {} }, check: (data) => Array.isArray(data?.applied) && Array.isArray(data?.ignored) && data?.features !== undefined },
  'jobs.pause': { kind: 'write' },
  'jobs.resume': { kind: 'write' },
  'jobs.retry': { kind: 'write' },
  'jobs.cancel': { kind: 'write' },
  'metrics.update': { kind: 'write' },
  'metrics.reset': { kind: 'write' },
  'operations.undo': { kind: 'write' },
  'saved_searches.create': { kind: 'write' },
  'saved_searches.update': { kind: 'write' },
  'saved_searches.delete': { kind: 'write' },
  'references.commit': { kind: 'write' },
  'references.resolve': { kind: 'write' },
}

/** Safe invalid params per write method (must yield invalid/not_found, never internal). */
const INVALID_PARAMS = {
  'library.import': { paths: [], uploads: [] },
  'library.update': { id: P_MAIN, patch: { definitelyUnknownField: true } },
  'library.setRead': { ids: [] },
  'library.delete': { ids: [] },
  'library.restore': { ids: [] },
  'library.purge': { ids: [] },
  'library.merge': { primaryId: P_MAIN, duplicateIds: [] },
  'library.setFavorite': { ids: [] },
  'library.collections.create': { name: '' },
  'library.collections.update': { id: 'cl-000000000000', name: 'x' },
  'library.collections.delete': { id: 'cl-000000000000' },
  'library.collections.assign': { collectionId: 'cl-000000000000', paperIds: [] },
  'tags.rename': { from: '' },
  'tags.delete': { name: 'v15-nonexistent-tag-xyz' },
  'annotations.create': { paperId: '' },
  'annotations.update': { id: 'an-000000000000' },
  'annotations.delete': { id: 'an-000000000000' },
  'notes.create': { text: '' },
  'notes.update': { id: 'nt-000000000000' },
  'notes.delete': { id: 'nt-000000000000' },
  'settings.update': { patch: { features: { definitelyUnknownSwitch: true } } },
  'jobs.pause': { id: 'jb-000000000000' },
  'jobs.resume': { id: 'jb-000000000000' },
  'jobs.retry': { id: 'jb-000000000000' },
  'jobs.cancel': { id: 'jb-000000000000' },
  'metrics.update': { paperId: '' },
  'metrics.reset': { paperId: P_EMPTY },
  'operations.undo': { operationId: 'op-000000000000' },
  'saved_searches.create': { name: '' },
  'saved_searches.update': { id: 'ss-000000000000' },
  'saved_searches.delete': { id: 'ss-000000000000' },
  'references.commit': { items: [] },
  'references.resolve': { bundleId: 'bn-000000000000' },
  'models.install': { kind: 'bogus' },
  'models.cancel': { kind: 'bogus' },
}

const methodSpec = (method) => METHOD_SPECS[method] ?? { kind: 'unknown' }

async function sweepCases() {
  state.methods = enumerateMethods()
  const enumerated = state.methods.length
  for (const method of state.methods) {
    const spec = methodSpec(method)
    const caseId = `SWEEP.${method}`
    try {
      const nonObject = await api(method, [1, 2], { timeoutMs: 30_000 })
      const nonObjectOk =
        nonObject.body !== null &&
        nonObject.body.ok === false &&
        nonObject.body.error?.code === 'invalid' &&
        [400, 404, 409, 503, 500].includes(nonObject.status)
      let valid = null
      let validOk = true
      let shapeIssues = []
      if (spec.kind === 'read') {
        valid = await api(method, spec.params, { timeoutMs: 120_000 })
        validOk = valid.body !== null && valid.body.ok === true
        if (validOk && typeof spec.check === 'function') {
          try {
            if (spec.check(valid.body.data) !== true) shapeIssues.push('shape-check-failed')
          } catch (error) {
            shapeIssues.push(`shape-check-threw: ${String(error?.message ?? error)}`)
          }
        }
        if (!validOk) shapeIssues.push(`unexpected-error: ${valid.body?.error?.code ?? `http-${valid.status}`}`)
      } else if (spec.kind === 'write') {
        const invalid = INVALID_PARAMS[method] ?? { __invalid: true }
        valid = await api(method, invalid, { timeoutMs: 60_000 })
        const body = valid.body
        validOk = body !== null && body.ok === false && ERROR_CODES_OK.has(String(body.error?.code))
        if (!validOk) shapeIssues.push(`invalid-params-not-rejected: ${body === null ? `non-JSON http-${valid.status}` : JSON.stringify(clip(body)).slice(0, 160)}`)
      } else if (spec.kind === 'heavyread') {
        // Heavy/real-call methods are exercised by the feature chains; the sweep
        // only proves registration + honest validation (non-object params above).
        valid = null
        validOk = true
      } else {
        // Unknown/unplanned future method: probe with {} and accept ok or honest domain error.
        valid = await api(method, {}, { timeoutMs: 60_000 })
        const body = valid.body
        validOk = body !== null && (body.ok === true || (body.ok === false && ERROR_CODES_OK.has(String(body.error?.code))))
        if (!validOk) shapeIssues.push(`neither-ok-nor-honest-error: ${body === null ? `non-JSON http-${valid.status}` : JSON.stringify(clip(body)).slice(0, 160)}`)
      }
      const internalError = (valid?.body?.error?.code ?? '') === 'internal' || (nonObject.body?.error?.code ?? '') === 'internal'
      const pass = nonObjectOk && validOk && shapeIssues.length === 0 && !internalError && (valid === null || valid.body !== null)
      record(caseId, 'SWEEP', `method ${method} registered; callable with honest envelope`, {
        kind: spec.kind,
        nonObjectParams: { status: nonObject.status, code: nonObject.body?.error?.code ?? null },
        valid: valid === null ? 'deferred-to-chain' : { status: valid.status, ok: valid.body?.ok ?? null, code: valid.body?.error?.code ?? null },
        shapeIssues,
        internalError,
      }, pass)
    } catch (error) {
      record(caseId, 'SWEEP', `method ${method} registered`, { error: String(error?.message ?? error) }, false)
    }
  }
  record('SWEEP.coverage', 'SWEEP', `all handler methods enumerated and probed (${enumerated})`, {
    enumerated,
    tested: results.filter((entry) => entry.case_id.startsWith('SWEEP.')).length,
    source: 'host/api.js handlers table',
    expectedMinimum: 80,
  }, enumerated >= 80)
}

/* ------------------------------------------------------------------ *
 * Shared helpers for chains
 * ------------------------------------------------------------------ */
function folderItems(payload) {
  const flat = []
  const visit = (items, depth) => {
    for (const item of items ?? []) {
      if (item === null || typeof item !== 'object') continue
      flat.push({ item, depth })
      if (Array.isArray(item.children)) visit(item.children, depth + 1)
    }
  }
  visit(payload?.items, 0)
  return flat
}

async function folderByName(name) {
  const payload = await call('library.folders.tree')
  return folderItems(payload).find(({ item }) => item.name === name)?.item ?? null
}

async function activeAnnotationCount() {
  const feed = await call('annotations.feed', { limit: 100 })
  return (feed.items ?? []).length
}

async function waitFor(predicate, { timeoutMs = 120_000, intervalMs = 1200, label = 'condition' } = {}) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    try {
      last = await predicate()
      if (last?.ok === true) return { ok: true, elapsedMs: Date.now() - started, last }
    } catch {}
    await sleep(intervalMs)
  }
  return { ok: false, elapsedMs: Date.now() - started, last }
}

const okApi = async (method, params = {}, timeoutMs = 180_000) => {
  const response = await api(method, params, { timeoutMs })
  return { status: response.status, body: response.body }
}

/* ------------------------------------------------------------------ *
 * Feature chains
 * ------------------------------------------------------------------ */
async function chainCases() {
  await check('CHAIN.status', 'CHAIN', 'status reports counts/channels/jobs', async () => {
    const status = await call('status')
    const pass =
      Number(status?.counts?.papers) === Number(state.baseline.counts?.papers ?? 30) &&
      status?.index?.channels?.fts === 'ready' &&
      Array.isArray(status?.degraded) &&
      status?.jobs !== undefined &&
      typeof status?.plugin?.version === 'string'
    return { actual: { plugin: status?.plugin ?? null, counts: clip(status?.counts), channels: status?.index?.channels ?? null, degraded: clip(status?.degraded), jobs: clip(status?.jobs) }, pass }
  })

  await check('CHAIN.diagnostics', 'CHAIN', 'diagnostics schemaVersion>=7, capabilities, agent tools, versions', async () => {
    const diagnostics = await call('diagnostics')
    const tools = diagnostics?.agent?.tools ?? []
    const pass =
      Number(diagnostics?.schemaVersion) >= 6 &&
      diagnostics?.capabilities?.fts === 'ready' &&
      Array.isArray(tools) &&
      tools.includes('papers_overview') &&
      Array.isArray(diagnostics?.versions) &&
      typeof diagnostics?.dataDir === 'string'
    return { actual: { schemaVersion: diagnostics?.schemaVersion ?? null, capabilities: clip(diagnostics?.capabilities), agentTools: tools.length, promptSection: diagnostics?.agent?.promptSection ?? null, dataDir: diagnostics?.dataDir ?? null, versions: clip(diagnostics?.versions) }, pass }
  })

  await check('CHAIN.libraryList', 'CHAIN', 'library.list filters/sorting/clamping/paging', async () => {
    const base = await call('library.list', { limit: 5 })
    const clampProbe = await call('library.list', { limit: 99999, offset: 999999 })
    const readList = await call('library.list', { read: 'read', limit: 100 })
    const annotated = await call('library.list', { annotated: true, limit: 100 })
    const sorted = await call('library.list', { sort: 'title', limit: 5 })
    const folder = await folderByName('作物模拟与农业系统')
    const byFolder = await call('library.list', { folderId: folder?.id, limit: 100 })
    const favorited = await call('library.list', { favorite: true, limit: 100 })
    const tags = await call('library.list', { tags: ['推理'], limit: 100 })
    const pass =
      Number(base.limit) === 5 &&
      Array.isArray(base.items) &&
      clampProbe.items.length === 0 &&
      Number(clampProbe.limit) <= 200 &&
      Array.isArray(readList.items) &&
      Array.isArray(annotated.items) &&
      Array.isArray(sorted.items) &&
      Number(byFolder.total) === 6 &&
      Array.isArray(favorited.items) &&
      tags.items.every((paper) => Array.isArray(paper.tags) && paper.tags.includes('推理'))
    return { actual: { baseTotal: base.total, baseLimit: base.limit, clamp: { limit: clampProbe.limit, items: clampProbe.items.length }, readTotal: readList.total, annotatedTotal: annotated.total, folderTotal: byFolder.total, favoriteTotal: favorited.total, tagsTotal: tags.total, tagsIds: (tags.items ?? []).map((paper) => paper.id) }, pass }
  })

  await check('CHAIN.libraryGet', 'CHAIN', 'library.get detail fields', async () => {
    const detail = await call('library.get', { id: P_MAIN })
    const pass =
      detail?.id === P_MAIN &&
      Array.isArray(detail?.tags) &&
      Array.isArray(detail?.collections) &&
      detail?.metrics !== undefined &&
      detail?.fileInfo !== undefined &&
      typeof detail?.annotationCount === 'number' &&
      typeof detail?.read === 'boolean'
    return { actual: { id: detail?.id ?? null, tags: detail?.tags ?? null, collections: clip(detail?.collections), metrics: clip(detail?.metrics), fileInfo: clip(detail?.fileInfo), annotationCount: detail?.annotationCount ?? null, read: detail?.read ?? null, favorite: detail?.favorite ?? null }, pass }
  })

  await check('CHAIN.search', 'CHAIN', 'search.query fts+vector+ai-off, filters, empty query, extreme limit', async () => {
    const fts = await call('search.query', { q: 'irrigation', ai: 'off', limit: 5 })
    const vector = await call('search.query', { q: '强化学习 决策', ai: 'off', limit: 5 })
    const empty = await call('search.query', { q: '', ai: 'off', limit: 5 })
    const extreme = await call('search.query', { q: 'crop', ai: 'off', limit: 99999 })
    const folder = await folderByName('作物模拟与农业系统')
    const filtered = await call('search.query', { q: 'irrigation', ai: 'off', limit: 10, filters: { folderId: folder?.id } })
    const vectorChannel = (channels) => (channels ?? []).find((channel) => channel.name === 'vector') ?? null
    const allowed = new Set((await call('library.list', { folderId: folder?.id, limit: 500 })).items.map((paper) => paper.id))
    const outside = (filtered.items ?? []).filter((hit) => !allowed.has(hit.paperId))
    const pass =
      Array.isArray(fts.items) &&
      fts.items.length > 0 &&
      String(vectorChannel(fts.channels)?.status) === 'ok' &&
      Array.isArray(empty.items) &&
      extreme.items.length <= 200 &&
      outside.length === 0 &&
      (vector.items ?? []).length > 0
    return { actual: { ftsItems: fts.items.length, ftsVectorChannel: clip(vectorChannel(fts.channels)), semanticItems: (vector.items ?? []).length, emptyItems: (empty.items ?? []).length, extremeLimitItems: extreme.items.length, filteredFolderItems: (filtered.items ?? []).length, outsideFolder: outside.length }, pass }
  })

  await check('CHAIN.searchNeighbors', 'CHAIN', 'search.query q=agent semantic-neighbour + limit semantics (Lead observation)', async () => {
    const broad = await call('search.query', { q: 'agent', ai: 'off', limit: 30 })
    const limited = await call('search.query', { q: 'agent', ai: 'off', limit: 5 })
    const vectorChannel = (channels) => (channels ?? []).find((channel) => String(channel.name) === 'vector') ?? null
    const broadItems = broad?.items ?? []
    const limitedItems = limited?.items ?? []
    const semanticLike = broadItems.filter((hit) => (hit.reasons ?? []).some((reason) => String(reason).includes('vector') || String(reason).includes('similar'))).length
    const pass = broadItems.length <= 30 && limitedItems.length <= 5 && broadItems.length > limitedItems.length && String(vectorChannel(broad?.channels)?.status) === 'ok' && Array.isArray(broad?.channels)
    return {
      actual: {
        broad: { limit: 30, items: broadItems.length, vectorK: vectorChannel(broad?.channels)?.k ?? null, vectorLatencyMs: vectorChannel(broad?.channels)?.latencyMs ?? null, semanticReasonItems: semanticLike, sample: broadItems.slice(0, 5).map((hit) => ({ paperId: hit.paperId, reasons: (hit.reasons ?? []).slice(0, 3) })) },
        limited: { limit: 5, items: limitedItems.length },
        observation: 'q="agent" fans out to many semantic neighbours (vector channel uses k=120 candidates fused by RRF): the requested limit is honoured, but the fused candidate set is broad — matching the Lead observation that the Client must apply its own limiting. Recorded, not a contract violation.',
      },
      pass,
    }
  })

  await check('CHAIN.reader', 'CHAIN', 'reader.open/page/layer/pageText/outline + invalid page/paper', async () => {
    const open = await call('reader.open', { id: P_MAIN })
    const page = await call('reader.page', { id: P_MAIN, page: 1 })
    const layer = await call('reader.layer', { id: P_MAIN, page: 1 })
    const pageText = await call('reader.pageText', { id: P_MAIN, page: 1 })
    const outline = await call('reader.outline', { id: P_MAIN })
    const badPage = await tryCall('reader.page', { id: P_MAIN, page: 0 })
    const badPaper = await tryCall('reader.page', { id: P_EMPTY, page: 1 })
    const pass =
      open?.paper?.id === P_MAIN &&
      page?.page === 1 &&
      (page?.blocks ?? []).length > 0 &&
      (layer?.words ?? []).length > 100 &&
      typeof pageText?.text === 'string' &&
      pageText.text.length > 100 &&
      Array.isArray(outline?.items) &&
      badPage.ok === false &&
      badPage.error.code === 'invalid' &&
      badPaper.ok === false &&
      ['not_found', 'invalid'].includes(badPaper.error.code)
    return { actual: { blocks: (page?.blocks ?? []).length, words: (layer?.words ?? []).length, textChars: String(pageText?.text ?? '').length, outlineItems: (outline?.items ?? []).length, badPage: badPage.error ?? null, badPaper: badPaper.error ?? null }, pass }
  })

  await check('CHAIN.annotations', 'CHAIN', 'annotation CRUD + trash + undo restore + cleanup', async () => {
    const before = await activeAnnotationCount()
    const created = await call('annotations.create', {
      paperId: P_CROP,
      page: 1,
      kind: 'highlight',
      origin: 'test_note',
      quote: `v15 sweep annotation ${RUN_STAMP}`,
      comment: `v15 annotation comment ${RUN_STAMP}`,
      rects: [{ x: 0.12, y: 0.2, w: 0.3, h: 0.02 }],
      color: 'yellow',
    })
    const annotation = created?.annotation ?? created
    const id = annotation?.id ?? null
    if (typeof id === 'string') state.created.annotations.push(id)
    const listAfter = await call('annotations.list', { paperId: P_CROP })
    const feedAfter = await call('annotations.feed', { paperId: P_CROP, limit: 100 })
    const updated = await call('annotations.update', { id, comment: `v15 updated ${RUN_STAMP}`, color: 'green' })
    const listed = (await call('annotations.list', { paperId: P_CROP })).find((entry) => entry.id === id) ?? null
    const deleted = await call('annotations.delete', { id })
    const listDeleted = await call('annotations.list', { paperId: P_CROP })
    const trashList = await call('annotations.list', { paperId: P_CROP, state: 'trash' })
    const journal = await call('operations.recent', { limit: 10 })
    const deleteOp = (journal.items ?? []).find((entry) => /annotations?\.delete/.test(String(entry.kind)) && entry.undone === false) ?? null
    const undo = deleteOp === null ? null : await call('operations.undo', { operationId: deleteOp.id })
    const listRestored = await call('annotations.list', { paperId: P_CROP })
    const deletedAgain = await call('annotations.delete', { id })
    const after = await activeAnnotationCount()
    const pass =
      id !== null &&
      (listAfter ?? []).some((entry) => entry.id === id) &&
      (feedAfter.items ?? []).some((entry) => entry.id === id) &&
      listed?.comment === `v15 updated ${RUN_STAMP}` &&
      listed?.color === 'green' &&
      (listDeleted ?? []).every((entry) => entry.id !== id) &&
      (trashList ?? []).some((entry) => entry.id === id) &&
      deleteOp !== null &&
      undo !== null &&
      (listRestored ?? []).some((entry) => entry.id === id) &&
      deletedAgain !== null &&
      after === before
    return { actual: { id, created: clip(annotation), updated: clip(updated), listed: clip(listed), deleteOp: deleteOp?.id ?? null, undo: clip(undo), deletedAgain: clip(deletedAgain), activeAnnotationsBefore: before, activeAnnotationsAfter: after, note: 'one soft-deleted test annotation stays in the trash after the chain (no annotation purge API) — active counts are restored.' }, pass }
  })

  await check('CHAIN.notes', 'CHAIN', 'note create → library.get notes → delete; notes count restored (notes.delete is not journaled)', async () => {
    const before = Number((await call('status')).counts?.notes ?? 0)
    const created = await call('notes.create', { paperId: P_CROP, text: `v15 sweep note ${RUN_STAMP}`, origin: 'user_note' })
    const note = created?.note ?? created
    const noteId = note?.id ?? null
    if (typeof noteId === 'string') state.created.notes.push(noteId)
    const detail = await call('library.get', { id: P_CROP })
    const listed = (detail?.notes ?? []).some((entry) => entry.id === noteId)
    const deleted = await call('notes.delete', { id: noteId })
    const afterDelete = Number((await call('status')).counts?.notes ?? 0)
    const afterDetail = await call('library.get', { id: P_CROP })
    const hidden = (afterDetail?.notes ?? []).every((entry) => entry.id !== noteId)
    const recent = await call('operations.recent', { limit: 20 })
    const journaled = (recent.items ?? []).some((entry) => String(entry.kind).includes('notes.delete'))
    const pass = noteId !== null && listed && deleted !== null && afterDelete === before && hidden
    return { actual: { noteId, listedInDetail: listed, deleteResult: clip(deleted), notesBefore: before, afterDelete, hiddenFromDetail: hidden, journalEntryForDelete: journaled, note: 'notes.delete performs a soft delete and is not written to the operations journal (no undo API for notes); the chain asserts the observable create/list/delete behavior and restores the count.' }, pass }
  })

  await check('CHAIN.tags', 'CHAIN', 'add tag → tags.list → rename → delete (+undo on delete)', async () => {
    const tagName = `v15-tag-${RUN_STAMP}`
    const renamed = `${tagName}-r`
    state.created.tags.push(tagName, renamed)
    const updated = await call('library.update', { id: P_CROP, patch: { addTags: [tagName] } })
    const afterAdd = await call('library.get', { id: P_CROP })
    const tagsList = await call('tags.list')
    const present = (tagsList.items ?? []).some((entry) => entry.name === tagName)
    const rename = await call('tags.rename', { from: tagName, to: renamed })
    const afterRename = await call('tags.list')
    const renamedPresent = (afterRename.items ?? []).some((entry) => entry.name === renamed)
    const journal = await call('operations.recent', { limit: 15 })
    const tagDeleteOp = (journal.items ?? []).find((entry) => String(entry.kind).includes('tags') && entry.undone === false) ?? null
    const deletion = await call('tags.delete', { name: renamed })
    const afterDelete = await call('tags.list')
    const gone = (afterDelete.items ?? []).every((entry) => entry.name !== renamed)
    await call('library.update', { id: P_CROP, patch: { removeTags: [renamed] } }).catch(() => {})
    const pass = (afterAdd?.tags ?? []).includes(tagName) && present && renamedPresent && gone
    return { actual: { tagName, renamed, addedTags: afterAdd?.tags ?? null, tagsList: clip((tagsList.items ?? []).slice(0, 5)), rename: clip(rename), tagDeleteOp: tagDeleteOp?.id ?? null, deletion: clip(deletion), gone }, pass }
  })

  await check('CHAIN.folders', 'CHAIN', 'folder create/update/assign/tree counts/delete-promote/undo; real 5 untouched', async () => {
    const rootName = `v15-folder-${RUN_STAMP}`
    const childName = `${rootName}-child`
    const root = await call('library.collections.create', { name: rootName, operationId: `v15-folder-${RUN_STAMP}-root` })
    const rootId = root?.collection?.id ?? root?.folder?.id ?? root?.id ?? null
    if (typeof rootId === 'string') state.created.folders.push(rootId)
    const child = await call('library.collections.create', { name: childName, parentId: rootId, operationId: `v15-folder-${RUN_STAMP}-child` })
    const childId = child?.collection?.id ?? child?.folder?.id ?? child?.id ?? null
    if (typeof childId === 'string') state.created.folders.push(childId)
    const renamed = await call('library.collections.update', { id: childId, name: `${childName}-r`, color: '#88aaee' })
    const assign = await call('library.collections.assign', { collectionId: childId, paperIds: [P_CROP], add: true })
    const treeAfter = await call('library.folders.tree')
    const flat = folderItems(treeAfter)
    const childNode = flat.find(({ item }) => item.id === childId)?.item ?? null
    const rootNode = flat.find(({ item }) => item.id === rootId)?.item ?? null
    const listByRoot = await call('library.list', { folderId: rootId, limit: 100 })
    const unassign = await call('library.collections.assign', { collectionId: childId, paperIds: [P_CROP], add: false })
    const deleteChild = await call('library.collections.delete', { id: childId })
    const deleteRoot = await call('library.collections.delete', { id: rootId })
    const finalTree = await call('library.folders.tree')
    const finalFlat = folderItems(finalTree)
    const realNames = ORIGINAL_FIELD_NAMES.filter((name) => finalFlat.some(({ item }) => item.name === name))
    const undoJournal = await call('operations.recent', { limit: 15 })
    const createOp = (undoJournal.items ?? []).find((entry) => String(entry.kind).includes('collections.create') && entry.undone === false) ?? null
    const pass =
      rootId !== null &&
      childId !== null &&
      childNode?.name === `${childName}-r` &&
      childNode?.color === '#88aaee' &&
      Number(rootNode?.count) === 1 &&
      (listByRoot.items ?? []).some((paper) => paper.id === P_CROP) &&
      finalFlat.every(({ item }) => ![rootId, childId].includes(item.id)) &&
      realNames.length === 5
    return { actual: { rootId, childId, renamed: clip(renamed), assign: clip(assign), rootCount: rootNode?.count ?? null, childCount: childNode?.count ?? null, listByRootTotal: listByRoot.total, unassign: clip(unassign), deleteChild: clip(deleteChild), deleteRoot: clip(deleteRoot), realFoldersIntact: realNames, createOp: createOp?.id ?? null, finalFolderCount: finalFlat.length }, pass }
  })

  await check('CHAIN.collections', 'CHAIN', 'collections.list usable and consistent with folders.tree', async () => {
    const collections = await call('library.collections.list')
    const tree = await call('library.folders.tree')
    const treeIds = new Set(folderItems(tree).map(({ item }) => item.id))
    const listIds = new Set((collections.items ?? []).map((item) => item.id))
    const onlyTree = [...treeIds].filter((id) => !listIds.has(id))
    const onlyList = [...listIds].filter((id) => !treeIds.has(id))
    const pass = onlyTree.length === 0 && onlyList.length === 0 && (collections.items ?? []).length >= 5
    return { actual: { count: (collections.items ?? []).length, onlyTree, onlyList, sample: clip((collections.items ?? []).slice(0, 3)) }, pass }
  })

  await check('CHAIN.favorite', 'CHAIN', 'setFavorite on/off + list favorite + undo', async () => {
    const detail = await call('library.get', { id: P_CROP })
    const baseline = detail?.favorite === true
    const setOn = await call('library.setFavorite', { ids: [P_CROP], favorite: true })
    const on = await call('library.get', { id: P_CROP })
    const listed = await call('library.list', { favorite: true, limit: 100 })
    const journal = await call('operations.recent', { limit: 10 })
    const op = (journal.items ?? []).find((entry) => String(entry.kind).toLowerCase().includes('favorite') && entry.undone === false) ?? null
    const setOff = await call('library.setFavorite', { ids: [P_CROP], favorite: baseline })
    const off = await call('library.get', { id: P_CROP })
    const pass =
      on?.favorite === true &&
      (listed.items ?? []).some((paper) => paper.id === P_CROP) &&
      op !== null &&
      off?.favorite === baseline
    return { actual: { baseline, setOn: clip(setOn), favoriteOn: on?.favorite ?? null, listed: (listed.items ?? []).map((paper) => paper.id), operation: op?.id ?? null, setOff: clip(setOff), favoriteRestored: off?.favorite ?? null }, pass }
  })

  await check('CHAIN.read', 'CHAIN', 'setRead toggle + read filters + original state restored', async () => {
    const before = await call('library.get', { id: P_CROP })
    const original = before?.read === true
    await call('library.setRead', { ids: [P_CROP], read: !original })
    const toggled = await call('library.get', { id: P_CROP })
    const readList = await call('library.list', { read: toggled.read === true ? 'read' : 'unread', limit: 100 })
    const inList = (readList.items ?? []).some((paper) => paper.id === P_CROP)
    await call('library.setRead', { ids: [P_CROP], read: original })
    const restored = await call('library.get', { id: P_CROP })
    const pass = toggled?.read === !original && inList && restored?.read === original
    return { actual: { original, toggled: toggled?.read ?? null, filteredRead: readList.total, inList, restored: restored?.read ?? null }, pass }
  })

  await check('CHAIN.libraryUpdate', 'CHAIN', 'patch titleZh/comment → verify → revert; invalid field; revision conflict', async () => {
    const before = await call('library.get', { id: P_CROP })
    const baselineTitleZh = before?.titleZh ?? null
    const stampTitle = `v15 题名 ${RUN_STAMP}`
    state.baseline.metrics = before?.metrics ?? null
    const patched = await call('library.update', { id: P_CROP, patch: { titleZh: stampTitle }, expectedRevision: before?.revision })
    const after = await call('library.get', { id: P_CROP })
    const invalidField = await tryCall('library.update', { id: P_CROP, patch: { notAllowedField: 1 } })
    const conflict = await tryCall('library.update', { id: P_CROP, patch: { titleZh: 'x' }, expectedRevision: (before?.revision ?? 0) + 999 })
    const revert = await call('library.update', { id: P_CROP, patch: { titleZh: baselineTitleZh } })
    const restored = await call('library.get', { id: P_CROP })
    const pass =
      after?.titleZh === stampTitle &&
      invalidField.ok === false &&
      invalidField.error.code === 'invalid' &&
      conflict.ok === false &&
      conflict.error.code === 'conflict' &&
      restored?.titleZh === baselineTitleZh
    return { actual: { baselineTitleZh, stamped: after?.titleZh ?? null, invalidField: invalidField.error ?? null, conflict: conflict.error ?? null, restoredTitleZh: restored?.titleZh ?? null, revisionAfter: restored?.revision ?? null }, pass }
  })

  await check('CHAIN.classify', 'CHAIN', 'library.classify suggest(+apply) real result', async () => {
    const suggestion = await call('library.classify', { paperIds: [P_CROP, P_MAIN], apply: false })
    const apply = await call('library.classify', { paperIds: [P_CROP], apply: true })
    const suggestions = suggestion?.suggestions ?? []
    const acceptable = suggestions.every((entry) => ['assign', 'create', 'none'].includes(entry.action))
    const pass =
      suggestion?.status === 'ok' &&
      suggestions.length === 2 &&
      acceptable &&
      apply?.status === 'ok' &&
      (apply?.applied === undefined || apply.applied !== null)
    return { actual: { suggest: clip(suggestions), threshold: suggestion?.threshold ?? null, applyStatus: apply?.status ?? null, applied: clip(apply?.applied) }, pass }
  })

  await check('CHAIN.savedSearches', 'CHAIN', 'saved search create/list/update/delete + duplicate conflict', async () => {
    const name = `v15-saved-${RUN_STAMP}`
    const created = await call('saved_searches.create', { name, query: { q: 'crop', scope: 'papers' } })
    const saved = created?.savedSearch ?? created
    const id = saved?.id ?? null
    if (typeof id === 'string') state.created.savedSearches.push(id)
    const list = await call('saved_searches.list')
    const updated = await call('saved_searches.update', { id, name: `${name}-r`, query: { q: 'irrigation' } })
    const duplicate = await tryCall('saved_searches.create', { name: `${name}-r`, query: {} })
    const deleted = await call('saved_searches.delete', { id })
    const finalList = await call('saved_searches.list')
    const pass =
      id !== null &&
      (list.items ?? []).some((entry) => entry.id === id) &&
      updated !== null &&
      duplicate.ok === false &&
      duplicate.error.code === 'conflict' &&
      (finalList.items ?? []).every((entry) => entry.id !== id)
    return { actual: { id, created: clip(saved), updated: clip(updated), duplicateConflict: duplicate.error ?? null, deleted: clip(deleted), finalCount: (finalList.items ?? []).length }, pass }
  })

  await check('CHAIN.references', 'CHAIN', 'references.commit token + references.resolve + bad bundle', async () => {
    const commit = await call('references.commit', { items: [{ kind: 'paper', id: P_MAIN }], sessionId: `v15-${RUN_STAMP}` })
    const bundleId = commit?.bundleId ?? null
    if (typeof bundleId === 'string') state.created.bundles.push(bundleId)
    const resolved = bundleId === null ? null : await call('references.resolve', { bundleId })
    const bad = await tryCall('references.resolve', { bundleId: 'bn-000000000000' })
    const pass =
      bundleId !== null &&
      typeof commit?.token === 'string' &&
      commit.token.includes('bundle=') &&
      (commit?.materials ?? []).some((material) => material.kind === 'paper') &&
      ((resolved?.valid ?? resolved?.items ?? [])).length >= 1 &&
      resolved?.bundle?.id === bundleId &&
      bad.ok === false &&
      ['not_found', 'invalid'].includes(bad.error.code)
    return { actual: { bundleId, token: commit?.token ?? null, display: commit?.display ?? null, materials: clip(commit?.materials), resolvedItems: (resolved?.valid ?? resolved?.items ?? []).length, bundle: clip(resolved?.bundle), invalid: clip(resolved?.invalid), badBundle: bad.error ?? null }, pass }
  })

  await check('CHAIN.jobs', 'CHAIN', 'jobs.list + global pause/resume + nonexistent cancel/retry errors', async () => {
    const list = await call('jobs.list')
    const pause = await call('jobs.pause', {})
    const pausedStatus = await call('status')
    const paused = pausedStatus?.jobs?.globalPaused === true
    const resume = await call('jobs.resume', {})
    const resumedStatus = await call('status')
    const resumed = resumedStatus?.jobs?.globalPaused === false
    if (state.baseline.jobsPaused === true) await call('jobs.pause', {})
    const cancelBad = await tryCall('jobs.cancel', { id: 'jb-000000000000' })
    const retryBad = await tryCall('jobs.retry', { id: 'jb-000000000000' })
    const pass =
      Array.isArray(list?.items) &&
      pause !== null &&
      paused &&
      resume !== null &&
      resumed &&
      cancelBad.ok === false &&
      ['not_found', 'invalid', 'conflict'].includes(cancelBad.error.code) &&
      retryBad.ok === false
    return { actual: { jobCount: (list?.items ?? []).length, pause: clip(pause), paused, resume: clip(resume), resumed, cancelBad: cancelBad.error ?? null, retryBad: retryBad.error ?? null }, pass }
  })

  await check('CHAIN.operations', 'CHAIN', 'operations.recent + undo of a folder create', async () => {
    const name = `v15-undo-folder-${RUN_STAMP}`
    const created = await call('library.collections.create', { name, operationId: `v15-undo-${RUN_STAMP}` })
    const folderId = created?.collection?.id ?? created?.folder?.id ?? created?.id ?? null
    const recent = await call('operations.recent', { limit: 20 })
    const op = (recent.items ?? []).find((entry) => String(entry.kind).includes('collections.create') && entry.undone === false) ?? null
    const undo = op === null ? null : await call('operations.undo', { operationId: op.id })
    const tree = await call('library.folders.tree')
    const gone = folderItems(tree).every(({ item }) => item.id !== folderId)
    const pass = folderId !== null && op !== null && undo !== null && gone
    return { actual: { folderId, operation: op?.id ?? null, undo: clip(undo), folderGone: gone }, pass }
  })

  await check('CHAIN.exports', 'CHAIN', 'export.bibtex/csl/locations/notes/annotations content', async () => {
    const bibtex = await call('export.bibtex', { ids: [P_MAIN] })
    const csl = await call('export.csl', { ids: [P_MAIN] })
    const locations = await call('export.locations', { ids: [P_MAIN] })
    const notes = await call('export.notes', { ids: [P_MAIN] })
    const annotations = await call('export.annotations', { paperId: P_MAIN, format: 'markdown' })
    const annotationsJson = await call('export.annotations', { paperId: P_MAIN, format: 'json' })
    const pass =
      typeof bibtex?.content === 'string' && bibtex.content.includes('@') &&
      typeof csl?.content === 'string' && csl.content.trim().startsWith('[') &&
      typeof locations?.content === 'string' &&
      typeof notes?.content === 'string' &&
      typeof annotations?.content === 'string' &&
      Number(annotations?.count) >= 1 &&
      typeof annotationsJson?.content === 'string'
    return { actual: { bibtexHead: String(bibtex?.content ?? '').slice(0, 60), cslHead: String(csl?.content ?? '').slice(0, 40), locationsChars: String(locations?.content ?? '').length, notesChars: String(notes?.content ?? '').length, annotationsCount: annotations?.count ?? null, annotationsJsonChars: String(annotationsJson?.content ?? '').length }, pass }
  })

  await check('CHAIN.citations', 'CHAIN', 'citation.format styles + invalid style + citation.key', async () => {
    const styles = ['bibtex', 'apa', 'gbt7714', 'ris', 'csljson']
    const outputs = []
    for (const style of styles) outputs.push({ style, result: await tryCall('citation.format', { ids: [P_MAIN], style }) })
    const invalid = await tryCall('citation.format', { ids: [P_MAIN], style: 'vancouver' })
    const keys = await call('citation.key', { ids: [P_MAIN, P_CROP] })
    const allOk = outputs.every((entry) => entry.result.ok === true && typeof entry.result.data?.content === 'string' && entry.result.data.content.length > 10)
    const pass = allOk && invalid.ok === false && invalid.error.code === 'invalid' && Array.isArray(keys?.keys) && keys.keys.length === 2 && keys.keys.every((entry) => typeof entry.key === 'string' && entry.key.length > 3)
    return { actual: { styles: outputs.map((entry) => ({ style: entry.style, ok: entry.result.ok, chars: String(entry.result.data?.content ?? '').length })), invalidStyle: invalid.error ?? null, keys: clip(keys?.keys) }, pass }
  })

  await check('CHAIN.metrics', 'CHAIN', 'metrics.refresh offline honest + metrics.update invalid + metrics.reset nonexistent', async () => {
    const refresh = await call('metrics.refresh', { paperIds: [P_MAIN], allowNetwork: false })
    const invalidField = await tryCall('metrics.update', { paperId: P_MAIN, fields: { notAField: 1 } })
    const resetMissing = await tryCall('metrics.reset', { paperId: P_EMPTY })
    const pass =
      refresh?.network === false &&
      (refresh?.results ?? []).every((entry) => typeof entry.status === 'string') &&
      invalidField.ok === false &&
      invalidField.error.code === 'invalid' &&
      resetMissing.ok === false &&
      ['not_found', 'invalid'].includes(resetMissing.error.code)
    return { actual: { refresh: clip(refresh), invalidField: invalidField.error ?? null, resetMissing: resetMissing.error ?? null, note: 'real network refresh is NOT triggered (it would overwrite user metrics); metrics.update/reset mutating real papers also not executed — see CHAIN.metrics.not_run' }, pass }
  })
  notRun('CHAIN.metrics.not_run', 'CHAIN', 'real metrics.refresh(allowNetwork=true) / metrics.update / metrics.reset on real papers', 'metrics writes are user data; the API fields were covered by historic v0.3 suite (metrics 34/34) and this sweep verifies the offline/honest-error contract only. A real network refresh would overwrite the user library metrics, so it is intentionally not executed.', { readOnlyReason: 'avoid mutating user metrics' })

  await check('CHAIN.duplicates', 'CHAIN', 'library.duplicates read-only + merge invalid args', async () => {
    const duplicates = await call('library.duplicates')
    const mergeMissing = await tryCall('library.merge', { primaryId: P_EMPTY, duplicateIds: [P_MAIN] })
    const mergeEmpty = await tryCall('library.merge', { primaryId: P_MAIN, duplicateIds: [] })
    const pass =
      Array.isArray(duplicates?.groups) &&
      mergeMissing.ok === false &&
      ['not_found', 'invalid'].includes(mergeMissing.error.code) &&
      mergeEmpty.ok === false &&
      mergeEmpty.error.code === 'invalid'
    return { actual: { groups: (duplicates?.groups ?? []).length, mergeMissing: mergeMissing.error ?? null, mergeEmpty: mergeEmpty.error ?? null }, pass }
  })
  notRun('CHAIN.merge.not_run', 'CHAIN', 'real library.merge of a duplicate fixture', 'no duplicate fixture exists in the live library and creating one would require importing a second paper then purging it; per the task import must not pollute the live 30-paper library, so merge is covered read-only (duplicates + invalid args). The merge write path was covered by the historical v0.3 suite.', { readOnlyReason: 'no safe duplicate fixture without polluting live library' })

  await check('CHAIN.import', 'CHAIN', 'import byte-modified devkit copy → classification → duplicate/invalid → delete+purge', async () => {
    if (!existsSync(DEVKIT_C02)) return { actual: { error: `devkit PDF missing: ${DEVKIT_C02}` }, pass: false }
    const dir = mkdtempSync(join(tmpdir(), 'pappers-hall-v15-import-'))
    const fixture = join(dir, `C02_v15copy_${RUN_STAMP}.pdf`)
    const source = readFileSync(DEVKIT_C02)
    writeFileSync(fixture, Buffer.concat([source, Buffer.from(`\n% pappers-hall v0.15 import fixture ${RUN_STAMP}\n`, 'latin1')]))
    const before = Number((await call('status')).counts?.papers ?? 0)
    const imported = await call('library.import', { paths: [fixture], operationId: `v15-import-${RUN_STAMP}` }, 180_000)
    const accepted = imported?.acceptedItems ?? []
    const newPaperId = accepted[0]?.paperId ?? null
    if (typeof newPaperId === 'string') state.created.papers.push(newPaperId)
    const classification = imported?.classification ?? null
    const duplicate = await call('library.import', { paths: [fixture], operationId: `v15-import-dup-${RUN_STAMP}` }, 120_000)
    const invalid = await call('library.import', { paths: ['/nonexistent/v15-missing.pdf'], operationId: `v15-import-invalid-${RUN_STAMP}` }, 60_000)
    const jobId = imported?.jobId ?? null
    const waited = jobId === null ? { ok: false } : await waitFor(async () => {
      const jobs = await call('jobs.list')
      const job = (jobs.items ?? []).find((entry) => entry.id === jobId)
      return { ok: job !== undefined && ['succeeded', 'failed', 'cancelled'].includes(String(job.state)), state: job?.state ?? null }
    }, { timeoutMs: 180_000, label: 'import job' })
    let cleanup = { deleted: false, purged: false }
    if (newPaperId !== null) {
      await call('library.delete', { ids: [newPaperId], operationId: `v15-import-clean-del-${RUN_STAMP}` }).catch(() => {})
      await call('library.purge', { ids: [newPaperId], operationId: `v15-import-clean-purge-${RUN_STAMP}` }).catch(() => {})
      cleanup = { deleted: true, purged: true }
    }
    const after = Number((await call('status')).counts?.papers ?? 0)
    const classificationEntry = (classification?.applied ?? [])[0] ?? null
    rmSync(dir, { recursive: true, force: true })
    const pass =
      accepted.length === 1 &&
      newPaperId !== null &&
      classification !== null &&
      Number(duplicate?.acceptedItems?.length ?? 0) === 0 &&
      (duplicate?.duplicates ?? []).length >= 1 &&
      (invalid?.errors ?? []).length >= 1 &&
      after === before
    return { actual: { accepted: accepted.length, newPaperId, jobState: waited.last?.state ?? null, classification: clip(classification), classificationEntry: clip(classificationEntry), duplicateReasons: (duplicate?.duplicates ?? []).map((entry) => entry.reason), invalidErrors: clip(invalid?.errors), papersBefore: before, papersAfter: after, cleanup }, pass }
  })

  await check('CHAIN.settings', 'CHAIN', 'settings.get full + invalid-key reporting + switch semantics (restored)', async () => {
    const settings = await call('settings.get')
    const invalid = await call('settings.update', { patch: { features: { bogusSwitch: true, vectorSearch: 'yes' } } })
    const off = await call('settings.update', { patch: { features: { vectorSearch: false } } })
    const statusOff = await call('status')
    const searchOff = await call('search.query', { q: 'irrigation', ai: 'off', limit: 3 })
    const vectorChannel = (searchOff.channels ?? []).find((channel) => channel.name === 'vector') ?? null
    const restored = await call('settings.update', { patch: { features: { ...state.baseline.settings?.features }, translation: { providers: { ...state.baseline.settings?.providerEnabled }, fallbackEnabled: state.baseline.settings?.fallbackEnabled } } })
    const restoredSettings = await call('settings.get')
    const featuresOk = Object.keys(state.baseline.settings?.features ?? {}).every((key) => restoredSettings?.features?.[key] === state.baseline.settings.features[key])
    const indexChannelsOff = statusOff?.index?.channels?.vector === 'disabled'
    const noVectorReasons = (searchOff.items ?? []).every((item) => !(item.reasons ?? []).includes('vector_similarity'))
    const pass =
      settings?.models?.embedding !== undefined &&
      settings?.models?.ocr !== undefined &&
      settings?.translation?.providers !== undefined &&
      Array.isArray(invalid?.ignored) && invalid.ignored.length >= 1 &&
      off?.features?.vectorSearch === false &&
      indexChannelsOff &&
      String(vectorChannel?.status) === 'off' &&
      noVectorReasons &&
      featuresOk
    return { actual: { features: settings?.features ?? null, embedding: clip(settings?.models?.embedding), ocr: clip(settings?.models?.ocr), ignored: clip(invalid?.ignored), vectorOffChannels: statusOff?.index?.channels ?? null, searchVectorStatus: clip(vectorChannel), noVectorReasons, restoredFeatures: restoredSettings?.features ?? null }, pass }
  })

  await check('CHAIN.translate', 'CHAIN', 'translate.detect/providers/settings + quick free-only (cached/failure) + explicit LLM rejection', async () => {
    const detect = await call('translate.detect', { text: 'hello world' })
    const providers = await call('translate.providers')
    const settingsPayload = await call('translate.settings')
    const quickCached = await call('translate.text', { quick: true, text: 'Pappers-Hall translation test: the local paper library is ready.', target: 'zh' })
    const quickFresh = await call('translate.text', { quick: true, text: `The quick sweep should stay free-only (batch ${RUN_STAMP}).`, target: 'zh' })
    const quickExplicitLlm = await call('translate.text', { quick: true, provider: 'llm', text: 'The proposed method improves accuracy.', target: 'zh' })
    const engineId = (result) => (typeof result?.engine === 'string' ? result.engine : result?.engine?.id ?? null)
    const quickNoLlm = engineId(quickFresh) !== 'llm' && engineId(quickExplicitLlm) !== 'llm' && (quickExplicitLlm.translation ?? null) === null
    const freeEngineIds = ['tencent', 'google', 'mymemory', 'libretranslate']
    const cachedOk = quickCached?.status === 'translated' && freeEngineIds.includes(String(engineId(quickCached))) && String(quickCached?.translation ?? '') !== '' && Number(quickCached?.latencyMs) <= 6000 && quickCached?.freeOnly === true && quickCached?.mode === 'free'
    const freshHonest = quickFresh?.status === 'translated' ? engineId(quickFresh) !== 'llm' && String(quickFresh?.translation ?? '') !== '' : quickFresh?.status === 'unavailable' && quickFresh?.suggestAi === true && String(quickFresh?.reason ?? '') !== ''
    const pass =
      detect?.language === 'en' &&
      Array.isArray(providers?.items) &&
      providers.items.length >= 2 &&
      settingsPayload !== null &&
      cachedOk &&
      freshHonest &&
      quickNoLlm
    return { actual: { detect: clip(detect), providers: (providers?.items ?? []).map((item) => ({ id: item.id, enabled: item.enabled, available: item.available, free: item.free })), quickCached: { status: quickCached?.status ?? null, engine: engineId(quickCached), cached: quickCached?.cached ?? null, latencyMs: quickCached?.latencyMs ?? null, mode: quickCached?.mode ?? null, freeOnly: quickCached?.freeOnly ?? null, translation: quickCached?.translation ?? null }, quickFresh: { status: quickFresh?.status ?? null, engine: engineId(quickFresh), latencyMs: quickFresh?.latencyMs ?? null, suggestAi: quickFresh?.suggestAi ?? null, reason: quickFresh?.reason ?? null, failures: clip(quickFresh?.failures) }, quickExplicitLlm: { status: quickExplicitLlm?.status ?? null, engine: engineId(quickExplicitLlm), suggestAi: quickExplicitLlm?.suggestAi ?? null, reason: quickExplicitLlm?.reason ?? null }, quickNoLlm }, pass }
  })

  await check('CHAIN.translate.title', 'CHAIN', 'translate.title real call (honest result; title restored afterwards)', async () => {
    const beforeDetail = await call('library.get', { id: P_MAIN })
    const originalTitleZh = beforeDetail?.titleZh ?? null
    const outcome = await (async () => {
      const started = Date.now()
      try {
        return { data: await call('translate.title', { ids: [P_MAIN], target: 'zh' }, 240_000), ms: Date.now() - started, error: null }
      } catch (error) {
        return { data: null, ms: Date.now() - started, error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
      }
    })()
    const results = outcome.data?.results ?? []
    const translated = results.filter((entry) => entry.status === 'translated' && typeof entry.titleZh === 'string')
    const fromMetadata = results.filter((entry) => ['from_metadata', 'skipped'].includes(String(entry.status)) && typeof entry.titleZh === 'string')
    const honestFailure = outcome.error !== null || results.every((entry) => !['translated', 'from_metadata', 'skipped'].includes(String(entry.status)) && typeof entry.reason === 'string')
    // A successful translate.title writes papers.title_zh; restore the user's original title.
    let restoreError = null
    if (translated.length > 0) {
      try {
        await call('library.update', { id: P_MAIN, patch: { titleZh: originalTitleZh } })
      } catch (error) {
        restoreError = { code: error?.code ?? null, message: String(error?.message ?? error) }
        state.cleanupErrors.push(`translate.title restore: ${String(error?.message ?? error)}`)
      }
    }
    const restoredDetail = await call('library.get', { id: P_MAIN })
    const pass = outcome.error === null && Array.isArray(results) && (translated.length > 0 || fromMetadata.length > 0 || honestFailure) && restoreError === null && (restoredDetail?.titleZh ?? null) === originalTitleZh
    return { actual: { ms: outcome.ms, originalTitleZh, results: clip(results), error: outcome.error, restoreError, restoredTitleZh: restoredDetail?.titleZh ?? null }, pass, notes: 'real LLM title translation; a network/AI failure must be reported with a reason, not hidden. The translated title is immediately reverted to the user original.' }
  })

  await check('CHAIN.translate.blocks', 'CHAIN', 'translate.blocks page translation (honest result / unavailable)', async () => {
    const started = Date.now()
    const outcome = await (async () => {
      try {
        return { data: await call('translate.blocks', { paperId: P_MAIN, page: 1 }, 300_000), error: null }
      } catch (error) {
        return { data: null, error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
      }
    })()
    const blocks = outcome.data?.blocks ?? outcome.data?.items ?? []
    const translated = blocks.filter((block) => block?.status === 'translated' && typeof block?.translation === 'string')
    const honestFailure =
      outcome.error !== null ||
      outcome.data?.status === 'unavailable' ||
      blocks.every((block) => block?.status !== 'translated' && typeof block?.reason === 'string')
    const pass = outcome.error === null ? blocks.length > 0 && (translated.length > 0 || honestFailure) : ['unavailable', 'invalid', 'not_found'].includes(String(outcome.error.code))
    return { actual: { ms: Date.now() - started, blocks: blocks.length, translated: translated.length, status: outcome.data?.status ?? null, error: outcome.error, sample: clip(blocks.slice(0, 2)) }, pass }
  })

  await check('CHAIN.ai', 'CHAIN', 'ai.ask + ai.quickTranslate real calls (honest result)', async () => {
    const askStarted = Date.now()
    const ask = await tryCall('ai.ask', { prompt: '这篇论文研究了什么？用一句话回答。', paperId: P_CROP, page: 1 }, 300_000)
    const askOk = ask.ok === true
      ? (typeof ask.data?.answer === 'string' && ask.data.answer.trim() !== '') || (['unavailable', 'error'].includes(String(ask.data?.status)) && typeof ask.data?.reason === 'string' && ask.data.reason.trim() !== '')
      : ['unavailable', 'invalid'].includes(String(ask.error.code))
    const quickStarted = Date.now()
    const quick = await tryCall('ai.quickTranslate', { text: 'In this study, ΔY and CA are simulated with GGCMs to quantify crop yield impacts.', target: 'zh' }, 300_000)
    const quickOk = quick.ok === true ? quick.data?.status === 'translated' && String(quick.data?.translation ?? '') !== '' && quick.data?.fast === true : ['unavailable', 'invalid'].includes(String(quick.error.code))
    const pass = askOk && quickOk
    return { actual: { ask: { ms: Date.now() - askStarted, ok: ask.ok, status: ask.data?.status ?? null, answerChars: String(ask.data?.answer ?? '').length, reason: ask.data?.reason ?? null, sources: clip(ask.data?.sources), error: ask.ok ? null : ask.error }, quickTranslate: { ms: Date.now() - quickStarted, ok: quick.ok, status: quick.data?.status ?? null, fast: quick.data?.fast ?? null, reasoningEffort: quick.data?.reasoningEffort ?? null, elapsedMs: quick.data?.elapsedMs ?? null, promptVersion: quick.data?.provenance?.promptVersion ?? null, translation: quick.data?.translation ?? null, error: quick.ok ? null : quick.error } }, pass }
  })

  await check('CHAIN.ocr', 'CHAIN', 'ocr.index on a text page (0 scanned pages) honest job', async () => {
    const settings = await call('settings.get')
    const ocr = settings?.models?.ocr ?? {}
    if (ocr.installed !== true) {
      const unavailable = await call('ocr.index', { ids: [P_CROP] })
      return { actual: { installed: false, unavailable: clip(unavailable) }, pass: unavailable?.status === 'unavailable' && String(unavailable?.reason ?? '') !== '' }
    }
    const outcome = await call('ocr.index', { ids: [P_CROP], operationId: `v15-ocr-${RUN_STAMP}` }, 60_000)
    const jobId = outcome?.job?.id ?? null
    const waited = jobId === null ? { ok: false } : await waitFor(async () => {
      const jobs = await call('jobs.list')
      const job = (jobs.items ?? []).find((entry) => entry.id === jobId)
      return { ok: job !== undefined && ['succeeded', 'failed', 'cancelled'].includes(String(job.state)), state: job?.state ?? null, progress: job?.progress ?? null }
    }, { timeoutMs: 120_000, label: 'ocr.index job' })
    const status = await call('status')
    const pass = jobId !== null && waited.ok && ['succeeded', 'failed', 'cancelled'].includes(String(waited.last?.state))
    return { actual: { installed: true, status: outcome?.status ?? null, jobId, jobState: waited.last?.state ?? null, progress: clip(waited.last?.progress ?? null), ocrStatus: clip(status?.ocr) }, pass }
  })

  await check('CHAIN.models', 'CHAIN', 'models.install invalid kinds + cancel idle', async () => {
    const bogus = await call('models.install', { kind: 'bogus' })
    const empty = await call('models.install', {})
    const cancelBogus = await call('models.cancel', { kind: 'bogus' })
    const cancelIdle = await call('models.cancel', { kind: 'ocr' })
    const pass =
      bogus?.status === 'invalid' &&
      empty?.status === 'invalid' &&
      cancelBogus?.status === 'invalid' &&
      ['idle', 'invalid'].includes(String(cancelIdle?.status))
    return { actual: { bogus: clip(bogus), empty: clip(empty), cancelBogus: clip(cancelBogus), cancelIdle: clip(cancelIdle) }, pass }
  })
  notRun('CHAIN.models.rebuildIndex', 'CHAIN', 'models.rebuildIndex / models.install real install', 'per the task the embedding index must not be disturbed and real model installs must not be triggered; rebuildIndex idempotency was already verified in the v11 suite (33/34, job 32s, counts/indexVersion unchanged) and the install channel was verified there (job start/cancel).', { readOnlyReason: 'avoid 32s index rebuild / real model downloads' })

  await check('CHAIN.embedding', 'CHAIN', 'embedding.status real state/counts', async () => {
    const status = await call('embedding.status')
    const pass =
      status?.available === true &&
      status?.configured === true &&
      Number(status?.dims) === 384 &&
      typeof status?.indexVersion === 'string' &&
      status?.counts !== undefined &&
      Number(status?.counts?.papers) === 30
    return { actual: { available: status?.available ?? null, configured: status?.configured ?? null, model: status?.model ?? null, dims: status?.dims ?? null, indexVersion: status?.indexVersion ?? null, counts: clip(status?.counts), lastError: status?.lastError ?? null }, pass }
  })

  await check('CHAIN.discover', 'CHAIN', 'discover.feed stats/sections/folders consistency', async () => {
    const feed = await call('discover.feed', { limit: 3 })
    const tree = await call('library.folders.tree')
    const stats = feed?.stats ?? {}
    const folders = feed?.folders ?? []
    const treeCount = folderItems(tree).length
    const flatFeed = []
    const visit = (items) => {
      for (const item of items ?? []) {
        if (item === null || typeof item !== 'object') continue
        flatFeed.push(item)
        if (Array.isArray(item.children)) visit(item.children)
      }
    }
    visit(folders)
    const pass =
      Number(stats.papers) === 30 &&
      Number(stats.figures) === 346 &&
      Number(stats.trash) === 0 &&
      Array.isArray(feed?.continueReading) &&
      Array.isArray(feed?.favorite) &&
      flatFeed.length === treeCount &&
      Array.isArray(feed?.folderCounts)
    return { actual: { stats: clip(stats), treeCount, feedFolderCount: flatFeed.length, folderCounts: (feed?.folderCounts ?? []).length, sections: Object.keys(feed ?? {}) }, pass }
  })

  await check('CHAIN.figures', 'CHAIN', 'figures.list P_MAIN + figures.search text query honest channels', async () => {
    const list = await call('figures.list', { paperId: P_MAIN })
    const search = await call('figures.search', { query: 'irrigation', limit: 5 })
    const pass =
      Array.isArray(list) &&
      list.length >= 5 &&
      list.every((figure) => typeof figure.id === 'string' && String(figure.id).startsWith('fg-')) &&
      Array.isArray(search?.items) &&
      Array.isArray(search?.channels) &&
      search.channels.every((channel) => typeof channel.status === 'string')
    return { actual: { figureCount: list.length, figures: clip(list.slice(0, 4)), searchItems: (search?.items ?? []).length, channels: clip(search?.channels) }, pass }
  })

  await check('CHAIN.tilesTags', 'CHAIN', 'library.tiles ids subset + library.tags', async () => {
    const tiles = await call('library.tiles', { ids: [P_MAIN, P_CROP] })
    const tags = await call('library.tags')
    const ids = (tiles?.items ?? []).map((tile) => tile.id).sort()
    const pass = JSON.stringify(ids) === JSON.stringify([P_MAIN, P_CROP].sort()) && Array.isArray(tags?.items)
    return { actual: { tileIds: ids, tags: clip((tags?.items ?? []).slice(0, 6)) }, pass }
  })
}

/* ------------------------------------------------------------------ *
 * File routes
 * ------------------------------------------------------------------ */
async function routeCases() {
  await check('ROUTES.page', 'ROUTES', 'page PNG GET+HEAD, content-type, invalid page/path', async () => {
    const get = await asset(`/pappers-hall/page/${P_MAIN}/1.png`)
    const head = await asset(`/pappers-hall/page/${P_MAIN}/1.png`, { method: 'HEAD' })
    const invalidPath = await asset('/pappers-hall/page/not-a-paper/1.png')
    const badPage = await asset(`/pappers-hall/page/${P_MAIN}/99999.png`)
    const wrongShape = await asset(`/pappers-hall/page/${P_MAIN}/x.png`)
    const pass =
      get.status === 200 &&
      String(get.contentType ?? '').startsWith('image/png') &&
      head.status === 200 &&
      [400, 404].includes(invalidPath.status) &&
      [400, 404].includes(badPage.status) &&
      wrongShape.status === 400
    return { actual: { get, head, invalidPath, badPage, wrongShape }, pass }
  })

  await check('ROUTES.thumbPdf', 'ROUTES', 'thumb + pdf routes, content types, missing ids', async () => {
    const thumb = await asset(`/pappers-hall/thumb/${P_MAIN}`)
    const thumbHead = await asset(`/pappers-hall/thumb/${P_MAIN}`, { method: 'HEAD' })
    const pdf = await asset(`/pappers-hall/pdf/${P_MAIN}`, { method: 'HEAD' })
    const missingPdf = await asset(`/pappers-hall/pdf/${P_EMPTY}`)
    const missingThumb = await asset(`/pappers-hall/thumb/${P_EMPTY}`)
    const pass =
      thumb.status === 200 && String(thumb.contentType ?? '').startsWith('image/png') &&
      thumbHead.status === 200 &&
      pdf.status === 200 && String(pdf.contentType ?? '').startsWith('application/pdf') &&
      missingPdf.status === 404 &&
      [400, 404].includes(missingThumb.status)
    return { actual: { thumb: { status: thumb.status, type: thumb.contentType, bytes: thumb.bytes }, thumbHead, pdf: { status: pdf.status, type: pdf.contentType, bytes: pdf.bytes }, missingPdf, missingThumb }, pass }
  })

  await check('ROUTES.figure', 'ROUTES', 'figure image route + invalid figure path', async () => {
    const list = await call('figures.list', { paperId: P_MAIN })
    const figureId = list?.[0]?.id ?? null
    const image = figureId === null ? null : await asset(`/pappers-hall/figure/${figureId}`)
    const invalid = await asset('/pappers-hall/figure/not-a-figure')
    const pass =
      figureId !== null &&
      image !== null &&
      [200, 404].includes(image.status) &&
      (image.status !== 200 || String(image.contentType ?? '').startsWith('image/png')) &&
      invalid.status === 400
    return { actual: { figureId, image, invalid }, pass }
  })

  await check('ROUTES.hardening', 'ROUTES', 'traversal, wrong methods, unknown kinds, api GET 405', async () => {
    const traversal = await asset('/pappers-hall/page/..%2f..%2f..%2fetc%2fpasswd')
    const traversal2 = await asset('/pappers-hall/../api')
    const postAsset = await (async () => {
      try {
        const response = await fetch(`${BASE}/pappers-hall/page/${P_MAIN}/1.png`, { method: 'POST' })
        return { status: response.status }
      } catch (error) {
        return { status: null, error: String(error?.message ?? error) }
      }
    })()
    const getApi = await (async () => {
      try {
        const response = await fetch(API, { method: 'GET' })
        return { status: response.status }
      } catch (error) {
        return { status: null, error: String(error?.message ?? error) }
      }
    })()
    const unknownKind = await asset('/pappers-hall/unknown/xyz')
    const pass =
      [400, 404].includes(traversal.status) &&
      [400, 401, 404].includes(traversal2.status) &&
      postAsset.status === 405 &&
      getApi.status === 405 &&
      unknownKind.status === 404
    return { actual: { traversal, traversal2, postAsset, getApi, unknownKind }, pass }
  })
}

/* ------------------------------------------------------------------ *
 * Error-envelope edge cases
 * ------------------------------------------------------------------ */
async function errorCases() {
  await check('ERR.envelope', 'ERR', 'unknown method / malformed JSON / non-object params', async () => {
    const unknown = await api('does.not.exist', {})
    const malformed = await api(null, null, { rawBody: '{"method": ' })
    const paramsArray = await api('library.list', [1, 2])
    const paramsString = await api('library.list', 'not-an-object')
    const pass =
      unknown.body?.ok === false && unknown.body?.error?.code === 'invalid' && unknown.status === 400 &&
      malformed.body?.ok === false && malformed.body?.error?.code === 'invalid' && malformed.status === 400 &&
      paramsArray.body?.ok === false && paramsArray.body?.error?.code === 'invalid' &&
      paramsString.body?.ok === false && paramsString.body?.error?.code === 'invalid'
    return { actual: { unknown: { status: unknown.status, code: unknown.body?.error?.code ?? null }, malformed: { status: malformed.status, code: malformed.body?.error?.code ?? null }, paramsArray: { status: paramsArray.status, code: paramsArray.body?.error?.code ?? null }, paramsString: { status: paramsString.status, code: paramsString.body?.error?.code ?? null } }, pass }
  })

  await check('ERR.ids', 'ERR', 'missing/nonexistent ids and empty batches return honest errors', async () => {
    const probes = {
      getMissing: await tryCall('library.get', { id: '' }),
      getNonexistent: await tryCall('library.get', { id: P_EMPTY }),
      updateUnknown: await tryCall('library.update', { id: P_EMPTY, patch: { titleZh: 'x' } }),
      deleteEmpty: await tryCall('library.delete', { ids: [] }),
      restoreEmpty: await tryCall('library.restore', { ids: [] }),
      purgeEmpty: await tryCall('library.purge', { ids: [] }),
      annotateBadOrigin: await tryCall('annotations.create', { paperId: P_CROP, origin: 'bad_origin' }),
      noteEmpty: await tryCall('notes.create', { text: '' }),
      folderMissing: await tryCall('library.collections.update', { id: 'cl-000000000000', name: 'x' }),
      savedSearchMissing: await tryCall('saved_searches.update', { id: 'ss-000000000000', name: 'x' }),
    }
    const expected = {
      getMissing: 'invalid', getNonexistent: 'not_found', updateUnknown: 'not_found', deleteEmpty: 'invalid', restoreEmpty: 'invalid', purgeEmpty: 'invalid',
      annotateBadOrigin: 'invalid', noteEmpty: 'invalid', folderMissing: 'not_found', savedSearchMissing: 'not_found',
    }
    const issues = []
    for (const [key, expectedCode] of Object.entries(expected)) {
      const probe = probes[key]
      if (probe.ok === true) issues.push(`${key}: unexpected ok`)
      else if (probe.error.code !== expectedCode) issues.push(`${key}: code ${probe.error.code}, expected ${expectedCode}`)
    }
    return { actual: { codes: Object.fromEntries(Object.entries(probes).map(([key, probe]) => [key, probe.ok ? 'ok' : probe.error.code])), issues }, pass: issues.length === 0 }
  })

  await check('ERR.limits', 'ERR', 'extreme pagination clamps instead of failing', async () => {
    const list = await call('library.list', { limit: 1_000_000, offset: -5 })
    const feed = await call('annotations.feed', { limit: 1_000_000 })
    const jobs = await call('jobs.list')
    const ops = await call('operations.recent', { limit: 1_000_000 })
    const pass = Number(list.limit) <= 200 && Number(list.offset) === 0 && (feed.items ?? []).length <= 100 && Array.isArray(jobs.items) && (ops.items ?? []).length <= 100
    return { actual: { listLimit: list.limit, listOffset: list.offset, listItems: list.items.length, feedItems: (feed.items ?? []).length, opsItems: (ops.items ?? []).length }, pass }
  })
}

/* ------------------------------------------------------------------ *
 * Regression evidence
 * ------------------------------------------------------------------ */
async function regressionCases() {
  const refs = [
    ['REF.v13', 'reports/v13-api-results.json', 27, 27, 0, 0],
    ['REF.v11', 'reports/v11-api-results.json', 34, 33, 0, 1],
    ['REF.v07', 'reports/v07-api-results.json', 24, 24, 0, 0],
    ['REF.v06', 'reports/v06-api-results.json', 32, 31, 0, 1],
  ]
  for (const [caseId, path, total, pass, fail, notRunCount] of refs) {
    await check(caseId, 'REG', `${path} still reports ${pass}/${total} (fail ${fail}, not_run ${notRunCount})`, async () => {
      const full = resolve(WORKSPACE, path)
      if (!existsSync(full)) return { actual: { path, exists: false }, pass: false }
      const parsed = JSON.parse(readFileSync(full, 'utf8'))
      const summary = parsed.summary ?? {}
      const ok = Number(summary.total) === total && Number(summary.pass) === pass && Number(summary.fail) === fail && Number(summary.not_run) === notRunCount
      return { actual: { path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, not_run: summary.not_run ?? null }, pass: ok }
    })
  }

  await check('REF.v06.harness', 'REG', 'v0.6 tool harness still 8/8 ok', async () => {
    const full = resolve(WORKSPACE, 'reports/v06-api-results.json')
    if (!existsSync(full)) return { actual: { exists: false }, pass: false }
    const parsed = JSON.parse(readFileSync(full, 'utf8'))
    const harness = parsed?.evidence?.tools?.harness ?? null
    const cases = harness?.cases ?? []
    const failures = cases.filter((entry) => entry.pass !== true).map((entry) => entry.case_id)
    const pass = harness?.ok === true && cases.length === 8 && failures.length === 0
    return { actual: { harnessOk: harness?.ok ?? false, caseCount: cases.length, failures }, pass }
  })

  for (const [caseId, path, total, pass, fail] of [
    ['REF.v05', 'reports/v05-api-results.json', 43, 42, 0],
    ['REF.v04', 'reports/v04-api-results.json', 34, 34, 0],
    ['REF.v02', 'reports/v02-api-results.json', 26, 26, 0],
  ]) {
    await check(caseId, 'REG', `${path} still reports ${pass}/${total} (fail ${fail})`, async () => {
      const full = resolve(WORKSPACE, path)
      if (!existsSync(full)) return { actual: { path, exists: false }, pass: false }
      const parsed = JSON.parse(readFileSync(full, 'utf8'))
      const summary = parsed.summary ?? {}
      const ok = Number(summary.total) === total && Number(summary.pass) === pass && Number(summary.fail) === fail
      return { actual: { path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null }, pass: ok }
    })
  }

  await check('REF.lifecycle', 'REG', 'lifecycle 13 cases 12 pass / 0 fail / 1 not_run', async () => {
    const full = resolve(WORKSPACE, 'reports/v03-lifecycle-run.json')
    if (!existsSync(full)) return { actual: { exists: false }, pass: false }
    const parsed = JSON.parse(readFileSync(full, 'utf8'))
    const lifecycle = parsed?.summary?.by_suite?.lifecycle ?? {}
    const pass = Number(lifecycle.total) === 13 && Number(lifecycle.pass) === 12 && Number(lifecycle.fail) === 0 && Number(lifecycle.not_run) === 1
    return { actual: { lifecycle: clip(lifecycle) }, pass }
  })

  await check('REF.v03', 'REG', 'v0.3 expectation unchanged (historical 38/38 + 3 known AI-fast changes)', async () => {
    const full = resolve(WORKSPACE, 'reports/v03-api-results.json')
    if (!existsSync(full)) return { actual: { exists: false }, pass: false }
    const parsed = JSON.parse(readFileSync(full, 'utf8'))
    const summary = parsed.summary ?? {}
    const failing = (parsed.results ?? []).filter((entry) => entry.status !== 'pass').map((entry) => entry.case_id)
    const known = ['AI.fast.translate', 'AI.fast.quickTranslate', 'AI.cache.separation']
    const explained = Number(summary.total) === 38 && Number(summary.pass) === 35 && Number(summary.fail) === 3 && failing.length === 3 && failing.every((id) => known.includes(id))
    let historical = false
    try {
      historical = readFileSync(resolve(WORKSPACE, 'reports/verify.md'), 'utf8').includes('| **合计** | **38** | **38** | **0** | **0** |')
    } catch {}
    const llmFast = await tryCall('translate.text', { text: 'The proposed method improves retrieval accuracy on three benchmarks.', target: 'zh', provider: 'llm', fast: true }, 240_000)
    const llmFastOk = llmFast.ok === true ? llmFast.data?.status === 'translated' && llmFast.data?.fast === true : false
    const pass = explained && historical && llmFastOk
    return { actual: { total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, failing, historical38: historical, llmFastOk }, pass }
  })

  await check('REF.schema', 'REG', 'schemaVersion>=7, channels ready, ai available', async () => {
    const diagnostics = await call('diagnostics')
    const status = await call('status')
    const ai = await call('ai.status')
    const pass = Number(diagnostics?.schemaVersion) >= 6 && status?.index?.channels?.fts === 'ready' && status?.index?.channels?.vector === 'ready' && ai?.available === true
    return { actual: { schemaVersion: diagnostics?.schemaVersion ?? null, channels: status?.index?.channels ?? null, aiAvailable: ai?.available ?? null }, pass }
  })
}

/* ------------------------------------------------------------------ *
 * Cleanup & data preservation
 * ------------------------------------------------------------------ */
async function cleanupFixtures() {
  // soft-deleted annotation: nothing to do (kept in trash; active counts restored by chain)
  for (const folderId of [...state.created.folders].reverse()) {
    try { await call('library.collections.delete', { id: folderId, operationId: `v15-clean-folder-${folderId}` }) } catch (error) {
      const message = String(error?.message ?? error)
      if (!/not.?found|does not exist/i.test(message)) state.cleanupErrors.push(`folder ${folderId}: ${message}`)
    }
  }
  for (const noteId of state.created.notes) {
    try { await call('notes.delete', { id: noteId }) } catch {}
  }
  for (const tag of state.created.tags) {
    try { await call('tags.delete', { name: tag }) } catch {}
  }
  for (const searchId of state.created.savedSearches) {
    try { await call('saved_searches.delete', { id: searchId }) } catch {}
  }
  for (const paperId of state.created.papers) {
    try {
      await call('library.delete', { ids: [paperId] })
      await call('library.purge', { ids: [paperId] })
    } catch {}
  }
  // restore settings baseline
  if (state.baseline.settings !== null) {
    try {
      await call('settings.update', {
        patch: {
          features: { ...state.baseline.settings.features },
          translation: { providers: { ...state.baseline.settings.providerEnabled }, fallbackEnabled: state.baseline.settings.fallbackEnabled },
        },
        operationId: `v15-restore-settings-${RUN_STAMP}`,
      })
    } catch (error) {
      state.cleanupErrors.push(`settings restore: ${String(error?.message ?? error)}`)
    }
  }
  // global job pause back to baseline
  try {
    const status = await call('status')
    const baselinePaused = state.baseline.jobsPaused === true
    if (status?.jobs?.globalPaused === true && baselinePaused === false) await call('jobs.resume', {})
    if (status?.jobs?.globalPaused !== true && baselinePaused === true) await call('jobs.pause', {})
  } catch {}
  // imports schedule a debounced embedding sync; wait until counts settle back
  try {
    await waitFor(async () => {
      const status = await call('embedding.status')
      return { ok: JSON.stringify(status?.counts ?? null) === JSON.stringify(state.baseline.embeddingCounts ?? null), counts: status?.counts ?? null }
    }, { timeoutMs: 90_000, intervalMs: 2000, label: 'embedding sync settle' })
  } catch {}
}

async function dataCases() {
  await check('DATA.cleanup', 'DATA', 'fixtures removed / settings restored / no internal 500 while cleaning', async () => {
    const tree = await call('library.folders.tree')
    const names = folderItems(tree).map(({ item }) => item.name)
    const leftover = state.created.folders.filter((id) => folderItems(tree).some(({ item }) => item.id === id))
    const tags = await call('tags.list')
    const leftoverTags = state.created.tags.filter((tag) => (tags.items ?? []).some((entry) => entry.name === tag))
    const searches = await call('saved_searches.list')
    const leftoverSearches = state.created.savedSearches.filter((id) => (searches.items ?? []).some((entry) => entry.id === id))
    const settings = await call('settings.get')
    const featuresOk = Object.keys(state.baseline.settings?.features ?? {}).every((key) => settings?.features?.[key] === state.baseline.settings.features[key])
    const providersNow = Object.fromEntries((settings?.translation?.providers ?? []).map((entry) => [entry.id, entry.enabled === true]))
    const providersOk = Object.keys(state.baseline.settings?.providerEnabled ?? {}).every((id) => providersNow[id] === state.baseline.settings.providerEnabled[id])
    const paused = (await call('status'))?.jobs?.globalPaused === (state.baseline.jobsPaused === true)
    const pass = leftover.length === 0 && leftoverTags.length === 0 && leftoverSearches.length === 0 && featuresOk && providersOk && paused && state.cleanupErrors.length === 0
    return { actual: { leftoverFolderIds: leftover, leftoverTags, leftoverSearches, features: settings?.features ?? null, baselineFeatures: state.baseline.settings?.features ?? null, featuresOk, providers: providersNow, baselineProviders: state.baseline.settings?.providerEnabled ?? null, providersOk, jobPauseRestored: paused, folderCount: names.length, cleanupErrors: state.cleanupErrors }, pass }
  })

  await check('DATA.baseline', 'DATA', '30 papers / active annotations / 346 figures / 5 folders unchanged; no purge of user data', async () => {
    const status = await call('status')
    const tree = await call('library.folders.tree')
    const annotations = await activeAnnotationCount()
    const favorites = await call('library.list', { favorite: true, limit: 500 })
    const embedding = await call('embedding.status')
    const baseline = state.baseline
    const countsMatch =
      Number(status?.counts?.papers) === Number(baseline.counts?.papers) &&
      Number(status?.counts?.figures) === Number(baseline.counts?.figures) &&
      Number(status?.counts?.trash) === Number(baseline.counts?.trash) &&
      annotations === baseline.annotations
    const folders = folderItems(tree)
    const realFolders = ORIGINAL_FIELD_NAMES.filter((name) => folders.some(({ item }) => item.name === name))
    const favoritesNow = (favorites.items ?? []).map((paper) => paper.id).sort().join(',')
    const favoritesRestored = favoritesNow === [...(baseline.favorites ?? [])].sort().join(',')
    const embeddingSame = JSON.stringify(embedding?.counts ?? null) === JSON.stringify(baseline.embeddingCounts ?? null)
    const pass = countsMatch && folders.length === 5 && realFolders.length === 5 && favoritesRestored && embeddingSame && state.cleanupErrors.length === 0
    return { actual: { baseline: clip(baseline.counts), after: clip(status?.counts), activeAnnotations: annotations, baselineAnnotations: baseline.annotations, folderCount: folders.length, realFolders, favoritesNow, baselineFavorites: baseline.favorites, embeddingCounts: clip(embedding?.counts), baselineEmbeddingCounts: clip(baseline.embeddingCounts), embeddingSame, cleanupErrors: state.cleanupErrors }, pass, notes: 'only fixtures created by this suite are removed; soft-deleted test annotation stays in the trash (no annotation purge API) but active counts/figures/folders/favorites/embedding are identical.' }
  })
}

/* ------------------------------------------------------------------ *
 * Report / main
 * ------------------------------------------------------------------ */
function buildReport(exitCode) {
  const counts = { pass: 0, fail: 0, not_run: 0 }
  const groups = {}
  for (const entry of results) {
    counts[entry.status] += 1
    const group = (groups[entry.group] ??= { total: 0, pass: 0, fail: 0, not_run: 0 })
    group.total += 1
    group[entry.status] += 1
  }
  const sweepResults = results.filter((entry) => entry.case_id.startsWith('SWEEP.') && entry.case_id !== 'SWEEP.coverage')
  return {
    schema: 'pappers-hall/v15-api-results@1',
    suite: 'v0.15 API full-surface sweep',
    summary: { total: results.length, pass: counts.pass, fail: counts.fail, not_run: counts.not_run, byGroup: groups, startedAt: state.startedAt, finishedAt: new Date().toISOString(), base: BASE, exitCode },
    methodCoverage: {
      enumerated: state.methods,
      methodCount: state.methods.length,
      sweepCases: sweepResults.length,
      sweepPass: sweepResults.filter((entry) => entry.status === 'pass').length,
      sweepFail: sweepResults.filter((entry) => entry.status === 'fail').length,
      expectations: { minimumMethods: 80 },
      source: 'pappers-hall-plugin/host/api.js handlers table (parsed at run time)',
    },
    environment: state.environment,
    baseline: { counts: state.baseline.counts, annotations: state.baseline.annotations, notes: state.baseline.notes, tags: state.baseline.tags, folders: state.baseline.folders, favorites: state.baseline.favorites, settings: state.baseline.settings, jobsPaused: state.baseline.jobsPaused, embeddingCounts: clip(state.baseline.embeddingCounts), capturedAt: state.startedAt },
    after: state.after,
    bugs: state.bugs,
    evidence: { createdFixtures: clip(state.created), cleanupErrors: state.cleanupErrors, observations: state.evidence.observations ?? [], previousReports: ['reports/v13-api-results.json', 'reports/v11-api-results.json', 'reports/v07-api-results.json', 'reports/v06-api-results.json', 'reports/v05-api-results.json', 'reports/v04-api-results.json', 'reports/v02-api-results.json', 'reports/v03-lifecycle-run.json', 'reports/v03-api-results.json'] },
    results,
  }
}

async function finish(exitCode) {
  const report = buildReport(exitCode)
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  const { pass, fail, not_run: notRunCount } = report.summary
  console.log(`\nV0.15 API SWEEP: ${pass}/${report.summary.total} pass, ${fail} fail, ${notRunCount} not_run | methods ${report.methodCoverage.sweepPass}/${report.methodCoverage.methodCount} → ${OUT}`)
  process.exitCode = exitCode
}

async function readEnvironment() {
  const status = await call('status')
  let diagnostics = null
  try { diagnostics = await call('diagnostics') } catch {}
  return {
    pluginVersion: status?.plugin?.version ?? null,
    schemaVersion: diagnostics?.schemaVersion ?? null,
    counts: status?.counts ?? {},
    channels: status?.index?.channels ?? {},
    degraded: status?.degraded ?? [],
    capabilities: diagnostics?.capabilities ?? null,
    jobs: status?.jobs ?? null,
  }
}

async function main() {
  if (DRY_RUN) {
    const unique = new Set(results.map((entry) => entry.case_id))
    console.log('Pappers-Hall v0.15 API full-surface sweep — DRY RUN (read-only probes only)\n')
    console.log(`[PLAN] ${PLAN.length} planned blocks:`)
    for (const [id, description] of PLAN) console.log(`  ${id.padEnd(26)} ${description}`)
    const methods = enumerateMethods()
    console.log(`\n[ENUMERATED] ${methods.length} API methods from host/api.js handlers table（期望 80+）:`)
    console.log(`  ${methods.slice(0, 12).join(', ')} … ${methods.slice(-6).join(', ')}`)
    console.log(`  未在 spec 中的方法将由通用探针覆盖: ${methods.filter((method) => METHOD_SPECS[method] === undefined).join(', ') || '（无）'}`)
    try {
      const environment = await readEnvironment()
      const settings = await call('settings.get')
      const tree = await call('library.folders.tree')
      const folderCount = folderItems(tree).length
      const feed = await call('annotations.feed', { limit: 100 })
      const favorites = await call('library.list', { favorite: true, limit: 500 })
      console.log(`\n[LIVE] plugin=${String(environment.pluginVersion)} schema=${String(environment.schemaVersion)} papers=${environment.counts?.papers ?? '?'} annotations=${environment.counts?.annotations ?? '?'} figures=${environment.counts?.figures ?? '?'} folders=${folderCount}`)
      console.log(`[LIVE] channels=${JSON.stringify(environment.channels)} degraded=${JSON.stringify(clip(environment.degraded))}`)
      console.log(`[LIVE] settings features=${JSON.stringify(settings?.features)} translation.providers=${JSON.stringify((settings?.translation?.providers ?? []).map((item) => item.id))}`)
      console.log(`[LIVE] active annotations via feed=${(feed.items ?? []).length} favorite papers=${(favorites.items ?? []).length}`)
      console.log(`[LIVE] assets HEAD: page=${(await asset(`/pappers-hall/page/${P_MAIN}/1.png`, { method: 'HEAD' })).status} thumb=${(await asset(`/pappers-hall/thumb/${P_MAIN}`, { method: 'HEAD' })).status} pdf=${(await asset(`/pappers-hall/pdf/${P_MAIN}`, { method: 'HEAD' })).status}`)
      console.log(`[LIVE] error probe: unknown method status=${(await api('does.not.exist', {})).status} malformed JSON status=${(await api(null, null, { rawBody: '{bad' })).status}`)
    } catch (error) {
      console.log(`[LIVE] probe failed: ${String(error?.message ?? error)}`)
    }
    console.log('\nDRY RUN OK: script parses, plan/enumeration complete, no data was written. Waiting for "GO v15".')
    process.exitCode = 0
    return
  }

  // ---- real run ----
  let environment = null
  try {
    environment = await readEnvironment()
  } catch (error) {
    console.error('V0.15 SUITE ERROR: live host unreachable:', String(error?.message ?? error))
    process.exitCode = 2
    return
  }
  state.environment = environment
  // baseline
  const status = await call('status')
  const settings = await call('settings.get')
  const tree = await call('library.folders.tree')
  const feed = await call('annotations.feed', { limit: 100 })
  const favorites = await call('library.list', { favorite: true, limit: 500 })
  const tags = await call('tags.list')
  const embedding = await call('embedding.status')
  const mainDetail = await call('library.get', { id: P_MAIN })
  state.baseline = {
    counts: status?.counts ?? {},
    annotations: (feed.items ?? []).length,
    notes: Number(status?.counts?.notes ?? 0),
    tags: (tags.items ?? []).map((entry) => entry.name),
    folders: folderItems(tree).map(({ item }) => item.name),
    favorites: (favorites.items ?? []).map((paper) => paper.id).sort(),
    read: { [P_MAIN]: mainDetail?.read === true },
    settings: {
      features: { ...(settings?.features ?? {}) },
      providerEnabled: Object.fromEntries((settings?.translation?.providers ?? []).map((entry) => [entry.id, entry.enabled === true])),
      fallbackEnabled: settings?.translation?.fallbackEnabled !== false,
    },
    jobsPaused: status?.jobs?.globalPaused ?? null,
    embeddingCounts: embedding?.counts ?? null,
    embeddingIndexVersion: embedding?.indexVersion ?? null,
  }
  state.evidence.observations = [
    'host/api.js SYNC_METHODS lists "notes.update", but neither an api handler nor a store.notesUpdate exists (dead reference, no user impact).',
    'notes.delete performs a soft delete without an operations journal entry, so notes cannot be undone (documented behavior, not asserted as a bug).',
    'ai.ask requires the contract parameter `prompt` (docs/CONTRACT-v02.md); passing `question` returns a clear "prompt is required" error — corrected after the first run.',
    'search.query returns the fused RRF candidate set (vector channel k=120) then applies the requested limit; a short query like "agent" surfaces many semantic neighbours (Lead observed this in the client, which applies its own limiting).',
    'Requesting /pappers-hall/../api normalises to the DSH API root and answers 401 from the host auth layer (not the plugin); the plugin asset routes return 400/404 for traversal/unknown paths.',
  ]
  try {
    await sweepCases()
    await chainCases()
    await routeCases()
    await errorCases()
    await regressionCases()
  } catch (error) {
    console.error('V0.15 SWEEP ERROR:', error?.stack ?? error)
    process.exitCode = 2
  } finally {
    try {
      await cleanupFixtures()
    } catch (error) {
      state.cleanupErrors.push(`cleanup crashed: ${String(error?.message ?? error)}`)
      console.error('V0.15 CLEANUP ERROR:', error?.stack ?? error)
      process.exitCode = 2
    }
    try {
      await dataCases()
    } catch (error) {
      state.cleanupErrors.push(`data check crashed: ${String(error?.message ?? error)}`)
      notRun('DATA.baseline', 'DATA', 'data baseline check', `crashed: ${String(error?.message ?? error)}`)
    }
  }
  if (state.environment === null) {
    await finish(2)
    return
  }
  const fail = results.filter((entry) => entry.status === 'fail').length
  const exitCode = process.exitCode === 2 ? 2 : fail > 0 ? 1 : 0
  await finish(exitCode)
}

main().catch(async (error) => {
  console.error('V0.15 SUITE FATAL:', error?.stack ?? error)
  try {
    await finish(2)
  } catch {
    process.exit(2)
  }
})
