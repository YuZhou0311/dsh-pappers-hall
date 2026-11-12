#!/usr/bin/env node
/**
 * Pappers-Hall v0.5 API acceptance suite.
 *
 * Exercises the v0.5 contract additions (docs/CONTRACT-v05.md §1/§2/§4):
 * - Zotero-style FOLDERS: library.folders.tree (nested + descendant counts),
 *   create/rename/move/cycle-rejection/field-readonly/delete-promote/assign,
 *   library.list filters (folderId incl. descendants, tags AND, favorite,
 *   collectionId equivalence), discover feed folders, operations undo;
 * - single FAVORITES: library.setFavorite, library.get.favorite,
 *   library.list favorite, discover.feed stats.favorite + favorite section, undo;
 * - SEARCH FILTERS: search.query filters (folderId/tags/favorite) and combos,
 *   every returned item satisfies the filter, channels never fabricated;
 * - REAL VECTOR SEARCH: embedding.status (384d multilingual model),
 *   embedding.index (force + idempotency + counts + indexVersion), vector
 *   channel in search.query with reasons, 4 real Chinese semantic queries
 *   recorded with Top5 and a pure-FTS comparison when the API allows disabling
 *   the vector channel, diagnostics.embedding;
 * - regression evidence: recorded v0.4 34/34, v0.3 (historical 38/38 plus the
 *   current v0.4 re-run explanation), v0.2 26/26 and lifecycle 12/0/1.
 *
 * Design rules:
 * - never pretend FTS results are vector results: the vector channel status,
 *   model, latency and k are asserted and recorded; if the worker is unavailable
 *   the suite records unavailable+reason instead of inventing similarity;
 * - test folders/favorites/tags are created through the public API and removed
 *   in `finally`; user papers/annotations are never deleted;
 * - expectations are never edited to make a failing implementation pass.
 *
 * Usage:
 *   node test/v05.mjs --dry-run   # print the case plan + read-only environment probe
 *   node test/v05.mjs             # real run (requires the v0.5 host loaded)
 *   node test/v05.mjs --base http://127.0.0.1:3080 --out ../reports/v05-api-results.json
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
const BASE = arg('--base', process.env.PAPPERS_BASE ?? 'http://127.0.0.1:3080')
const API = `${BASE}/pappers-hall/api`
const OUT = resolve(HERE, arg('--out', '../../reports/v05-api-results.json'))
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const EMBED_ROOT = join(HOME, 'pappers-hall', 'embedding')
const EMBED_PYTHON = join(EMBED_ROOT, 'venv', 'bin', 'python')
const EMBED_MODELS = join(HOME, 'pappers-hall', 'models')
const WORKER = join(WORKSPACE, 'pappers-hall-plugin', 'host', 'embedding_worker.py')
const EMBED_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
const EMBED_DIMS = 384
const EMBED_INDEX_VERSION = `v1:${EMBED_MODEL}:${EMBED_DIMS}`
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

/** Papers used by the folder/favorite/filter cases (all user papers, never deleted). */
const P_GRAND = arg('--paper-grandchild', 'ph-8d90723ee7bc') // C01 irrigation
const P_CHILD = arg('--paper-child', 'ph-2fe2db39be9b') // C05 crop yields
const P_ROOT = arg('--paper-root', 'ph-53132d8d95a6') // A01 ReAct
const P_EXTRA = arg('--paper-extra', 'ph-ab4eb56f3937') // V01 CLIP
const P_UNDO = arg('--paper-undo', 'ph-90eb4c4b4449') // E05 canopy height (outside the test folder subtree)

/** Contract §2.3 semantic queries; `fields` is a rule-based relevance expectation. */
const SEMANTIC_QUERIES = [
  { id: 'q1', q: '如何用强化学习做农业决策', fields: ['作物模拟与农业系统', '强化学习与决策'] },
  { id: 'q2', q: 'agent 推理与行动结合', fields: ['大语言模型与 Agent'] },
  { id: 'q3', q: '遥感影像预训练模型', fields: ['遥感与地球观测', '多模态与文档检索'] },
  { id: 'q4', q: '气候变暖对作物产量的影响', fields: ['作物模拟与农业系统'] },
]

const PLAN = [
  ['ENV.version', 'ENV', 'v0.5 Host loaded: plugin 0.5.x / schemaVersion>=5 or library.folders.tree+embedding.status callable'],
  ['ENV.baseline', 'ENV', 'live library intact before mutation: papers>=30, annotations>=1, trash=0; favorite/tag/folder baseline captured'],
  ['ENV.embeddingEnv', 'ENV', 'local embedding environment present: venv python executable, model cache non-empty, embedding_worker.py exists'],
  ['FOLDERS.create.nested', 'FOLDERS', 'root + child + grandchild folders are created through library.collections.create(parentId) and read back nested'],
  ['FOLDERS.tree.structure', 'FOLDERS', 'library.folders.tree returns items with id/name/kind(folder|field)/count/children and 5 read-only field items'],
  ['FOLDERS.tree.counts', 'FOLDERS', 'folder counts include descendants: root=3 (A01 direct + C05 child + C01 grandchild), child=2, grandchild=1'],
  ['FOLDERS.list.folderId', 'FOLDERS', 'library.list folderId=root returns the 3 subtree papers; folderId=child returns 2; grandchild returns 1'],
  ['FOLDERS.list.collectionId', 'FOLDERS', 'library.list collectionId=root is equivalent to folderId=root (descendants included)'],
  ['FOLDERS.list.tagsAND', 'FOLDERS', 'library.list tags:[A,B] matches papers carrying ALL tags; adding a missing tag yields 0; folderId+tags combine'],
  ['FOLDERS.update.renameColor', 'FOLDERS', 'library.collections.update renames and recolours a folder; tree reads the new name/colour'],
  ['FOLDERS.update.move', 'FOLDERS', 'moving the grandchild to root and back changes nesting + descendant counts, then restores'],
  ['FOLDERS.move.cycleRejected', 'FOLDERS', 'moving a folder into its own descendant is rejected with an explicit error and the tree is unchanged'],
  ['FOLDERS.field.readonly', 'FOLDERS', 'field collections (kind=field) cannot be renamed or deleted; they stay in the tree'],
  ['FOLDERS.delete.promote', 'FOLDERS', 'deleting a folder promotes its child folder to the parent; papers are not deleted and counts stay consistent'],
  ['FOLDERS.assign.manyToMany', 'FOLDERS', 'a paper can live in several folders; removing one membership keeps the others; filters reflect it'],
  ['FOLDERS.undo', 'FOLDERS', 'folder create/update/assign operations are journaled and undo restores the tree/memberships'],
  ['FOLDERS.discover', 'FOLDERS', 'discover.feed exposes the folder tree or folder counts consistent with library.folders.tree'],
  ['FAVORITES.set', 'FAVORITES', 'library.setFavorite true marks papers favorite; library.get.favorite=true on every marked paper'],
  ['FAVORITES.list', 'FAVORITES', 'library.list favorite=true returns exactly the favorite set; sort=favorite accepted'],
  ['FAVORITES.discover', 'FAVORITES', 'discover.feed stats.favorite matches and the favorite section contains favorite tiles'],
  ['FAVORITES.undo', 'FAVORITES', 'setFavorite is journaled; undo restores the previous favorite value'],
  ['SEARCH.filters.folder', 'SEARCH', 'search.query filters.folderId restricts every returned item to the folder subtree (all channels respect filters)'],
  ['SEARCH.filters.tags', 'SEARCH', 'search.query filters.tags and filters.favorite restrict results to matching papers'],
  ['SEARCH.filters.comboChannels', 'SEARCH', 'filters combine (folder+tags+favorite, top-level compat) and channels are honest (vector ok with latency/k or unavailable+reason)'],
  ['EMBEDDING.status', 'EMBEDDING', 'embedding.status: available=true, configured, model=paraphrase-multilingual-MiniLM-L12-v2, dims=384, indexVersion, building, counts, lastError'],
  ['EMBEDDING.index.ready', 'EMBEDDING', 'index is ready (building=false, indexVersion=v1:<model>:384) after waiting for the mount/background job'],
  ['EMBEDDING.index.counts', 'EMBEDDING', 'embedding counts papers>=30, pages>=100, figures>=300, annotations>=20'],
  ['EMBEDDING.index.idempotent', 'EMBEDDING', 'embedding.index {force:true} rebuilds idempotently: counts/indexVersion unchanged, no duplicate rows/errors'],
  ['EMBEDDING.vector.channel', 'EMBEDDING', 'search.query vector channel status=ok with model/latencyMs/k>0 and at least one item reason=vector_similarity'],
  ['EMBEDDING.semantic.q1', 'EMBEDDING', 'semantic query 1 top5 recorded with vector contribution + rule-based field relevance'],
  ['EMBEDDING.semantic.q2', 'EMBEDDING', 'semantic query 2 top5 recorded with vector contribution + rule-based field relevance'],
  ['EMBEDDING.semantic.q3', 'EMBEDDING', 'semantic query 3 top5 recorded with vector contribution + rule-based field relevance'],
  ['EMBEDDING.semantic.q4', 'EMBEDDING', 'semantic query 4 top5 recorded with vector contribution + rule-based field relevance'],
  ['EMBEDDING.semantic.compare', 'EMBEDDING', 'Top5 of the 4 semantic queries compared against a pure-FTS baseline when the API supports disabling the vector channel'],
  ['EMBEDDING.diagnostics', 'EMBEDDING', 'diagnostics exposes embedding status and capabilities.vector=ready'],
  ['EMBEDDING.scope.vector', 'EMBEDDING', 'vector channel works for scope=pages and scope=annotations without faking results'],
  ['EMBEDDING.degrade', 'EMBEDDING', 'when the embedding worker is unavailable the vector channel reports unavailable+reason; not fabricating similarity'],
  ['REF.v04', 'REF', 'recorded v0.4 API result file still reports 34/34 pass'],
  ['REF.v03', 'REF', 'recorded v0.3 result: historical 38/38 (verified in v0.3) and the current v0.4 re-run only fails the 3 AI-fast cases explained by v0.4 translate.text routing'],
  ['REF.v02', 'REF', 'recorded v0.2 API result file still reports 26/26 pass'],
  ['REF.lifecycle', 'REF', 'recorded lifecycle result file still reports 13 cases: 12 pass, 0 fail, 1 not_run'],
  ['CLEANUP.folders', 'CLEANUP', 'all test folders are deleted and no test tags/favorites remain on user papers'],
  ['REF.data.preserved', 'REF', 'after cleanup: papers/annotations/figures/trash back to baseline, favorites/tags restored, no test folders left'],
]

const results = []
const state = {
  startedAt: new Date().toISOString(),
  base: BASE,
  environment: null,
  baseline: {},
  folders: {},
  createdFolderIds: [],
  assigned: {},
  tags: [],
  favorites: { baseline: new Set(), expected: new Set() },
  journal: {},
  embedding: { status: null, countsBefore: null, countsAfter: null, vectorChannel: null, semantic: {}, ftsBaseline: null },
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

const isoNow = () => new Date().toISOString()
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const uniqueName = (label) => `v05-${label}-${RUN_STAMP}`

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
    return { path: relativePath, exists: true, parsed: JSON.parse(readFileSync(full, 'utf8')), bytes: statSync(full).size }
  } catch (error) {
    return { path: relativePath, exists: true, error: String(error?.message ?? error) }
  }
}

function dirNonEmpty(path) {
  try {
    if (!existsSync(path)) return { exists: false, entries: 0 }
    const stat = statSync(path)
    if (stat.isFile()) return { exists: true, entries: 1, bytes: stat.size }
    // recursion depth 2 is enough to prove the model cache is populated
    let entries = 0
    const visit = (target, depth) => {
      const own = readdirSafe(target)
      entries += own.length
      if (depth <= 0) return
      for (const entry of own) {
        const child = join(target, entry)
        if (safeIsDirectory(child)) visit(child, depth - 1)
      }
    }
    visit(path, 2)
    return { exists: true, entries, isDirectory: true }
  } catch (error) {
    return { exists: false, error: String(error?.message ?? error) }
  }
}

function readdirSafe(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function safeIsDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Folder tree helpers
 * ------------------------------------------------------------------ */
function collectFolders(data) {
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
  return collectFolders(data).find((entry) => entry.item.id === id) ?? null
}

function folderIdsInTree(data) {
  return new Set(collectFolders(data).map((entry) => entry.item?.id).filter((id) => typeof id === 'string'))
}

function createdId(data) {
  return data?.collection?.id ?? data?.folder?.id ?? data?.id ?? null
}

/* ------------------------------------------------------------------ *
 * Operations journal helpers (folders / favorites)
 * ------------------------------------------------------------------ */
const MATCHERS = {
  folderCreate: (kind) => /(collect|folder)/.test(kind) && /creat/.test(kind),
  folderUpdate: (kind) => /(collect|folder)/.test(kind) && /updat|mov|renam|color/.test(kind),
  folderDelete: (kind) => /(collect|folder)/.test(kind) && /delet/.test(kind),
  folderAssign: (kind) => /(collect|folder|assign)/.test(kind) && /assign|add|remov/.test(kind),
  favorite: (kind) => /favorit/.test(kind),
}

function operationTime(item) {
  const parsed = Date.parse(String(item?.createdAt ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

const isUndone = (item) => item?.undone === true || item?.undone === 1

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

async function journalEntry(operationId) {
  const data = await call('operations.recent', { limit: 80 })
  return (data?.items ?? []).find((item) => String(item.id) === String(operationId)) ?? null
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
    embedding: diagnostics?.embedding ?? null,
    capabilities: diagnostics?.capabilities ?? null,
  }
}

async function probeV05Shape() {
  const probe = { folders: 'missing', embedding: 'missing' }
  try {
    const data = await call('library.folders.tree', {}, 15_000)
    probe.folders = Array.isArray(data?.items) ? 'ok' : 'bad-shape'
  } catch (error) {
    probe.folders = `error:${error?.code ?? 'unknown'}`
  }
  try {
    const data = await call('embedding.status', {}, 15_000)
    probe.embedding = data !== null && typeof data === 'object' ? 'ok' : 'bad-shape'
  } catch (error) {
    probe.embedding = `error:${error?.code ?? 'unknown'}`
  }
  return probe
}

async function favoriteIds() {
  const list = await call('library.list', { favorite: true, limit: 200 })
  return (list.items ?? []).map((paper) => paper.id)
}

async function readSettingsTree() {
  return call('library.folders.tree', {}, 20_000)
}

/* ------------------------------------------------------------------ *
 * Case group: folders
 * ------------------------------------------------------------------ */
async function folderSetup() {
  const rootCreate = await call('library.collections.create', { name: uniqueName('root'), color: '#3366cc', operationId: `v05-root-${RUN_STAMP}` })
  const rootId = createdId(rootCreate)
  const childCreate = await call('library.collections.create', { name: uniqueName('child'), parentId: rootId, operationId: `v05-child-${RUN_STAMP}` })
  const childId = createdId(childCreate)
  const grandChildCreate = await call('library.collections.create', { name: uniqueName('grandchild'), parentId: childId, operationId: `v05-grandchild-${RUN_STAMP}` })
  const grandChildId = createdId(grandChildCreate)
  if ([rootId, childId, grandChildId].some((id) => typeof id !== 'string')) {
    throw new Error(`folder creation failed: ${JSON.stringify({ rootCreate, childCreate, grandChildCreate }).slice(0, 400)}`)
  }
  state.folders = { rootId, childId, grandChildId, rootCreate, childCreate, grandChildCreate }
  state.createdFolderIds.push(rootId, childId, grandChildId)
  await call('library.collections.assign', { collectionId: grandChildId, paperIds: [P_GRAND], add: true, operationId: `v05-assign-grand-${RUN_STAMP}` })
  await call('library.collections.assign', { collectionId: childId, paperIds: [P_CHILD], add: true, operationId: `v05-assign-child-${RUN_STAMP}` })
  await call('library.collections.assign', { collectionId: rootId, paperIds: [P_ROOT], add: true, operationId: `v05-assign-root-${RUN_STAMP}` })
}

async function folderCases() {
  const { rootId, childId, grandChildId } = state.folders
  let initialTree = null

  await check('FOLDERS.create.nested', EXPECTED.get('FOLDERS.create.nested').expected, async () => {
    initialTree = await readSettingsTree()
    const root = findFolder(initialTree, rootId)
    const child = findFolder(initialTree, childId)
    const grand = findFolder(initialTree, grandChildId)
    const nested = root !== null && child !== null && grand !== null && root.depth === 0 && child.depth === 1 && grand.depth === 2
    return {
      actual: {
        root: { id: rootId, depth: root?.depth ?? null, name: root?.item?.name ?? null },
        child: { id: childId, depth: child?.depth ?? null, name: child?.item?.name ?? null },
        grandchild: { id: grandChildId, depth: grand?.depth ?? null, name: grand?.item?.name ?? null },
      },
      pass: nested,
    }
  })

  await check('FOLDERS.tree.structure', EXPECTED.get('FOLDERS.tree.structure').expected, async () => {
    const tree = initialTree ?? (await readSettingsTree())
    const flat = collectFolders(tree)
    const problems = flat
      .map(({ item }) => {
        const issues = []
        if (typeof item?.id !== 'string' || item.id === '') issues.push('id')
        if (typeof item?.name !== 'string' || item.name === '') issues.push('name')
        if (!['folder', 'field'].includes(item?.kind)) issues.push('kind')
        if (typeof item?.count !== 'number') issues.push('count')
        if (!Array.isArray(item?.children)) issues.push('children')
        return issues.length === 0 ? null : { id: item?.id, issues }
      })
      .filter(Boolean)
    const fields = flat.filter(({ item }) => item.kind === 'field')
    const folders = flat.filter(({ item }) => item.kind === 'folder')
    const testFolders = flat.filter(({ item }) => [rootId, childId, grandChildId].includes(item.id))
    const pass = Array.isArray(tree?.items) && typeof tree?.total === 'number' && problems.length === 0 && fields.length === 5 && testFolders.length === 3
    return {
      actual: {
        total: tree?.total ?? null,
        itemsAtRoot: Array.isArray(tree?.items) ? tree.items.length : null,
        flatItems: flat.length,
        fieldItems: fields.map(({ item }) => item.name),
        folderItems: folders.map(({ item }) => item.name),
        testFolders: testFolders.map(({ item }) => ({ id: item.id, kind: item.kind, count: item.count })),
        problems,
      },
      pass,
    }
  })

  await check('FOLDERS.tree.counts', EXPECTED.get('FOLDERS.tree.counts').expected, async () => {
    const tree = initialTree ?? (await readSettingsTree())
    const counts = {
      root: findFolder(tree, rootId)?.item?.count ?? null,
      child: findFolder(tree, childId)?.item?.count ?? null,
      grandchild: findFolder(tree, grandChildId)?.item?.count ?? null,
    }
    const pass = counts.root === 3 && counts.child === 2 && counts.grandchild === 1
    return { actual: counts, pass, notes: 'count = direct + descendant papers (A01 direct in root, C05 in child, C01 in grandchild)' }
  })

  await check('FOLDERS.list.folderId', EXPECTED.get('FOLDERS.list.folderId').expected, async () => {
    const expected = {
      root: [P_GRAND, P_CHILD, P_ROOT].sort().join(','),
      child: [P_GRAND, P_CHILD].sort().join(','),
      grandchild: [P_GRAND].join(','),
    }
    const observed = {}
    for (const [name, folderId] of [['root', rootId], ['child', childId], ['grandchild', grandChildId]]) {
      const list = await call('library.list', { folderId, limit: 200 })
      observed[name] = { total: list.total, ids: (list.items ?? []).map((paper) => paper.id).sort() }
    }
    const pass = Object.entries(expected).every(([name, ids]) => observed[name].ids.join(',') === ids)
    return { actual: observed, pass }
  })

  await check('FOLDERS.list.collectionId', EXPECTED.get('FOLDERS.list.collectionId').expected, async () => {
    const byFolder = await call('library.list', { folderId: rootId, limit: 200 })
    const byCollection = await call('library.list', { collectionId: rootId, limit: 200 })
    const folderIds = (byFolder.items ?? []).map((paper) => paper.id).sort()
    const collectionIds = (byCollection.items ?? []).map((paper) => paper.id).sort()
    const pass = folderIds.join(',') === collectionIds.join(',') && folderIds.length === 3
    return { actual: { folder: { total: byFolder.total, ids: folderIds }, collection: { total: byCollection.total, ids: collectionIds } }, pass }
  })

  await check('FOLDERS.list.tagsAND', EXPECTED.get('FOLDERS.list.tagsAND').expected, async () => {
    const tagA = uniqueName('tagA')
    const tagB = uniqueName('tagB')
    state.tags.push(tagA, tagB)
    await call('library.update', { id: P_GRAND, patch: { addTags: [tagA, tagB] }, operationId: `v05-tags-${RUN_STAMP}` })
    const both = await call('library.list', { tags: [tagA, tagB], limit: 200 })
    const single = await call('library.list', { tags: [tagA], limit: 200 })
    const missing = await call('library.list', { tags: [tagA, uniqueName('missing')], limit: 200 })
    const combined = await call('library.list', { tags: [tagA, tagB], folderId: rootId, limit: 200 })
    const bothIds = (both.items ?? []).map((paper) => paper.id)
    const singleIds = (single.items ?? []).map((paper) => paper.id)
    const combinedIds = (combined.items ?? []).map((paper) => paper.id)
    const pass = bothIds.includes(P_GRAND) && singleIds.includes(P_GRAND) && Number(missing.total) === 0 && combinedIds.join(',') === [P_GRAND].join(',')
    return {
      actual: {
        tags: { tagA, tagB },
        both: { total: both.total, ids: bothIds },
        single: { total: single.total, ids: singleIds },
        missing: { total: missing.total },
        combinedWithFolder: { total: combined.total, ids: combinedIds },
      },
      pass,
    }
  })

  await check('FOLDERS.update.renameColor', EXPECTED.get('FOLDERS.update.renameColor').expected, async () => {
    const newName = uniqueName('child-renamed')
    await call('library.collections.update', { id: childId, name: newName, color: '#123456', operationId: `v05-rename-${RUN_STAMP}` })
    const tree = await readSettingsTree()
    const child = findFolder(tree, childId)
    const pass = child?.item?.name === newName && String(child?.item?.color ?? '').toLowerCase() === '#123456'
    state.folders.childName = newName
    return { actual: { name: child?.item?.name ?? null, color: child?.item?.color ?? null }, pass }
  })

  await check('FOLDERS.update.move', EXPECTED.get('FOLDERS.update.move').expected, async () => {
    await call('library.collections.update', { id: grandChildId, parentId: rootId, operationId: `v05-move-up-${RUN_STAMP}` })
    const moved = await readSettingsTree()
    const movedState = {
      rootChildren: (findFolder(moved, rootId)?.item?.children ?? []).map((child) => child.id),
      childChildren: (findFolder(moved, childId)?.item?.children ?? []).map((child) => child.id),
      counts: {
        root: findFolder(moved, rootId)?.item?.count ?? null,
        child: findFolder(moved, childId)?.item?.count ?? null,
      },
    }
    await call('library.collections.update', { id: grandChildId, parentId: childId, operationId: `v05-move-back-${RUN_STAMP}` })
    const restored = await readSettingsTree()
    const restoredState = {
      rootChildren: (findFolder(restored, rootId)?.item?.children ?? []).map((child) => child.id),
      childChildren: (findFolder(restored, childId)?.item?.children ?? []).map((child) => child.id),
      counts: {
        root: findFolder(restored, rootId)?.item?.count ?? null,
        child: findFolder(restored, childId)?.item?.count ?? null,
        grandchild: findFolder(restored, grandChildId)?.item?.count ?? null,
      },
    }
    const pass =
      movedState.rootChildren.includes(grandChildId) &&
      !movedState.childChildren.includes(grandChildId) &&
      movedState.counts.child === 1 &&
      restoredState.rootChildren.includes(childId) &&
      restoredState.childChildren.includes(grandChildId) &&
      restoredState.counts.root === 3 &&
      restoredState.counts.child === 2
    return { actual: { movedState, restoredState }, pass }
  })

  await check('FOLDERS.move.cycleRejected', EXPECTED.get('FOLDERS.move.cycleRejected').expected, async () => {
    let error = null
    try {
      await call('library.collections.update', { id: childId, parentId: grandChildId, operationId: `v05-cycle-${RUN_STAMP}` })
    } catch (caught) {
      error = { code: caught?.code ?? null, message: String(caught?.message ?? caught) }
    }
    const tree = await readSettingsTree()
    const childDepth = findFolder(tree, childId)?.depth ?? null
    const grandDepth = findFolder(tree, grandChildId)?.depth ?? null
    const pass = error !== null && childDepth === 1 && grandDepth === 2
    return { actual: { error, childDepth, grandDepth }, pass }
  })

  await check('FOLDERS.field.readonly', EXPECTED.get('FOLDERS.field.readonly').expected, async () => {
    const tree = await readSettingsTree()
    const field = collectFolders(tree).find(({ item }) => item.kind === 'field')?.item ?? null
    if (field === null) return { actual: { field: null }, pass: false, notes: 'no field collection in the tree' }
    const updateError = await call('library.collections.update', { id: field.id, name: uniqueName('field-rename'), operationId: `v05-field-${RUN_STAMP}` }).then(
      () => null,
      (error) => ({ code: error?.code ?? null, message: String(error?.message ?? error) }),
    )
    const deleteError = await call('library.collections.delete', { id: field.id, operationId: `v05-field-del-${RUN_STAMP}` }).then(
      () => null,
      (error) => ({ code: error?.code ?? null, message: String(error?.message ?? error) }),
    )
    const after = await readSettingsTree()
    const stillThere = findFolder(after, field.id)
    const fieldCount = collectFolders(after).filter(({ item }) => item.kind === 'field').length
    const pass = updateError !== null && deleteError !== null && stillThere !== null && stillThere.item.name === field.name && fieldCount === 5
    return { actual: { field: { id: field.id, name: field.name }, updateError, deleteError, stillThere: stillThere?.item?.name ?? null, fieldCount }, pass }
  })

  await check('FOLDERS.delete.promote', EXPECTED.get('FOLDERS.delete.promote').expected, async () => {
    const tempACreate = await call('library.collections.create', { name: uniqueName('tempA'), parentId: childId, operationId: `v05-tempA-${RUN_STAMP}` })
    const tempA = createdId(tempACreate)
    const tempBCreate = await call('library.collections.create', { name: uniqueName('tempB'), parentId: tempA, operationId: `v05-tempB-${RUN_STAMP}` })
    const tempB = createdId(tempBCreate)
    state.createdFolderIds.push(tempA, tempB)
    await call('library.collections.assign', { collectionId: tempB, paperIds: [P_EXTRA], add: true, operationId: `v05-tempB-assign-${RUN_STAMP}` })
    await call('library.collections.delete', { id: tempA, operationId: `v05-tempA-del-${RUN_STAMP}` })
    const tree = await readSettingsTree()
    const tempBNode = findFolder(tree, tempB)
    const childNode = findFolder(tree, childId)
    const childList = await call('library.list', { folderId: childId, limit: 200 })
    const paperStillActive = await call('library.get', { id: P_EXTRA })
    const pass =
      findFolder(tree, tempA) === null &&
      tempBNode !== null &&
      tempBNode.depth === 2 &&
      (childNode?.item?.children ?? []).some((child) => child.id === tempB) &&
      (childList.items ?? []).some((paper) => paper.id === P_EXTRA) &&
      paperStillActive?.state === 'active'
    return {
      actual: {
        tempA: { id: tempA, deleted: findFolder(tree, tempA) === null },
        tempB: { id: tempB, depth: tempBNode?.depth ?? null, parentIsChild: (childNode?.item?.children ?? []).some((child) => child.id === tempB) },
        childListTotal: childList.total,
        extraPaperActive: paperStillActive?.state ?? null,
      },
      pass,
    }
  })

  await check('FOLDERS.assign.manyToMany', EXPECTED.get('FOLDERS.assign.manyToMany').expected, async () => {
    const before = await readSettingsTree()
    const rootCountBefore = findFolder(before, rootId)?.item?.count ?? null
    const grandListBefore = await call('library.list', { folderId: grandChildId, limit: 200 })
    await call('library.collections.assign', { collectionId: rootId, paperIds: [P_GRAND], add: true, operationId: `v05-m2m-add-${RUN_STAMP}` })
    const afterAdd = await readSettingsTree()
    const rootCountAfterAdd = findFolder(afterAdd, rootId)?.item?.count ?? null
    const paperListedInRoot = (await call('library.list', { folderId: rootId, limit: 200 })).items ?? []
    await call('library.collections.assign', { collectionId: rootId, paperIds: [P_GRAND], add: false, operationId: `v05-m2m-remove-${RUN_STAMP}` })
    const grandList = await call('library.list', { folderId: grandChildId, limit: 200 })
    const treeAfterRemove = await readSettingsTree()
    const pass =
      rootCountAfterAdd === rootCountBefore &&
      (paperListedInRoot ?? []).some((paper) => paper.id === P_GRAND) &&
      (grandList.items ?? []).some((paper) => paper.id === P_GRAND) &&
      (findFolder(treeAfterRemove, rootId)?.item?.count ?? null) === rootCountBefore
    return {
      actual: {
        rootCountBefore,
        rootCountAfterAdd,
        rootTotalAfterAddingSamePaperToRoot: paperListedInRoot.length,
        grandchildStillContainsPaper: (grandList.items ?? []).some((paper) => paper.id === P_GRAND),
        treeAfterRemove: {
          rootCount: findFolder(treeAfterRemove, rootId)?.item?.count ?? null,
          childCount: findFolder(treeAfterRemove, childId)?.item?.count ?? null,
        },
        rootChildrenAfterAdd: (findFolder(afterAdd, rootId)?.item?.children ?? []).map((child) => child.id),
      },
      pass,
      notes: 'a paper may live in several folders; removing the extra membership keeps the original one (descendant counts count unique papers)',
    }
  })

  await check('FOLDERS.undo', EXPECTED.get('FOLDERS.undo').expected, async () => {
    const observed = {}
    // a) create -> undo -> gone
    const sinceCreate = isoNow()
    const createOpId = `v05-undo-create-${RUN_STAMP}`
    const created = await call('library.collections.create', { name: uniqueName('undo-create'), parentId: rootId, operationId: createOpId })
    const createdFolderId = createdId(created)
    state.createdFolderIds.push(createdFolderId)
    const createJournal = await findOperation(MATCHERS.folderCreate, { since: sinceCreate, operationId: createOpId })
    let createUndo = null
    let createGone = false
    if (createJournal.item !== undefined) {
      createUndo = await call('operations.undo', { operationId: createJournal.item.id })
      createGone = findFolder(await readSettingsTree(), createdFolderId) === null
    }
    observed.create = { folderId: createdFolderId, journalKind: createJournal.item?.kind ?? null, undo: clipValue(createUndo), gone: createGone }
    // b) update -> undo -> name restored
    const beforeName = state.folders.childName ?? findFolder(await readSettingsTree(), childId)?.item?.name ?? null
    const sinceUpdate = isoNow()
    const updateOpId = `v05-undo-update-${RUN_STAMP}`
    await call('library.collections.update', { id: childId, name: uniqueName('child-undo'), operationId: updateOpId })
    const updateJournal = await findOperation(MATCHERS.folderUpdate, { since: sinceUpdate, operationId: updateOpId })
    let updateUndo = null
    let nameRestored = false
    if (updateJournal.item !== undefined) {
      updateUndo = await call('operations.undo', { operationId: updateJournal.item.id })
      nameRestored = findFolder(await readSettingsTree(), childId)?.item?.name === beforeName
    }
    observed.update = { journalKind: updateJournal.item?.kind ?? null, undo: clipValue(updateUndo), nameRestored }
    // c) assign -> undo -> membership removed
    const sinceAssign = isoNow()
    const assignOpId = `v05-undo-assign-${RUN_STAMP}`
    await call('library.collections.assign', { collectionId: rootId, paperIds: [P_UNDO], add: true, operationId: assignOpId })
    const assignedList = await call('library.list', { folderId: rootId, limit: 200 })
    const assignJournal = await findOperation(MATCHERS.folderAssign, { since: sinceAssign, operationId: assignOpId })
    let assignUndo = null
    let membershipRemoved = false
    if (assignJournal.item !== undefined) {
      assignUndo = await call('operations.undo', { operationId: assignJournal.item.id })
      const afterList = await call('library.list', { folderId: rootId, limit: 200 })
      membershipRemoved = !(afterList.items ?? []).some((paper) => paper.id === P_UNDO)
    }
    observed.assign = {
      journalKind: assignJournal.item?.kind ?? null,
      wasAssigned: (assignedList.items ?? []).some((paper) => paper.id === P_UNDO),
      undo: clipValue(assignUndo),
      membershipRemoved,
    }
    if (!membershipRemoved) {
      await call('library.collections.assign', { collectionId: rootId, paperIds: [P_UNDO], add: false, operationId: `v05-undo-assign-safety-${RUN_STAMP}` }).catch(() => {})
    }
    const pass =
      createJournal.item !== undefined && createGone &&
      updateJournal.item !== undefined && nameRestored &&
      assignJournal.item !== undefined && observed.assign.wasAssigned && membershipRemoved
    return { actual: observed, pass }
  })

  await check('FOLDERS.discover', EXPECTED.get('FOLDERS.discover').expected, async () => {
    const feed = await call('discover.feed', { limit: 5 }, 30_000)
    const tree = await readSettingsTree()
    const rootCount = findFolder(tree, rootId)?.item?.count ?? null
    let source = null
    let foundCount = null
    const feedFolderItems = Array.isArray(feed?.folders) ? feed.folders : Array.isArray(feed?.folders?.items) ? feed.folders.items : null
    if (feedFolderItems !== null) {
      const flat = collectFolders({ items: feedFolderItems })
      const found = flat.find(({ item }) => item.id === rootId)?.item ?? null
      if (found !== null) {
        source = 'folders-tree'
        foundCount = found.count
      }
    }
    if (source === null && feed?.folderCounts !== undefined) {
      const counts = feed.folderCounts
      if (Array.isArray(counts)) {
        const found = counts.find((entry) => entry?.id === rootId || entry?.folderId === rootId)
        if (found !== undefined) {
          source = 'folderCounts-array'
          foundCount = found.count
        }
      } else if (counts !== null && typeof counts === 'object' && counts[rootId] !== undefined) {
        source = 'folderCounts-map'
        foundCount = counts[rootId]
      }
    }
    const pass = source !== null && Number(foundCount) === Number(rootCount)
    return { actual: { source, rootCount, foundCount: foundCount ?? null, feedKeys: feed !== null && typeof feed === 'object' ? Object.keys(feed) : null }, pass }
  })
}

/* ------------------------------------------------------------------ *
 * Case group: favorites
 * ------------------------------------------------------------------ */
async function favoriteCases() {
  const { rootId } = state.folders

  await check('FAVORITES.set', EXPECTED.get('FAVORITES.set').expected, async () => {
    if (state.favorites.baseline.size === 0 && (state.baseline.favoriteIds ?? []).length > 0) {
      state.favorites.baseline = new Set(state.baseline.favoriteIds)
    }
    state.favorites.expected = new Set([...state.favorites.baseline, P_GRAND, P_ROOT])
    const set = await call('library.setFavorite', { ids: [P_GRAND, P_ROOT], favorite: true, operationId: `v05-fav-set-${RUN_STAMP}` })
    const grand = await call('library.get', { id: P_GRAND })
    const root = await call('library.get', { id: P_ROOT })
    const list = await call('library.list', { favorite: true, limit: 200 })
    const ids = new Set((list.items ?? []).map((paper) => paper.id))
    const expected = [...state.favorites.expected].sort()
    state.favorites.expectedIds = expected
    const pass =
      grand?.favorite === true &&
      root?.favorite === true &&
      expected.every((id) => ids.has(id)) &&
      Number(list.total) === expected.length
    return {
      actual: {
        response: clipValue(set),
        favoriteFields: { grand: grand?.favorite ?? null, root: root?.favorite ?? null },
        list: { total: list.total, ids: [...ids].sort() },
        expected,
      },
      pass,
    }
  })

  await check('FAVORITES.list', EXPECTED.get('FAVORITES.list').expected, async () => {
    const list = await call('library.list', { favorite: true, limit: 200 })
    const items = list.items ?? []
    const allFavorite = items.every((paper) => paper.favorite === true)
    const sortedAttempt = await call('library.list', { favorite: true, sort: 'favorite', limit: 200 })
    const pass = allFavorite && Number(list.total) === (state.favorites.expectedIds ?? []).length && Array.isArray(sortedAttempt.items)
    return { actual: { total: list.total, items: items.map((paper) => ({ id: paper.id, favorite: paper.favorite ?? null })), sortFavoriteAccepted: Array.isArray(sortedAttempt.items) }, pass }
  })

  await check('FAVORITES.discover', EXPECTED.get('FAVORITES.discover').expected, async () => {
    const feed = await call('discover.feed', { limit: 5 }, 30_000)
    const section = Array.isArray(feed?.favorite) ? feed.favorite : []
    const expectedCount = (state.favorites.expectedIds ?? []).length
    const statsFavorite = feed?.stats?.favorite ?? null
    const allTilesFavorite = section.every((tile) => tile?.favorite !== false)
    const containsBoth = [P_GRAND, P_ROOT].every((id) => section.some((tile) => tile.id === id))
    const pass =
      Number(statsFavorite) === expectedCount &&
      section.length <= 5 &&
      allTilesFavorite &&
      (section.length >= expectedCount ? containsBoth : true)
    return {
      actual: {
        statsFavorite,
        expectedCount,
        sectionLength: section.length,
        sectionIds: section.map((tile) => tile.id),
        containsBoth,
        tileSample: section.slice(0, 2).map((tile) => ({ id: tile.id, title: String(tile.title ?? '').slice(0, 40), favorite: tile.favorite ?? null })),
      },
      pass,
    }
  })

  await check('FAVORITES.undo', EXPECTED.get('FAVORITES.undo').expected, async () => {
    const since = isoNow()
    const opId = `v05-fav-undo-${RUN_STAMP}`
    await call('library.setFavorite', { ids: [P_ROOT], favorite: false, operationId: opId })
    const unset = await call('library.get', { id: P_ROOT })
    const journal = await findOperation(MATCHERS.favorite, { since, operationId: opId })
    let undo = null
    let restored = null
    if (journal.item !== undefined) {
      undo = await call('operations.undo', { operationId: journal.item.id })
      restored = await call('library.get', { id: P_ROOT })
    }
    const pass = unset?.favorite === false && journal.item !== undefined && restored?.favorite === true
    return {
      actual: {
        favoriteAfterUnset: unset?.favorite ?? null,
        journalKind: journal.item?.kind ?? null,
        undo: clipValue(undo),
        favoriteAfterUndo: restored?.favorite ?? null,
        rootFolderId: rootId,
      },
      pass,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Case group: search filters
 * ------------------------------------------------------------------ */
function itemPaperId(item) {
  return item?.paperId ?? item?.paper?.id ?? item?.id ?? null
}

async function searchResultIds(params) {
  const data = await call('search.query', params, 60_000)
  return { data, ids: (data?.items ?? []).map(itemPaperId).filter(Boolean), channels: data?.channels ?? [] }
}

function channelMap(channels) {
  return Object.fromEntries((channels ?? []).map((channel) => [channel?.name, channel]))
}

async function searchFilterCases() {
  const { rootId, childId } = state.folders

  await check('SEARCH.filters.folder', EXPECTED.get('SEARCH.filters.folder').expected, async () => {
    const folderList = await call('library.list', { folderId: childId, limit: 200 })
    const allowed = new Set((folderList.items ?? []).map((paper) => paper.id))
    const filtered = await searchResultIds({ q: 'crop', scope: 'papers', ai: 'off', limit: 20, filters: { folderId: childId } })
    const unfiltered = await searchResultIds({ q: 'crop', scope: 'papers', ai: 'off', limit: 20 })
    const allAllowed = filtered.ids.length > 0 && filtered.ids.every((id) => allowed.has(id))
    const channelsOk = Array.isArray(filtered.channels) && filtered.channels.length > 0 && filtered.channels.every((channel) => typeof channel?.name === 'string' && typeof channel?.status === 'string')
    const pass = allAllowed && channelsOk && unfiltered.ids.length >= filtered.ids.length
    return {
      actual: {
        allowedIds: [...allowed],
        filtered: { count: filtered.ids.length, ids: filtered.ids },
        unfiltered: { count: unfiltered.ids.length, ids: unfiltered.ids.slice(0, 10) },
        channels: filtered.channels,
        allAllowed,
      },
      pass,
    }
  })

  await check('SEARCH.filters.tags', EXPECTED.get('SEARCH.filters.tags').expected, async () => {
    const tagA = state.tags[0]
    const tagB = state.tags[1]
    const tagList = await call('library.list', { tags: [tagA, tagB], limit: 200 })
    const tagAllowed = new Set((tagList.items ?? []).map((paper) => paper.id))
    const byTags = await searchResultIds({ q: 'irrigation', scope: 'papers', ai: 'off', limit: 20, filters: { tags: [tagA, tagB] } })
    const favoriteIdsNow = new Set((await call('library.list', { favorite: true, limit: 200 })).items?.map((paper) => paper.id) ?? [])
    const byFavorite = await searchResultIds({ q: 'reasoning', scope: 'papers', ai: 'off', limit: 20, filters: { favorite: true } })
    const tagsOk = byTags.ids.length > 0 && byTags.ids.every((id) => tagAllowed.has(id))
    const favoriteOk = byFavorite.ids.length > 0 && byFavorite.ids.every((id) => favoriteIdsNow.has(id))
    state.evidence.search = {
      ...(state.evidence.search ?? {}),
      tags: { tagA, tagB, allowed: [...tagAllowed], resultCount: byTags.ids.length, ids: byTags.ids },
      favorite: { allowedCount: favoriteIdsNow.size, resultCount: byFavorite.ids.length, ids: byFavorite.ids },
    }
    return {
      actual: {
        tags: { tagA, tagB, allowed: [...tagAllowed], resultCount: byTags.ids.length, ids: byTags.ids, allMatch: tagsOk },
        favorite: { allowedCount: favoriteIdsNow.size, resultCount: byFavorite.ids.length, ids: byFavorite.ids, allMatch: favoriteOk },
      },
      pass: tagsOk && favoriteOk,
    }
  })

  await check('SEARCH.filters.comboChannels', EXPECTED.get('SEARCH.filters.comboChannels').expected, async () => {
    // evidence only (filled below)
    const tagA = state.tags[0]
    const tagB = state.tags[1]
    const combo = await searchResultIds({
      q: 'irrigation',
      scope: 'papers',
      ai: 'off',
      limit: 20,
      filters: { folderId: rootId, tags: [tagA, tagB], favorite: true },
    })
    const expectedId = P_GRAND
    const comboOk = combo.ids.length === 1 && combo.ids[0] === expectedId
    // top-level compat variant (contract allows filters at the top level too)
    let topLevel = null
    try {
      topLevel = await searchResultIds({ q: 'irrigation', scope: 'papers', ai: 'off', limit: 20, folderId: rootId, tags: [tagA, tagB], favorite: true })
    } catch (error) {
      topLevel = { error: String(error?.message ?? error) }
    }
    const channels = combo.channels ?? []
    const vectorChannel = channels.find((channel) => channel?.name === 'vector') ?? null
    const vectorHonest =
      vectorChannel === null
        ? false
        : vectorChannel.status === 'ok'
          ? typeof vectorChannel.latencyMs === 'number' && Number(vectorChannel.k > 0)
          : ['unavailable', 'degraded', 'off'].includes(String(vectorChannel.status)) && String(vectorChannel.reason ?? vectorChannel.note ?? '').trim() !== ''
    const vectorInItems = (combo.data?.items ?? []).some((item) => (item.reasons ?? []).includes('vector_similarity'))
    const topLevelOk = topLevel !== null && topLevel.error === undefined && Array.isArray(topLevel.ids) && topLevel.ids.length === 1 && topLevel.ids[0] === expectedId
    const pass = comboOk && vectorHonest && Array.isArray(channels) && channels.length > 0
    state.evidence.search = {
      combo: { ids: combo.ids, channels, vectorChannel },
      tags: state.evidence.search?.tags ?? null,
      favorite: state.evidence.search?.favorite ?? null,
    }
    return {
      actual: {
        combo: { ids: combo.ids, channels },
        expectedId,
        vectorChannel,
        vectorInItems,
        topLevelCompat: topLevel?.ids ?? topLevel,
        topLevelOk,
      },
      pass,
      notes: 'filters must apply to every channel; an unavailable vector channel is accepted only with an explicit reason.',
    }
  })
}

/* ------------------------------------------------------------------ *
 * Case group: real vector search / embeddings
 * ------------------------------------------------------------------ */
function vectorChannelOf(channels) {
  return (channels ?? []).find((channel) => channel?.name === 'vector') ?? null
}

async function embeddingStatus() {
  const data = await call('embedding.status', {}, 30_000)
  state.embedding.status = data
  return data
}

function embeddingReady(status) {
  return (
    status !== null &&
    status?.available === true &&
    status?.building === false &&
    status?.indexVersion === EMBED_INDEX_VERSION &&
    Number(status?.counts?.papers ?? 0) >= 30 &&
    Number(status?.counts?.pages ?? 0) >= 100
  )
}

async function waitForEmbeddingReady(timeoutMs = 180_000, label = 'mount') {
  const started = Date.now()
  const polls = []
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await embeddingStatus()
    polls.push({ at: Date.now() - started, available: last?.available ?? null, building: last?.building ?? null, indexVersion: last?.indexVersion ?? null, counts: clipValue(last?.counts ?? null), lastError: last?.lastError ?? null })
    if (embeddingReady(last)) return { ready: true, status: last, elapsedMs: Date.now() - started, polls }
    if (label === 'mount' && Date.now() - started > 25_000 && last?.available === true && last?.building !== true && last?.indexVersion !== EMBED_INDEX_VERSION) {
      // the mount auto-index did not start (e.g. manual reload): enqueue it once
      try {
        const enqueued = await call('embedding.index', {}, 30_000)
        state.evidence.mountIndexEnqueue = clipValue(enqueued)
        label = 'forced-after-mount'
      } catch (error) {
        state.evidence.mountIndexEnqueueError = { code: error?.code ?? null, message: String(error?.message ?? error) }
      }
    }
    await sleep(2000)
  }
  return { ready: false, status: last, elapsedMs: Date.now() - started, polls }
}

async function embeddingCases() {
  const expectedVersion = EMBED_INDEX_VERSION

  let statusOutcome = null
  await check('EMBEDDING.status', EXPECTED.get('EMBEDDING.status').expected, async () => {
    statusOutcome = await measure(() => embeddingStatus())
    const status = statusOutcome.data ?? {}
    const counts = status.counts ?? {}
    const requiredKeys = ['available', 'configured', 'model', 'dims', 'indexVersion', 'building', 'counts', 'lastError']
    const present = requiredKeys.filter((key) => Object.hasOwn(status, key))
    const countsKeys = ['papers', 'pages', 'figures', 'annotations'].filter((key) => Object.hasOwn(counts, key))
    const pass =
      present.length === requiredKeys.length &&
      countsKeys.length === 4 &&
      status.available === true &&
      status.configured === true &&
      status.model === EMBED_MODEL &&
      Number(status.dims) === EMBED_DIMS &&
      typeof status.pythonPath === 'string'
    return {
      actual: {
        status: {
          available: status.available ?? null,
          configured: status.configured ?? null,
          model: status.model ?? null,
          dims: status.dims ?? null,
          indexVersion: status.indexVersion ?? null,
          building: status.building ?? null,
          counts: clipValue(counts),
          lastError: status.lastError ?? null,
          pythonPath: status.pythonPath ?? null,
        },
        present,
        countsKeys,
        expectedVersion,
        ms: statusOutcome.ms,
        error: statusOutcome.error,
      },
      pass,
      notes: status.available === true ? `worker available; model=${status.model}, dims=${status.dims}` : `expected the installed worker to be available, lastError=${String(status.lastError)}`,
    }
  })

  const embeddingAvailable = statusOutcome?.data?.available === true
  if (!embeddingAvailable) {
    for (const caseId of ['EMBEDDING.index.ready', 'EMBEDDING.index.counts', 'EMBEDDING.index.idempotent', 'EMBEDDING.vector.channel', 'EMBEDDING.semantic.q1', 'EMBEDDING.semantic.q2', 'EMBEDDING.semantic.q3', 'EMBEDDING.semantic.q4', 'EMBEDDING.semantic.compare', 'EMBEDDING.diagnostics', 'EMBEDDING.scope.vector']) {
      notRun(caseId, EXPECTED.get(caseId).expected, `embedding.status.available=false (${String(statusOutcome?.data?.lastError ?? 'worker unavailable')}); vector cases cannot fabricate results`)
    }
    await check('EMBEDDING.degrade', EXPECTED.get('EMBEDDING.degrade').expected, async () => {
      const search = await searchResultIds({ q: '强化学习', scope: 'papers', ai: 'off', limit: 5 })
      const vector = vectorChannelOf(search.channels)
      const pass = ['unavailable', 'degraded', 'off'].includes(String(vector?.status)) && String(vector?.reason ?? vector?.note ?? '').trim() !== ''
      return { actual: { vectorChannel: vector, status: statusOutcome?.data, channels: search.channels }, pass }
    })
    return
  }

  const wait = await waitForEmbeddingReady(180_000, 'mount')
  state.evidence.embeddingWait = { ready: wait.ready, elapsedMs: wait.elapsedMs, polls: wait.polls.slice(-12), status: clipValue(wait.status) }
  await check('EMBEDDING.index.ready', EXPECTED.get('EMBEDDING.index.ready').expected, async () => {
    const status = wait.status ?? (await embeddingStatus())
    const ready = embeddingReady(status)
    return {
      actual: {
        ready,
        elapsedMs: wait.elapsedMs,
        building: status?.building ?? null,
        indexVersion: status?.indexVersion ?? null,
        expectedVersion,
        counts: clipValue(status?.counts),
        lastError: status?.lastError ?? null,
      },
      pass: ready,
      notes: ready ? `index ready after ${wait.elapsedMs}ms` : 'index did not become ready within the timeout; embedding cases downstream depend on it',
    }
  })

  await check('EMBEDDING.index.counts', EXPECTED.get('EMBEDDING.index.counts').expected, async () => {
    const status = await embeddingStatus()
    const counts = status?.counts ?? {}
    const pass =
      Number(counts.papers ?? 0) >= 30 &&
      Number(counts.pages ?? 0) >= 100 &&
      Number(counts.figures ?? 0) >= 300 &&
      Number(counts.annotations ?? 0) >= 20
    state.embedding.countsBefore = { ...counts }
    return {
      actual: {
        counts,
        thresholds: { papers: 30, pages: 100, figures: 300, annotations: 20 },
        indexVersion: status?.indexVersion ?? null,
        building: status?.building ?? null,
      },
      pass,
    }
  })

  await check('EMBEDDING.index.idempotent', EXPECTED.get('EMBEDDING.index.idempotent').expected, async () => {
    const before = state.embedding.countsBefore ?? (await embeddingStatus())?.counts ?? null
    const forced = await measure(() => call('embedding.index', { force: true }, 60_000))
    const forcedWait = await waitForEmbeddingReady(240_000, 'force')
    const after = (await embeddingStatus())?.counts ?? null
    state.embedding.countsAfter = after ? { ...after } : null
    state.evidence.forceIndex = { response: clipValue(forced.data), error: forced.error, elapsedMs: forcedWait.elapsedMs, ready: forcedWait.ready, enqueueError: state.evidence.mountIndexEnqueueError ?? null }
    const same = before !== null && after !== null && ['papers', 'pages', 'figures', 'annotations'].every((key) => Number(before[key]) === Number(after[key]))
    const versionOk = (await embeddingStatus())?.indexVersion === expectedVersion
    const pass = forced.error === null && forcedWait.ready && same && versionOk
    return {
      actual: {
        forceResponse: clipValue(forced.data),
        forceError: forced.error,
        rebuildMs: forcedWait.elapsedMs,
        countsBefore: before,
        countsAfter: after,
        countsUnchanged: same,
        indexVersion: (await embeddingStatus())?.indexVersion ?? null,
      },
      pass,
      notes: 'force reindex upserts the same (kind, ref_id, chunk_index, model) rows: counts must not grow and the index version must stay the same.',
    }
  })

  await check('EMBEDDING.vector.channel', EXPECTED.get('EMBEDDING.vector.channel').expected, async () => {
    const search = await measure(() => searchResultIds({ q: '强化学习', scope: 'papers', ai: 'off', limit: 10 }))
    const data = search.data?.data ?? null
    const vector = vectorChannelOf(search.data?.channels)
    const items = data?.items ?? []
    const vectorInItems = items.filter((item) => (item.reasons ?? []).includes('vector_similarity')).length
    state.embedding.vectorChannel = { channel: vector, total: search.ms, resultCount: items.length, vectorInItems }
    const pass =
      search.error === null &&
      vector !== null &&
      vector.status === 'ok' &&
      typeof vector.latencyMs === 'number' &&
      Number(vector.k) > 0 &&
      items.length > 0 &&
      vectorInItems > 0
    return {
      actual: {
        vectorChannel: vector,
        queryMs: search.ms,
        items: items.length,
        vectorInItems,
        top: items.slice(0, 5).map((item) => ({ paperId: itemPaperId(item), title: String(item.title ?? '').slice(0, 48), reasons: item.reasons ?? [], score: item.score ?? null })),
      },
      pass,
      notes: `vector channel measured ${String(vector?.latencyMs)}ms for the query; client round-trip ${search.ms}ms`,
    }
  })

  // 4 real Chinese semantic queries
  for (const query of SEMANTIC_QUERIES) {
    const caseId = `EMBEDDING.semantic.${query.id}`
    await check(caseId, EXPECTED.get(caseId).expected, async () => {
      const search = await measure(() => call('search.query', { q: query.q, scope: 'papers', ai: 'off', limit: 5 }, 60_000))
      const data = search.data ?? {}
      const items = data.items ?? []
      const vector = vectorChannelOf(data.channels)
      const top = []
      const fields = []
      for (const item of items) {
        const paperId = itemPaperId(item)
        let field = null
        try {
          const detail = await call('library.get', { id: paperId }, 20_000)
          field = detail?.field ?? null
        } catch {
          field = null
        }
        fields.push(field)
        top.push({
          paperId,
          title: String(item.title ?? '').slice(0, 60),
          field,
          reasons: item.reasons ?? [],
          hasVector: (item.reasons ?? []).includes('vector_similarity'),
          score: item.score ?? null,
        })
      }
      const relevanceHits = fields.filter((field) => query.fields.includes(field)).length
      const vectorOk = vector !== null && vector.status === 'ok' && Number(vector.k) > 0
      state.embedding.semantic[query.id] = { q: query.q, expectedFields: query.fields, top, relevanceHits, vector, queryMs: search.ms }
      const pass = search.error === null && items.length > 0 && vectorOk && top.every((entry) => typeof entry.title === 'string' && entry.title !== '')
      return {
        actual: {
          query: query.q,
          expectedFields: query.fields,
          vectorChannel: vector,
          queryMs: search.ms,
          top,
          relevanceHits,
          vectorInTop: top.filter((entry) => entry.hasVector).length,
        },
        pass,
        notes: `rule-based relevance: ${relevanceHits}/${top.length} top results belong to the expected fields (recorded, no hard threshold).`,
      }
    })
  }

  await check('EMBEDDING.semantic.compare', EXPECTED.get('EMBEDDING.semantic.compare').expected, async () => {
    // Probe for a parameter combination that disables the vector channel (the
    // contract does not pin one; try the plausible shapes and record what works).
    const variants = [
      { label: 'vector:false', params: { vector: false } },
      { label: 'channels:[fts]', params: { channels: ['fts'] } },
      { label: 'semantic:false', params: { semantic: false } },
      { label: 'mode:fts', params: { mode: 'fts' } },
      { label: 'vector:off', params: { vector: 'off' } },
    ]
    const attempts = []
    for (const variant of variants) {
      try {
        const data = await call('search.query', { q: '灌溉与作物产量', scope: 'papers', ai: 'off', limit: 5, ...variant.params }, 60_000)
        const vector = vectorChannelOf(data?.channels)
        const disabled = vector === null || vector.status !== 'ok'
        attempts.push({ label: variant.label, vector: vector === null ? null : { name: vector.name, status: vector.status }, disabled })
      } catch (error) {
        attempts.push({ label: variant.label, error: { code: error?.code ?? null, message: String(error?.message ?? error) }, disabled: false })
      }
    }
    const working = attempts.find((attempt) => attempt.disabled === true) ?? null
    state.embedding.ftsBaseline = { attempts, working: working?.label ?? null }
    if (working === null) {
      notRun(
        'EMBEDDING.semantic.compare',
        EXPECTED.get('EMBEDDING.semantic.compare').expected,
        '实现未提供关闭向量通道的公开参数（已尝试 vector:false/channels:[fts]/semantic:false/mode:fts/vector:off），无法取得纯 FTS 基线；向量/融合 Top5 与规则相关性已在上方 4 条查询中如实记录',
        { actual: { attempts } },
      )
      return { skipped: true }
    }
    const variantParams = variants.find((variant) => variant.label === working.label)?.params ?? {}
    const comparisons = []
    for (const query of SEMANTIC_QUERIES) {
      const fts = await call('search.query', { q: query.q, scope: 'papers', ai: 'off', limit: 5, ...variantParams }, 60_000)
      const ftsIds = (fts.items ?? []).map(itemPaperId)
      const vectorTop = state.embedding.semantic[query.id]?.top ?? []
      const vectorIds = vectorTop.map((entry) => entry.paperId)
      const overlap = vectorIds.filter((id) => ftsIds.includes(id)).length
      comparisons.push({
        q: query.q,
        ftsIds,
        vectorIds,
        overlapAt5: overlap,
        vectorOnly: vectorIds.filter((id) => !ftsIds.includes(id)),
        ftsOnly: ftsIds.filter((id) => !vectorIds.includes(id)),
        vectorTitles: vectorTop.map((entry) => entry.title),
      })
    }
    return {
      actual: { baselineMode: working, attempts, comparisons },
      pass: comparisons.every((entry) => Array.isArray(entry.ftsIds)),
      notes: 'comparison recorded only; no hard ranking metric is asserted (contract §2.3).',
    }
  })

  await check('EMBEDDING.diagnostics', EXPECTED.get('EMBEDDING.diagnostics').expected, async () => {
    const diagnostics = await call('diagnostics', {}, 30_000)
    const embedding = diagnostics?.embedding ?? null
    const vectorCapability = diagnostics?.capabilities?.vector ?? null
    const pass =
      embedding !== null &&
      typeof embedding === 'object' &&
      embedding.available === true &&
      Number(embedding.dims) === EMBED_DIMS &&
      String(embedding.model ?? '').includes('paraphrase-multilingual-MiniLM-L12-v2') &&
      vectorCapability === 'ready'
    return { actual: { embedding: clipValue(embedding), vectorCapability }, pass }
  })

  await check('EMBEDDING.scope.vector', EXPECTED.get('EMBEDDING.scope.vector').expected, async () => {
    const pages = await searchResultIds({ q: '强化学习', scope: 'pages', ai: 'off', limit: 5 })
    const annotations = await searchResultIds({ q: '灌溉', scope: 'annotations', ai: 'off', limit: 5 })
    const pagesVector = vectorChannelOf(pages.channels)
    const annotationsVector = vectorChannelOf(annotations.channels)
    const pass =
      pagesVector !== null && pagesVector.status === 'ok' && Number(pagesVector.k) > 0 && pages.ids.length > 0 &&
      annotationsVector !== null && annotationsVector.status === 'ok' && Number(annotationsVector.k) > 0
    return {
      actual: {
        pages: { count: pages.ids.length, vector: pagesVector },
        annotations: { count: annotations.ids.length, vector: annotationsVector },
        annotationsItems: annotations.data?.items?.slice(0, 3),
      },
      pass,
    }
  })

  await check('EMBEDDING.degrade', EXPECTED.get('EMBEDDING.degrade').expected, async () => {
    notRun(
      'EMBEDDING.degrade',
      EXPECTED.get('EMBEDDING.degrade').expected,
      '本机 embedding worker 真实可用（available=true），套件无法在不破坏用户环境的前提下模拟 worker 崩溃；降级路径由宿主 selftest / 环境未安装场景覆盖，套件对 vector channel 仍要求 status+reason 的诚实报告',
      { actual: { available: (await embeddingStatus())?.available ?? null } },
    )
    return { skipped: true }
  })
}

/* ------------------------------------------------------------------ *
 * Regression evidence
 * ------------------------------------------------------------------ */
async function regressionCases() {
  await check('REF.v04', EXPECTED.get('REF.v04').expected, async () => {
    const report = readReport('reports/v04-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const pass = report.exists && Number(summary.total) === 34 && Number(summary.pass) === 34 && Number(summary.fail) === 0 && Number(summary.not_run) === 0
    return { actual: { path: report.path, exists: report.exists, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null, not_run: summary.not_run ?? null }, pass }
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
    // Historical v0.3 (recorded at v0.3 time in reports/verify.md §13–§18) was 38/38.
    // The current file is a v0.4 re-run; the 3 failures come from v0.4 routing
    // translate.text to the free-engine chain (fast only applies to provider=llm).
    let llmFastProbe = null
    try {
      llmFastProbe = await call('translate.text', { text: 'The proposed method improves retrieval accuracy on three benchmarks.', target: 'zh', provider: 'llm', fast: true }, 90_000)
    } catch (error) {
      llmFastProbe = { error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
    }
    const llmFastOk = llmFastProbe?.status === 'translated' && llmFastProbe?.fast === true && Object.hasOwn(llmFastProbe ?? {}, 'reasoningEffort')
    let historical38 = false
    try {
      const verifyText = readFileSync(resolve(WORKSPACE, 'reports/verify.md'), 'utf8')
      historical38 = verifyText.includes('| **合计** | **38** | **38** | **0** | **0** |')
    } catch {
      historical38 = false
    }
    const pass = (Number(summary.pass) === 38 && Number(summary.fail) === 0) || (explained && llmFastOk && historical38)
    return {
      actual: {
        path: report.path,
        total: summary.total ?? null,
        pass: summary.pass ?? null,
        fail: summary.fail ?? null,
        not_run: summary.not_run ?? null,
        failingCases: failing,
        knownAiFastRoutingExplanation: explained,
        historicalV03: historical38 ? 'reports/verify.md §13–§18 documents the v0.3 run as 38/38 (historical)' : 'historical 38/38 marker not found in verify.md',
        llmFastProbe: clipValue(llmFastProbe),
        llmFastOk,
      },
      pass,
      notes: 'current v0.3 file is a v0.4 re-run whose 3 failures are the v0.4 translate.text free-engine routing change (fast applies to provider=llm); the live llm-fast probe proves the v0.3 AI-fast expectation still holds on the LLM channel.',
    }
  })

  await check('REF.v02', EXPECTED.get('REF.v02').expected, async () => {
    const report = readReport('reports/v02-api-results.json')
    const summary = report.parsed?.summary ?? {}
    const pass = report.exists && Number(summary.total) === 26 && Number(summary.pass) === 26 && Number(summary.fail) === 0
    return { actual: { path: report.path, exists: report.exists, total: summary.total ?? null, pass: summary.pass ?? null, fail: summary.fail ?? null }, pass }
  })

  await check('REF.lifecycle', EXPECTED.get('REF.lifecycle').expected, async () => {
    const report = readReport('reports/v03-lifecycle-run.json')
    const lifecycle = report.parsed?.summary?.by_suite?.lifecycle ?? {}
    const pass = report.exists && Number(lifecycle.total) === 13 && Number(lifecycle.pass) === 12 && Number(lifecycle.fail) === 0 && Number(lifecycle.not_run) === 1
    return { actual: { path: report.path, lifecycle: clipValue(lifecycle), notRunCase: 'LIFE.05.tool_read_rejected' }, pass }
  })
}

/* ------------------------------------------------------------------ *
 * Cleanup / data preservation
 * ------------------------------------------------------------------ */
async function cleanupCases() {
  // 1) delete every test folder (children are promoted automatically; delete deepest first)
  const reverseIds = [...state.createdFolderIds].reverse()
  for (const folderId of reverseIds) {
    try {
      await call('library.collections.delete', { id: folderId, operationId: `v05-clean-folder-${folderId}` }, 30_000)
    } catch (error) {
      // already deleted by an earlier parent delete/promote or by an undo
      const message = String(error?.message ?? error)
      if (!/not.?found|does not exist/i.test(message)) state.cleanupErrors.push(`folder delete ${folderId}: ${message}`)
    }
  }
  let treeAfter = null
  try {
    treeAfter = await readSettingsTree()
  } catch (error) {
    state.cleanupErrors.push(`folder tree read: ${String(error?.message ?? error)}`)
  }
  const leftoverFolderIds = [...(treeAfter === null ? [] : folderIdsInTree(treeAfter))].filter((id) => reverseIds.includes(id))

  // 2) remove test tags from the user paper
  if (state.tags.length > 0) {
    try {
      await call('library.update', { id: P_GRAND, patch: { removeTags: [...state.tags] }, operationId: `v05-clean-tags-${RUN_STAMP}` })
    } catch (error) {
      state.cleanupErrors.push(`tag cleanup: ${String(error?.message ?? error)}`)
    }
  }

  // 3) restore favorites to the captured baseline
  try {
    const current = new Set(await favoriteIds())
    const baseline = new Set(state.favorites.baseline ?? [])
    const toUnset = [...current].filter((id) => !baseline.has(id))
    const toSet = [...baseline].filter((id) => !current.has(id))
    if (toUnset.length > 0) await call('library.setFavorite', { ids: toUnset, favorite: false, operationId: `v05-clean-fav-off-${RUN_STAMP}` })
    if (toSet.length > 0) await call('library.setFavorite', { ids: toSet, favorite: true, operationId: `v05-clean-fav-on-${RUN_STAMP}` })
  } catch (error) {
    state.cleanupErrors.push(`favorite restore: ${String(error?.message ?? error)}`)
  }

  await check('CLEANUP.folders', EXPECTED.get('CLEANUP.folders').expected, async () => {
    const tree = await readSettingsTree().catch(() => null)
    const stillThere = [...(tree === null ? [] : folderIdsInTree(tree))].filter((id) => state.createdFolderIds.includes(id))
    const tags = await call('tags.list')
    const leftoverTags = state.tags.filter((name) => (tags.items ?? []).some((tag) => tag.name === name))
    const currentFavorites = new Set(await favoriteIds())
    const baseline = new Set(state.favorites.baseline ?? [])
    const favoritesRestored = currentFavorites.size === baseline.size && [...baseline].every((id) => currentFavorites.has(id))
    const pass = stillThere.length === 0 && leftoverTags.length === 0 && favoritesRestored
    return {
      actual: {
        deletedFolderIds: state.createdFolderIds,
        leftInTree: stillThere,
        leftoverTestTags: leftoverTags,
        favoritesRestored,
        favorites: [...currentFavorites].sort(),
        baselineFavorites: [...baseline].sort(),
        cleanupErrors: state.cleanupErrors,
      },
      pass,
    }
  })

  const after = await readEnvironment()
  state.after = { counts: after.counts, finishedAt: isoNow() }
  const baselineCounts = state.baseline?.counts ?? {}
  await check('REF.data.preserved', EXPECTED.get('REF.data.preserved').expected, async () => {
    const countsMatch =
      Number(after.counts?.papers) === Number(baselineCounts.papers) &&
      Number(after.counts?.annotations) === Number(baselineCounts.annotations) &&
      Number(after.counts?.figures) === Number(baselineCounts.figures) &&
      Number(after.counts?.trash) === Number(baselineCounts.trash)
    const tree = await readSettingsTree().catch(() => null)
    const fallbackIds = tree === null ? [] : [...folderIdsInTree(tree)].filter((id) => state.createdFolderIds.includes(id))
    const favorites = await favoriteIds().catch(() => [])
    const baseline = [...(state.favorites.baseline ?? [])].sort()
    const favoritesRestored = favorites.sort().join(',') === baseline.join(',')
    const tags = await call('tags.list').catch(() => ({ items: [] }))
    const leftoverTags = state.tags.filter((name) => (tags.items ?? []).some((tag) => tag.name === name))
    return {
      actual: {
        baseline: clipValue(baselineCounts),
        after: clipValue(after.counts),
        countsMatch,
        fallbackIds,
        favoritesRestored,
        leftoverTags,
        cleanupErrors: state.cleanupErrors,
        embeddingIndexPersisted: { indexVersion: state.embedding.status?.indexVersion ?? null, counts: clipValue(state.embedding.countsAfter ?? state.embedding.countsBefore) },
      },
      pass: countsMatch && fallbackIds.length === 0 && favoritesRestored && leftoverTags.length === 0 && state.cleanupErrors.length === 0,
      notes: 'the embedding index built by this suite is a real feature artefact and is intentionally kept (not user data); folders/favorites/tags are restored.',
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
    schema: 'pappers-hall/v05-api-results@1',
    suite: 'v0.5 API acceptance',
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
    baseline: {
      counts: state.baseline?.counts ?? null,
      favoriteIds: [...(state.favorites.baseline ?? [])],
      tags: state.baseline?.tags ?? [],
      folderIds: state.baseline?.folderIds ?? [],
      embedding: state.baseline?.embedding ?? null,
      capturedAt: state.startedAt,
    },
    after: state.after,
    evidence: {
      folders: {
        created: state.folders,
        createdFolderIds: state.createdFolderIds,
        discoverFeed: state.evidence.foldersDiscover ?? null,
      },
      favorites: { baseline: [...(state.favorites.baseline ?? [])], expected: state.favorites.expectedIds ?? [] },
      search: state.evidence.search ?? null,
      embedding: {
        status: clipValue(state.embedding.status),
        expectedVersion: EMBED_INDEX_VERSION,
        countsBefore: state.embedding.countsBefore,
        countsAfter: state.embedding.countsAfter,
        vectorChannel: state.embedding.vectorChannel,
        semantic: state.embedding.semantic,
        ftsBaseline: state.embedding.ftsBaseline,
        wait: state.evidence.embeddingWait ?? null,
        forceIndex: state.evidence.forceIndex ?? null,
      },
      regression: { v04: 'reports/v04-api-results.json', v03: 'reports/v03-api-results.json', v02: 'reports/v02-api-results.json', lifecycle: 'reports/v03-lifecycle-run.json' },
    },
    results,
  }
}

async function finish(exitCode) {
  const report = buildReport(exitCode)
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  const { pass, fail, not_run: notRunCount } = report.summary
  console.log(`\nV0.5 API RESULT: ${pass}/${report.summary.total} pass, ${fail} fail, ${notRunCount} not_run → ${OUT}`)
  process.exitCode = exitCode
}

async function main() {
  if (DRY_RUN) {
    const unique = new Set(PLAN.map(([id]) => id))
    if (unique.size !== PLAN.length) throw new Error('duplicate case ids in PLAN')
    console.log('Pappers-Hall v0.5 API acceptance suite — DRY RUN (no mutations, read-only probes only)\n')
    let currentGroup = null
    for (const [id, group, expected] of PLAN) {
      if (group !== currentGroup) {
        console.log(`\n[${group}]`)
        currentGroup = group
      }
      console.log(`  ${id.padEnd(34)} ${expected}`)
    }
    console.log(`\nplanned cases: ${PLAN.length}`)
    console.log(`embedding expectation: model=${EMBED_MODEL} dims=${EMBED_DIMS} indexVersion=${EMBED_INDEX_VERSION}`)
    const python = dirNonEmpty(EMBED_PYTHON)
    const modelCache = dirNonEmpty(EMBED_MODELS)
    console.log(`embedding env: python=${JSON.stringify(python)} modelCache=${JSON.stringify(modelCache)} worker=${existsSync(WORKER)}`)
    try {
      const environment = await readEnvironment()
      console.log(`live host: version=${String(environment.pluginVersion)} schemaVersion=${String(environment.schemaVersion)} papers=${environment.counts?.papers ?? '?'} annotations=${environment.counts?.annotations ?? '?'} vector=${environment.capabilities?.vector ?? '?'}`)
      const shape = await probeV05Shape()
      console.log(`v0.5 method probe: library.folders.tree=${shape.folders}, embedding.status=${shape.embedding}`)
      const v05 = String(environment.pluginVersion ?? '').startsWith('0.5') || Number(environment.schemaVersion) >= 5 || (shape.folders === 'ok' && shape.embedding === 'ok')
      console.log(v05 ? 'v0.5 host appears loaded — a real run is possible after GO v05.' : 'v0.5 host is NOT loaded yet: the real run will be refused by the ENV gate until the Lead reload + "GO v05".')
      const regression = ['reports/v04-api-results.json', 'reports/v03-api-results.json', 'reports/v02-api-results.json', 'reports/v03-lifecycle-run.json']
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
    console.log('\nDRY RUN OK: script parses, case plan complete, no data was written. Waiting for "GO v05".')
    process.exitCode = 0
    return
  }

  /* ---------------- real run ---------------- */
  let environment
  try {
    environment = await readEnvironment()
  } catch (error) {
    console.error('V0.5 SUITE ERROR: live host unreachable:', String(error?.message ?? error))
    process.exitCode = 2
    return
  }
  state.environment = {
    plugin: environment.status?.plugin ?? null,
    schemaVersion: environment.schemaVersion,
    counts: environment.counts,
    features: environment.features,
    capabilities: environment.capabilities,
    embedding: environment.embedding,
    ai: environment.ai,
    versions: environment.diagnostics?.versions ?? null,
    degraded: environment.status?.degraded ?? null,
  }
  state.baseline = {
    counts: environment.counts,
    tags: [],
    folderIds: [],
    embedding: environment.embedding ? clipValue(environment.embedding) : null,
    capturedAt: state.startedAt,
  }

  const shape = await probeV05Shape()
  const version = String(environment.pluginVersion ?? '')
  const v05Loaded = version.startsWith('0.5') || Number(environment.schemaVersion) >= 5 || (shape.folders === 'ok' && shape.embedding === 'ok')
  await check('ENV.version', EXPECTED.get('ENV.version').expected, async () => {
    return {
      actual: { pluginVersion: version || null, schemaVersion: environment.schemaVersion, probe: shape },
      pass: v05Loaded,
    }
  })
  if (!v05Loaded) {
    console.error(`\nV0.5 GATE: host reports plugin ${version || 'unknown'} / schemaVersion ${String(environment.schemaVersion)} and folders.tree=${shape.folders}, embedding.status=${shape.embedding}; refusing mutation cases until the Lead reloads v0.5 and sends "GO v05".`)
    await finish(2)
    return
  }
  await check('ENV.baseline', EXPECTED.get('ENV.baseline').expected, async () => {
    const counts = environment.counts ?? {}
    const tags = await call('tags.list').catch(() => ({ items: [] }))
    const tree = await readSettingsTree().catch(() => null)
    state.baseline.tags = (tags.items ?? []).map((tag) => tag.name)
    state.baseline.folderIds = tree === null ? [] : [...folderIdsInTree(tree)]
    state.favorites.baseline = new Set(await favoriteIds().catch(() => []))
    state.baseline.favoriteIds = [...state.favorites.baseline]
    const pass = Number(counts.papers ?? 0) >= 30 && Number(counts.annotations ?? 0) >= 1 && Number(counts.trash ?? -1) === 0
    return {
      actual: {
        counts,
        favoriteIds: [...state.favorites.baseline].sort(),
        tags: state.baseline.tags,
        folderCount: state.baseline.folderIds.length,
      },
      pass,
    }
  })
  await check('ENV.embeddingEnv', EXPECTED.get('ENV.embeddingEnv').expected, async () => {
    const python = dirNonEmpty(EMBED_PYTHON)
    const modelCache = dirNonEmpty(EMBED_MODELS)
    const worker = existsSync(WORKER)
    const pass = python.exists === true && modelCache.exists === true && Number(modelCache.entries ?? 0) > 0 && worker === true
    return { actual: { python: { path: EMBED_PYTHON, ...python }, modelCache: { path: EMBED_MODELS, ...modelCache }, worker: { path: WORKER, exists: worker } }, pass }
  })

  try {
    await folderSetup()
    await folderCases()
    await favoriteCases()
    await searchFilterCases()
    await embeddingCases()
    await regressionCases()
  } catch (error) {
    console.error('V0.5 SUITE ERROR (unexpected):', error?.stack ?? error)
    process.exitCode = 2
  } finally {
    try {
      await cleanupCases()
    } catch (error) {
      console.error('V0.5 CLEANUP ERROR:', error?.stack ?? error)
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
  console.error('V0.5 SUITE FATAL:', error?.stack ?? error)
  try {
    await finish(2)
  } catch {
    process.exit(2)
  }
})
