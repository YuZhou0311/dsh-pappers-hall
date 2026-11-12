#!/usr/bin/env node
/**
 * Pappers-Hall v0.7 API acceptance suite.
 *
 * Covers docs/CONTRACT-v07.md:
 * - STATUS: `status.degraded` must be DYNAMIC — no `vector` entry while the
 *   embedding index is ready, no `translation` entry while the free engine chain
 *   works, and the remaining `ocr` entry must carry user-readable wording plus an
 *   optional marker; `diagnostics.capabilities.vector/translation` must agree with
 *   `status` and `status.index.channels.fts` stays ready.
 * - FILTERS (data plane behind the right-sidebar fix): `annotations.feed`
 *   folderId (including descendants) / tags / colors / query combinations, and
 *   `library.list` folderId/favorite/tags combinations keep AND semantics.
 * - REF: v0.6 (31/32 + tool harness 8/8), v0.5 42/43, v0.4 34/34, v0.2 26/26,
 *   lifecycle 12/0/1 and the agreed v0.3 explanation.
 * - DATA: 30 papers / 21 annotations / 346 figures unchanged, the real former
 *   5 folders untouched, no user data purged, embedding index kept.
 *
 * The GUI sidebar fix itself (folder/tag/favorite chips updating the paper list)
 * is verified by the Lead in the browser; this suite proves the API data plane
 * and status semantics it depends on.
 *
 * Usage:
 *   node test/v07.mjs --dry-run   # plan + read-only probe
 *   node test/v07.mjs             # real run (requires v0.7 host loaded)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
const OUT = resolve(HERE, arg('--out', '../../reports/v07-api-results.json'))
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

const ORIGINAL_FIELD_NAMES = ['大语言模型与 Agent', '强化学习与决策', '多模态与文档检索', '遥感与地球观测', '作物模拟与农业系统']
const KNOWN_FREE_PROVIDERS = ['google', 'mymemory', 'libretranslate', 'llm']
const KNOWN_CHANNELS = ['vector', 'ocr', 'translation', 'fts', 'ai', 'pdfText', 'pageRender', 'figureCrop', 'dhash']

const P_AGENT = arg('--paper-agent', 'ph-53132d8d95a6') // ReAct: 4 yellow annotations, tags 推理 + LLM Agent
const P_CROP = arg('--paper-crop', 'ph-8d90723ee7bc') // irrigation: 2 annotations

const PLAN = [
  ['ENV.version', 'ENV', 'v0.7 Host loaded: plugin 0.7.x or dynamic status.degraded (vector ready → absent) with capabilities.translation=ready'],
  ['ENV.baseline', 'ENV', 'library baseline captured: 30 papers / 21 annotations / 346 figures / trash 0, 5 former-domain folders, favorites + embedding ready'],
  ['STATUS.degraded.vectorAbsent', 'STATUS', 'embedding ready → status.degraded has NO vector entry; index.channels.vector=ready; capabilities.vector=ready'],
  ['STATUS.degraded.translation', 'STATUS', 'free translation chain available → capabilities.translation=ready, degraded has no translation entry, live translate.text probe succeeds'],
  ['STATUS.degraded.ocr', 'STATUS', 'if ocr stays degraded its reason is user-readable (未安装/扫描) and severity/optional marks it optional; capabilities.ocr=unavailable agrees'],
  ['STATUS.degraded.fts', 'STATUS', 'index.channels.fts=ready and status.degraded never lists fts'],
  ['STATUS.consistency', 'STATUS', 'status.degraded / status.index.channels / diagnostics.capabilities agree for vector, translation, ocr, fts (raw payload recorded)'],
  ['FILTERS.feed.folderId', 'FILTERS', 'annotations.feed {folderId} returns only annotations whose paper is inside that folder (descendants included), count ≤ unfiltered'],
  ['FILTERS.feed.tags', 'FILTERS', 'annotations.feed {tags:[推理]} only annotations of papers carrying every tag; AND with LLm Agent narrows to A01; unknown tag yields 0'],
  ['FILTERS.feed.query', 'FILTERS', 'annotations.feed {query:灌溉} returns only annotations whose quote/comment/title contains the query'],
  ['FILTERS.feed.combo', 'FILTERS', 'annotations.feed {folderId+tags+colors} combination is AND: every item satisfies folder AND tags AND color'],
  ['FILTERS.feed.descendants', 'FILTERS', 'annotations.feed folderId includes papers attached to descendant folders (independent temp root/child folder fixture)'],
  ['FILTERS.feed.empty', 'FILTERS', 'an impossible tag filter returns 0 items and hasMore=false instead of ignoring the filter'],
  ['FILTERS.list.combo', 'FILTERS', 'library.list {folderId+tags} keeps AND semantics (LLM folder + 推理 → A01 only; crop folder + 推理 → 0)'],
  ['FILTERS.list.favorite', 'FILTERS', 'library.list {favorite} and {folderId+tags+favorite} reflect a real favorite toggle (baseline restored)'],
  ['REF.v06', 'REF', 'recorded v0.6 API result file still reports 32 cases: 31 pass, 0 fail, 1 not_run'],
  ['REF.v06.harness', 'REF', 'recorded v0.6 tool harness still reports ok=true with all 8 cases passing'],
  ['REF.v05', 'REF', 'recorded v0.5 API result file still reports 43 cases: 42 pass, 0 fail, 1 not_run'],
  ['REF.v04', 'REF', 'recorded v0.4 API result file still reports 34/34 pass'],
  ['REF.v02', 'REF', 'recorded v0.2 API result file still reports 26/26 pass'],
  ['REF.lifecycle', 'REF', 'recorded lifecycle result file still reports 13 cases: 12 pass, 0 fail, 1 not_run'],
  ['REF.v03', 'REF', 'v0.3 expectation unchanged: historical 38/38 + current v0.4 re-run only fails the 3 AI-fast cases explained by v0.4 routing'],
  ['CLEANUP.filters', 'CLEANUP', 'temp folders deleted, A01 membership back to baseline, favorite restored, no test tags left'],
  ['REF.data.preserved', 'REF', 'after cleanup: papers/annotations/figures/trash unchanged, real 5 folders intact, favorites restored, embedding index kept'],
]

const results = []
const startedAt = new Date().toISOString()
const state = {
  startedAt,
  base: BASE,
  environment: null,
  baseline: { counts: null, folders: null, favoriteIds: [], embedding: null, memberships: {} },
  createdFolderIds: [],
  status: null,
  diagnostics: null,
  after: {},
  evidence: {},
  cleanupErrors: [],
}

const EXPECTED = new Map(PLAN.map(([id, group, expected]) => [id, { group, expected }]))
const recordedIds = new Set()

/* ------------------------------------------------------------------ *
 * HTTP / recording helpers (same robustness as the v0.6 suite: Host HMR during
 * an acceptance run answers 405/502 without the JSON envelope; retry those)
 * ------------------------------------------------------------------ */
async function call(method, params = {}, timeoutMs = 120_000) {
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
          throw error
        }
        return body.data
      }
    } catch (error) {
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
const uniqueName = (label) => `v07-${label}-${RUN_STAMP}`

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
function flattenFolders(data) {
  const flat = []
  const visit = (items, depth) => {
    for (const item of items ?? []) {
      if (item === null || typeof item !== 'object') continue
      flat.push({ item, depth })
      if (Array.isArray(item.children)) visit(item.children, depth + 1)
    }
  }
  visit(data?.items, 0)
  return flat
}

async function tree() {
  return call('library.folders.tree', {}, 30_000)
}

async function folderByName(name) {
  const data = await tree()
  return flattenFolders(data).find((entry) => entry.item.name === name)?.item ?? null
}

async function allowedPaperIds(filters) {
  const list = await call('library.list', { ...filters, limit: 500 }, 60_000)
  return new Set((list.items ?? []).map((paper) => paper.id))
}

async function annotateFeed(params) {
  return call('annotations.feed', { limit: 100, ...params }, 60_000)
}

function channelsOfDegraded(degraded) {
  return (Array.isArray(degraded) ? degraded : []).map((entry) => String(entry?.channel ?? entry?.name ?? '')).filter((value) => value !== '')
}

function feedText(annotation) {
  return [annotation?.quote, annotation?.comment, annotation?.paperTitle, annotation?.paperTitleOriginal]
    .filter((value) => typeof value === 'string')
    .join('\n')
}

const folderCollectionsOf = (detail) => (Array.isArray(detail?.collections) ? detail.collections : []).map((item) => item.id).sort()

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
  return {
    status,
    diagnostics,
    pluginVersion: status?.plugin?.version ?? null,
    schemaVersion: diagnostics?.schemaVersion ?? null,
    counts: status?.counts ?? {},
    channels: status?.index?.channels ?? {},
    degraded: status?.degraded ?? [],
    capabilities: diagnostics?.capabilities ?? null,
    translationProviders: diagnostics?.translationProviders ?? null,
    embedding: diagnostics?.embedding ?? null,
  }
}

/** Dynamic v0.7 signal: vector ready but no longer listed as degraded (plus translation ready). */
function looksLikeV07(environment) {
  const channels = environment.channels ?? {}
  const degradedChannels = channelsOfDegraded(environment.degraded)
  const dynamicVector = channels.vector === 'ready' && !degradedChannels.includes('vector')
  const translationReady = environment.capabilities?.translation === 'ready'
  return dynamicVector && translationReady
}

async function envCases() {
  const environment = await readEnvironment()
  state.environment = {
    plugin: environment.status?.plugin ?? null,
    schemaVersion: environment.schemaVersion,
    counts: environment.counts,
    channels: environment.channels,
    degraded: environment.degraded,
    capabilities: environment.capabilities,
    translationProviders: environment.translationProviders,
    embedding: environment.embedding,
    versions: environment.diagnostics?.versions ?? null,
  }
  state.status = environment.status
  state.diagnostics = environment.diagnostics

  const version = String(environment.pluginVersion ?? '')
  const v07Loaded = version.startsWith('0.7') || looksLikeV07(environment)
  record(
    'ENV.version',
    EXPECTED.get('ENV.version').expected,
    {
      pluginVersion: version || null,
      schemaVersion: environment.schemaVersion,
      dynamicDegraded: looksLikeV07(environment),
      degraded: clipValue(environment.degraded),
      channels: environment.channels,
      capabilities: clipValue(environment.capabilities),
    },
    v07Loaded,
  )
  if (!v07Loaded) {
    console.error(`\nV0.7 GATE: plugin ${version || 'unknown'}, degraded includes vector=${channelsOfDegraded(environment.degraded).includes('vector')}, capabilities.translation=${String(environment.capabilities?.translation)}; refusing mutations until the Lead reloads v0.7 and sends "GO v07".`)
    await finish(2)
    return false
  }

  await check('ENV.baseline', EXPECTED.get('ENV.baseline').expected, async () => {
    const counts = environment.counts ?? {}
    const treeData = await tree()
    const flat = flattenFolders(treeData)
    const favorites = await call('library.list', { favorite: true, limit: 500 }).catch(() => ({ items: [] }))
    state.baseline.counts = counts
    state.baseline.folders = flat.map(({ item, depth }) => ({ id: item.id, name: item.name, kind: item.kind, count: item.count, depth }))
    state.baseline.favoriteIds = (favorites.items ?? []).map((paper) => paper.id).sort()
    state.baseline.embedding = environment.embedding ? clipValue(environment.embedding) : null
    state.baseline.memberships[P_AGENT] = folderCollectionsOf(await call('library.get', { id: P_AGENT }, 30_000))
    const pass = Number(counts.papers ?? 0) >= 30 && Number(counts.annotations ?? 0) === 21 && Number(counts.trash ?? -1) === 0 && ORIGINAL_FIELD_NAMES.every((name) => flat.some(({ item }) => item.name === name))
    return {
      actual: {
        counts,
        folderCount: flat.length,
        originalFolders: ORIGINAL_FIELD_NAMES.map((name) => flat.find(({ item }) => item.name === name)?.item?.id ?? null),
        favoriteIds: state.baseline.favoriteIds,
        embedding: { available: environment.embedding?.available ?? null, indexReady: environment.embedding?.indexReady ?? null, indexVersion: environment.embedding?.indexVersion ?? null },
        agentMembership: state.baseline.memberships[P_AGENT],
      },
      pass,
    }
  })
  return true
}

/* ------------------------------------------------------------------ *
 * STATUS
 * ------------------------------------------------------------------ */
async function statusCases() {
  const status = state.status ?? (await call('status'))
  const diagnostics = state.diagnostics ?? (await call('diagnostics'))
  const degraded = Array.isArray(status?.degraded) ? status.degraded : []
  const degradedChannels = channelsOfDegraded(degraded)
  const channels = status?.index?.channels ?? {}
  const capabilities = diagnostics?.capabilities ?? {}

  await check('STATUS.degraded.vectorAbsent', EXPECTED.get('STATUS.degraded.vectorAbsent').expected, async () => {
    const embeddingStatus = await call('embedding.status', {}, 30_000)
    const embeddingReady = embeddingStatus?.available === true && embeddingStatus?.indexReady === true
    const vectorEntry = degraded.find((entry) => String(entry?.channel) === 'vector') ?? null
    const pass = embeddingReady && channels.vector === 'ready' && capabilities.vector === 'ready' && vectorEntry === null
    return {
      actual: {
        embeddingReady,
        embedding: { available: embeddingStatus?.available ?? null, indexReady: embeddingStatus?.indexReady ?? null, indexVersion: embeddingStatus?.indexVersion ?? null },
        channels,
        capabilities: { vector: capabilities.vector ?? null, translation: capabilities.translation ?? null, ocr: capabilities.ocr ?? null, fts: capabilities.fts ?? null },
        degradedChannels,
        vectorEntry,
        degraded: clipValue(degraded),
      },
      pass,
      notes: 'contract §1: ready vector must never appear in status.degraded (this was the user complaint about the bottom bar).',
    }
  })

  await check('STATUS.degraded.translation', EXPECTED.get('STATUS.degraded.translation').expected, async () => {
    const translationEntry = degraded.find((entry) => String(entry?.channel) === 'translation') ?? null
    const providers = diagnostics?.translationProviders ?? null
    let probe = null
    for (let attempt = 0; attempt < 2 && (probe === null || probe.status === null); attempt += 1) {
      probe = await measure(() => call('translate.text', { text: 'The proposed method improves retrieval accuracy.', target: 'zh' }, 120_000))
      if (probe.error !== null) {
        probe = { ...probe, status: null }
        await sleep(1500)
      } else {
        probe = { ...probe, status: probe.data?.status ?? null }
      }
    }
    const probeTranslated = probe?.status === 'translated'
    const providersOk = providers === null || (Array.isArray(providers) && providers.some((entry) => KNOWN_FREE_PROVIDERS.includes(String(entry?.id ?? entry))))
    const pass = capabilities.translation === 'ready' && translationEntry === null && providersOk && probeTranslated
    return {
      actual: {
        capabilitiesTranslation: capabilities.translation ?? null,
        translationEntry,
        translationProviders: clipValue(providers),
        probe: probe === null ? null : { status: probe.status, ms: probe.ms, engine: probe.data?.engine ?? null, translated: probe.data?.translation ?? null, error: probe.error },
        degradedChannels,
      },
      pass,
      notes: 'free chain (google/mymemory) + LLM fallback is available here, so translation must be ready and absent from degraded.',
    }
  })

  await check('STATUS.degraded.ocr', EXPECTED.get('STATUS.degraded.ocr').expected, async () => {
    const ocrEntry = degraded.find((entry) => String(entry?.channel) === 'ocr') ?? null
    const reason = String(ocrEntry?.reason ?? '')
    const severity = ocrEntry?.severity ?? null
    const optionalFlag = ocrEntry?.optional
    const readabilityOk = /未安装|扫描|OCR/i.test(reason)
    const optionalOk = (severity === null || severity === undefined || String(severity) === 'optional') && (optionalFlag === null || optionalFlag === undefined || optionalFlag === true)
    const capabilitiesConsistent = ocrEntry === null || capabilities.ocr === 'unavailable' || capabilities.ocr === 'degraded'
    const pass = ocrEntry === null || (readabilityOk && optionalOk && capabilitiesConsistent)
    return {
      actual: {
        ocrEntry: ocrEntry === null ? null : clipValue(ocrEntry),
        reason,
        severity,
        optional: optionalFlag,
        capabilitiesOcr: capabilities.ocr ?? null,
        degradedChannels,
      },
      pass,
      notes: ocrEntry === null ? 'OCR engine is installed in this environment, so no ocr entry is expected.' : 'ocr entry must be user-readable and optional.',
    }
  })

  await check('STATUS.degraded.fts', EXPECTED.get('STATUS.degraded.fts').expected, async () => {
    const ftsEntry = degraded.find((entry) => String(entry?.channel) === 'fts') ?? null
    const pass = channels.fts === 'ready' && ftsEntry === null
    return { actual: { channels, ftsEntry, degradedChannels }, pass }
  })

  await check('STATUS.consistency', EXPECTED.get('STATUS.consistency').expected, async () => {
    const issues = []
    if (channels.vector === 'ready' && degradedChannels.includes('vector')) issues.push('vector ready but degraded')
    if (channels.vector !== 'ready' && !degradedChannels.includes('vector')) issues.push('vector not ready but not in degraded')
    if (capabilities.translation === 'ready' && degradedChannels.includes('translation')) issues.push('translation ready but degraded')
    if (capabilities.translation !== 'ready' && !degradedChannels.includes('translation')) issues.push('translation unavailable but not in degraded')
    if (capabilities.vector === 'ready' && degradedChannels.includes('vector')) issues.push('capabilities.vector ready but degraded')
    if (channels.fts !== 'ready') issues.push(`fts channel is ${String(channels.fts)}`)
    const unknown = degradedChannels.filter((channel) => !KNOWN_CHANNELS.includes(channel))
    if (unknown.length > 0) issues.push(`unknown degraded channels: ${unknown.join(',')}`)
    return {
      actual: {
        degradedChannels,
        channels,
        capabilities: { vector: capabilities.vector ?? null, translation: capabilities.translation ?? null, ocr: capabilities.ocr ?? null, fts: capabilities.fts ?? null },
        degraded: clipValue(degraded),
        issues,
      },
      pass: issues.length === 0,
    }
  })
}

/* ------------------------------------------------------------------ *
 * FILTERS
 * ------------------------------------------------------------------ */
async function filterCases() {
  const cropFolder = await folderByName('作物模拟与农业系统')
  const llmFolder = await folderByName('大语言模型与 Agent')
  const cropFolderId = cropFolder?.id ?? null
  const llmFolderId = llmFolder?.id ?? null

  const unfiltered = await annotateFeed({})
  const unfilteredItems = unfiltered.items ?? []
  state.evidence.unfilteredFeed = { count: unfilteredItems.length, hasMore: unfiltered.hasMore ?? null }

  await check('FILTERS.feed.folderId', EXPECTED.get('FILTERS.feed.folderId').expected, async () => {
    const allowed = await allowedPaperIds({ folderId: cropFolderId })
    const filtered = await annotateFeed({ folderId: cropFolderId })
    const items = filtered.items ?? []
    const outside = items.filter((annotation) => !allowed.has(annotation.paperId))
    const pass = cropFolderId !== null && items.length > 0 && items.length <= unfilteredItems.length && outside.length === 0
    return {
      actual: {
        folder: { id: cropFolderId, name: cropFolder?.name ?? null },
        allowedPapers: allowed.size,
        unfilteredCount: unfilteredItems.length,
        filteredCount: items.length,
        outsideFolder: outside.slice(0, 5).map((annotation) => ({ id: annotation.id, paperId: annotation.paperId })),
        hasMore: filtered.hasMore ?? null,
        sample: items.slice(0, 4).map((annotation) => ({ id: annotation.id, paperId: annotation.paperId, paperTitle: annotation.paperTitle })),
      },
      pass,
    }
  })

  await check('FILTERS.feed.tags', EXPECTED.get('FILTERS.feed.tags').expected, async () => {
    const tags = ['推理']
    const allowed = await allowedPaperIds({ tags })
    const filtered = await annotateFeed({ tags })
    const items = filtered.items ?? []
    const outside = items.filter((annotation) => !allowed.has(annotation.paperId))
    const bothTags = await annotateFeed({ tags: ['推理', 'LLM Agent'] })
    const bothTagsAllowed = await allowedPaperIds({ tags: ['推理', 'LLM Agent'] })
    const bothTagsOutside = (bothTags.items ?? []).filter((annotation) => !bothTagsAllowed.has(annotation.paperId))
    const missing = await annotateFeed({ tags: ['推理', 'v07-does-not-exist'] })
    const pass =
      items.length > 0 &&
      items.length <= unfilteredItems.length &&
      outside.length === 0 &&
      bothTagsOutside.length === 0 &&
      (bothTags.items ?? []).length > 0 &&
      (bothTags.items ?? []).length <= items.length &&
      (missing.items ?? []).length === 0
    return {
      actual: {
        tags,
        allowedPapers: allowed.size,
        filteredCount: items.length,
        outsideTag: outside.slice(0, 5).map((annotation) => ({ id: annotation.id, paperId: annotation.paperId })),
        bothTags: { tags: ['推理', 'LLM Agent'], allowedPapers: bothTagsAllowed.size, count: (bothTags.items ?? []).length, papers: [...new Set((bothTags.items ?? []).map((annotation) => annotation.paperId))] },
        missingTagCount: (missing.items ?? []).length,
        sample: items.slice(0, 4).map((annotation) => ({ id: annotation.id, paperId: annotation.paperId, color: annotation.color })),
      },
      pass,
    }
  })

  await check('FILTERS.feed.query', EXPECTED.get('FILTERS.feed.query').expected, async () => {
    const query = '灌溉'
    const filtered = await annotateFeed({ query })
    const items = filtered.items ?? []
    const mismatched = items.filter((annotation) => !feedText(annotation).toLowerCase().includes(query.toLowerCase()))
    const pass = items.length > 0 && items.length <= unfilteredItems.length && mismatched.length === 0
    return {
      actual: {
        query,
        filteredCount: items.length,
        unfilteredCount: unfilteredItems.length,
        mismatched: mismatched.slice(0, 3).map((annotation) => ({ id: annotation.id, quote: String(annotation.quote ?? '').slice(0, 40), title: annotation.paperTitle })),
        sample: items.slice(0, 3).map((annotation) => ({ id: annotation.id, paperId: annotation.paperId, quote: String(annotation.quote ?? '').slice(0, 50) })),
      },
      pass,
    }
  })

  await check('FILTERS.feed.combo', EXPECTED.get('FILTERS.feed.combo').expected, async () => {
    const tags = ['推理']
    const colors = ['yellow']
    const allowed = await allowedPaperIds({ folderId: llmFolderId, tags })
    const filtered = await annotateFeed({ folderId: llmFolderId, tags, colors })
    const items = filtered.items ?? []
    const violations = items.filter((annotation) => !allowed.has(annotation.paperId) || String(annotation.color) !== 'yellow')
    const pass = llmFolderId !== null && items.length > 0 && items.length <= unfilteredItems.length && violations.length === 0
    return {
      actual: {
        filters: { folderId: llmFolderId, folderName: llmFolder?.name ?? null, tags, colors },
        allowedPapers: allowed.size,
        filteredCount: items.length,
        violations: violations.slice(0, 5).map((annotation) => ({ id: annotation.id, paperId: annotation.paperId, color: annotation.color })),
        sample: items.slice(0, 4).map((annotation) => ({ id: annotation.id, paperId: annotation.paperId, color: annotation.color })),
      },
      pass,
    }
  })

  await check('FILTERS.feed.descendants', EXPECTED.get('FILTERS.feed.descendants').expected, async () => {
    const root = await call('library.collections.create', { name: uniqueName('temp-root'), operationId: `v07-desc-root-${RUN_STAMP}` }, 30_000)
    const rootId = root?.collection?.id ?? root?.folder?.id ?? root?.id ?? null
    if (typeof rootId !== 'string') return { actual: { createRoot: clipValue(root) }, pass: false }
    state.createdFolderIds.push(rootId)
    const child = await call('library.collections.create', { name: uniqueName('temp-child'), parentId: rootId, operationId: `v07-desc-child-${RUN_STAMP}` }, 30_000)
    const childId = child?.collection?.id ?? child?.folder?.id ?? child?.id ?? null
    if (typeof childId !== 'string') return { actual: { rootId, createChild: clipValue(child) }, pass: false }
    state.createdFolderIds.push(childId)
    await call('library.collections.assign', { collectionId: childId, paperIds: [P_AGENT], add: true, operationId: `v07-desc-assign-${RUN_STAMP}` }, 30_000)
    const listByRoot = await call('library.list', { folderId: rootId, limit: 200 })
    const feedByRoot = await annotateFeed({ folderId: rootId })
    const baselineFeed = await annotateFeed({ paperId: P_AGENT })
    const listIncludesAgent = (listByRoot.items ?? []).some((paper) => paper.id === P_AGENT)
    const items = feedByRoot.items ?? []
    const allowed = new Set((listByRoot.items ?? []).map((paper) => paper.id))
    const outside = items.filter((annotation) => !allowed.has(annotation.paperId))
    const expectedAgentAnnotations = (baselineFeed.items ?? []).length
    const includesAgentAnnotations = items.some((annotation) => annotation.paperId === P_AGENT)
    const pass = listIncludesAgent && includesAgentAnnotations && items.length >= expectedAgentAnnotations && outside.length === 0
    return {
      actual: {
        rootId,
        childId,
        listIncludesAgent,
        expectedAgentAnnotations,
        feedCount: items.length,
        includesAgentAnnotations,
        outsideSubtree: outside.slice(0, 3).map((annotation) => ({ id: annotation.id, paperId: annotation.paperId })),
        agentAnnotations: items.filter((annotation) => annotation.paperId === P_AGENT).length,
      },
      pass,
      notes: 'root has no direct papers; paper sits in the descendant folder, so any returned annotation proves descendant inclusion.',
    }
  })

  await check('FILTERS.feed.empty', EXPECTED.get('FILTERS.feed.empty').expected, async () => {
    const missingTag = await annotateFeed({ tags: [`v07-missing-${RUN_STAMP}`] })
    const missingColor = await annotateFeed({ colors: ['green'] })
    const pass = (missingTag.items ?? []).length === 0 && missingTag.hasMore === false && (missingColor.items ?? []).length < unfilteredItems.length
    return {
      actual: {
        missingTag: { count: (missingTag.items ?? []).length, hasMore: missingTag.hasMore ?? null },
        greenColor: { count: (missingColor.items ?? []).length, hasMore: missingColor.hasMore ?? null },
        unfilteredCount: unfilteredItems.length,
      },
      pass,
    }
  })

  await check('FILTERS.list.combo', EXPECTED.get('FILTERS.list.combo').expected, async () => {
    const llmCombo = await call('library.list', { folderId: llmFolderId, tags: ['推理'], limit: 500 })
    const cropCombo = await call('library.list', { folderId: cropFolderId, tags: ['推理'], limit: 500 })
    const llmIds = (llmCombo.items ?? []).map((paper) => paper.id)
    const cropIds = (cropCombo.items ?? []).map((paper) => paper.id)
    const tagAllowed = await allowedPaperIds({ tags: ['推理'] })
    const violations = llmIds.filter((id) => !tagAllowed.has(id))
    const pass = llmFolderId !== null && cropFolderId !== null && llmIds.length === 1 && llmIds[0] === P_AGENT && cropIds.length === 0 && violations.length === 0
    return {
      actual: {
        llmFolder: { id: llmFolderId, total: llmCombo.total, ids: llmIds },
        cropFolder: { id: cropFolderId, total: cropCombo.total, ids: cropIds },
        tagAllowedPapers: tagAllowed.size,
        violations,
      },
      pass,
    }
  })

  await check('FILTERS.list.favorite', EXPECTED.get('FILTERS.list.favorite').expected, async () => {
    const baseline = state.baseline.favoriteIds ?? []
    if (!baseline.includes(P_AGENT)) {
      await call('library.setFavorite', { ids: [P_AGENT], favorite: true, operationId: `v07-fav-set-${RUN_STAMP}` }, 30_000)
    }
    const favoriteList = await call('library.list', { favorite: true, limit: 500 })
    const favoriteIds = (favoriteList.items ?? []).map((paper) => paper.id)
    const combo = await call('library.list', { folderId: llmFolderId, tags: ['推理'], favorite: true, limit: 500 })
    const comboIds = (combo.items ?? []).map((paper) => paper.id)
    const pass = favoriteIds.includes(P_AGENT) && comboIds.includes(P_AGENT) && comboIds.length === 1
    return {
      actual: {
        baselineFavoriteIds: baseline,
        favoriteIds,
        favoriteTotal: favoriteList.total ?? null,
        combo: { folderId: llmFolderId, tags: ['推理'], favorite: true, ids: comboIds, total: combo.total ?? null },
      },
      pass,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Regression evidence
 * ------------------------------------------------------------------ */
async function regressionCases() {
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
    const pass = report.exists && harness?.ok === true && cases.length === 8 && failures.length === 0 && Number(harness?.livePaperCountBefore) === Number(harness?.livePaperCountAfter)
    return {
      actual: { path: report.path, harnessOk: harness?.ok ?? false, caseCount: cases.length, failures, livePapers: [harness?.livePaperCountBefore ?? null, harness?.livePaperCountAfter ?? null], promptSections: harness?.promptSections ?? null },
      pass,
    }
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
    const pass = report.exists && Number(summary.total) === 34 && Number(summary.pass) === 34 && Number(summary.fail) === 0 && Number(summary.not_run) === 0
    return { actual: { path: report.path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, not_run: summary.not_run ?? null }, pass }
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
      llmFastProbe = await call('translate.text', { text: 'The proposed method improves retrieval accuracy on three benchmarks.', target: 'zh', provider: 'llm', fast: true }, 120_000)
    } catch (error) {
      llmFastProbe = { error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
    }
    const llmFastOk = llmFastProbe?.status === 'translated' && llmFastProbe?.fast === true && Object.hasOwn(llmFastProbe ?? {}, 'reasoningEffort')
    const pass = (Number(summary.pass) === 38 && Number(summary.fail) === 0) || (explained && llmFastOk && historical38)
    return {
      actual: { path: report.path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, failingCases: failing, knownAiFastRoutingExplanation: explained, historical38, llmFastOk },
      pass,
      notes: 'v0.3 expectations unchanged: historical 38/38 in reports/verify.md §13–§18; current 35/38 is the v0.4 translate.text routing change proven live by the llm-fast probe.',
    }
  })
}

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */
async function cleanupCases() {
  for (const folderId of [...state.createdFolderIds].reverse()) {
    try {
      await call('library.collections.delete', { id: folderId, operationId: `v07-clean-folder-${folderId}` }, 30_000)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!/not.?found|does not exist/i.test(message)) state.cleanupErrors.push(`folder delete ${folderId}: ${message}`)
    }
  }
  // restore the favorite baseline captured at ENV.baseline
  try {
    const baseline = state.baseline.favoriteIds ?? []
    const current = new Set((await call('library.list', { favorite: true, limit: 500 })).items?.map((paper) => paper.id) ?? [])
    const toRemove = [...current].filter((id) => !baseline.includes(id))
    const toAdd = baseline.filter((id) => !current.has(id))
    if (toRemove.length > 0) await call('library.setFavorite', { ids: toRemove, favorite: false, operationId: `v07-clean-fav-off-${RUN_STAMP}` }, 30_000)
    if (toAdd.length > 0) await call('library.setFavorite', { ids: toAdd, favorite: true, operationId: `v07-clean-fav-on-${RUN_STAMP}` }, 30_000)
  } catch (error) {
    state.cleanupErrors.push(`favorite restore: ${String(error?.message ?? error)}`)
  }

  await check('CLEANUP.filters', EXPECTED.get('CLEANUP.filters').expected, async () => {
    const treeData = await tree().catch(() => null)
    const ids = new Set(flattenFolders(treeData).map((entry) => entry.item?.id))
    const leftover = state.createdFolderIds.filter((id) => ids.has(id))
    const agentMembership = folderCollectionsOf(await call('library.get', { id: P_AGENT }, 30_000).catch(() => null))
    const baselineMembership = state.baseline.memberships[P_AGENT] ?? []
    const membershipRestored = agentMembership.join(',') === baselineMembership.join(',')
    const favoriteIds = ((await call('library.list', { favorite: true, limit: 500 })).items ?? []).map((paper) => paper.id).sort()
    const favoritesRestored = favoriteIds.join(',') === [...(state.baseline.favoriteIds ?? [])].sort().join(',')
    const pass = leftover.length === 0 && membershipRestored && favoritesRestored && state.cleanupErrors.length === 0
    return {
      actual: {
        createdFolderIds: state.createdFolderIds,
        leftoverFolderIds: leftover,
        baselineMembership,
        currentMembership: agentMembership,
        membershipRestored,
        baselineFavorites: state.baseline.favoriteIds,
        favorites: favoriteIds,
        favoritesRestored,
        cleanupErrors: state.cleanupErrors,
      },
      pass,
    }
  })

  let after = null
  for (let attempt = 0; attempt < 5 && after === null; attempt += 1) {
    try {
      after = await readEnvironment()
    } catch (error) {
      state.cleanupErrors.push(`post-run environment read ${attempt + 1}: ${String(error?.message ?? error)}`)
      await sleep(1500)
    }
  }
  state.after = { counts: after?.counts ?? null, finishedAt: new Date().toISOString() }

  await check('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, async () => {
    if (after === null) return { actual: { error: 'post-run status unavailable' }, pass: false }
    const baselineCounts = state.baseline.counts ?? {}
    const countsMatch =
      Number(after.counts?.papers) === Number(baselineCounts.papers) &&
      Number(after.counts?.annotations) === Number(baselineCounts.annotations) &&
      Number(after.counts?.figures) === Number(baselineCounts.figures) &&
      Number(after.counts?.trash) === Number(baselineCounts.trash)
    const treeData = await tree().catch(() => null)
    const flat = flattenFolders(treeData)
    const originalPresent = ORIGINAL_FIELD_NAMES.filter((name) => flat.some(({ item }) => item.name === name))
    const favoriteIds = ((await call('library.list', { favorite: true, limit: 500 })).items ?? []).map((paper) => paper.id).sort()
    const favoritesRestored = favoriteIds.join(',') === [...(state.baseline.favoriteIds ?? [])].sort().join(',')
    const embeddingStatus = await call('embedding.status', {}, 30_000).catch(() => null)
    const embeddingKept = embeddingStatus?.indexReady === true && embeddingStatus?.indexVersion === (state.baseline.embedding?.indexVersion ?? null)
    const vectorDegradedAfter = channelsOfDegraded(after.degraded).includes('vector')
    return {
      actual: {
        baseline: clipValue(baselineCounts),
        after: clipValue(after.counts),
        countsMatch,
        folderCount: flat.length,
        originalFoldersPresent: originalPresent,
        favorites: favoriteIds,
        favoritesRestored,
        embeddingKept,
        embeddingStatus: { indexVersion: embeddingStatus?.indexVersion ?? null, indexReady: embeddingStatus?.indexReady ?? null, counts: clipValue(embeddingStatus?.counts) },
        vectorStillAbsentFromDegraded: !vectorDegradedAfter,
        cleanupErrors: state.cleanupErrors,
      },
      pass: countsMatch && originalPresent.length === 5 && flat.length === 5 && favoritesRestored && embeddingKept && state.cleanupErrors.length === 0,
      notes: 'real 5 folders untouched, no user data purged, embedding index intentionally kept.',
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
        actual: { not_run_reason: 'case did not execute (environment gate/abort)' },
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
    schema: 'pappers-hall/v07-api-results@1',
    suite: 'v0.7 API acceptance',
    summary: {
      total: results.length,
      pass: counts.pass,
      fail: counts.fail,
      not_run: counts.not_run,
      byGroup,
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      base: BASE,
      exitCode,
    },
    environment: state.environment,
    baseline: {
      counts: state.baseline.counts,
      folders: clipValue(state.baseline.folders),
      favoriteIds: state.baseline.favoriteIds,
      embedding: clipValue(state.baseline.embedding),
      memberships: clipValue(state.baseline.memberships),
      capturedAt: state.startedAt,
    },
    after: state.after,
    evidence: {
      status: {
        degraded: clipValue(state.status?.degraded ?? null),
        channels: state.status?.index?.channels ?? null,
        capabilities: clipValue(state.diagnostics?.capabilities ?? null),
        translationProviders: clipValue(state.diagnostics?.translationProviders ?? null),
      },
      filters: state.evidence,
      regression: {
        v06: 'reports/v06-api-results.json',
        v06Harness: 'reports/v06-api-results.json#evidence.tools.harness',
        v05: 'reports/v05-api-results.json',
        v04: 'reports/v04-api-results.json',
        v02: 'reports/v02-api-results.json',
        lifecycle: 'reports/v03-lifecycle-run.json',
        v03: 'reports/v03-api-results.json',
      },
    },
    results,
  }
}

async function finish(exitCode) {
  const report = buildReport(exitCode)
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  const { pass, fail, not_run: notRunCount } = report.summary
  console.log(`\nV0.7 API RESULT: ${pass}/${report.summary.total} pass, ${fail} fail, ${notRunCount} not_run → ${OUT}`)
  process.exitCode = exitCode
}

async function main() {
  if (DRY_RUN) {
    const unique = new Set(PLAN.map(([id]) => id))
    if (unique.size !== PLAN.length) throw new Error('duplicate case ids in PLAN')
    console.log('Pappers-Hall v0.7 API acceptance suite — DRY RUN (no mutations, read-only probes only)\n')
    let currentGroup = null
    for (const [id, group, expected] of PLAN) {
      if (group !== currentGroup) {
        console.log(`\n[${group}]`)
        currentGroup = group
      }
      console.log(`  ${id.padEnd(32)} ${expected}`)
    }
    console.log(`\nplanned cases: ${PLAN.length}`)
    try {
      const environment = await readEnvironment()
      const degradedChannels = channelsOfDegraded(environment.degraded)
      console.log(`live host: version=${String(environment.pluginVersion)} schemaVersion=${String(environment.schemaVersion)} papers=${environment.counts?.papers ?? '?'} annotations=${environment.counts?.annotations ?? '?'}`)
      console.log(`status.index.channels=${JSON.stringify(environment.channels)}`)
      console.log(`status.degraded channels=${JSON.stringify(degradedChannels)}`)
      console.log(`diagnostics.capabilities=${JSON.stringify(clipValue(environment.capabilities))}`)
      const v07 = String(environment.pluginVersion ?? '').startsWith('0.7') || looksLikeV07(environment)
      console.log(v07 ? 'v0.7 host appears loaded — a real run is possible after GO v07.' : 'v0.7 host is NOT loaded yet (degraded still lists ready channels / capabilities.translation not ready): the real run will be refused by the ENV gate until reload + "GO v07".')
      const feed = await annotateFeed({})
      console.log(`annotations.feed unfiltered: ${(feed.items ?? []).length} items, hasMore=${String(feed.hasMore)}`)
      const crop = await folderByName('作物模拟与农业系统')
      if (crop !== null) {
        const filtered = await annotateFeed({ folderId: crop.id })
        const tagFiltered = await annotateFeed({ tags: ['推理'] })
        console.log(`annotations.feed probes: folder(${crop.name})=${(filtered.items ?? []).length} items, tags[推理]=${(tagFiltered.items ?? []).length} items`)
      }
      for (const file of ['reports/v06-api-results.json', 'reports/v05-api-results.json', 'reports/v04-api-results.json', 'reports/v02-api-results.json', 'reports/v03-lifecycle-run.json']) {
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
    console.log('\nDRY RUN OK: script parses, case plan complete, no data was written. Waiting for "GO v07".')
    process.exitCode = 0
    return
  }

  let environment
  try {
    environment = await readEnvironment()
  } catch (error) {
    console.error('V0.7 SUITE ERROR: live host unreachable:', String(error?.message ?? error))
    process.exitCode = 2
    return
  }
  let ok = false
  try {
    ok = await envCases()
    if (ok) {
      await statusCases()
      await filterCases()
      await regressionCases()
    }
  } catch (error) {
    console.error('V0.7 SUITE ERROR (unexpected):', error?.stack ?? error)
    process.exitCode = 2
  } finally {
    if (ok) {
      try {
        await cleanupCases()
      } catch (error) {
        console.error('V0.7 CLEANUP ERROR:', error?.stack ?? error)
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
  console.error('V0.7 SUITE FATAL:', error?.stack ?? error)
  try {
    await finish(2)
  } catch {
    process.exit(2)
  }
})
