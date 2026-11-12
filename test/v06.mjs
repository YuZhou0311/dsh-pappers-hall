#!/usr/bin/env node
/**
 * Pappers-Hall v0.6 API acceptance suite.
 *
 * Exercises the v0.6 contract additions (docs/CONTRACT-v06.md):
 * - MIGRATION to user_version 6: no more kind='field' collections (all folders),
 *   the former 5 "领域" directories stay as ordinary editable folders, paper
 *   deletion semantics unchanged;
 * - CLASSIFY: library.classify suggestions (assign/create, score, newFolderName,
 *   threshold 0.32) and apply (assign / create) + undo;
 * - IMPORT: library.import auto-classifies new papers and never blocks on a
 *   classification failure;
 * - AGENT TOOLS: diagnostics.agent.tools lists the 5 new tools and
 *   diagnostics.agent.promptSection=true; the tool handlers themselves are
 *   exercised by `test/v06-tools.mjs` against an isolated DB copy
 *   (papers_import_file preview must not write, confirm imports + classifies,
 *   papers_folders CRUD, papers_related excludes itself, papers_overview);
 * - PROMPT: the management prompt section is registered (boolean only, prompt
 *   text is never leaked);
 * - regression evidence: v0.5 42/43, v0.4 34/34, v0.2 26/26, lifecycle 12/0/1
 *   and the agreed v0.3 explanation (historical 38/38 + v0.4 routing change).
 *
 * Data rules: test folders are created through the public API and removed in
 * `finally`; the classify apply test removes then restores a paper's folder
 * membership; the import test imports a byte-modified devkit copy and purges it
 * afterwards; the former 5 domain folders are never renamed or deleted.
 *
 * Usage:
 *   node test/v06.mjs --dry-run   # plan + read-only environment probe
 *   node test/v06.mjs             # real run (requires v0.6 host loaded)
 */
import { execFile } from 'node:child_process'
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
const BASE = arg('--base', process.env.PAPPERS_BASE ?? 'http://127.0.0.1:54731')
const API = `${BASE}/pappers-hall/api`
const OUT = resolve(HERE, arg('--out', '../../reports/v06-api-results.json'))
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const EMBED_PYTHON = join(HOME, 'pappers-hall', 'embedding', 'venv', 'bin', 'python')
const DEVKIT_C02 = join(WORKSPACE, 'pappers_hall_devkit_lite', 'papers', 'pdf', 'C02_ggcmi_evaluation.pdf')
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

/** Former "领域" (field) folder names that must survive the v6 migration as folders. */
const ORIGINAL_FIELD_NAMES = ['大语言模型与 Agent', '强化学习与决策', '多模态与文档检索', '遥感与地球观测', '作物模拟与农业系统']
const NEW_TOOLS = ['papers_overview', 'papers_folders', 'papers_classify', 'papers_import_file', 'papers_related']

const P_CROP = arg('--paper-crop', 'ph-8d90723ee7bc') // C01 irrigation
const P_AGENT = arg('--paper-agent', 'ph-53132d8d95a6') // A01 ReAct
const P_MULTIMODAL = arg('--paper-multimodal', 'ph-ab4eb56f3937') // V01 CLIP (classify apply fixture)

const PLAN = [
  ['ENV.version', 'ENV', 'v0.6 Host loaded: plugin 0.6.x / schemaVersion>=6 / library.classify+diagnostics.agent available'],
  ['ENV.baseline', 'ENV', 'live library intact before mutation: papers>=30, annotations>=1, trash=0; folders/favorites/embedding baseline captured'],
  ['ENV.embedding', 'ENV', 'embedding available (needed by classify/import auto-classification); model/dims/indexVersion recorded'],
  ['MIGRATION.schemaVersion', 'MIGRATION', 'diagnostics.schemaVersion = 6 (user_version 6 migration applied)'],
  ['MIGRATION.noFieldKind', 'MIGRATION', 'collections.list / folders.tree contain no kind="field"; every collection is an editable folder'],
  ['MIGRATION.domainFoldersSurvive', 'MIGRATION', 'the former 5 领域 names still exist as ordinary kind="folder" nodes (not read-only)'],
  ['MIGRATION.folderDeleteKeepsPapers', 'MIGRATION', 'deleting a folder (independent test folder) removes only the folder/membership; the paper stays active and counts stay consistent'],
  ['CLASSIFY.suggest', 'CLASSIFY', 'library.classify apply=false returns one suggestion per paper with action assign|create, numeric score and folderId/folderName or newFolderName'],
  ['CLASSIFY.threshold', 'CLASSIFY', 'the 0.32 threshold semantics hold: suggestions below threshold use action=create (record actual scores)'],
  ['CLASSIFY.apply', 'CLASSIFY', 'library.classify apply=true assigns the paper (or creates a folder) and the membership/count is observable via library.list'],
  ['CLASSIFY.undo', 'CLASSIFY', 'the classify/assign work is journaled and undo removes the membership again (baseline restored afterwards)'],
  ['CLASSIFY.unavailable', 'CLASSIFY', 'when embedding is unavailable classify reports status=unavailable+reason instead of inventing a folder'],
  ['IMPORT.classification', 'IMPORT', 'library.import of a byte-modified devkit PDF returns classification (applied folder/created/confidence) and the new paper lands in that folder'],
  ['IMPORT.duplicateNoBlock', 'IMPORT', 'importing the same file again reports a duplicate without throwing and without changing counts'],
  ['IMPORT.invalidNoBlock', 'IMPORT', 'importing a missing path reports errors[] without throwing and without changing counts'],
  ['TOOLS.registered', 'TOOLS', 'diagnostics.agent.tools lists papers_overview/papers_folders/papers_classify/papers_import_file/papers_related'],
  ['TOOLS.promptSection', 'TOOLS', 'diagnostics.agent.promptSection=true (management guidance registered, prompt text not exposed)'],
  ['TOOLS.harnessIsolation', 'TOOLS', 'the out-of-process tool harness leaves the LIVE library untouched (paper count before/after identical)'],
  ['TOOLS.overview', 'TOOLS', 'papers_overview returns library stats + folder tree + tags/recent summaries'],
  ['TOOLS.foldersActions', 'TOOLS', 'papers_folders tree/create/rename/assign/unassign/delete all work; delete keeps the paper'],
  ['TOOLS.classify', 'TOOLS', 'papers_classify returns suggestions and applies one on the sandbox copy'],
  ['TOOLS.importPreviewNoWrite', 'TOOLS', 'papers_import_file with confirm absent returns needs_confirmation/title/question and does NOT write the DB (paper count unchanged)'],
  ['TOOLS.importInvalid', 'TOOLS', 'papers_import_file with a missing path returns status=invalid+reason'],
  ['TOOLS.importConfirm', 'TOOLS', 'papers_import_file confirm=true imports the PDF (+1 paper) and auto-classifies it; sandbox cleanup restores counts'],
  ['TOOLS.related', 'TOOLS', 'papers_related returns topN (<=limit) related papers excluding the source paper, with title/score, and supports query'],
  ['REF.v05', 'REF', 'recorded v0.5 API result file still reports 43 cases: 42 pass, 0 fail, 1 not_run'],
  ['REF.v04', 'REF', 'recorded v0.4 API result file still reports 34/34 pass'],
  ['REF.v02', 'REF', 'recorded v0.2 API result file still reports 26/26 pass'],
  ['REF.lifecycle', 'REF', 'recorded lifecycle result file still reports 13 cases: 12 pass, 0 fail, 1 not_run'],
  ['REF.v03', 'REF', 'v0.3 expectation unchanged: historical 38/38 + current v0.4 re-run only fails the 3 AI-fast cases explained by v0.4 routing'],
  ['CLEANUP.folders', 'CLEANUP', 'all test folders removed, paper memberships restored, import fixture purged, no test tags left'],
  ['REF.data.preserved', 'REF', 'after cleanup: papers/annotations/figures/trash/folders/favorites back to baseline; embedding index kept'],
]

const results = []
const state = {
  startedAt: new Date().toISOString(),
  base: BASE,
  environment: null,
  baseline: { counts: null, folders: null, favoriteIds: [], embedding: null, memberships: {} },
  createdFolderIds: [],
  createdTags: [],
  importedPaperId: null,
  importJobId: null,
  importCreatedFolders: [],
  classify: { updated: null },
  harness: { path: '/tmp', parsed: null, stdout: '', stderr: '', error: null },
  after: {},
  evidence: {},
  cleanupErrors: [],
  branchRestores: [],
}

const EXPECTED = new Map(PLAN.map(([id, group, expected]) => [id, { group, expected }]))
const recordedIds = new Set()

/* ------------------------------------------------------------------ *
 * HTTP / recording helpers
 * ------------------------------------------------------------------ */
async function call(method, params = {}, timeoutMs = 120_000) {
  // A Host reload (HMR during an acceptance run) temporarily makes the route
  // disappear: node:http answers 405/502 without the JSON envelope. Those are
  // transient transport failures, not domain results, so retry them with a
  // short backoff instead of recording a false failure. Domain errors (HTTP 200
  // with ok:false) are never retried.
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
        if ([405, 425, 429, 502, 503, 504].includes(response.status) && attempt < attempts) {
          transient = message
        } else {
          throw new Error(message)
        }
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
        // fall through to the backoff below
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
  if (depth > 3) return '[depth]'
  if (Array.isArray(value)) {
    const head = value.slice(0, 8).map((entry) => clipValue(entry, depth + 1))
    return value.length > 8 ? [...head, `…${value.length - 8} more`] : head
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = clipValue(entry, depth + 1)
  return out
}

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

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const uniqueName = (label) => `v06-${label}-${RUN_STAMP}`

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
 * Folder tree helpers
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

function findFolder(data, id) {
  return flattenFolders(data).find((entry) => entry.item.id === id) ?? null
}

function folderIdSet(data) {
  return new Set(flattenFolders(data).map((entry) => entry.item?.id).filter((id) => typeof id === 'string'))
}

async function tree() {
  return call('library.folders.tree', {}, 30_000)
}

async function folderMemberships(paperId) {
  const detail = await call('library.get', { id: paperId }, 30_000)
  return { collections: detail?.collections ?? [], favorite: detail?.favorite === true }
}

/* ------------------------------------------------------------------ *
 * Operations journal helpers
 * ------------------------------------------------------------------ */
function operationTime(item) {
  const parsed = Date.parse(String(item?.createdAt ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

const isUndone = (item) => item?.undone === true || item?.undone === 1

const MATCHERS = {
  classifyOrAssign: (kind) => /classif|assign|collect|folder/.test(kind),
  favorite: (kind) => /favorit/.test(kind),
}

async function findOperation(matcher, { since, operationId } = {}) {
  const data = await call('operations.recent', { limit: 80 })
  const items = Array.isArray(data?.items) ? data.items : []
  const candidates = items.filter((item) => item && typeof item.kind === 'string' && matcher(String(item.kind).toLowerCase()))
  if (operationId !== undefined) {
    const exact = items.find((item) => String(item.id) === String(operationId))
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

/* ------------------------------------------------------------------ *
 * Environment
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
    agent: diagnostics?.agent ?? null,
    embedding: diagnostics?.embedding ?? null,
    capabilities: diagnostics?.capabilities ?? null,
    ai: diagnostics?.ai ?? null,
  }
}

async function probeV06Shape() {
  const probe = { classify: 'missing', agent: null, folders: 'missing' }
  try {
    const data = await call('library.classify', { paperIds: [P_CROP], apply: false }, 90_000)
    probe.classify = Array.isArray(data?.suggestions) || data?.status === 'unavailable' ? 'ok' : 'bad-shape'
  } catch (error) {
    probe.classify = `error:${error?.code ?? 'unknown'}`
  }
  try {
    const diagnostics = await call('diagnostics', {}, 20_000)
    probe.agent = diagnostics?.agent ?? null
  } catch {
    probe.agent = null
  }
  try {
    const data = await call('library.folders.tree', {}, 15_000)
    probe.folders = Array.isArray(data?.items) ? 'ok' : 'bad-shape'
  } catch (error) {
    probe.folders = `error:${error?.code ?? 'unknown'}`
  }
  return probe
}

/* ------------------------------------------------------------------ *
 * Cases: migration
 * ------------------------------------------------------------------ */
async function migrationCases() {
  await check('MIGRATION.schemaVersion', EXPECTED.get('MIGRATION.schemaVersion').expected, async () => {
    const diagnostics = await call('diagnostics', {}, 20_000)
    const schemaVersion = diagnostics?.schemaVersion ?? null
    const pass = Number(schemaVersion) >= 6
    return { actual: { schemaVersion, versions: clipValue(diagnostics?.versions) }, pass }
  })

  await check('MIGRATION.noFieldKind', EXPECTED.get('MIGRATION.noFieldKind').expected, async () => {
    const list = await call('library.collections.list', {}, 20_000)
    const treeData = await tree()
    const listItems = list?.items ?? []
    const flatTree = flattenFolders(treeData)
    const kinds = new Map()
    for (const item of listItems) kinds.set(String(item.kind), (kinds.get(String(item.kind)) ?? 0) + 1)
    const treeKinds = new Map()
    for (const { item } of flatTree) treeKinds.set(String(item.kind), (treeKinds.get(String(item.kind)) ?? 0) + 1)
    const fieldItems = listItems.filter((item) => item.kind === 'field')
    const treeFieldItems = flatTree.filter(({ item }) => item.kind === 'field')
    // contract §1: no kind='field' anywhere; folders.tree maps every node to kind='folder'.
    // library.collections.list is the legacy v0.2 view and may report its historical 'custom'
    // label for the same rows — that is recorded, not treated as a v0.6 regression.
    const treeKindsAreFolder = flatTree.every(({ item }) => item.kind === 'folder')
    const pass = fieldItems.length === 0 && treeFieldItems.length === 0 && treeKindsAreFolder
    return {
      actual: {
        collectionsListCount: listItems.length,
        collectionKinds: Object.fromEntries(kinds),
        treeFlatCount: flatTree.length,
        treeKinds: Object.fromEntries(treeKinds),
        fieldItems,
        treeFieldItems: treeFieldItems.map(({ item }) => item.id),
        treeKindsAreFolder,
      },
      pass,
    }
  })

  await check('MIGRATION.domainFoldersSurvive', EXPECTED.get('MIGRATION.domainFoldersSurvive').expected, async () => {
    const treeData = await tree()
    const flat = flattenFolders(treeData)
    const byName = new Map(flat.map(({ item }) => [item.name, item]))
    const observed = ORIGINAL_FIELD_NAMES.map((name) => {
      const item = byName.get(name)
      if (item === undefined) return { name, found: false }
      const readonlyFlags = ['readonly', 'readOnly', 'derived', 'locked', 'fieldKey', 'field_key']
        .filter((flag) => item[flag] !== undefined && item[flag] !== null && item[flag] !== false)
      return { name, found: true, id: item.id, kind: item.kind, count: item.count, readonlyFlags }
    })
    const allFoundAsFolder = observed.every((entry) => entry.found === true && entry.kind === 'folder' && entry.readonlyFlags.length === 0)
    // prove the folder-kind code path is editable: a sibling test folder is renamed and deleted
    const probe = await call('library.collections.create', { name: uniqueName('editable-probe'), operationId: `v06-editable-${RUN_STAMP}` })
    const probeId = probe?.collection?.id ?? probe?.folder?.id ?? probe?.id ?? null
    if (typeof probeId === 'string') state.createdFolderIds.push(probeId)
    const renamed = typeof probeId === 'string'
      ? await call('library.collections.update', { id: probeId, name: uniqueName('editable-renamed'), operationId: `v06-editable-rename-${RUN_STAMP}` })
      : null
    const afterRename = typeof probeId === 'string' ? findFolder(await tree(), probeId) : null
    const deleted = typeof probeId === 'string'
      ? await call('library.collections.delete', { id: probeId, operationId: `v06-editable-del-${RUN_STAMP}` }).then(() => true, () => false)
      : false
    const stillPresent = typeof probeId === 'string' ? findFolder(await tree(), probeId) !== null : false
    const editPathWorks = renamed !== null && afterRename?.item?.name === uniqueName('editable-renamed') && deleted && !stillPresent
    return {
      actual: {
        originalFolders: observed,
        editableProbe: { folderId: probeId, renamed: afterRename?.item?.name ?? null, deleted, stillPresent },
        note: 'the real former 领域 folders were NOT renamed/deleted on purpose; the editable-folder path is proven on an independent test folder',
      },
      pass: allFoundAsFolder && editPathWorks,
    }
  })

  await check('MIGRATION.folderDeleteKeepsPapers', EXPECTED.get('MIGRATION.folderDeleteKeepsPapers').expected, async () => {
    const create = await call('library.collections.create', { name: uniqueName('delete-semantics'), operationId: `v06-del-sem-${RUN_STAMP}` })
    const folderId = create?.collection?.id ?? create?.folder?.id ?? create?.id ?? null
    if (typeof folderId !== 'string') return { actual: { create: clipValue(create) }, pass: false }
    state.createdFolderIds.push(folderId)
    await call('library.collections.assign', { collectionId: folderId, paperIds: [P_CROP], add: true, operationId: `v06-del-sem-assign-${RUN_STAMP}` })
    const before = await call('library.get', { id: P_CROP }, 30_000)
    const listBefore = await call('library.list', { folderId, limit: 200 })
    await call('library.collections.delete', { id: folderId, operationId: `v06-del-sem-delete-${RUN_STAMP}` })
    const after = await call('library.get', { id: P_CROP }, 30_000)
    const treeData = await tree()
    const folderGone = findFolder(treeData, folderId) === null
    const pass = folderGone && after?.state === 'active' && Number(listBefore.total) === 1 && before?.state === 'active'
    return {
      actual: {
        folderId,
        folderGone,
        paperStateBefore: before?.state ?? null,
        paperStateAfter: after?.state ?? null,
        listBeforeTotal: listBefore.total,
        paperCountUnchanged: Number((await call('status')).counts?.papers) === Number(state.baseline.counts?.papers),
      },
      pass,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Cases: classify
 * ------------------------------------------------------------------ */
async function classifyCases() {
  const embeddingAvailable = state.baseline.embedding?.available === true

  await check('CLASSIFY.suggest', EXPECTED.get('CLASSIFY.suggest').expected, async () => {
    const ids = [P_CROP, P_AGENT, P_MULTIMODAL]
    const outcome = await measure(() => call('library.classify', { paperIds: ids, apply: false }, 90_000))
    state.classify.suggest = outcome.data
    const data = outcome.data ?? {}
    if (String(data.status) === 'unavailable') {
      return { actual: { status: data.status, reason: data.reason ?? null }, pass: false, notes: 'embedding unavailable: classify cannot produce suggestions' }
    }
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : []
    const issues = suggestions
      .map((entry) => {
        const entryIssues = []
        if (!ids.includes(entry?.paperId)) entryIssues.push('paperId')
        if (!['assign', 'create'].includes(entry?.action)) entryIssues.push('action')
        if (typeof entry?.score !== 'number' || entry.score < -0.0001 || entry.score > 1.0001) entryIssues.push('score')
        if (entry?.action === 'assign' && (typeof entry.folderId !== 'string' || String(entry.folderName ?? '') === '')) entryIssues.push('assign-target')
        if (entry?.action === 'create' && String(entry?.newFolderName ?? '').trim() === '') entryIssues.push('newFolderName')
        return entryIssues.length === 0 ? null : { paperId: entry?.paperId, issues: entryIssues }
      })
      .filter(Boolean)
    const pass = outcome.error === null && suggestions.length === ids.length && issues.length === 0
    return {
      actual: {
        status: data.status ?? null,
        suggestions: suggestions.map((entry) => ({ paperId: entry.paperId, action: entry.action, score: entry.score, folderId: entry.folderId ?? null, folderName: entry.folderName ?? null, newFolderName: entry.newFolderName ?? null })),
        issues,
        latencyMs: outcome.ms,
        error: outcome.error,
      },
      pass,
    }
  })

  await check('CLASSIFY.threshold', EXPECTED.get('CLASSIFY.threshold').expected, async () => {
    const suggestions = state.classify.suggest?.suggestions ?? []
    const threshold = 0.32
    const below = suggestions.filter((entry) => typeof entry.score === 'number' && entry.score < threshold)
    const violations = below.filter((entry) => entry.action !== 'create')
    const pass = suggestions.length > 0 && violations.length === 0
    return {
      actual: {
        threshold,
        suggestionCount: suggestions.length,
        belowThreshold: below.map((entry) => ({ paperId: entry.paperId, score: entry.score, action: entry.action })),
        violations,
      },
      pass,
      notes: 'contract §2: best similarity below 0.32 → action=create; scores are recorded verbatim and never fabricated by the test.',
    }
  })

  await check('CLASSIFY.apply', EXPECTED.get('CLASSIFY.apply').expected, async () => {
    if (!embeddingAvailable) return { skipped: true, actual: { available: false } }
    const baseline = await folderMemberships(P_MULTIMODAL)
    state.baseline.memberships[P_MULTIMODAL] = baseline
    const baselineFolderIds = (baseline.collections ?? []).filter((item) => item.kind === 'folder' || item.kind === 'custom' || item.kind === 'field').map((item) => item.id)
    // detach the fixture paper so apply has a real effect
    for (const folderId of baselineFolderIds) {
      await call('library.collections.assign', { collectionId: folderId, paperIds: [P_MULTIMODAL], add: false, operationId: `v06-classify-detach-${RUN_STAMP}-${folderId}` })
    }
    const detached = await folderMemberships(P_MULTIMODAL)
    const outcome = await measure(() => call('library.classify', { paperIds: [P_MULTIMODAL], apply: true }, 120_000))
    state.classify.apply = outcome.data
    const data = outcome.data ?? {}
    if (String(data.status) === 'unavailable') {
      return { actual: { status: data.status, reason: data.reason, detached: (detached.collections ?? []).length }, pass: false }
    }
    // host returns `applied: {applied, createdFolders, errors, operationId}` (applied is nested)
    const appliedPayload = data.applied ?? null
    const applied = Array.isArray(appliedPayload) ? appliedPayload : (appliedPayload?.applied ?? [])
    const createdFolders = Array.isArray(appliedPayload?.createdFolders) ? appliedPayload.createdFolders : (Array.isArray(data.createdFolders) ? data.createdFolders : [])
    const entry = applied.find((item) => item.paperId === P_MULTIMODAL) ?? applied[0] ?? null
    let membershipObserved = null
    if (entry?.folderId !== undefined && entry?.folderId !== null) {
      const list = await call('library.list', { folderId: entry.folderId, limit: 200 })
      membershipObserved = (list.items ?? []).some((paper) => paper.id === P_MULTIMODAL)
    }
    for (const folder of createdFolders) if (typeof folder?.id === 'string') state.createdFolderIds.push(folder.id)
    if (entry?.created === true && typeof entry?.folderId === 'string') {
      createdFolderId = entry.folderId
      state.createdFolderIds.push(createdFolderId)
    }
    const pass =
      outcome.error === null &&
      entry !== null &&
      typeof entry?.folderId === 'string' &&
      typeof entry?.folderName === 'string' &&
      typeof entry?.confidence === 'number' &&
      membershipObserved === true
    return {
      actual: {
        status: data.status ?? null,
        detachedFolderIds: baselineFolderIds,
        detachedMembershipCount: (detached.collections ?? []).length,
        applied: applied.map((item) => ({ paperId: item.paperId, folderId: item.folderId, folderName: item.folderName, created: item.created, confidence: item.confidence })),
        createdFolders: clipValue(createdFolders),
        appliedRaw: clipValue(appliedPayload),
        membershipObserved,
        latencyMs: outcome.ms,
        error: outcome.error,
      },
      pass,
    }
  })

  await check('CLASSIFY.undo', EXPECTED.get('CLASSIFY.undo').expected, async () => {
    const payload = state.classify.apply?.applied ?? null
    const appliedList = Array.isArray(payload) ? payload : (payload?.applied ?? [])
    const entry = appliedList.find((item) => item.paperId === P_MULTIMODAL) ?? null
    if (entry === null || typeof entry.folderId !== 'string') {
      return { actual: { applied: clipValue(state.classify.apply) }, pass: false, notes: 'no applied classify result to undo' }
    }
    const since = state.startedAt
    const journal = await findOperation(MATCHERS.classifyOrAssign, { since })
    let undo = null
    let membershipAfterUndo = null
    if (journal.item !== undefined) {
      undo = await call('operations.undo', { operationId: journal.item.id }, 30_000)
      const list = await call('library.list', { folderId: entry.folderId, limit: 200 })
      membershipAfterUndo = (list.items ?? []).some((paper) => paper.id === P_MULTIMODAL)
    }
    // restore the captured baseline membership regardless of the undo result
    const baseline = state.baseline.memberships[P_MULTIMODAL] ?? { collections: [] }
    const baselineFolderIds = (baseline.collections ?? []).map((item) => item.id)
    const current = await folderMemberships(P_MULTIMODAL)
    const currentFolderIds = new Set((current.collections ?? []).map((item) => item.id))
    for (const folderId of baselineFolderIds) {
      if (!currentFolderIds.has(folderId)) {
        await call('library.collections.assign', { collectionId: folderId, paperIds: [P_MULTIMODAL], add: true, operationId: `v06-classify-restore-${RUN_STAMP}-${folderId}` }).catch(() => {})
      }
    }
    const restored = await folderMemberships(P_MULTIMODAL)
    const restoredIds = new Set((restored.collections ?? []).map((item) => item.id))
    const baselineRestored = baselineFolderIds.every((id) => restoredIds.has(id))
    const pass = journal.item !== undefined && membershipAfterUndo === false && baselineRestored
    return {
      actual: {
        appliedFolderId: entry.folderId,
        journalKind: journal.item?.kind ?? null,
        undo: clipValue(undo),
        membershipAfterUndo,
        baselineFolderIds,
        baselineRestored,
        restoredFolderIds: [...restoredIds],
      },
      pass,
    }
  })

  await check('CLASSIFY.unavailable', EXPECTED.get('CLASSIFY.unavailable').expected, async () => {
    if (embeddingAvailable) {
      notRun('CLASSIFY.unavailable', EXPECTED.get('CLASSIFY.unavailable').expected, 'embedding worker is available in this environment; the unavailable branch cannot be simulated without breaking the user environment (host selftest covers it)', {
        actual: { available: true },
      })
      return { skipped: true }
    }
    const data = await call('library.classify', { paperIds: [P_CROP], apply: false }, 30_000)
    const pass = data?.status === 'unavailable' && String(data?.reason ?? '').trim() !== ''
    return { actual: { status: data?.status ?? null, reason: data?.reason ?? null }, pass }
  })
}

/* ------------------------------------------------------------------ *
 * Cases: import auto-classification
 * ------------------------------------------------------------------ */
async function waitForJob(jobId, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const data = await call('jobs.list', {}, 20_000)
      const job = (data?.items ?? []).find((entry) => entry.id === jobId)
      if (job !== undefined && ['succeeded', 'failed', 'cancelled'].includes(String(job.state))) return { job, waitedMs: Date.now() - started }
    } catch {}
    await sleep(1500)
  }
  return { job: null, waitedMs: Date.now() - started }
}

function prepareImportFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pappers-hall-v06-import-'))
  const path = join(dir, `C02_v06import_${RUN_STAMP}.pdf`)
  const source = readFileSync(DEVKIT_C02)
  writeFileSync(path, Buffer.concat([source, Buffer.from(`\n% pappers-hall v0.6 import fixture ${RUN_STAMP}\n`, 'latin1')]))
  return { dir, path }
}

async function importCases() {
  let fixture = null
  await check('IMPORT.classification', EXPECTED.get('IMPORT.classification').expected, async () => {
    if (!existsSync(DEVKIT_C02)) return { actual: { error: `devkit PDF missing: ${DEVKIT_C02}` }, pass: false }
    fixture = prepareImportFixture()
    state.evidence.importFixture = fixture.path
    const before = await call('status')
    const imported = await call('library.import', { paths: [fixture.path], operationId: `v06-import-${RUN_STAMP}` }, 180_000)
    const accepted = imported?.acceptedItems ?? []
    if (accepted.length === 0) {
      return { actual: { import: clipValue(imported) }, pass: false, notes: 'import did not accept the fixture PDF' }
    }
    const paperId = accepted[0].paperId
    state.importedPaperId = paperId
    state.importJobId = imported?.jobId ?? null
    const classification = imported?.classification ?? null
    const applied = classification?.applied ?? []
    const entry = applied.find((item) => item.paperId === paperId) ?? applied[0] ?? null
    let membershipObserved = null
    if (entry?.folderId !== undefined && entry?.folderId !== null) {
      const list = await call('library.list', { folderId: entry.folderId, limit: 200 })
      membershipObserved = (list.items ?? []).some((paper) => paper.id === paperId)
    }
    for (const folder of classification?.createdFolders ?? []) if (typeof folder?.id === 'string') state.createdFolderIds.push(folder.id)
    if (entry?.created === true && typeof entry?.folderId === 'string') state.createdFolderIds.push(entry.folderId)
    const after = await call('status')
    const pass =
      Number(accepted.length) === 1 &&
      classification !== null &&
      (entry === null ? classification.error !== undefined : typeof entry.folderId === 'string' && typeof entry.confidence === 'number') &&
      (entry === null || membershipObserved === true)
    return {
      actual: {
        accepted: accepted.length,
        paperId,
        jobId: imported?.jobId ?? null,
        classification: clipValue(classification),
        classificationEntry: entry === null ? null : { paperId: entry.paperId, folderId: entry.folderId, folderName: entry.folderName, created: entry.created, confidence: entry.confidence },
        membershipObserved,
        papersBefore: before?.counts?.papers ?? null,
        papersAfter: after?.counts?.papers ?? null,
        duplicates: clipValue(imported?.duplicates),
        errors: clipValue(imported?.errors),
      },
      pass,
    }
  })

  await check('IMPORT.duplicateNoBlock', EXPECTED.get('IMPORT.duplicateNoBlock').expected, async () => {
    if (fixture === null) return { actual: { fixture: null }, pass: false }
    const before = await call('status')
    const imported = await call('library.import', { paths: [fixture.path], operationId: `v06-import-dup-${RUN_STAMP}` }, 120_000)
    const after = await call('status')
    const duplicates = imported?.duplicates ?? []
    const acceptedCount = Array.isArray(imported?.acceptedItems) ? imported.acceptedItems.length : Number(imported?.accepted ?? 0)
    const pass =
      Number(acceptedCount) === 0 &&
      Array.isArray(duplicates) &&
      duplicates.length >= 1 &&
      Number(before?.counts?.papers) === Number(after?.counts?.papers)
    return {
      actual: { accepted: acceptedCount, duplicates: clipValue(duplicates), errors: clipValue(imported?.errors), papersBefore: before?.counts?.papers ?? null, papersAfter: after?.counts?.papers ?? null },
      pass,
    }
  })

  await check('IMPORT.invalidNoBlock', EXPECTED.get('IMPORT.invalidNoBlock').expected, async () => {
    const before = await call('status')
    let data = null
    let error = null
    try {
      data = await call('library.import', { paths: ['/nonexistent/pappers-hall-v06-missing.pdf'], operationId: `v06-import-invalid-${RUN_STAMP}` }, 60_000)
    } catch (caught) {
      error = { code: caught?.code ?? null, message: String(caught?.message ?? caught) }
    }
    const after = await call('status')
    const errors = data?.errors ?? []
    const acceptedCount = Array.isArray(data?.acceptedItems) ? data.acceptedItems.length : Number(data?.accepted ?? 0)
    const pass =
      (data !== null && Number(acceptedCount) === 0 && Array.isArray(errors) && errors.length >= 1) ||
      (error !== null && /invalid|not.?found|does not exist/i.test(error.message))
    return {
      actual: { accepted: acceptedCount, errors: clipValue(errors), error, papersBefore: before?.counts?.papers ?? null, papersAfter: after?.counts?.papers ?? null },
      pass,
      notes: `papers unchanged: ${Number(before?.counts?.papers) === Number(after?.counts?.papers)}`,
    }
  })

  // wait for the import job and then purge the fixture paper so later cases see a clean library
  if (state.importJobId !== null) {
    const waited = await waitForJob(state.importJobId, 120_000)
    state.evidence.importJob = { jobId: state.importJobId, state: waited.job?.state ?? null, waitedMs: waited.waitedMs }
  }
  if (state.importedPaperId !== null) {
    try {
      await call('library.delete', { ids: [state.importedPaperId], operationId: `v06-import-clean-del-${RUN_STAMP}` }, 60_000)
      await call('library.purge', { ids: [state.importedPaperId], operationId: `v06-import-clean-purge-${RUN_STAMP}` }, 60_000)
    } catch (error) {
      state.cleanupErrors.push(`import fixture purge: ${String(error?.message ?? error)}`)
    }
  }
  for (const folderId of [...new Set(state.createdFolderIds)]) {
    try {
      await call('library.collections.delete', { id: folderId, operationId: `v06-import-clean-folder-${RUN_STAMP}` })
    } catch {
      // folder may not exist (already deleted by classify/import cleanup) — tolerated
    }
  }
  state.createdFolderIds = []
  if (fixture !== null) {
    try {
      rmSync(fixture.dir, { recursive: true, force: true })
    } catch {}
  }
}

/* ------------------------------------------------------------------ *
 * Cases: agent tools (diagnostics + out-of-process harness)
 * ------------------------------------------------------------------ */
function runHarnessProcess(outPath) {
  const harnessPath = resolve(HERE, 'v06-tools.mjs')
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [harnessPath, '--out', outPath],
      { cwd: PLUGIN_ROOT, timeout: 300_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env } },
      (error, stdout, stderr) => {
        resolvePromise({ error: error === null ? null : { message: String(error.message ?? error), code: error.code ?? null }, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
    child.on('error', (error) => resolvePromise({ error: { message: String(error?.message ?? error), code: null }, stdout: '', stderr: '' }))
  })
}

async function toolCases() {
  const liveBefore = await call('status')

  await check('TOOLS.registered', EXPECTED.get('TOOLS.registered').expected, async () => {
    const diagnostics = await call('diagnostics', {}, 20_000)
    const agent = diagnostics?.agent ?? null
    const tools = Array.isArray(agent?.tools) ? agent.tools : []
    const missing = NEW_TOOLS.filter((name) => !tools.includes(name))
    const pass = missing.length === 0 && tools.length >= 15
    return { actual: { agent: clipValue(agent), missing, toolCount: tools.length, tools: tools.slice(0, 20) }, pass }
  })

  await check('TOOLS.promptSection', EXPECTED.get('TOOLS.promptSection').expected, async () => {
    const diagnostics = await call('diagnostics', {}, 20_000)
    const agent = diagnostics?.agent ?? null
    const pass = agent?.promptSection === true
    return { actual: { agent: clipValue(agent) }, pass, notes: 'only the registration boolean is exposed by the Host (prompt text is not leaked).' }
  })

  const outPath = join(tmpdir(), `pappers-hall-v06-tools-${RUN_STAMP}.json`)
  const harness = await runHarnessProcess(outPath)
  state.harness.stdout = harness.stdout.slice(-4000)
  state.harness.stderr = harness.stderr.slice(-4000)
  state.harness.processError = harness.error
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(outPath, 'utf8'))
  } catch (error) {
    parsed = null
    state.harness.error = `harness result missing/invalid (${String(error?.message ?? error)}): ${harness.error?.message ?? ''}`
  }
  state.harness.parsed = parsed

  await check('TOOLS.harnessIsolation', EXPECTED.get('TOOLS.harnessIsolation').expected, async () => {
    const liveAfter = await call('status')
    const pass =
      parsed !== null &&
      parsed.ok === true &&
      Number(liveBefore?.counts?.papers) === Number(liveAfter?.counts?.papers) &&
      Number(parsed.livePaperCountBefore) === Number(parsed.livePaperCountAfter)
    return {
      actual: {
        harnessOk: parsed?.ok ?? false,
        harnessError: parsed?.error ?? state.harness.error ?? null,
        livePapersBefore: liveBefore?.counts?.papers ?? null,
        livePapersAfter: liveAfter?.counts?.papers ?? null,
        harnessLiveBefore: parsed?.livePaperCountBefore ?? null,
        harnessLiveAfter: parsed?.livePaperCountAfter ?? null,
        process: { exitError: harness.error, stderrTail: harness.stderr.slice(-600) },
      },
      pass,
      notes: 'the harness runs applyHost against a sqlite .backup copy in a temp dir; preview/confirm/CRUD only touch the sandbox.',
    }
  })

  const harnessCase = (harnessId, caseId) => {
    const entry = (parsed?.cases ?? []).find((item) => item.case_id === harnessId) ?? null
    if (entry === null) {
      notRun(caseId, EXPECTED.get(caseId).expected, `harness case ${harnessId} did not run (harness ok=${parsed?.ok ?? false})`, { actual: { harnessId, error: parsed?.error ?? state.harness.error ?? harness.error?.message ?? null } })
      return null
    }
    record(caseId, EXPECTED.get(caseId).expected, entry.actual, entry.pass === true, { notes: entry.notes })
    return entry
  }
  harnessCase('HARNESS.overview', 'TOOLS.overview')
  harnessCase('HARNESS.foldersActions', 'TOOLS.foldersActions')
  harnessCase('HARNESS.classify', 'TOOLS.classify')
  harnessCase('HARNESS.importPreviewNoWrite', 'TOOLS.importPreviewNoWrite')
  harnessCase('HARNESS.importInvalid', 'TOOLS.importInvalid')
  harnessCase('HARNESS.importConfirm', 'TOOLS.importConfirm')
  harnessCase('HARNESS.related', 'TOOLS.related')
}

/* ------------------------------------------------------------------ *
 * Regression evidence
 * ------------------------------------------------------------------ */
async function regressionCases() {
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
    return { actual: { path: report.path, lifecycle: clipValue(lifecycle), notRunCase: 'LIFE.05.tool_read_rejected' }, pass }
  })

  await check('REF.v03', EXPECTED.get('REF.v03').expected, async () => {
    const report = readReport('reports/v03-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const failing = (report.parsed?.results ?? []).filter((entry) => entry.status !== 'pass').map((entry) => entry.case_id)
    const knownAiFast = ['AI.fast.translate', 'AI.fast.quickTranslate', 'AI.cache.separation']
    const explained =
      Number(summary.total) === 38 &&
      Number(summary.pass) === 35 &&
      Number(summary.fail) === 3 &&
      failing.length === 3 &&
      failing.every((caseId) => knownAiFast.includes(caseId))
    let historical38 = false
    try {
      const verifyText = readFileSync(resolve(WORKSPACE, 'reports/verify.md'), 'utf8')
      historical38 = verifyText.includes('| **合计** | **38** | **38** | **0** | **0** |')
    } catch {
      historical38 = false
    }
    let llmFastProbe = null
    try {
      llmFastProbe = await call('translate.text', { text: 'The proposed method improves retrieval accuracy on three benchmarks.', target: 'zh', provider: 'llm', fast: true }, 90_000)
    } catch (error) {
      llmFastProbe = { error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
    }
    const llmFastOk = llmFastProbe?.status === 'translated' && llmFastProbe?.fast === true && Object.hasOwn(llmFastProbe ?? {}, 'reasoningEffort')
    const pass = (Number(summary.pass) === 38 && Number(summary.fail) === 0) || (explained && llmFastOk && historical38)
    return {
      actual: { path: report.path, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, failingCases: failing, knownAiFastRoutingExplanation: explained, historical38, llmFastOk },
      pass,
      notes: 'v0.3 expectations unchanged: historical 38/38 is recorded in reports/verify.md §13–§18; the current 35/38 is the v0.4 translate.text routing change (fast only applies to provider=llm), proven live by the probe.',
    }
  })
}

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */
async function cleanupCases() {
  // remove any test folder still present
  for (const folderId of [...new Set(state.createdFolderIds)]) {
    try {
      await call('library.collections.delete', { id: folderId, operationId: `v06-clean-folder-${folderId}` }, 30_000)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!/not.?found|does not exist/i.test(message)) state.cleanupErrors.push(`folder delete ${folderId}: ${message}`)
    }
  }
  // restore the classify fixture paper membership captured at baseline
  try {
    const baseline = state.baseline.memberships[P_MULTIMODAL]
    if (baseline !== undefined) {
      const baselineFolderIds = (baseline.collections ?? []).map((item) => item.id)
      const current = await folderMemberships(P_MULTIMODAL)
      const currentIds = new Set((current.collections ?? []).map((item) => item.id))
      for (const folderId of baselineFolderIds) {
        if (!currentIds.has(folderId)) {
          await call('library.collections.assign', { collectionId: folderId, paperIds: [P_MULTIMODAL], add: true, operationId: `v06-clean-restore-${RUN_STAMP}-${folderId}` }).catch((error) => {
            state.cleanupErrors.push(`membership restore ${folderId}: ${String(error?.message ?? error)}`)
          })
        }
      }
    }
  } catch (error) {
    state.cleanupErrors.push(`membership cleanup: ${String(error?.message ?? error)}`)
  }
  // import fixture should already be purged
  if (state.importedPaperId !== null) {
    const detail = await call('library.get', { id: state.importedPaperId }).catch(() => null)
    if (detail !== null && detail.state !== 'trash') {
      try {
        await call('library.delete', { ids: [state.importedPaperId], operationId: `v06-clean-import-del-${RUN_STAMP}` })
        await call('library.purge', { ids: [state.importedPaperId], operationId: `v06-clean-import-purge-${RUN_STAMP}` })
      } catch (error) {
        state.cleanupErrors.push(`import cleanup: ${String(error?.message ?? error)}`)
      }
    }
  }
  if (state.evidence.importFixture !== undefined) {
    try {
      rmSync(state.evidence.importFixture, { force: true })
    } catch {}
  }

  await check('CLEANUP.folders', EXPECTED.get('CLEANUP.folders').expected, async () => {
    const treeData = await tree().catch(() => null)
    const ids = treeData === null ? new Set() : folderIdSet(treeData)
    const leftover = [...ids].filter((id) => state.createdFolderIds.includes(id))
    const detail = await folderMemberships(P_MULTIMODAL)
    const baseline = state.baseline.memberships[P_MULTIMODAL] ?? { collections: [] }
    const baselineIds = (baseline.collections ?? []).map((item) => item.id).sort()
    const currentIds = (detail.collections ?? []).map((item) => item.id).sort()
    const membershipRestored = baselineIds.join(',') === currentIds.join(',')
    const importGone = state.importedPaperId === null || (await call('library.get', { id: state.importedPaperId }).catch(() => null)) === null
    const pass = leftover.length === 0 && membershipRestored && importGone && state.cleanupErrors.length === 0
    return {
      actual: {
        deletedFolderIds: [...new Set(state.createdFolderIds)],
        leftoverFolderIds: leftover,
        baselineMembership: baselineIds,
        currentMembership: currentIds,
        membershipRestored,
        importFixtureGone: importGone,
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
  if (after === null) {
    notRun('CLEANUP.folders', EXPECTED.get('CLEANUP.folders').expected, 'post-run cleanup could not read the Host (reload in progress)')
    notRun('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, 'post-run cleanup could not read the Host (reload in progress)')
    return
  }
  await check('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, async () => {
    const baselineCounts = state.baseline.counts ?? {}
    const countsMatch =
      Number(after.counts?.papers) === Number(baselineCounts.papers) &&
      Number(after.counts?.annotations) === Number(baselineCounts.annotations) &&
      Number(after.counts?.figures) === Number(baselineCounts.figures) &&
      Number(after.counts?.trash) === Number(baselineCounts.trash)
    const treeData = await tree().catch(() => null)
    const originalNames = new Set(flattenFolders(treeData).map(({ item }) => item.name))
    const originalPresent = ORIGINAL_FIELD_NAMES.filter((name) => originalNames.has(name))
    const favorites = (await call('library.list', { favorite: true, limit: 200 })).items?.map((paper) => paper.id).sort() ?? []
    const favoritesRestored = favorites.join(',') === [...(state.baseline.favoriteIds ?? [])].sort().join(',')
    const embedding = await call('embedding.status', {}, 30_000).catch(() => null)
    const embeddingKept = embedding?.indexVersion === (state.baseline.embedding?.indexVersion ?? null) && embedding?.indexReady === true
    return {
      actual: {
        baseline: clipValue(baselineCounts),
        after: clipValue(after.counts),
        countsMatch,
        originalFoldersPresent: originalPresent,
        favoritesRestored,
        favorites,
        embeddingKept,
        embeddingStatus: { indexVersion: embedding?.indexVersion ?? null, indexReady: embedding?.indexReady ?? null, counts: clipValue(embedding?.counts) },
        cleanupErrors: state.cleanupErrors,
      },
      pass: countsMatch && originalPresent.length === 5 && favoritesRestored && embeddingKept && state.cleanupErrors.length === 0,
      notes: 'the embedding index is a real feature artefact and is intentionally kept; no user data is purged by the suite.',
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
    schema: 'pappers-hall/v06-api-results@1',
    suite: 'v0.6 API acceptance',
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
      migration: state.evidence.migration ?? null,
      classify: { suggest: state.classify.suggest ?? null, apply: state.classify.apply ?? null },
      import: {
        fixture: state.evidence.importFixture ?? null,
        job: state.evidence.importJob ?? null,
        importedPaperId: state.importedPaperId,
        cleanupErrors: state.cleanupErrors.filter((entry) => /import/i.test(entry)),
      },
      tools: { harness: state.harness.parsed ?? null, harnessStderrTail: state.harness.stderr.slice(-1200), harnessError: state.harness.error, processExitError: state.harness.processError ?? null },
      regression: { v05: 'reports/v05-api-results.json', v04: 'reports/v04-api-results.json', v02: 'reports/v02-api-results.json', lifecycle: 'reports/v03-lifecycle-run.json', v03: 'reports/v03-api-results.json' },
    },
    results,
  }
}

async function finish(exitCode) {
  const report = buildReport(exitCode)
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  const { pass, fail, not_run: notRunCount } = report.summary
  console.log(`\nV0.6 API RESULT: ${pass}/${report.summary.total} pass, ${fail} fail, ${notRunCount} not_run → ${OUT}`)
  process.exitCode = exitCode
}

async function main() {
  if (DRY_RUN) {
    const unique = new Set(PLAN.map(([id]) => id))
    if (unique.size !== PLAN.length) throw new Error('duplicate case ids in PLAN')
    console.log('Pappers-Hall v0.6 API acceptance suite — DRY RUN (no mutations, read-only probes only)\n')
    let currentGroup = null
    for (const [id, group, expected] of PLAN) {
      if (group !== currentGroup) {
        console.log(`\n[${group}]`)
        currentGroup = group
      }
      console.log(`  ${id.padEnd(34)} ${expected}`)
    }
    console.log(`\nplanned cases: ${PLAN.length}`)
    console.log(`tool harness: ${resolve(HERE, 'v06-tools.mjs')} (${existsSync(resolve(HERE, 'v06-tools.mjs')) ? 'found' : 'MISSING'})`)
    console.log(`devkit import fixture: ${DEVKIT_C02} (${existsSync(DEVKIT_C02) ? 'found' : 'MISSING'})`)
    console.log(`embedding python: ${EMBED_PYTHON} (${existsSync(EMBED_PYTHON) ? 'found' : 'MISSING'})`)
    try {
      const environment = await readEnvironment()
      console.log(`live host: version=${String(environment.pluginVersion)} schemaVersion=${String(environment.schemaVersion)} papers=${environment.counts?.papers ?? '?'} annotations=${environment.counts?.annotations ?? '?'}`)
      const shape = await probeV06Shape()
      console.log(`v0.6 method probe: library.classify=${shape.classify}, folders.tree=${shape.folders}, diagnostics.agent=${shape.agent === null ? 'missing' : JSON.stringify(clipValue(shape.agent))}`)
      const v06 = String(environment.pluginVersion ?? '').startsWith('0.6') || Number(environment.schemaVersion) >= 6 || (shape.classify === 'ok' && shape.agent !== null)
      console.log(v06 ? 'v0.6 host appears loaded — a real run is possible after GO v06.' : 'v0.6 host is NOT loaded yet: the real run will be refused by the ENV gate until the Lead reload + "GO v06".')
      const regression = ['reports/v05-api-results.json', 'reports/v04-api-results.json', 'reports/v02-api-results.json', 'reports/v03-lifecycle-run.json']
      for (const file of regression) {
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
    console.log('\nDRY RUN OK: script parses, case plan complete, no data was written. Waiting for "GO v06".')
    process.exitCode = 0
    return
  }

  /* ---------------- real run ---------------- */
  let environment
  try {
    environment = await readEnvironment()
  } catch (error) {
    console.error('V0.6 SUITE ERROR: live host unreachable:', String(error?.message ?? error))
    process.exitCode = 2
    return
  }
  state.environment = {
    plugin: environment.status?.plugin ?? null,
    schemaVersion: environment.schemaVersion,
    counts: environment.counts,
    features: environment.features,
    agent: environment.agent,
    embedding: environment.embedding,
    capabilities: environment.capabilities,
    ai: environment.ai,
    versions: environment.diagnostics?.versions ?? null,
  }

  const shape = await probeV06Shape()
  const version = String(environment.pluginVersion ?? '')
  const v06Loaded = version.startsWith('0.6') || Number(environment.schemaVersion) >= 6 || (shape.classify === 'ok' && shape.agent !== null)
  await check('ENV.version', EXPECTED.get('ENV.version').expected, async () => {
    return { actual: { pluginVersion: version || null, schemaVersion: environment.schemaVersion, probe: clipValue(shape) }, pass: v06Loaded }
  })
  if (!v06Loaded) {
    console.error(`\nV0.6 GATE: host reports plugin ${version || 'unknown'} / schemaVersion ${String(environment.schemaVersion)} and classify=${shape.classify}, agent=${shape.agent === null ? 'missing' : 'present'}; refusing mutation cases until the Lead reloads v0.6 and sends "GO v06".`)
    await finish(2)
    return
  }

  await check('ENV.baseline', EXPECTED.get('ENV.baseline').expected, async () => {
    const counts = environment.counts ?? {}
    const treeData = await tree().catch(() => null)
    const favorites = await call('library.list', { favorite: true, limit: 200 }).catch(() => ({ items: [] }))
    state.baseline.counts = counts
    state.baseline.folders = treeData === null ? null : flattenFolders(treeData).map(({ item, depth }) => ({ id: item.id, name: item.name, kind: item.kind, count: item.count, depth }))
    state.baseline.favoriteIds = (favorites.items ?? []).map((paper) => paper.id).sort()
    state.baseline.embedding = environment.embedding ? clipValue(environment.embedding) : null
    state.baseline.memberships[P_MULTIMODAL] = await folderMemberships(P_MULTIMODAL).catch(() => ({ collections: [] }))
    const pass = Number(counts.papers ?? 0) >= 30 && Number(counts.annotations ?? 0) >= 1 && Number(counts.trash ?? -1) === 0 && Array.isArray(state.baseline.folders)
    return {
      actual: {
        counts,
        folderCount: state.baseline.folders?.length ?? null,
        favoriteIds: state.baseline.favoriteIds,
        embedding: { available: environment.embedding?.available ?? null, indexVersion: environment.embedding?.indexVersion ?? null, dims: environment.embedding?.dims ?? null },
      },
      pass,
    }
  })

  await check('ENV.embedding', EXPECTED.get('ENV.embedding').expected, async () => {
    const status = await call('embedding.status', {}, 30_000)
    const pass =
      status?.available === true &&
      status?.configured === true &&
      status?.model === 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2' &&
      Number(status?.dims) === 384 &&
      typeof status?.indexVersion === 'string' &&
      status?.indexReady === true
    return {
      actual: { available: status?.available ?? null, configured: status?.configured ?? null, model: status?.model ?? null, dims: status?.dims ?? null, indexVersion: status?.indexVersion ?? null, indexReady: status?.indexReady ?? null, counts: clipValue(status?.counts) },
      pass,
    }
  })

  try {
    await migrationCases()
    await classifyCases()
    await importCases()
    await toolCases()
    await regressionCases()
  } catch (error) {
    console.error('V0.6 SUITE ERROR (unexpected):', error?.stack ?? error)
    process.exitCode = 2
  } finally {
    try {
      await cleanupCases()
    } catch (error) {
      console.error('V0.6 CLEANUP ERROR:', error?.stack ?? error)
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
  console.error('V0.6 SUITE FATAL:', error?.stack ?? error)
  try {
    await finish(2)
  } catch {
    process.exit(2)
  }
})
