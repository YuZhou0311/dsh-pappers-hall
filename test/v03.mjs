#!/usr/bin/env node
/**
 * Pappers-Hall v0.3 API acceptance suite.
 *
 * Exercises the v0.3 contract additions (docs/CONTRACT-v03.md §1) against the
 * LIVE installed plugin: journal metrics (manual update / explicit network
 * refresh / no JCR-IF fabrication), the operations journal + undo, duplicate
 * detection + merge, citation formatting + annotation export, the AI fast mode
 * (reasoning-effort downgrade + cache-key separation) and the new
 * `library.list` reading filter / metrics sort.
 *
 * Design rules:
 * - every mutating case undoes or removes its own fixture, and the suite
 *   records the library counts before and after so data preservation is
 *   falsifiable;
 * - AI / network capabilities pass both when they succeed and when they fail
 *   honestly (explicit status + non-empty reason, no fabricated payload); a
 *   degraded capability is recorded as `not_run` only when the specific
 *   contract behaviour cannot be exercised at all;
 * - expectations are never edited to make a failing implementation pass.
 *
 * Usage:
 *   node test/v03.mjs --dry-run     # print the case plan + environment probe, no writes
 *   node test/v03.mjs               # real run (requires the v0.3 host loaded)
 *   node test/v03.mjs --base http://127.0.0.1:54731 --paper ph-... --out ../reports/v03-api-results.json
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
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
const OUT = resolve(HERE, arg('--out', '../../reports/v03-api-results.json'))
/** C01 "Global irrigation contribution to wheat and maize yield": has a DOI, read=false. */
const PAPER = arg('--paper', 'ph-8d90723ee7bc')
/** A01 "ReAct": no DOI (deterministic metrics.refresh failure path). */
const NO_DOI_PAPER = arg('--no-doi-paper', 'ph-53132d8d95a6')
const DUP_SOURCE = arg(
  '--dup-source',
  join(WORKSPACE, 'pappers_hall_devkit_lite', 'papers', 'pdf', 'C01_irrigation_yield_contribution.pdf'),
)
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

/* ------------------------------------------------------------------ *
 * Case plan (id → expectation). Dry-run prints this; the real run must
 * record exactly these ids (anything missing becomes `not_run`).
 * ------------------------------------------------------------------ */
const PLAN = [
  ['ENV.version', 'ENV', 'v0.3 host loaded: status.plugin.version = 0.3.x and diagnostics.schemaVersion >= 3'],
  ['ENV.baseline', 'ENV', 'live library intact before mutation: papers >= 30, annotations >= 1, figures >= 300, trash = 0'],
  ['FIXTURE.duplicate', 'FIXTURE', 'import a byte-modified copy of C01 → new active paper with same title/DOI/year, different sha256 (disposable merge fixture)'],
  ['FIXTURE.metrics', 'FIXTURE', 'bibliography-import a disposable paper with a unique test journal so manual metrics never touch a user journal'],
  ['METRICS.get.structure', 'METRICS', 'library.get returns metrics{impactFactor,impactFactorYear,fiveYearImpactFactor,quartile,issn,publisher,citationCount,source,updatedAt,stale} + keywords[] + citationKey'],
  ['METRICS.get.fresh', 'METRICS', 'a freshly imported paper reports source=null, impactFactor=null, citationCount=null (no invented metrics)'],
  ['METRICS.update.manual', 'METRICS', 'metrics.update fields → library.get reads back the same numbers with source="manual" and updatedAt set'],
  ['METRICS.refresh.noDoi', 'METRICS', 'metrics.refresh on a paper without DOI → per-paper status="failed" + explicit non-empty reason, no fabricated metrics written'],
  ['METRICS.refresh.network', 'METRICS', 'metrics.refresh allowNetwork on C01 → OpenAlex+Crossref provenance with numeric citationCount / ISSN / publisher, OR explicit offline failure reason with no fabricated values'],
  ['METRICS.noJcrFabrication', 'METRICS', 'OpenAlex 2yr_mean_citedness is never exposed as JCR impactFactor: metrics.impactFactor stays null unless source="manual"'],
  ['LIST.reading.read', 'LIST', 'library.list reading="read" returns exactly the read=true subset (items read===true, total matches)'],
  ['LIST.reading.toRead', 'LIST', 'library.list reading="to-read" returns exactly the read=false subset'],
  ['LIST.reading.readingProgress', 'LIST', 'readingProgress=50 makes a paper appear in reading="reading"; undo restores the previous progress and membership'],
  ['LIST.sort.citations', 'LIST', 'library.list sort="citations" orders by citationCount descending with missing values last'],
  ['LIST.sort.impactFactor', 'LIST', 'library.list sort="impactFactor" puts the manual-IF paper first and missing values last'],
  ['UNDO.annotation.create', 'UNDO', 'annotation.create journaled (operations.recent) → operations.undo removes the annotation and marks the journal entry undone'],
  ['UNDO.annotation.update', 'UNDO', 'annotation.update journaled → undo restores previous colour/comment'],
  ['UNDO.setRead', 'UNDO', 'library.setRead journaled → undo restores read=false'],
  ['UNDO.tags.add', 'UNDO', 'library.update addTags journaled → undo removes the tag from paper and tags.list'],
  ['UNDO.delete', 'UNDO', 'library.delete (disposable fixture) journaled → undo restores the paper to active'],
  ['UNDO.idempotent', 'UNDO', 'undoing the same operationId twice is idempotent: second call does not error and state stays restored'],
  ['UNDO.notUndoable', 'UNDO', 'undoing an irreversible purge operation returns status="not_undoable" with a non-empty reason'],
  ['CITATION.styles', 'CITATION', 'citation.format returns non-empty content + count=1 for bibtex/apa/gbt7714/ris/csljson'],
  ['CITATION.bibtexKey', 'CITATION', 'BibTeX keeps a readable key (not the paper id) and joins authors with " and "'],
  ['CITATION.key', 'CITATION', 'citation.key returns {id,key,source:"authoryear"} and the key matches the BibTeX key'],
  ['EXPORT.annotations.markdown', 'EXPORT', 'export.annotations markdown contains page, quote, comment, colour and timestamp'],
  ['EXPORT.annotations.json', 'EXPORT', 'export.annotations json parses and contains the annotation with page/quote/comment'],
  ['EXPORT.bibtex', 'EXPORT', 'export.bibtex still works (v0.2 regression): @article + readable key + " and " authors'],
  ['DUP.structure', 'DUP', 'library.duplicates returns {groups:[{key,reason:"sha256"|"title",items>=2}]} and groups the constructed C01 pair'],
  ['DUP.merge', 'DUP', 'library.merge keeps primary file, merges tags/collections/read, moves the annotation to the primary and trashes the duplicate'],
  ['DUP.merge.undo', 'DUP', 'undoing the merge restores the duplicate (active) with its tags/collection/annotation/read state'],
  ['AI.fast.translate', 'AI', 'translate.text fast:true returns fast=true + reasoningEffort (null allowed) + non-source-copy translation, or an explicit unavailable reason'],
  ['AI.fast.quickTranslate', 'AI', 'ai.quickTranslate fast alias returns the same success shape, or explicit unavailable reason'],
  ['AI.fast.ask', 'AI', 'ai.ask mode="fast" answers with sources/elapsed, or fails explicitly with a reason (no invented answer)'],
  ['AI.cache.separation', 'AI', 'second identical fast call reports cached=true and the deep call does NOT hit the fast cache entry'],
  ['AI.deep.timing', 'AI', 'fast vs deep translate measured on the same text (numbers recorded, no hard target)'],
  ['REF.search', 'REF', 'search.query still returns hits after the v0.3 host changes (read-only sanity)'],
  ['REF.data.preserved', 'REF', 'after cleanup: papers/annotations/figures/trash/tags/collections back to the pre-run baseline and the fixture is gone'],
]

const results = []
const state = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  base: BASE,
  paper: null,
  baseline: {},
  fixture: null,
  metricsFixture: null,
  created: { annotationIds: [], tagNames: [], collectionIds: [] },
  journal: {},
  evidence: {},
  cleanupErrors: [],
  ai: { status: null, fast: null, deep: null, quick: null, ask: null, calls: {} },
  timings: {},
  after: {},
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
  const group = extra.group ?? plan?.group ?? 'OTHER'
  const entry = {
    case_id: caseId,
    group,
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
    // a case may record itself as not_run (e.g. unavailable AI capability)
    if (outcome?.skipped === true) return outcome
    record(caseId, expected, outcome.actual, outcome.pass === true, { ...extra, notes: outcome.notes })
    return outcome
  } catch (error) {
    record(caseId, expected, { error: String(error?.message ?? error), code: error?.code }, false, extra)
    return null
  }
}

const isoNow = () => new Date().toISOString()
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/* ------------------------------------------------------------------ *
 * Operations journal helpers (v0.3 §1.2)
 * ------------------------------------------------------------------ */
async function recentOperations(limit = 60) {
  const data = await call('operations.recent', { limit })
  return Array.isArray(data?.items) ? data.items : []
}

const MATCHERS = {
  annotationCreate: (kind) => /annotation/.test(kind) && /creat/.test(kind),
  annotationUpdate: (kind) => /annotation/.test(kind) && /updat/.test(kind),
  setRead: (kind) => /read/.test(kind),
  libraryUpdate: (kind) => /updat/.test(kind) && /(library|paper|tag|field)/.test(kind),
  libraryDelete: (kind) => /delet/.test(kind) && /(library|paper)/.test(kind) && !/annotation/.test(kind),
  merge: (kind) => /merg/.test(kind),
  purge: (kind) => /purg/.test(kind),
}

const isUndone = (item) => item?.undone === true || item?.undone === 1

function operationTime(item) {
  const raw = item?.createdAt ?? item?.created_at ?? item?.time
  const parsed = Date.parse(String(raw ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Find the journal entry for an operation that was just performed.
 * The journal id is implementation-owned, so match by kind + recency (and by
 * exact id when the implementation reuses the client operationId).
 */
async function findOperation(matcher, { since, operationId } = {}) {
  const items = await recentOperations(60)
  const withKind = items.filter((item) => item && typeof item.kind === 'string')
  const candidates = withKind.filter((item) => matcher(String(item.kind).toLowerCase(), item))
  if (operationId !== undefined) {
    const exact = withKind.find((item) => String(item.id) === String(operationId))
    if (exact !== undefined) return { item: exact, candidates, items, matchedBy: 'operationId' }
  }
  const pending = candidates.filter((item) => !isUndone(item))
  const sinceMs = Date.parse(String(since ?? ''))
  let pool = pending
  if (Number.isFinite(sinceMs)) {
    const fresh = pending.filter((item) => operationTime(item) >= sinceMs - 2000)
    if (fresh.length > 0) pool = fresh
  }
  pool = [...pool].sort((left, right) => operationTime(right) - operationTime(left))
  return { item: pool[0], candidates: pool, items, matchedBy: 'kind+time' }
}

async function journalEntry(operationId) {
  const items = await recentOperations(60)
  return items.find((item) => String(item.id) === String(operationId))
}

/* ------------------------------------------------------------------ *
 * Environment / baseline
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
  }
}

async function getPaper(id) {
  return call('library.get', { id })
}

function summarizeMetrics(metrics) {
  if (metrics === null || typeof metrics !== 'object') return metrics
  return {
    impactFactor: metrics.impactFactor ?? null,
    impactFactorYear: metrics.impactFactorYear ?? null,
    fiveYearImpactFactor: metrics.fiveYearImpactFactor ?? null,
    quartile: metrics.quartile ?? null,
    issn: metrics.issn ?? null,
    publisher: metrics.publisher ?? null,
    citationCount: metrics.citationCount ?? null,
    source: metrics.source ?? null,
    updatedAt: metrics.updatedAt ?? null,
    stale: metrics.stale ?? null,
    otherKeys: Object.keys(metrics).filter(
      (key) =>
        ![
          'impactFactor',
          'impactFactorYear',
          'fiveYearImpactFactor',
          'quartile',
          'issn',
          'publisher',
          'citationCount',
          'citedByPercentile',
          'hIndex',
          'source',
          'updatedAt',
          'stale',
        ].includes(key),
    ),
  }
}

function normalizeRefresh(data) {
  const list = Array.isArray(data)
    ? data
    : (data?.results ?? data?.items ?? data?.papers ?? data?.papersResults ?? null)
  const items = Array.isArray(list) ? list : list === null ? [] : [list]
  return items.map((item) => {
    const id = item?.paperId ?? item?.id ?? item?.paper_id ?? null
    const status = item?.status ?? item?.state ?? null
    const reason = item?.reason ?? item?.error ?? item?.message ?? null
    return { raw: item, id, status, reason }
  })
}

async function prepareFixture() {
  const caseId = 'FIXTURE.duplicate'
  const expected = EXPECTED.get(caseId).expected
  if (!existsSync(DUP_SOURCE)) {
    record(caseId, expected, { error: `fixture PDF missing: ${DUP_SOURCE}` }, false)
    return null
  }
  let tempDir = null
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'pappers-v03-'))
    const stem = basename(DUP_SOURCE, extname(DUP_SOURCE)) // e.g. C01_irrigation_yield_contribution
    // The host resolves manifest metadata from the `^[A-Z][0-9]{2}` file stem.
    const copyPath = join(tempDir, `${stem}_v03dup.pdf`)
    const source = readFileSync(DUP_SOURCE)
    const marker = Buffer.from(`\n% pappers-hall v0.3 duplicate fixture ${RUN_STAMP}\n`, 'latin1')
    writeFileSync(copyPath, Buffer.concat([source, marker]))
    const imported = await call('library.import', { paths: [copyPath], operationId: `v03-import-${RUN_STAMP}` }, 180_000)
    const accepted = imported?.acceptedItems ?? []
    const item = accepted[0]
    if (!item?.paperId) {
      record(caseId, expected, { import: clipValue(imported), note: 'import did not create a paper' }, false)
      return null
    }
    const detail = await getPaper(item.paperId)
    const sameTitle = String(detail?.title ?? '') === String(state.paper?.title ?? '')
    const sameDoi = detail?.doi === state.paper?.doi && (detail?.doi ?? null) !== null
    const differentSha = detail?.sha256 !== state.paper?.sha256
    const active = detail?.state === 'active'
    state.fixture = { id: item.paperId, versionId: item.versionId ?? null, import: imported }
    record(
      caseId,
      expected,
      {
        id: item.paperId,
        title: detail?.title,
        doi: detail?.doi,
        sha256: detail?.sha256,
        originalSha256: state.paper?.sha256,
        state: detail?.state,
        jobId: imported?.jobId ?? null,
      },
      active && sameTitle && sameDoi && differentSha,
      { group: 'FIXTURE' },
    )
    return state.fixture
  } catch (error) {
    record(caseId, expected, { error: String(error?.message ?? error) }, false, { group: 'FIXTURE' })
    return null
  } finally {
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true })
  }
}

/**
 * Disposable metadata-only paper in a unique test journal.
 *
 * `metrics.update` is journal-level (it writes the `papers_journal` row for the
 * paper's venue), so manual metrics must never be exercised on a paper sharing a
 * real user journal: that would show a fake impact factor on every paper of the
 * journal. A bibliography import with a unique title + journal keeps it isolated.
 */
async function prepareMetricsFixture() {
  const caseId = 'FIXTURE.metrics'
  const expected = EXPECTED.get(caseId).expected
  try {
    const journalName = `v03-acceptance-journal-${RUN_STAMP}`
    const title = `v03 acceptance metrics fixture ${RUN_STAMP}`
    const bib = [
      `@article{v03metrics${RUN_STAMP.replace(/[^a-z0-9]/gi, '')},`,
      `  title = {${title}},`,
      '  author = {Acceptance, Vera and Verifier, Trio},',
      '  year = {2026},',
      `  journal = {${journalName}}`,
      '}',
      '',
    ].join('\n')
    const imported = await call(
      'library.import',
      {
        format: 'bibtex',
        uploads: [{ name: `v03-metrics-${RUN_STAMP}.bib`, base64: Buffer.from(bib, 'utf8').toString('base64') }],
        operationId: `v03-import-metrics-${RUN_STAMP}`,
      },
      60_000,
    )
    const item = (imported?.acceptedItems ?? [])[0]
    if (item?.paperId === undefined) {
      record(caseId, expected, { import: clipValue(imported), note: 'bibliography import did not create a paper' }, false, { group: 'FIXTURE' })
      return null
    }
    const detail = await getPaper(item.paperId)
    state.metricsFixture = { id: item.paperId, journalName, title }
    record(
      caseId,
      expected,
      { id: item.paperId, title: detail?.title, venue: detail?.venue, containerTitle: detail?.containerTitle, state: detail?.state, journalName },
      detail?.state === 'active' && String(detail?.title ?? '') === title,
      { group: 'FIXTURE' },
    )
    return state.metricsFixture
  } catch (error) {
    record(caseId, expected, { error: String(error?.message ?? error) }, false, { group: 'FIXTURE' })
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 1) METRICS
 * ------------------------------------------------------------------ */
async function metricsCases() {
  await check('METRICS.get.structure', EXPECTED.get('METRICS.get.structure').expected, async () => {
    const detail = await getPaper(PAPER)
    const metrics = detail?.metrics
    const required = [
      'impactFactor',
      'impactFactorYear',
      'fiveYearImpactFactor',
      'quartile',
      'issn',
      'publisher',
      'citationCount',
      'source',
      'updatedAt',
      'stale',
    ]
    const present = required.filter((key) => metrics !== null && typeof metrics === 'object' && Object.hasOwn(metrics, key))
    const pass =
      present.length === required.length &&
      (metrics.source === null || typeof metrics.source === 'string') &&
      typeof metrics.stale === 'boolean' &&
      Array.isArray(detail?.keywords) &&
      typeof detail?.citationKey === 'string' &&
      detail.citationKey.length > 0
    return {
      actual: {
        present,
        metrics: summarizeMetrics(metrics),
        keywords: detail?.keywords,
        citationKey: detail?.citationKey,
      },
      pass,
    }
  })

  if (state.metricsFixture === null) {
    notRun('METRICS.get.fresh', EXPECTED.get('METRICS.get.fresh').expected, 'metrics fixture missing: no freshly imported paper with an isolated journal to inspect')
    notRun('METRICS.update.manual', EXPECTED.get('METRICS.update.manual').expected, 'metrics fixture missing: refusing to write manual metrics to a user paper/journal')
    notRun('LIST.sort.impactFactor', EXPECTED.get('LIST.sort.impactFactor').expected, 'metrics fixture missing: no paper with a disposable manual impact factor')
  } else {
    await check('METRICS.get.fresh', EXPECTED.get('METRICS.get.fresh').expected, async () => {
      const detail = await getPaper(state.metricsFixture.id)
      const metrics = detail?.metrics ?? null
      const pass =
        metrics !== null &&
        typeof metrics === 'object' &&
        metrics.source === null &&
        (metrics.impactFactor === null || metrics.impactFactor === undefined) &&
        (metrics.citationCount === null || metrics.citationCount === undefined)
      return { actual: { metrics: summarizeMetrics(metrics), stale: metrics?.stale }, pass }
    })

    await check('METRICS.update.manual', EXPECTED.get('METRICS.update.manual').expected, async () => {
      const fields = {
        impactFactor: 12.34,
        impactFactorYear: 2024,
        fiveYearImpactFactor: 15.6,
        quartile: 'Q1',
        issn: '1234-5678',
        publisher: 'v03-acceptance-publisher',
        citationCount: 42,
      }
      const update = await call('metrics.update', { paperId: state.metricsFixture.id, fields })
      const detail = await getPaper(state.metricsFixture.id)
      const metrics = detail?.metrics ?? {}
      const near = (value, wanted) => typeof value === 'number' && Math.abs(value - wanted) < 1e-9
      const pass =
        metrics.source === 'manual' &&
        near(metrics.impactFactor, 12.34) &&
        near(metrics.impactFactorYear, 2024) &&
        near(metrics.fiveYearImpactFactor, 15.6) &&
        metrics.quartile === 'Q1' &&
        metrics.issn === '1234-5678' &&
        metrics.publisher === 'v03-acceptance-publisher' &&
        near(metrics.citationCount, 42) &&
        typeof metrics.updatedAt === 'string' &&
        metrics.updatedAt.length > 0
      return { actual: { update: clipValue(update), metrics: summarizeMetrics(metrics) }, pass }
    })
  }

  await check('METRICS.refresh.noDoi', EXPECTED.get('METRICS.refresh.noDoi').expected, async () => {
    const before = await getPaper(NO_DOI_PAPER)
    const data = await call('metrics.refresh', { paperIds: [NO_DOI_PAPER], allowNetwork: true }, 60_000)
    const items = normalizeRefresh(data)
    const item = items.find((entry) => entry.id === NO_DOI_PAPER) ?? items[0]
    const after = await getPaper(NO_DOI_PAPER)
    const noFabrication =
      (after?.metrics?.impactFactor === null || after?.metrics?.impactFactor === undefined) &&
      (after?.metrics?.citationCount === null || after?.metrics?.citationCount === undefined) &&
      !String(after?.metrics?.source ?? '').includes('openalex')
    const pass =
      item !== undefined &&
      item.status === 'failed' &&
      typeof item.reason === 'string' &&
      item.reason.trim() !== '' &&
      noFabrication
    return {
      actual: {
        refresh: clipValue(data),
        normalized: { id: item?.id, status: item?.status, reason: item?.reason },
        beforeMetrics: summarizeMetrics(before?.metrics),
        afterMetrics: summarizeMetrics(after?.metrics),
        noFabrication,
      },
      pass,
    }
  })

  const networkOutcome = await check('METRICS.refresh.network', EXPECTED.get('METRICS.refresh.network').expected, async () => {
    const data = await call('metrics.refresh', { paperIds: [PAPER], allowNetwork: true }, 90_000)
    const items = normalizeRefresh(data)
    const item = items.find((entry) => entry.id === PAPER) ?? items[0]
    const detail = await getPaper(PAPER)
    const metrics = detail?.metrics ?? {}
    const source = String(metrics.source ?? '')
    const successStatuses = ['ok', 'refreshed', 'fetched', 'updated', 'success', 'cached']
    const succeeded =
      successStatuses.includes(String(item?.status ?? '').toLowerCase()) || source.includes('openalex')
    const offlineReason = String(item?.reason ?? '')
    if (succeeded) {
      const hasProvenance = source.includes('openalex') && source.includes('crossref')
      const pass =
        typeof metrics.citationCount === 'number' &&
        metrics.citationCount >= 0 &&
        typeof metrics.issn === 'string' &&
        metrics.issn.trim() !== '' &&
        typeof metrics.publisher === 'string' &&
        metrics.publisher.trim() !== '' &&
        hasProvenance &&
        typeof metrics.updatedAt === 'string' &&
        metrics.updatedAt.length > 0 &&
        metrics.stale === false
      state.evidence.metricsRefresh = { branch: 'network-success', refresh: clipValue(data), metrics: summarizeMetrics(metrics) }
      return {
        actual: { branch: 'network-success', refresh: clipValue(data), metrics: summarizeMetrics(metrics) },
        pass,
        notes: `provenance source="${source}", citationCount=${metrics.citationCount}`,
      }
    }
    const failed = /fail|offline|error|unavailable|network|doi|skip/i.test(String(item?.status ?? '')) || offlineReason.trim() !== ''
    const noFabrication =
      (metrics.impactFactor === null || metrics.impactFactor === undefined) &&
      (metrics.citationCount === null || metrics.citationCount === undefined) &&
      !source.includes('openalex')
    state.evidence.metricsRefresh = { branch: 'offline-or-failed', refresh: clipValue(data), metrics: summarizeMetrics(metrics) }
    return {
      actual: { branch: 'offline-degraded', refresh: clipValue(data), metrics: summarizeMetrics(metrics), noFabrication },
      pass: failed && offlineReason.trim() !== '' && noFabrication,
      notes: `network unavailable path accepted only with explicit reason: "${offlineReason}"`,
    }
  })

  const networkSucceeded = networkOutcome?.actual?.branch === 'network-success'
  if (!networkSucceeded) {
    notRun(
      'METRICS.noJcrFabrication',
      EXPECTED.get('METRICS.noJcrFabrication').expected,
      'metrics.refresh did not obtain OpenAlex data in this run; the 2yr_mean_citedness ≠ JCR IF field semantics cannot be exercised',
    )
  } else {
    await check('METRICS.noJcrFabrication', EXPECTED.get('METRICS.noJcrFabrication').expected, async () => {
      const detail = await getPaper(PAPER)
      const metrics = detail?.metrics ?? {}
      const source = String(metrics.source ?? '')
      const openalexOnly = source.includes('openalex') && source !== 'manual'
      const meanLikeKeys = Object.keys(metrics).filter((key) => /mean|2yr|two.?year/i.test(key))
      const meanLikeValues = Object.fromEntries(meanLikeKeys.map((key) => [key, metrics[key]]))
      const pass =
        openalexOnly &&
        (metrics.impactFactor === null || metrics.impactFactor === undefined) &&
        meanLikeKeys.every((key) => key !== 'impactFactor') &&
        Object.values(meanLikeValues).every((value) => value === null || typeof value === 'number' || typeof value === 'string')
      return {
        actual: {
          source,
          impactFactor: metrics.impactFactor ?? null,
          impactFactorYear: metrics.impactFactorYear ?? null,
          meanLikeKeys,
          meanLikeValues,
          rawMetrics: clipValue(metrics),
        },
        pass,
        notes: 'OpenAlex only provides 2yr mean citedness / h-index / i10; a JCR impactFactor must stay null unless the source is manual.',
      }
    })
  }
}

/* ------------------------------------------------------------------ *
 * 2) library.list reading filter + metrics sort
 * ------------------------------------------------------------------ */
async function listCases() {
  await check('LIST.reading.read', EXPECTED.get('LIST.reading.read').expected, async () => {
    const all = await call('library.list', { limit: 200 })
    const read = await call('library.list', { reading: 'read', limit: 200 })
    const expectedCount = (all.items ?? []).filter((paper) => paper.read === true).length
    const pass =
      read.total === expectedCount &&
      (read.items ?? []).length === expectedCount &&
      (read.items ?? []).every((paper) => paper.read === true)
    return { actual: { total: read.total, expectedCount, items: (read.items ?? []).length }, pass }
  })

  await check('LIST.reading.toRead', EXPECTED.get('LIST.reading.toRead').expected, async () => {
    const all = await call('library.list', { limit: 200 })
    const toRead = await call('library.list', { reading: 'to-read', limit: 200 })
    const expectedCount = (all.items ?? []).filter((paper) => paper.read === false).length
    const pass =
      toRead.total === expectedCount &&
      (toRead.items ?? []).length === expectedCount &&
      (toRead.items ?? []).every((paper) => paper.read !== true)
    return { actual: { total: toRead.total, expectedCount, items: (toRead.items ?? []).length }, pass }
  })

  await check('LIST.reading.readingProgress', EXPECTED.get('LIST.reading.readingProgress').expected, async () => {
    const before = await call('library.list', { reading: 'reading', limit: 200 })
    const beforeIds = new Set((before.items ?? []).map((paper) => paper.id))
    const readBefore = (await getPaper(PAPER))?.read === true
    const since = isoNow()
    const opId = `v03-progress-${RUN_STAMP}`
    await call('library.update', { id: PAPER, patch: { readingProgress: 50 }, operationId: opId })
    const detail = await getPaper(PAPER)
    const during = await call('library.list', { reading: 'reading', limit: 200 })
    const duringIds = new Set((during.items ?? []).map((paper) => paper.id))
    const listed = duringIds.has(PAPER) && !beforeIds.has(PAPER)
    const { item } = await findOperation(MATCHERS.libraryUpdate, { since, operationId: opId })
    let undoResponse = null
    let undone = false
    if (item !== undefined) {
      undoResponse = await call('operations.undo', { operationId: item.id })
      const after = await getPaper(PAPER)
      const afterList = await call('library.list', { reading: 'reading', limit: 200 })
      const afterIds = new Set((afterList.items ?? []).map((paper) => paper.id))
      let readRestored = after?.read === readBefore
      if (!readRestored) {
        await call('library.setRead', { id: PAPER, read: readBefore, operationId: `v03-progress-read-restore-${RUN_STAMP}` }).catch(() => {})
        readRestored = (await getPaper(PAPER))?.read === readBefore
      }
      undone = Number(after?.readingProgress ?? 0) === 0 && afterIds.has(PAPER) === beforeIds.has(PAPER) && readRestored
      state.journal.progress = { opId: item.id }
    }
    if (!undone) {
      // best effort restore so the user paper is not left with a test progress
      await call('library.update', { id: PAPER, patch: { readingProgress: null }, operationId: `v03-progress-restore-${RUN_STAMP}` }).catch(() => {})
    }
    const pass = listed && item !== undefined && undone
    return {
      actual: {
        progressAfterSet: detail?.readingProgress ?? null,
        listedDuring: listed,
        journalOperation: item === undefined ? null : { id: item.id, kind: item.kind, summary: item.summary },
        undo: clipValue(undoResponse),
        undone,
      },
      pass,
    }
  })

  await check('LIST.sort.citations', EXPECTED.get('LIST.sort.citations').expected, async () => {
    const sorted = await call('library.list', { sort: 'citations', limit: 200 })
    const items = sorted.items ?? []
    const values = []
    for (const paper of items) {
      const detail = await getPaper(paper.id)
      values.push({ id: paper.id, value: detail?.metrics?.citationCount ?? null })
    }
    const nonNull = values.filter((entry) => typeof entry.value === 'number')
    const nulls = values.filter((entry) => typeof entry.value !== 'number')
    const monotonic = nonNull.every((entry, index) => index === 0 || nonNull[index - 1].value >= entry.value)
    const nullsLast = values.findIndex((entry) => typeof entry.value !== 'number')
    const lastNonNull = values.reduce((last, entry, index) => (typeof entry.value === 'number' ? index : last), -1)
    const missingLast = nullsLast === -1 || lastNonNull < nullsLast
    if (nonNull.length === 0) {
      notRun('LIST.sort.citations', EXPECTED.get('LIST.sort.citations').expected, 'no paper has a numeric citationCount after metrics.refresh; nothing meaningful to order', { actual: { items: items.length } })
      return { skipped: true }
    }
    return {
      actual: {
        items: items.length,
        nonNull: nonNull.length,
        top: nonNull.slice(0, 5),
        nulls: nulls.length,
        monotonic,
        missingLast,
      },
      pass: monotonic && missingLast,
    }
  })

  if (state.metricsFixture === null) {
    // already recorded above as not_run in metricsCases
  } else {
    await check('LIST.sort.impactFactor', EXPECTED.get('LIST.sort.impactFactor').expected, async () => {
      const sorted = await call('library.list', { sort: 'impactFactor', limit: 200 })
      const items = sorted.items ?? []
      const first = items[0]
      const values = []
      for (const paper of items.slice(1, 12)) {
        const detail = await getPaper(paper.id)
        values.push({ id: paper.id, value: detail?.metrics?.impactFactor ?? null })
      }
      const pass = first?.id === state.metricsFixture.id && values.every((entry) => typeof entry.value !== 'number')
      return {
        actual: {
          items: items.length,
          first: first === undefined ? null : { id: first.id, title: first.title },
          expectedFirst: state.metricsFixture.id,
          nextValues: values,
        },
        pass,
        notes: 'the disposable metrics fixture carries a manual impactFactor=12.34 in its own test journal; every user paper has no IF in this library.',
      }
    })
  }
}

/* ------------------------------------------------------------------ *
 * 3) UNDO journal
 * ------------------------------------------------------------------ */
async function undoAnnotationCreateCase() {
  await check('UNDO.annotation.create', EXPECTED.get('UNDO.annotation.create').expected, async () => {
    const since = isoNow()
    const opId = `v03-undo-ann-create-${RUN_STAMP}`
    const created = await call('annotations.create', {
      paperId: PAPER,
      page: 3,
      kind: 'highlight',
      quote: `v03 undo quote ${RUN_STAMP}`,
      rects: [{ x: 0.12, y: 0.2, w: 0.3, h: 0.02 }],
      color: 'yellow',
      comment: `v03 undo comment ${RUN_STAMP}`,
      origin: 'test_note',
      operationId: opId,
    })
    const annotation = created?.annotation
    if (annotation?.id === undefined) {
      return { actual: { create: clipValue(created) }, pass: false, notes: 'annotations.create returned no annotation' }
    }
    state.created.annotationIds.push(annotation.id)
    const listedAfterCreate = (await call('annotations.list', { paperId: PAPER })).some((entry) => entry.id === annotation.id)
    const { item } = await findOperation(MATCHERS.annotationCreate, { since, operationId: opId })
    if (item === undefined) {
      return {
        actual: { annotationId: annotation.id, listedAfterCreate, journalFound: false },
        pass: false,
        notes: 'operations.recent contains no annotation.create entry',
      }
    }
    const undo = await call('operations.undo', { operationId: item.id })
    const listedAfterUndo = (await call('annotations.list', { paperId: PAPER })).some((entry) => entry.id === annotation.id)
    const journal = await journalEntry(item.id)
    state.journal.annotationCreate = { operationId: item.id, annotationId: annotation.id }
    return {
      actual: {
        annotationId: annotation.id,
        journalOperation: { id: item.id, kind: item.kind, summary: item.summary },
        listedAfterCreate,
        undo: clipValue(undo),
        listedAfterUndo,
        journalUndone: journal?.undone ?? null,
      },
      pass: listedAfterCreate && !listedAfterUndo && isUndone(journal),
    }
  })
}

async function undoAnnotationUpdateCase() {
  await check('UNDO.annotation.update', EXPECTED.get('UNDO.annotation.update').expected, async () => {
    const created = await call('annotations.create', {
      paperId: PAPER,
      page: 3,
      kind: 'highlight',
      quote: `v03 undo update quote ${RUN_STAMP}`,
      rects: [{ x: 0.12, y: 0.24, w: 0.25, h: 0.02 }],
      color: 'green',
      comment: `v03 undo update original ${RUN_STAMP}`,
      origin: 'test_note',
      operationId: `v03-undo-ann-create2-${RUN_STAMP}`,
    })
    const annotation = created?.annotation
    if (annotation?.id === undefined) {
      return { actual: { create: clipValue(created) }, pass: false }
    }
    state.created.annotationIds.push(annotation.id)
    const since = isoNow()
    const opId = `v03-undo-ann-update-${RUN_STAMP}`
    const updated = await call('annotations.update', {
      id: annotation.id,
      color: 'blue',
      comment: `v03 undo update changed ${RUN_STAMP}`,
      operationId: opId,
    })
    const afterUpdate = (updated?.annotation ?? {})
    const { item } = await findOperation(MATCHERS.annotationUpdate, { since, operationId: opId })
    let undo = null
    let restored = null
    if (item !== undefined) {
      undo = await call('operations.undo', { operationId: item.id })
      const listed = await call('annotations.list', { paperId: PAPER })
      restored = listed.find((entry) => entry.id === annotation.id) ?? null
    }
    // always remove the throw-away annotation (best effort)
    await call('annotations.delete', { id: annotation.id, operationId: `v03-undo-ann-clean-${RUN_STAMP}` }).catch(() => {})
    const pass =
      afterUpdate.color === 'blue' &&
      item !== undefined &&
      restored?.color === 'green' &&
      String(restored?.comment ?? '') === `v03 undo update original ${RUN_STAMP}`
    return {
      actual: {
        annotationId: annotation.id,
        afterUpdate: { color: afterUpdate.color, comment: afterUpdate.comment, revision: afterUpdate.revision },
        journalOperation: item === undefined ? null : { id: item.id, kind: item.kind, summary: item.summary },
        undo: clipValue(undo),
        restored: restored === null ? null : { color: restored.color, comment: restored.comment, revision: restored.revision },
      },
      pass,
    }
  })
}

async function undoSetReadCase() {
  await check('UNDO.setRead', EXPECTED.get('UNDO.setRead').expected, async () => {
    const before = await getPaper(PAPER)
    const readBefore = before?.read === true
    const readTarget = !readBefore
    const since = isoNow()
    const opId = `v03-undo-read-${RUN_STAMP}`
    await call('library.setRead', { id: PAPER, read: readTarget, operationId: opId })
    const afterSet = await getPaper(PAPER)
    const { item } = await findOperation(MATCHERS.setRead, { since, operationId: opId })
    let undo = null
    let afterUndo = null
    if (item !== undefined) {
      undo = await call('operations.undo', { operationId: item.id })
      afterUndo = await getPaper(PAPER)
    }
    // always restore the baseline read flag (the suite must be state-neutral)
    if (afterUndo?.read !== readBefore) {
      await call('library.setRead', { id: PAPER, read: readBefore, operationId: `v03-undo-read-restore-${RUN_STAMP}` }).catch(() => {})
    }
    const pass = afterSet?.read === readTarget && item !== undefined && afterUndo?.read === readBefore
    return {
      actual: {
        readBefore,
        readTarget,
        readAfterSet: afterSet?.read ?? null,
        journalOperation: item === undefined ? null : { id: item.id, kind: item.kind, summary: item.summary },
        undo: clipValue(undo),
        readAfterUndo: afterUndo?.read ?? null,
      },
      pass,
    }
  })
}

async function undoTagsCase() {
  await check('UNDO.tags.add', EXPECTED.get('UNDO.tags.add').expected, async () => {
    const tag = `v03-undo-tag-${RUN_STAMP}`
    state.created.tagNames.push(tag)
    const since = isoNow()
    const opId = `v03-undo-tag-${RUN_STAMP}`
    await call('library.update', { id: PAPER, patch: { addTags: [tag] }, operationId: opId })
    const afterAdd = await getPaper(PAPER)
    const tagsAfterAdd = await call('tags.list')
    const { item } = await findOperation(MATCHERS.libraryUpdate, { since, operationId: opId })
    let undo = null
    let afterUndo = null
    let tagsAfterUndo = []
    if (item !== undefined) {
      undo = await call('operations.undo', { operationId: item.id })
      afterUndo = await getPaper(PAPER)
      tagsAfterUndo = (await call('tags.list')).items ?? []
    }
    if ((afterUndo?.tags ?? []).includes(tag)) {
      await call('library.update', { id: PAPER, patch: { removeTags: [tag] }, operationId: `v03-undo-tag-restore-${RUN_STAMP}` }).catch(() => {})
    }
    const pass =
      (afterAdd?.tags ?? []).includes(tag) &&
      (tagsAfterAdd.items ?? []).some((entry) => entry.name === tag) &&
      item !== undefined &&
      !(afterUndo?.tags ?? []).includes(tag) &&
      !tagsAfterUndo.some((entry) => entry.name === tag)
    return {
      actual: {
        tag,
        tagsAfterAdd: afterAdd?.tags,
        journalOperation: item === undefined ? null : { id: item.id, kind: item.kind, summary: item.summary },
        undo: clipValue(undo),
        tagsAfterUndo: afterUndo?.tags,
        tagsListContainsTag: tagsAfterUndo.some((entry) => entry.name === tag),
      },
      pass,
    }
  })
}

async function undoDeleteCase() {
  const caseId = 'UNDO.delete'
  if (state.fixture === null) {
    notRun(caseId, EXPECTED.get(caseId).expected, 'duplicate fixture missing: refusing to delete a user paper to exercise undo')
    return
  }
  let pendingId = null
  await check(caseId, EXPECTED.get(caseId).expected, async () => {
    const before = await getPaper(state.fixture.id)
    const since = isoNow()
    const opId = `v03-undo-delete-${RUN_STAMP}`
    await call('library.delete', { ids: [state.fixture.id], operationId: opId })
    const trashed = await getPaper(state.fixture.id)
    const { item } = await findOperation(MATCHERS.libraryDelete, { since, operationId: opId })
    let undo = null
    let restored = null
    if (item !== undefined) {
      pendingId = item.id
      undo = await call('operations.undo', { operationId: item.id })
      restored = await getPaper(state.fixture.id)
    }
    if (restored?.state !== 'active') {
      // safety net: the fixture must not stay trashed for the merge cases
      await call('library.restore', { ids: [state.fixture.id], operationId: `v03-undo-delete-safety-${RUN_STAMP}` }).catch(() => {})
      restored = await getPaper(state.fixture.id).catch(() => null)
    }
    state.journal.delete = { operationId: item?.id ?? null, epochBefore: before?.epoch ?? null, epochAfter: restored?.epoch ?? null }
    return {
      actual: {
        paperId: state.fixture.id,
        stateAfterDelete: trashed?.state ?? null,
        journalOperation: item === undefined ? null : { id: item.id, kind: item.kind, summary: item.summary },
        undo: clipValue(undo),
        stateAfterUndo: restored?.state ?? null,
        epochBefore: before?.epoch ?? null,
        epochAfter: restored?.epoch ?? null,
      },
      pass: ['trash', 'trashed'].includes(trashed?.state) && item !== undefined && restored?.state === 'active',
    }
  })
  void pendingId
}

async function undoIdempotentCase() {
  await check('UNDO.idempotent', EXPECTED.get('UNDO.idempotent').expected, async () => {
    const operationId = state.journal.annotationCreate?.operationId ?? state.journal.delete?.operationId
    if (operationId === undefined || operationId === null) {
      return { actual: { operationId }, pass: false, notes: 'no undone operation available to repeat' }
    }
    const firstUndoAgain = await call('operations.undo', { operationId })
    const journal = await journalEntry(operationId)
    const annotationGone = state.journal.annotationCreate?.annotationId === undefined
      ? true
      : !(await call('annotations.list', { paperId: PAPER })).some((entry) => entry.id === state.journal.annotationCreate.annotationId)
    const fixtureActive = state.fixture === null ? null : (await getPaper(state.fixture.id).catch(() => null))?.state === 'active'
    return {
      actual: {
        operationId,
        secondUndo: clipValue(firstUndoAgain),
        journalUndone: journal?.undone ?? null,
        annotationGone,
        fixtureActive,
      },
      pass: annotationGone && fixtureActive !== false,
    }
  })
}

/* ------------------------------------------------------------------ *
 * 4) Citation formatting / export
 * ------------------------------------------------------------------ */
async function citationExportCases() {
  await check('CITATION.styles', EXPECTED.get('CITATION.styles').expected, async () => {
    const styles = ['bibtex', 'apa', 'gbt7714', 'ris', 'csljson']
    const observed = {}
    for (const style of styles) {
      const data = await call('citation.format', { ids: [PAPER], style }, 30_000)
      observed[style] = {
        style: data?.style ?? null,
        count: data?.count ?? null,
        chars: typeof data?.content === 'string' ? data.content.length : null,
        head: typeof data?.content === 'string' ? data.content.slice(0, 90) : null,
      }
    }
    const pass = styles.every((style) => {
      const entry = observed[style]
      return (
        entry.style === style &&
        entry.count === 1 &&
        typeof entry.chars === 'number' &&
        entry.chars > 20 &&
        typeof entry.head === 'string' &&
        entry.head.trim() !== ''
      )
    })
    return { actual: observed, pass }
  })

  await check('CITATION.bibtexKey', EXPECTED.get('CITATION.bibtexKey').expected, async () => {
    const data = await call('citation.format', { ids: [PAPER], style: 'bibtex' }, 30_000)
    const content = String(data?.content ?? '')
    const keyMatch = /@\w+\{\s*([^,\s]+)\s*,/.exec(content)
    const key = keyMatch?.[1] ?? null
    const readable = key !== null && key.length >= 8 && !key.startsWith('ph-') && /[a-z]/i.test(key) && /\d{2,4}/.test(key)
    const authorsJoined = /\band\b/.test(content)
    const head = content.slice(0, 400)
    return {
      actual: { key, readable, authorsJoined, head },
      pass: readable && authorsJoined && !content.includes('{{') && !content.includes('}{'),
    }
  })

  await check('CITATION.key', EXPECTED.get('CITATION.key').expected, async () => {
    const keys = await call('citation.key', { ids: [PAPER] }, 30_000)
    const items = keys?.keys ?? []
    const entry = items.find((item) => item.id === PAPER)
    const bibtex = await call('citation.format', { ids: [PAPER], style: 'bibtex' }, 30_000)
    const bibtexKey = /@\w+\{\s*([^,\s]+)\s*,/.exec(String(bibtex?.content ?? ''))?.[1] ?? null
    const pass =
      entry !== undefined &&
      typeof entry.key === 'string' &&
      entry.key.length >= 8 &&
      entry.source === 'authoryear' &&
      bibtexKey !== null &&
      entry.key === bibtexKey
    return { actual: { entry: entry ?? null, bibtexKey, items: clipValue(items) }, pass }
  })

  let exportAnnotationId = null
  await check('EXPORT.annotations.markdown', EXPECTED.get('EXPORT.annotations.markdown').expected, async () => {
    const created = await call('annotations.create', {
      paperId: PAPER,
      page: 3,
      kind: 'highlight',
      quote: `v03 export quote ${RUN_STAMP}`,
      rects: [{ x: 0.2, y: 0.3, w: 0.3, h: 0.02 }],
      color: 'blue',
      comment: `v03 export comment ${RUN_STAMP}`,
      origin: 'test_note',
      operationId: `v03-export-ann-${RUN_STAMP}`,
    })
    exportAnnotationId = created?.annotation?.id ?? null
    if (exportAnnotationId !== null) state.created.annotationIds.push(exportAnnotationId)
    const exported = await call('export.annotations', { paperId: PAPER, format: 'markdown' }, 30_000)
    const content = String(exported?.content ?? '')
    const hasPage = /(?:第\s*3\s*页|page\s*3|\bpage\b.*\b3\b|:\s*3\b)/i.test(content)
    const hasQuote = content.includes(`v03 export quote ${RUN_STAMP}`)
    const hasComment = content.includes(`v03 export comment ${RUN_STAMP}`)
    const hasColor = /blue|#|yellow|green|red|purple/i.test(content)
    const hasTime = /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/.test(content)
    return {
      actual: {
        annotationId: exportAnnotationId,
        count: exported?.count ?? null,
        chars: content.length,
        hasPage,
        hasQuote,
        hasComment,
        hasColor,
        hasTime,
        head: content.slice(0, 420),
      },
      pass: hasPage && hasQuote && hasComment && hasColor && hasTime && Number(exported?.count ?? 0) >= 1,
    }
  })

  await check('EXPORT.annotations.json', EXPECTED.get('EXPORT.annotations.json').expected, async () => {
    const exported = await call('export.annotations', { paperId: PAPER, format: 'json' }, 30_000)
    let parsed = exported?.content
    let parsedOk = false
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed)
        parsedOk = true
      } catch {
        parsedOk = false
      }
    } else {
      parsedOk = typeof parsed === 'object'
    }
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.annotations) ? parsed.annotations : Array.isArray(parsed?.items) ? parsed.items : []
    const found = entries.find((entry) => entry.id === exportAnnotationId) ?? entries[0] ?? null
    const pass =
      parsedOk &&
      Number(exported?.count ?? 0) >= 1 &&
      found !== null &&
      typeof found === 'object' &&
      (found.page === 3 || Number(found.page) === 3) &&
      typeof found.quote === 'string' &&
      found.quote.includes('v03 export quote') &&
      typeof found.comment === 'string' &&
      found.comment.includes('v03 export comment')
    // clean up the export annotation immediately; it must not survive the suite
    if (exportAnnotationId !== null) {
      await call('annotations.delete', { id: exportAnnotationId, operationId: `v03-export-ann-del-${RUN_STAMP}` }).catch(() => {})
    }
    return {
      actual: {
        count: exported?.count ?? null,
        parsedOk,
        entries: entries.length,
        first: found === null ? null : { id: found.id, page: found.page, quote: String(found.quote ?? '').slice(0, 60), comment: String(found.comment ?? '').slice(0, 60), color: found.color, createdAt: found.createdAt },
      },
      pass,
    }
  })

  await check('EXPORT.bibtex', EXPECTED.get('EXPORT.bibtex').expected, async () => {
    const data = await call('export.bibtex', { ids: [PAPER] }, 30_000)
    const content = String(data?.content ?? '')
    const key = /@\w+\{\s*([^,\s]+)\s*,/.exec(content)?.[1] ?? null
    return {
      actual: { head: content.slice(0, 220), key },
      pass: /@article\{/.test(content) && key !== null && key.length >= 8 && content.includes(' and ') && !content.includes('{{'),
    }
  })
}

/* ------------------------------------------------------------------ *
 * 5) Duplicates / merge
 * ------------------------------------------------------------------ */
async function duplicateSetup() {
  const fixture = state.fixture
  if (fixture === null) return
  const setup = { tagDup: `v03-merge-dup-tag-${RUN_STAMP}`, tagPrimary: `v03-merge-primary-tag-${RUN_STAMP}`, collectionId: null, annotationId: null }
  state.merge = setup
  try {
    await call('library.update', { id: fixture.id, patch: { addTags: [setup.tagDup] }, operationId: `v03-merge-tagdup-${RUN_STAMP}` })
    await call('library.update', { id: PAPER, patch: { addTags: [setup.tagPrimary] }, operationId: `v03-merge-tagprimary-${RUN_STAMP}` })
    state.created.tagNames.push(setup.tagDup, setup.tagPrimary)
    const collection = await call('library.collections.create', {
      name: `v03-merge-coll-${RUN_STAMP}`,
      color: '#7c5cff',
      operationId: `v03-merge-coll-${RUN_STAMP}`,
    })
    setup.collectionId = collection?.collection?.id ?? null
    if (setup.collectionId !== null) state.created.collectionIds.push(setup.collectionId)
    if (setup.collectionId !== null) {
      await call('library.collections.assign', { collectionId: setup.collectionId, paperIds: [fixture.id, PAPER], add: true, operationId: `v03-merge-assign-${RUN_STAMP}` })
    }
    await call('library.setRead', { id: fixture.id, read: true, operationId: `v03-merge-read-${RUN_STAMP}` })
    const created = await call('annotations.create', {
      paperId: fixture.id,
      page: 2,
      kind: 'highlight',
      quote: `v03 merge annotation quote ${RUN_STAMP}`,
      rects: [{ x: 0.15, y: 0.25, w: 0.4, h: 0.02 }],
      color: 'purple',
      comment: `v03 merge annotation comment ${RUN_STAMP}`,
      origin: 'test_note',
      operationId: `v03-merge-ann-${RUN_STAMP}`,
    })
    setup.annotationId = created?.annotation?.id ?? null
    if (setup.annotationId !== null) state.created.annotationIds.push(setup.annotationId)
  } catch (error) {
    state.cleanupErrors.push(`duplicate setup: ${String(error?.message ?? error)}`)
  }
}

async function duplicateCases() {
  const caseId = 'DUP.structure'
  if (state.fixture === null || !state.merge?.collectionId) {
    notRun(caseId, EXPECTED.get(caseId).expected, 'duplicate fixture not available: cannot construct a duplicate group in the real library')
    notRun('DUP.merge', EXPECTED.get('DUP.merge').expected, 'duplicate fixture not available')
    notRun('DUP.merge.undo', EXPECTED.get('DUP.merge.undo').expected, 'duplicate fixture not available')
    return
  }
  await check(caseId, EXPECTED.get(caseId).expected, async () => {
    const data = await call('library.duplicates', {}, 30_000)
    const groups = Array.isArray(data?.groups) ? data.groups : null
    const found = (groups ?? []).find((group) => {
      const ids = (group?.items ?? []).map((paper) => paper.id)
      return ids.includes(PAPER) && ids.includes(state.fixture.id)
    })
    const structureOk =
      groups !== null &&
      groups.every(
        (group) =>
          group !== null &&
          typeof group.key === 'string' &&
          ['sha256', 'title'].includes(group.reason) &&
          Array.isArray(group.items) &&
          group.items.length >= 2,
      )
    return {
      actual: {
        groups: groups === null ? null : groups.length,
        structureOk,
        found: found === undefined ? null : { key: found.key, reason: found.reason, ids: (found.items ?? []).map((paper) => paper.id) },
        allGroups: (groups ?? []).map((group) => ({ key: group.key, reason: group.reason, ids: (group.items ?? []).map((paper) => paper.id) })),
      },
      pass: structureOk && found !== undefined,
    }
  })

  await check('DUP.merge', EXPECTED.get('DUP.merge').expected, async () => {
    const beforePrimary = await getPaper(PAPER)
    state.merge.readBefore = beforePrimary?.read === true
    const duplicateId = state.fixture.id
    const since = isoNow()
    const opId = `v03-merge-${RUN_STAMP}`
    let merged = null
    try {
      merged = await call('library.merge', { primaryId: PAPER, duplicateIds: [duplicateId], operationId: opId }, 60_000)
    } catch (error) {
      state.merge.failed = { code: error?.code ?? null, message: String(error?.message ?? error) }
      return {
        actual: { error: String(error?.message ?? error), code: error?.code ?? null, note: 'the merge call threw; per-paper assertions were skipped' },
        pass: false,
        notes: 'contract §1.3 requires the merge to succeed; the whole call failed',
      }
    }
    const primary = await getPaper(PAPER)
    const duplicate = await getPaper(duplicateId)
    const primaryAnnotations = await call('annotations.list', { paperId: PAPER })
    const movedAnnotation = primaryAnnotations.find((entry) => entry.id === state.merge.annotationId) ?? null
    const duplicateAnnotations = await call('annotations.list', { paperId: duplicateId, state: 'all' }).catch(() => [])
    const trashedList = merged?.trashed ?? merged?.trashedIds ?? []
    const trashedIncludes = Array.isArray(trashedList) ? trashedList.includes(duplicateId) : Boolean(trashedList)
    const primaryTags = primary?.tags ?? []
    const primaryCollections = (primary?.collections ?? []).map((collection) => collection.id)
    const pass =
      merged?.primaryId === PAPER &&
      trashedIncludes &&
      ['trash', 'trashed'].includes(duplicate?.state) &&
      primary?.state === 'active' &&
      primaryTags.includes(state.merge.tagDup) &&
      primaryTags.includes(state.merge.tagPrimary) &&
      primaryCollections.includes(state.merge.collectionId) &&
      primary?.read === true &&
      primary?.fileInfo?.sha256 === beforePrimary?.fileInfo?.sha256 &&
      movedAnnotation !== null &&
      movedAnnotation.paperId === PAPER &&
      !(duplicateAnnotations ?? []).some((entry) => entry.id === state.merge.annotationId)
    state.journal.merge = { operationId: null }
    return {
      actual: {
        response: clipValue(merged),
        primary: {
          state: primary?.state,
          tags: primaryTags,
          collections: primaryCollections,
          read: primary?.read,
          fileSha: primary?.fileInfo?.sha256,
          annotations: (primaryAnnotations ?? []).length,
        },
        duplicate: { state: duplicate?.state, annotations: (duplicateAnnotations ?? []).length },
        movedAnnotation: movedAnnotation === null ? null : { id: movedAnnotation.id, paperId: movedAnnotation.paperId },
      },
      pass,
    }
  })

  await check('DUP.merge.undo', EXPECTED.get('DUP.merge.undo').expected, async () => {
    if (state.merge?.failed) {
      notRun(
        'DUP.merge.undo',
        EXPECTED.get('DUP.merge.undo').expected,
        `upstream merge failed (${state.merge.failed.code ?? 'error'}): the undo path cannot be exercised`,
        { actual: { mergeError: state.merge.failed } },
      )
      return { skipped: true }
    }
    const since = new Date(Date.now() - 60_000).toISOString()
    const { item } = await findOperation(MATCHERS.merge, { since })
    if (item === undefined) {
      return { actual: { journalFound: false }, pass: false, notes: 'operations.recent contains no merge entry' }
    }
    state.journal.merge = { operationId: item.id }
    const undo = await call('operations.undo', { operationId: item.id })
    const primary = await getPaper(PAPER)
    const duplicate = await getPaper(state.fixture.id)
    const duplicateTags = duplicate?.tags ?? []
    const duplicateCollections = (duplicate?.collections ?? []).map((collection) => collection.id)
    const duplicateAnnotations = await call('annotations.list', { paperId: state.fixture.id })
    const journal = await journalEntry(item.id)
    const pass =
      duplicate?.state === 'active' &&
      duplicateTags.includes(state.merge.tagDup) &&
      duplicateCollections.includes(state.merge.collectionId) &&
      duplicate?.read === true &&
      (duplicateAnnotations ?? []).some((entry) => entry.id === state.merge.annotationId && entry.paperId === state.fixture.id) &&
      !(primary?.tags ?? []).includes(state.merge.tagDup) &&
      primary?.read === (state.merge.readBefore === true)
    return {
      actual: {
        journalOperation: { id: item.id, kind: item.kind, summary: item.summary },
        undo: clipValue(undo),
        journalUndone: journal?.undone ?? null,
        duplicate: { state: duplicate?.state, tags: duplicateTags, collections: duplicateCollections, read: duplicate?.read, annotations: (duplicateAnnotations ?? []).length },
        primary: { state: primary?.state, tags: primary?.tags, read: primary?.read },
      },
      pass,
    }
  })
}

/* ------------------------------------------------------------------ *
 * 6) AI fast mode
 * ------------------------------------------------------------------ */
// Per-run unique inputs: AI results are cached per (mode, model, prompt hash), so a
// constant text would make the cache-separation assertions depend on earlier runs.
const FAST_TEXT = `The proposed method improves retrieval accuracy by 12% on three benchmarks while using half the memory (${RUN_STAMP}).`
const QUICK_TEXT = `Crop models simulate the effect of management on yields (${RUN_STAMP}).`

async function timedCall(fn) {
  const started = Date.now()
  try {
    const data = await fn()
    return { data, ms: Date.now() - started }
  } catch (error) {
    return { error: String(error?.message ?? error), ms: Date.now() - started }
  }
}

function translateOutcome(entry, sourceText) {
  const data = entry?.data ?? {}
  const reason = String(data.reason ?? data.provenance?.reason ?? entry?.error ?? '').trim()
  if (data.status === 'translated') {
    const translation = String(data.translation ?? '')
    const notCopy = translation.trim() !== '' && translation.trim() !== String(sourceText).trim()
    return {
      ok: notCopy,
      degraded: false,
      detail: {
        status: data.status,
        fast: data.fast ?? null,
        reasoningEffort: data.reasoningEffort ?? null,
        hasReasoningField: Object.hasOwn(data, 'reasoningEffort'),
        cached: data.cached ?? null,
        model: data.provenance?.model ?? null,
        translation: translation.slice(0, 100),
        ms: entry.ms,
      },
    }
  }
  return {
    ok: reason !== '' && !data.translation,
    degraded: true,
    detail: {
      status: data.status ?? null,
      fast: data.fast ?? null,
      reasoningEffort: data.reasoningEffort ?? null,
      hasReasoningField: Object.hasOwn(data, 'reasoningEffort'),
      reason,
      ms: entry.ms,
    },
  }
}

async function aiCases() {
  let aiStatus = null
  try {
    aiStatus = await call('ai.status', {}, 20_000)
  } catch (error) {
    aiStatus = { available: false, reason: String(error?.message ?? error) }
  }
  state.ai.status = aiStatus

  const fast1 = await timedCall(() => call('translate.text', { text: FAST_TEXT, target: 'zh', fast: true }, 60_000))
  state.ai.fast = fast1
  await check('AI.fast.translate', EXPECTED.get('AI.fast.translate').expected, async () => {
    const outcome = translateOutcome(fast1, FAST_TEXT)
    const strictFast = outcome.degraded ? true : outcome.detail.fast === true && outcome.detail.hasReasoningField
    return {
      actual: {
        aiStatus: { available: aiStatus?.available ?? null, provider: aiStatus?.provider ?? null, model: aiStatus?.model ?? null },
        ...outcome.detail,
        reason: fast1?.error ?? null,
      },
      pass: outcome.ok && strictFast,
      notes: outcome.degraded
        ? 'degraded path accepted only because it carries an explicit reason and no fabricated translation'
        : 'fast:true and reasoningEffort are present on the success path',
    }
  })

  const fast2 = await timedCall(() => call('translate.text', { text: FAST_TEXT, target: 'zh', fast: true }, 60_000))
  const quick = await timedCall(() => call('ai.quickTranslate', { text: QUICK_TEXT, target: 'zh', fast: true }, 60_000))
  state.ai.quick = quick
  await check('AI.fast.quickTranslate', EXPECTED.get('AI.fast.quickTranslate').expected, async () => {
    const outcome = translateOutcome(quick, QUICK_TEXT)
    const strictFast = outcome.degraded ? true : outcome.detail.fast === true
    return {
      actual: { ...outcome.detail, reason: quick?.error ?? null },
      pass: outcome.ok && strictFast,
      notes: outcome.degraded ? 'degraded path accepted with explicit reason' : 'alias success path',
    }
  })

  const deep = await timedCall(() => call('translate.text', { text: FAST_TEXT, target: 'zh', fast: false }, 120_000))
  state.ai.deep = deep
  const fastTranslated = fast1?.data?.status === 'translated'
  const deepTranslated = deep?.data?.status === 'translated'

  await check('AI.cache.separation', EXPECTED.get('AI.cache.separation').expected, async () => {
    if (!fastTranslated) {
      notRun('AI.cache.separation', EXPECTED.get('AI.cache.separation').expected, 'AI unavailable/failed on the fast path: cache separation cannot be observed', {
        actual: { fast1: translateOutcome(fast1, FAST_TEXT).detail },
      })
      return { skipped: true }
    }
    const secondCached = fast2?.data?.cached === true
    const deepCached = deep?.data?.cached === true
    const pass = secondCached && (!deepTranslated || deepCached === false)
    return {
      actual: {
        fast1: { status: fast1?.data?.status, cached: fast1?.data?.cached ?? null },
        fast2: { status: fast2?.data?.status, cached: fast2?.data?.cached ?? null },
        deep: { status: deep?.data?.status, cached: deep?.data?.cached ?? null },
        secondCached,
        deepCached,
        deepTranslated,
        deepReason: deep?.data?.reason ?? deep?.error ?? null,
      },
      pass,
      notes: 'the deep request reuses the same source text; it must not report cached=true unless the cache key includes the fast/deep mode.',
    }
  })

  await check('AI.deep.timing', EXPECTED.get('AI.deep.timing').expected, async () => {
    if (!fastTranslated || !deepTranslated) {
      notRun('AI.deep.timing', EXPECTED.get('AI.deep.timing').expected, 'one of the two translation modes did not return a translation; timing comparison would be meaningless', {
        actual: { fast: translateOutcome(fast1, FAST_TEXT).detail, deep: translateOutcome(deep, FAST_TEXT).detail },
      })
      return { skipped: true }
    }
    state.timings.fastTranslateMs = fast1.ms
    state.timings.deepTranslateMs = deep.ms
    return {
      actual: {
        fastMs: fast1.ms,
        deepMs: deep.ms,
        deltaMs: deep.ms - fast1.ms,
        ratio: fast1.ms > 0 ? Number((deep.ms / fast1.ms).toFixed(2)) : null,
        fastReasoningEffort: fast1?.data?.reasoningEffort ?? null,
        note: 'measured numbers only; no hard performance target is asserted',
      },
      pass: true,
    }
  })

  const ask = await timedCall(() =>
    call('ai.ask', { paperId: PAPER, page: 1, prompt: '用一句话概括这一页的主要贡献。', mode: 'fast' }, 90_000),
  )
  state.ai.ask = ask
  await check('AI.fast.ask', EXPECTED.get('AI.fast.ask').expected, async () => {
    const data = ask?.data ?? {}
    const answer = String(data.answer ?? '')
    const reason = String(data.reason ?? data.provenance?.reason ?? ask?.error ?? '').trim()
    const okBranch = data.status === 'ok' && answer.length > 3 && Number(data.elapsedMs ?? 0) >= 0
    const degradedBranch = ['unavailable', 'error', 'degraded'].includes(String(data.status ?? '')) && reason !== '' && answer === ''
    return {
      actual: {
        status: data.status ?? null,
        chars: answer.length,
        model: data.model ?? data.provider ?? null,
        sources: clipValue(data.sources),
        elapsedMs: data.elapsedMs ?? null,
        clientMs: ask.ms,
        reason: reason === '' ? null : reason,
      },
      pass: okBranch || degradedBranch,
      notes: okBranch ? 'fast ask success path' : 'degraded path accepted with explicit reason and no fabricated answer',
    }
  })
}

/* ------------------------------------------------------------------ *
 * 7) Cleanup + reference sanity
 * ------------------------------------------------------------------ */
async function cleanupAndReferenceCases() {
  const cleanupErrors = state.cleanupErrors

  // remove any annotation the suite may have left behind
  try {
    const listed = await call('annotations.list', { paperId: PAPER, state: 'all' }).catch(() => [])
    for (const annotation of listed ?? []) {
      if (state.created.annotationIds.includes(annotation.id)) {
        await call('annotations.delete', { id: annotation.id, operationId: `v03-clean-ann-${RUN_STAMP}` }).catch(() => {})
      }
    }
  } catch (error) {
    cleanupErrors.push(`annotation cleanup: ${String(error?.message ?? error)}`)
  }

  // remove the test tags from the user paper
  if (state.created.tagNames.length > 0) {
    try {
      await call('library.update', { id: PAPER, patch: { removeTags: [...state.created.tagNames] }, operationId: `v03-clean-tag-${RUN_STAMP}` })
    } catch (error) {
      cleanupErrors.push(`tag cleanup: ${String(error?.message ?? error)}`)
    }
  }

  // restore the captured baseline read flag / reading progress on the user paper
  try {
    const detail = await getPaper(PAPER)
    const baselineRead = state.paperBaseline?.read === true
    const baselineProgress = Number(state.paperBaseline?.readingProgress ?? 0)
    if (detail?.read !== baselineRead) {
      await call('library.setRead', { id: PAPER, read: baselineRead, operationId: `v03-clean-read-${RUN_STAMP}` })
    }
    if (Number(detail?.readingProgress ?? 0) !== baselineProgress) {
      await call('library.update', { id: PAPER, patch: { readingProgress: baselineProgress }, operationId: `v03-clean-progress-${RUN_STAMP}` })
    }
  } catch (error) {
    cleanupErrors.push(`paper state cleanup: ${String(error?.message ?? error)}`)
  }

  // purge the disposable metrics fixture (metadata-only paper in its own test journal)
  if (state.metricsFixture !== null) {
    const metricsFixtureId = state.metricsFixture.id
    try {
      const detail = await getPaper(metricsFixtureId).catch(() => null)
      if (detail !== null && !['trash', 'trashed'].includes(detail.state)) {
        await call('library.delete', { ids: [metricsFixtureId], operationId: `v03-clean-metrics-del-${RUN_STAMP}` })
      }
      const purge = await call('library.purge', { ids: [metricsFixtureId], operationId: `v03-clean-metrics-purge-${RUN_STAMP}` }, 60_000)
      state.evidence.metricsFixturePurge = { id: metricsFixtureId, response: clipValue(purge) }
    } catch (error) {
      cleanupErrors.push(`metrics fixture purge: ${String(error?.message ?? error)}`)
    }
  }

  // delete the test collection
  for (const collectionId of state.created.collectionIds) {
    try {
      await call('library.collections.delete', { id: collectionId, operationId: `v03-clean-coll-${RUN_STAMP}` })
    } catch (error) {
      cleanupErrors.push(`collection cleanup (${collectionId}): ${String(error?.message ?? error)}`)
    }
  }

  // delete + purge the disposable duplicate; the purge supplies the irreversible
  // operation for the not_undoable case.
  let purgeOperationId = null
  if (state.fixture !== null) {
    const fixtureId = state.fixture.id
    try {
      const detail = await getPaper(fixtureId).catch(() => null)
      if (detail !== null && !['trash', 'trashed'].includes(detail.state)) {
        await call('library.delete', { ids: [fixtureId], operationId: `v03-clean-fixture-del-${RUN_STAMP}` })
      }
      const purgeOp = `v03-clean-fixture-purge-${RUN_STAMP}`
      const purge = await call('library.purge', { ids: [fixtureId], operationId: purgeOp }, 60_000)
      state.evidence.purge = { operationId: purgeOp, response: clipValue(purge) }
      purgeOperationId = purgeOp
      const recent = await recentOperations(60)
      const purgeEntry = recent.filter((item) => MATCHERS.purge(String(item.kind ?? '').toLowerCase())).sort((left, right) => operationTime(right) - operationTime(left))[0]
      state.evidence.purgeJournal = purgeEntry === undefined ? null : { id: purgeEntry.id, kind: purgeEntry.kind, summary: purgeEntry.summary, undone: purgeEntry.undone }
      if (purgeEntry !== undefined) {
        let undoResponse = null
        let undoError = null
        try {
          undoResponse = await call('operations.undo', { operationId: purgeEntry.id })
        } catch (error) {
          undoError = { code: error?.code ?? null, message: String(error?.message ?? error) }
        }
        const status = String(undoResponse?.status ?? '').toLowerCase()
        const reason = String(undoResponse?.reason ?? undoError?.message ?? '').trim()
        record(
          'UNDO.notUndoable',
          EXPECTED.get('UNDO.notUndoable').expected,
          {
            purgeJournal: { id: purgeEntry.id, kind: purgeEntry.kind },
            undo: clipValue(undoResponse),
            undoError,
            reason,
          },
          (status === 'not_undoable' || undoError?.code === 'not_undoable') && reason !== '',
          { group: 'UNDO' },
        )
      } else {
        // Some implementations may accept the client operationId directly.
        let fallback = null
        let fallbackError = null
        try {
          fallback = await call('operations.undo', { operationId: purgeOp })
        } catch (error) {
          fallbackError = { code: error?.code ?? null, message: String(error?.message ?? error) }
        }
        const status = String(fallback?.status ?? '').toLowerCase()
        if (status === 'not_undoable') {
          record(
            'UNDO.notUndoable',
            EXPECTED.get('UNDO.notUndoable').expected,
            { purgeJournal: null, undo: clipValue(fallback), undoError: fallbackError, reason: String(fallback?.reason ?? '') },
            String(fallback?.reason ?? '').trim() !== '',
            { group: 'UNDO' },
          )
        } else {
          notRun(
            'UNDO.notUndoable',
            EXPECTED.get('UNDO.notUndoable').expected,
            `purge 未出现在 operations.recent，且 operations.undo("${purgeOp}") 未返回 not_undoable（${fallbackError?.code ?? status ?? 'unknown'}）；契约 §1.2 只列出可逆操作，purge 不可逆路径无法构造`,
            { actual: { fallback: clipValue(fallback), fallbackError } },
          )
        }
      }
    } catch (error) {
      cleanupErrors.push(`fixture purge: ${String(error?.message ?? error)}`)
      notRun('UNDO.notUndoable', EXPECTED.get('UNDO.notUndoable').expected, `fixture purge failed: ${String(error?.message ?? error)}`)
    }
  } else {
    notRun('UNDO.notUndoable', EXPECTED.get('UNDO.notUndoable').expected, 'duplicate fixture missing: no disposable paper to purge')
  }

  // reference sanity: read-only search still works
  await check('REF.search', EXPECTED.get('REF.search').expected, async () => {
    const data = await call('search.query', { q: 'reinforcement learning', scope: 'papers', limit: 3 }, 60_000)
    const items = data?.items ?? []
    return {
      actual: { items: items.length, first: items[0] === undefined ? null : { paperId: items[0].paperId, title: String(items[0].title ?? '').slice(0, 60) } },
      pass: items.length > 0 && items.every((item) => typeof item.paperId === 'string'),
    }
  })

  // data preservation: compare against the pre-run baseline
  const after = await readEnvironment()
  state.after = { counts: after.counts, finishedAt: isoNow() }
  const tagsAfter = await call('tags.list').catch(() => ({ items: [] }))
  const collectionsAfter = await call('library.collections.list').catch(() => ({ items: [] }))
  const tagNames = new Set((tagsAfter.items ?? []).map((tag) => tag.name))
  const leftoverTags = [...state.created.tagNames].filter((name) => tagNames.has(name))
  const collectionIds = new Set((collectionsAfter.items ?? []).map((collection) => collection.id))
  const leftoverCollections = state.created.collectionIds.filter((id) => collectionIds.has(id))
  const fixtureDetail = state.fixture === null ? null : await getPaper(state.fixture.id).catch(() => null)
  const metricsFixtureDetail = state.metricsFixture === null ? null : await getPaper(state.metricsFixture.id).catch(() => null)
  const fixtureGone = state.fixture === null ? true : fixtureDetail === null
  const metricsFixtureGone = state.metricsFixture === null ? true : metricsFixtureDetail === null
  const baseline = state.baseline?.counts ?? {}
  const countsMatch =
    after.counts?.papers === baseline.papers &&
    after.counts?.annotations === baseline.annotations &&
    after.counts?.figures === baseline.figures &&
    after.counts?.trash === baseline.trash
  const paperRead = (await getPaper(PAPER).catch(() => null))?.read ?? null
  const paperReadRestored = paperRead === (state.paperBaseline?.read === true)
  await check('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, async () => {
    return {
      actual: {
        baseline: clipValue(baseline),
        after: clipValue(after.counts),
        countsMatch,
        fixtureGone,
        metricsFixtureGone,
        leftoverTags,
        leftoverCollections,
        userPaperReadState: paperRead,
        baselineRead: state.paperBaseline?.read ?? null,
        paperReadRestored,
        cleanupErrors,
      },
      pass: countsMatch && fixtureGone && metricsFixtureGone && leftoverTags.length === 0 && leftoverCollections.length === 0 && paperReadRestored,
      notes: 'journal entries created by this suite are append-only and are not deleted by design.',
    }
  })
}

/* ------------------------------------------------------------------ *
 * Summary / output
 * ------------------------------------------------------------------ */
function buildReport(exitCode) {
  state.finishedAt = isoNow()
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
  const report = {
    schema: 'pappers-hall/v03-api-results@1',
    suite: 'v0.3 API acceptance',
    summary: {
      total: results.length,
      pass: counts.pass,
      fail: counts.fail,
      not_run: counts.not_run,
      byGroup,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      base: BASE,
      exitCode,
    },
    environment: state.environment ?? null,
    baseline: state.baseline,
    after: state.after,
    evidence: state.evidence,
    ai: {
      status: state.ai.status,
      timings: state.timings,
      fast: translateOutcome(state.ai.fast, FAST_TEXT).detail,
      quick: translateOutcome(state.ai.quick, QUICK_TEXT).detail,
      deep: translateOutcome(state.ai.deep, FAST_TEXT).detail,
      ask: state.ai.ask?.data
        ? {
            status: state.ai.ask.data.status ?? null,
            chars: String(state.ai.ask.data.answer ?? '').length,
            elapsedMs: state.ai.ask.data.elapsedMs ?? null,
            clientMs: state.ai.ask.ms,
            reason: state.ai.ask.data.reason ?? null,
          }
        : state.ai.ask,
    },
    results,
  }
  return report
}

async function finish(exitCode) {
  const report = buildReport(exitCode)
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  const { pass, fail, not_run: notRunCount } = report.summary
  console.log(`\nV0.3 API RESULT: ${pass}/${report.summary.total} pass, ${fail} fail, ${notRunCount} not_run → ${OUT}`)
  process.exitCode = exitCode
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  if (DRY_RUN) {
    const unique = new Set(PLAN.map(([id]) => id))
    if (unique.size !== PLAN.length) throw new Error('duplicate case ids in PLAN')
    console.log('Pappers-Hall v0.3 API acceptance suite — DRY RUN (no API writes, no test fixture)\n')
    let currentGroup = null
    for (const [id, group, expected] of PLAN) {
      if (group !== currentGroup) {
        console.log(`\n[${group}]`)
        currentGroup = group
      }
      console.log(`  ${id.padEnd(34)} ${expected}`)
    }
    console.log(`\nplanned cases: ${PLAN.length}`)
    if (!existsSync(DUP_SOURCE)) {
      console.log(`DRY RUN WARNING: duplicate fixture source PDF missing: ${DUP_SOURCE}`)
    } else {
      const head = readFileSync(DUP_SOURCE, { encoding: 'latin1' }).slice(0, 5)
      console.log(`duplicate fixture source: ${DUP_SOURCE} (${head === '%PDF-' ? 'valid %PDF-' : 'NOT a PDF'})`)
    }
    try {
      const environment = await readEnvironment()
      const version = String(environment.pluginVersion ?? 'unknown')
      const schema = environment.schemaVersion
      console.log(`live host: version=${version} schemaVersion=${String(schema)} papers=${environment.counts?.papers ?? '?'} annotations=${environment.counts?.annotations ?? '?'} ai=${environment.ai?.available === true ? 'available' : 'unavailable'}`)
      if (version.startsWith('0.3') || Number(schema) >= 3) {
        console.log('v0.3 host appears loaded — a real run is possible after the Lead sends GO v03.')
      } else {
        console.log('v0.3 host is NOT loaded yet (still 0.2.x): the real run is correctly gated on the Lead reload + "GO v03".')
      }
      const probe = await call('operations.recent', { limit: 1 }, 5_000).then(
        (data) => `present (${Array.isArray(data?.items) ? data.items.length : '?'} journal item(s))`,
        (error) => `probe-miss (${error?.code ?? String(error?.message ?? error)})`,
      )
      console.log(`operations.recent probe: ${probe} (read-only; a v0.2 host has no such method)`)
    } catch (error) {
      console.log(`live host probe failed: ${String(error?.message ?? error)}`)
    }
    console.log('\nDRY RUN OK: script parses, the case plan is complete, no data was written. Waiting for "GO v03".')
    process.exitCode = 0
    return
  }

  // ---------- real run: environment gate ----------
  let environment
  try {
    environment = await readEnvironment()
  } catch (error) {
    console.error('V0.3 SUITE ERROR: live host unreachable:', String(error?.message ?? error))
    process.exitCode = 2
    return
  }
  state.environment = {
    plugin: environment.status?.plugin ?? null,
    schemaVersion: environment.schemaVersion,
    counts: environment.counts,
    features: environment.features,
    ai: environment.ai,
    versions: environment.diagnostics?.versions ?? null,
    degraded: environment.status?.degraded ?? null,
  }
  state.baseline = { counts: environment.counts, capturedAt: state.startedAt }

  const version = String(environment.pluginVersion ?? '')
  const v03Loaded = version.startsWith('0.3') || Number(environment.schemaVersion) >= 3
  await check('ENV.version', EXPECTED.get('ENV.version').expected, async () => {
    return {
      actual: { pluginVersion: environment.pluginVersion, schemaVersion: environment.schemaVersion, dsh: environment.diagnostics?.host?.dsh ?? null },
      pass: v03Loaded,
    }
  })
  if (!v03Loaded) {
    console.error(`\nV0.3 GATE: host reports plugin version ${environment.pluginVersion || 'unknown'} / schemaVersion ${String(environment.schemaVersion)}; the v0.3 code is not loaded yet. Refusing to run mutation cases. Wait for the Lead reload + "GO v03".`)
    await finish(2)
    return
  }

  await check('ENV.baseline', EXPECTED.get('ENV.baseline').expected, async () => {
    const counts = environment.counts ?? {}
    const pass =
      Number(counts.papers ?? 0) >= 30 &&
      Number(counts.annotations ?? 0) >= 1 &&
      Number(counts.figures ?? 0) >= 300 &&
      Number(counts.trash ?? -1) === 0
    return { actual: { counts }, pass }
  })
  try {
    // capture the user paper state the suite must fully restore
    state.paper = await getPaper(PAPER)
    state.paperBaseline = {
      read: state.paper?.read === true,
      readingProgress: Number(state.paper?.readingProgress ?? 0),
    }
    console.log(`baseline ${PAPER}: read=${String(state.paperBaseline.read)} readingProgress=${state.paperBaseline.readingProgress}`)
    await prepareFixture()
    await prepareMetricsFixture()
    await metricsCases()
    await listCases()
    await undoAnnotationCreateCase()
    await undoAnnotationUpdateCase()
    await undoSetReadCase()
    await undoTagsCase()
    await undoDeleteCase()
    await undoIdempotentCase()
    await duplicateSetup()
    await citationExportCases()
    await duplicateCases()
    await aiCases()
  } catch (error) {
    console.error('V0.3 SUITE ERROR (unexpected):', error?.stack ?? error)
    process.exitCode = 2
  } finally {
    // cleanup always runs: the live library must not be left with test artefacts
    try {
      await cleanupAndReferenceCases()
    } catch (error) {
      console.error('V0.3 CLEANUP ERROR:', error?.stack ?? error)
      if (!recordedIds.has('REF.data.preserved')) {
        notRun('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, `suite aborted during cleanup: ${String(error?.message ?? error)}`)
      }
      process.exitCode = 2
    }
  }

  const fail = results.filter((entry) => entry.status === 'fail').length
  const notRunCount = results.filter((entry) => entry.status === 'not_run').length
  const exitCode = process.exitCode === 2 ? 2 : fail > 0 ? 1 : 0
  void notRunCount
  await finish(exitCode)
}

main().catch(async (error) => {
  console.error('V0.3 SUITE FATAL:', error?.stack ?? error)
  try {
    await finish(2)
  } catch {
    process.exit(2)
  }
})
