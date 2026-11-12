#!/usr/bin/env node
/**
 * Pappers-Hall v0.6 Agent-tool harness.
 *
 * The live plugin's `papers_*` tools are Cordis tool handlers, not HTTP
 * endpoints, so the verifier exercises them out-of-process against an ISOLATED
 * copy of the live library database:
 *
 * 1. `sqlite3 <liveDb> ".backup <sandbox>/pappers-hall.sqlite"` — consistent copy
 *    (WAL-safe); the copy keeps the real embeddings, folder tree and metadata so
 *    classify/related/folders behave exactly like production.
 * 2. `applyHost(fakeCtx, {dataDir: sandbox})` registers the real tool definitions
 *    on a fake Cordis context (same pattern as `host/selftest.mjs`).
 * 3. each tool handler is called with `definition.execute(args, {})` and the JSON
 *    value is asserted/recorded.
 *
 * Data safety: ALL writes (import confirm, folder CRUD, assignments) happen in
 * the sandbox DB/dirs only. The live library is never opened for writing, and the
 * main suite re-checks the live paper count before/after this harness.
 *
 * Usage:
 *   node test/v06-tools.mjs [--out /tmp/v06-tools.json] [--keep]
 *        [--live-db ~/.dsh/pappers-hall/pappers-hall.sqlite]
 *        [--devkit-pdf ../../pappers_hall_devkit_lite/papers/pdf/C02_ggcmi_evaluation.pdf]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const WORKSPACE = resolve(PLUGIN_ROOT, '..')
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const LIVE_DB = arg('--live-db', join(HOME, 'pappers-hall', 'pappers-hall.sqlite'))
const OUT = arg('--out', join(tmpdir(), `v06-tools-${Date.now()}.json`))
const DEVKIT_PDF = arg('--devkit-pdf', join(WORKSPACE, 'pappers_hall_devkit_lite', 'papers', 'pdf', 'C02_ggcmi_evaluation.pdf'))
const KEEP = args.includes('--keep')
const EMBED_PYTHON = process.env.PAPPERS_EMBED_PYTHON ?? join(HOME, 'pappers-hall', 'embedding', 'venv', 'bin', 'python')
const STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

const NEW_TOOLS = ['papers_overview', 'papers_folders', 'papers_classify', 'papers_import_file', 'papers_related']

/* ------------------------------------------------------------------ *
 * Fake Cordis context (same shape host/selftest.mjs uses)
 * ------------------------------------------------------------------ */
function createFakeContext() {
  const state = {
    topDisposers: [],
    tools: new Map(),
    routes: new Map(),
    intervals: new Set(),
    fibers: [],
    promptSections: new Map(),
    warnings: [],
    disposed: false,
  }

  const attachments = {
    async saveImage({ data, mediaType = 'image/png', name }) {
      const bytes = data instanceof Uint8Array ? data.byteLength : Buffer.byteLength(String(data ?? ''))
      return { attachmentId: `sha256:${'0'.repeat(64)}`, mediaType, bytes, width: 400, height: 300, ...(name === undefined ? {} : { name }) }
    },
  }

  const track = (disposer, owned) => {
    owned.push(disposer)
    return disposer
  }

  const makeContext = (services, owned) => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (...values) => state.warnings.push(values.map((value) => String(value)).join(' ')),
      error: (...values) => state.warnings.push(values.map((value) => String(value)).join(' ')),
    }
    const context = {
      logger,
      tools: {
        register(definition) {
          if (state.tools.has(definition.name)) throw new Error(`tool ${definition.name} already registered`)
          state.tools.set(definition.name, definition)
          return () => state.tools.delete(definition.name)
        },
      },
      timer: {
        interval(callback, milliseconds) {
          const entry = { callback, milliseconds }
          state.intervals.add(entry)
          return () => state.intervals.delete(entry)
        },
      },
      get(name) {
        return services[name]
      },
      effect(execute) {
        const result = execute()
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          const promise = Promise.resolve(result).then((disposer) => {
            track(disposer, owned)
            state.topDisposers.push(disposer)
            return disposer
          })
          return { then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected) }
        }
        if (typeof result === 'function') {
          track(result, owned)
          state.topDisposers.push(result)
          return { then: (onFulfilled) => Promise.resolve(onFulfilled === undefined ? result : onFulfilled(result)) }
        }
        throw new TypeError('fake ctx.effect: body must return a disposer or a promise of one')
      },
      inject(dependencies, callback) {
        const available = dependencies.every((name) => services[name] !== undefined)
        const fiberOwned = []
        const fiber = {
          disposed: false,
          then(onFulfilled, onRejected) {
            try {
              const value = onFulfilled === undefined ? fiber : onFulfilled(fiber)
              return Promise.resolve(value)
            } catch (error) {
              if (onRejected !== undefined) return Promise.reject(error).catch(onRejected)
              return Promise.reject(error)
            }
          },
          async dispose() {
            if (fiber.disposed) return
            fiber.disposed = true
            for (const disposer of fiberOwned.reverse()) await disposer()
          },
        }
        state.fibers.push(fiber)
        if (available) {
          const child = makeContext({ ...services }, fiberOwned)
          child.webServer = services.webServer
          callback(child)
        }
        return fiber
      },
    }
    return context
  }

  const webServer = {
    register(route) {
      if (state.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      state.routes.set(route.path, route)
      return () => state.routes.delete(route.path)
    },
  }

  const systemPrompt = {
    section(section) {
      if (state.promptSections.has(section.name)) throw new Error(`prompt section ${section.name} already registered`)
      state.promptSections.set(section.name, section)
      return () => state.promptSections.delete(section.name)
    },
    getSectionOrder(name) {
      return name === 'FILE_REFERENCE' ? 900 : 0
    },
  }

  const services = { tools: undefined, timer: undefined, webServer, attachments, systemPrompt }
  const ctx = makeContext(services, [])
  services.tools = ctx.tools
  services.timer = ctx.timer
  ctx.tools = ctx.tools
  ctx.timer = ctx.timer

  async function fireTimers() {
    for (const entry of [...state.intervals]) {
      try {
        await entry.callback()
      } catch {}
    }
  }

  async function disposeAll() {
    if (state.disposed) return
    state.disposed = true
    for (const disposer of [...state.topDisposers].reverse()) {
      try {
        await disposer()
      } catch {}
    }
    for (const fiber of state.fibers) {
      try {
        await fiber.dispose()
      } catch {}
    }
  }

  return { ctx, state, fireTimers, disposeAll }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function main() {
  const started = Date.now()
  const result = {
    schema: 'pappers-hall/v06-tools-harness@1',
    ok: false,
    sandbox: null,
    liveDb: LIVE_DB,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    tools: [],
    promptSections: [],
    promptRegistered: null,
    livePaperCountBefore: null,
    livePaperCountAfter: null,
    cases: [],
    error: null,
    warnings: [],
  }

  const record = (caseId, pass, actual, notes) => {
    result.cases.push({ case_id: caseId, pass, actual, ...(notes === undefined ? {} : { notes }) })
    console.log(`${pass ? 'PASS' : 'FAIL'} [harness] ${caseId}${pass ? '' : ' — ' + JSON.stringify(actual).slice(0, 300)}`)
  }

  let sandbox = null
  let fake = null
  let service = null
  let fixturePdf = null

  const run = async () => {
    if (!existsSync(LIVE_DB)) throw new Error(`live DB missing: ${LIVE_DB}`)
    if (!existsSync(DEVKIT_PDF)) throw new Error(`devkit PDF missing: ${DEVKIT_PDF}`)
    sandbox = mkdtempSync(join(tmpdir(), 'pappers-hall-v06-tools-'))
    result.sandbox = sandbox
    for (const dir of ['files', 'figures', 'cache', 'tmp']) mkdirSync(join(sandbox, dir), { recursive: true })
    const sandboxDb = join(sandbox, 'pappers-hall.sqlite')
    execFileSync('sqlite3', [LIVE_DB, `.backup '${sandboxDb}'`], { stdio: 'ignore' })

    // fixture PDF for import tests: byte-modified copy so the sha differs from the library
    fixturePdf = join(sandbox, `C02_v06copy_${STAMP}.pdf`)
    const source = readFileSync(DEVKIT_PDF)
    writeFileSync(fixturePdf, Buffer.concat([source, Buffer.from(`\n% pappers-hall v0.6 tool harness ${STAMP}\n`, 'latin1')]))

    fake = createFakeContext()
    const applyModule = await import(resolve(PLUGIN_ROOT, 'host', 'apply.js'))
    service = await applyModule.applyHost(fake.ctx, {
      dataDir: sandbox,
      embeddingPython: EMBED_PYTHON,
      embeddingReadyTimeoutMs: 120_000,
      embeddingRequestTimeoutMs: 120_000,
    })
    const domain = service.domain
    // The fake context never fires ctx.timer intervals by itself; tick the
    // persistent job worker while the harness runs so sandbox imports progress.
    const workerTicker = setInterval(() => {
      fake.fireTimers().catch(() => {})
    }, 250)
    result.workerTicker = true
    const stopTicker = () => clearInterval(workerTicker)
    try {
    const tool = (name) => {
      const definition = fake.state.tools.get(name)
      if (definition === undefined) throw new Error(`tool ${name} is not registered`)
      return definition
    }
    const callTool = async (name, toolArgs) => {
      try {
        const value = await tool(name).execute(toolArgs, {})
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: { code: error?.code ?? null, message: String(error?.message ?? error) } }
      }
    }
    const sandboxPaperCount = () => Number(domain.db.prepare("SELECT COUNT(*) AS n FROM papers WHERE state = 'active'").get()?.n ?? 0)
    const livePaperCount = () => {
      try {
        return Number(execFileSync('sqlite3', ['-readonly', LIVE_DB, "SELECT COUNT(*) FROM papers WHERE state = 'active'"], { encoding: 'utf8' }).trim())
      } catch {
        return null
      }
    }

    // 0) live DB untouched by the copy (read-only sanity; compare after too)
    result.livePaperCountBefore = livePaperCount()

    // 1) registration + prompt
    result.tools = [...fake.state.tools.keys()]
    result.promptSections = [...fake.state.promptSections.keys()]
    result.promptRegistered = service.promptRegistered === true
    record('HARNESS.tools.registered', NEW_TOOLS.every((name) => result.tools.includes(name)), { tools: result.tools })

    // 2) papers_overview
    const overview = await callTool('papers_overview', {})
    {
      const value = overview.value ?? {}
      const pass =
        overview.ok &&
        value !== null &&
        typeof value === 'object' &&
        (Array.isArray(value.folders) || Array.isArray(value.folderTree) || (value.stats !== undefined && typeof value.stats === 'object'))
      record('HARNESS.overview', pass, overview.ok ? { keys: Object.keys(value), stats: value.stats ?? null, folderCount: (value.folders ?? value.folderTree ?? []).length } : overview.error)
    }

    // 3) papers_folders all actions (sandbox only)
    const folderName = `v06-harness-folder-${STAMP}`
    const createdFolder = await callTool('papers_folders', { action: 'create', name: folderName })
    const treeAfterCreate = await callTool('papers_folders', { action: 'tree' })
    const findFolder = (treeValue, id, name) => {
      const items = Array.isArray(treeValue)
        ? treeValue
        : (treeValue?.items ?? treeValue?.folders ?? (Array.isArray(treeValue?.tree) ? treeValue.tree : treeValue?.tree?.items) ?? [])
      const visit = (list) => {
        for (const item of list ?? []) {
          if (item === null || typeof item !== 'object') continue
          if ((id !== undefined && item.id === id) || (name !== undefined && item.name === name)) return item
          const found = visit(item.children)
          if (found !== null) return found
        }
        return null
      }
      return visit(items)
    }
    const created = findFolder(treeAfterCreate.value, undefined, folderName)
    const folderId = created?.id ?? null
    const renameTo = `${folderName}-renamed`
    const renamed = folderId === null ? { ok: false, error: 'folder not found after create' } : await callTool('papers_folders', { action: 'rename', id: folderId, name: renameTo })
    const treeAfterRename = await callTool('papers_folders', { action: 'tree' })
    const foundRenamed = findFolder(treeAfterRename.value, folderId)
    const p = 'ph-8d90723ee7bc'
    const assign = folderId === null ? { ok: false, error: 'no folder' } : await callTool('papers_folders', { action: 'assign', folderId, paperIds: [p] })
    const listAfterAssign = folderId === null ? null : domain.libraryList({ folderId, limit: 200 })
    const unassign = folderId === null ? { ok: false, error: 'no folder' } : await callTool('papers_folders', { action: 'unassign', folderId, paperIds: [p] })
    const listAfterUnassign = folderId === null ? null : domain.libraryList({ folderId, limit: 200 })
    const deleted = folderId === null ? { ok: false, error: 'no folder' } : await callTool('papers_folders', { action: 'delete', id: folderId })
    const treeAfterDelete = await callTool('papers_folders', { action: 'tree' })
    const paperStillActive = domain.libraryGet({ id: p })?.state ?? null
    const foldersPass =
      createdFolder.ok &&
      folderId !== null &&
      renamed.ok &&
      foundRenamed?.name === renameTo &&
      assign.ok &&
      (listAfterAssign?.items ?? []).some((paper) => paper.id === p) &&
      unassign.ok &&
      !(listAfterUnassign?.items ?? []).some((paper) => paper.id === p) &&
      deleted.ok &&
      findFolder(treeAfterDelete.value, folderId) === null &&
      paperStillActive === 'active'
    record('HARNESS.foldersActions', foldersPass, {
      createdFolder: createdFolder.ok ? { id: folderId, name: created?.name ?? null } : createdFolder.error,
      renamed: renamed.ok ? { name: foundRenamed?.name ?? null } : renamed.error,
      assignOk: assign.ok,
      listAfterAssignTotal: listAfterAssign?.total ?? null,
      unassignOk: unassign.ok,
      listAfterUnassignTotal: listAfterUnassign?.total ?? null,
      deleteOk: deleted.ok,
      paperStillActive,
    })

    // 4) papers_classify (suggest; apply on a sandbox paper)
    const classifySuggest = await callTool('papers_classify', { paperIds: ['ph-8d90723ee7bc', 'ph-53132d8d95a6'], apply: false })
    const classifyApply = await callTool('papers_classify', { paperIds: ['ph-ab4eb56f3937'], apply: true })
    {
      const suggestions = (classifySuggest.value?.suggestions ?? classifySuggest.value?.items ?? [])
      const appliedPayload = classifyApply.value?.applied ?? null
      const applied = Array.isArray(appliedPayload) ? appliedPayload : (appliedPayload?.applied ?? [])
      const suggestOk =
        classifySuggest.ok &&
        Array.isArray(suggestions) &&
        suggestions.length === 2 &&
        suggestions.every((entry) => typeof entry.paperId === 'string' && ['assign', 'create'].includes(entry.action) && typeof entry.score === 'number')
      const applyOk = classifyApply.ok && (applied.length > 0 || classifyApply.value?.status === 'unavailable')
      record('HARNESS.classify', suggestOk && applyOk, {
        suggest: suggestions,
        apply: classifyApply.ok ? { applied, status: classifyApply.value?.status ?? null } : classifyApply.error,
      })
    }

    // 5) papers_import_file preview: must NOT write the DB
    const beforePreview = sandboxPaperCount()
    const preview = await callTool('papers_import_file', { path: fixturePdf })
    const afterPreview = sandboxPaperCount()
    {
      const value = preview.value ?? {}
      const question = String(value.question ?? '')
      const pass =
        preview.ok &&
        value.status === 'needs_confirmation' &&
        (value.kind === 'paper' || value.kind === 'unknown') &&
        typeof value.title === 'string' &&
        value.title.trim() !== '' &&
        question !== '' &&
        afterPreview === beforePreview
      record('HARNESS.importPreviewNoWrite', pass, {
        status: value.status ?? null,
        kind: value.kind ?? null,
        title: value.title ?? null,
        question,
        doi: value.doi ?? null,
        paperCountBefore: beforePreview,
        paperCountAfter: afterPreview,
        error: preview.error ?? null,
      })
    }

    // 6) papers_import_file invalid path
    const invalid = await callTool('papers_import_file', { path: '/nonexistent/pappers-hall-v06-missing.pdf' })
    {
      const value = invalid.value ?? {}
      const pass = invalid.ok && value.status === 'invalid' && String(value.reason ?? '').trim() !== ''
      record('HARNESS.importInvalid', pass, { value: invalid.ok ? { status: value.status, reason: value.reason } : invalid.error })
    }

    // 7) papers_import_file confirm=true -> imported (sync) or importing+jobId (async)
    //    then auto classified; the sandbox is cleaned up afterwards.
    const existingPaperIds = new Set(domain.db.prepare('SELECT id FROM papers').all().map((row) => row.id))
    const beforeConfirm = sandboxPaperCount()
    const confirmed = await callTool('papers_import_file', { path: fixturePdf, confirm: true })
    const waitSandboxJob = async (jobId, timeoutMs = 180_000) => {
      const began = Date.now()
      while (Date.now() - began < timeoutMs) {
        const row = domain.db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId)
        if (row !== undefined && ['succeeded', 'failed', 'cancelled'].includes(String(row.state))) return { state: String(row.state), waitedMs: Date.now() - began }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 300))
      }
      return { state: null, waitedMs: Date.now() - began }
    }
    {
      const value = confirmed.value ?? {}
      let status = value.status ?? null
      let paperId = value.paperId ?? value.id ?? null
      const jobId = value.jobId ?? value.job?.id ?? null
      let jobWait = null
      if (status === 'importing' || status === 'queued' || status === 'pending' || (paperId === null && jobId !== null)) {
        if (jobId !== null) jobWait = await waitSandboxJob(jobId)
        const added = domain.db.prepare('SELECT id FROM papers').all().map((row) => row.id).filter((id) => !existingPaperIds.has(id))
        if (paperId === null && added.length > 0) paperId = added[added.length - 1]
        status = jobWait?.state === 'succeeded' || paperId !== null ? 'imported' : jobWait?.state ?? status
      }
      const afterConfirm = sandboxPaperCount()
      const classification = value.classification ?? null
      const importedActive = paperId === null ? null : domain.libraryGet({ id: paperId })?.state ?? null
      let classificationFolderId = classification?.applied?.[0]?.folderId ?? classification?.folderId ?? null
      let classificationEvidence = null
      if (classification === null && paperId !== null) {
        const detail = domain.libraryGet({ id: paperId })
        const folders = (detail?.collections ?? []).filter((entry) => entry.kind === 'folder' || entry.kind === 'custom')
        classificationEvidence = { source: 'membership-derived', folders: folders.map((entry) => ({ id: entry.id, name: entry.name })) }
        if (classificationFolderId === null && folders.length > 0) classificationFolderId = folders[0].id
      }
      const folderMembership = classificationFolderId === null ? null : domain.libraryList({ folderId: classificationFolderId, limit: 200 })
      const classificationApplied = Array.isArray(classification?.applied) && classification.applied.length > 0
      const classificationExplicitFailure =
        classification !== null &&
        (classification.error !== undefined || classification.status === 'unavailable' || classification.status === 'error')
      const pass =
        confirmed.ok &&
        status === 'imported' &&
        paperId !== null &&
        afterConfirm === beforeConfirm + 1 &&
        importedActive === 'active' &&
        (classificationApplied || classificationExplicitFailure || (classificationEvidence !== null && classificationEvidence.folders.length >= 1)) &&
        (classificationFolderId === null || (folderMembership?.items ?? []).some((paper) => paper.id === paperId))
      // cleanup sandbox import so later cases see a clean copy
      let importCleanup = null
      try {
        if (paperId !== null) {
          domain.libraryDelete({ ids: [paperId] })
          domain.libraryPurge({ ids: [paperId] })
        }
        const createdFolders = classification?.createdFolders ?? []
        for (const folder of createdFolders) {
          if (typeof folder?.id === 'string') await callTool('papers_folders', { action: 'delete', id: folder.id })
        }
        importCleanup = { paperId, removed: paperId !== null, createdFolders: createdFolders.map((folder) => folder?.id ?? null) }
      } catch (error) {
        importCleanup = { paperId, removed: false, error: String(error?.message ?? error) }
      }
      result.importCleanup = importCleanup
      record('HARNESS.importConfirm', pass, {
        status,
        responseStatus: value.status ?? null,
        paperId,
        jobId,
        jobWait,
        title: value.title ?? null,
        classification,
        classificationEvidence,
        classificationFolderId,
        folderMembershipTotal: folderMembership?.total ?? null,
        paperCountBefore: beforeConfirm,
        paperCountAfter: afterConfirm,
        error: confirmed.error ?? null,
      })
    }

    // 8) papers_related: excludes itself, limit respected
    const related = await callTool('papers_related', { paperId: 'ph-8d90723ee7bc', limit: 5 })
    const relatedQuery = await callTool('papers_related', { query: '遥感影像预训练模型', limit: 5 })
    {
      const items = related.value?.items ?? related.value?.papers ?? related.value?.results ?? []
      const ids = items.map((item) => item.paperId ?? item.id)
      const pass =
        related.ok &&
        Array.isArray(items) &&
        items.length > 0 &&
        items.length <= 5 &&
        !ids.includes('ph-8d90723ee7bc') &&
        items.every((item) => typeof item.title === 'string' && typeof item.score === 'number') &&
        relatedQuery.ok &&
        ((relatedQuery.value?.items ?? relatedQuery.value?.papers ?? []).length > 0)
      record('HARNESS.related', pass, {
        items: items.map((item) => ({ paperId: item.paperId ?? item.id ?? null, title: String(item.title ?? '').slice(0, 50), score: item.score ?? null, year: item.year ?? null, venue: item.venue ?? null })),
        queryItems: (relatedQuery.value?.items ?? relatedQuery.value?.papers ?? []).slice(0, 3).map((item) => item.paperId ?? item.id ?? null),
        error: related.error ?? null,
      })
    }

    result.livePaperCountAfter = livePaperCount()
    result.ok = true
    result.elapsedMs = Date.now() - started
    } finally {
      stopTicker()
    }
  }

  return { result, run, cleanup: async () => {
    if (service !== null) {
      try {
        await service.dispose()
      } catch (error) {
        result.warnings.push(`dispose: ${String(error?.message ?? error)}`)
      }
    }
    if (fake !== null) {
      try {
        await fake.disposeAll()
      } catch (error) {
        result.warnings.push(`fake dispose: ${String(error?.message ?? error)}`)
      }
    }
    result.warnings.push(...(fake?.state.warnings ?? []))
    if (sandbox !== null && !KEEP) {
      try {
        rmSync(sandbox, { recursive: true, force: true })
      } catch {}
    }
    result.elapsedMs = result.elapsedMs || Date.now() - started
    try {
      writeFileSync(OUT, JSON.stringify(result, null, 2))
    } catch (error) {
      console.error('failed to write harness result:', String(error?.message ?? error))
    }
  } }
}

const harness = main()
harness
  .run()
  .catch((error) => {
    harness.result.error = String(error?.stack ?? error)
    console.error('V0.6 TOOL HARNESS FAILED:', error?.stack ?? error)
  })
  .finally(async () => {
    await harness.cleanup()
    console.log(`\nV0.6 TOOL HARNESS: ${harness.result.cases.filter((entry) => entry.pass).length}/${harness.result.cases.length} pass → ${OUT}`)
    process.exitCode = harness.result.ok ? 0 : 1
  })
