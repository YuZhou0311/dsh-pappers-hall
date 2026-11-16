#!/usr/bin/env node
/**
 * Standalone selftest for the Pappers-Hall Host half.
 *
 * Runs without DSH: it builds a minimal fake Cordis context (tools registry, tickable
 * timer, web-server route table, attachment stub), mounts `applyHost` against a
 * temporary data directory, imports the real A01_react.pdf fixture through the
 * public API and asserts the full lifecycle required by the task:
 *
 *   import → background job (driven by the injected timer) → page text / figures /
 *   search → delete (trash) → search exclusion → restore (new epoch) → visible.
 *
 * Run with `node host/selftest.mjs`; exits 0 and prints PASS on success.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractQueryTerms, PROMPT_VERSIONS } from './ai.js'
import { evaluateTranslationQuality, normalizeTranslationInput, splitTextChunks } from './translate.js'
import { chunkPageText } from './embedding.js'
import { fuseVectorHits } from './search.js'
import { applyHost } from './apply.js'
import { applyV6Migration } from './db.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.resolve(HERE, '..', '..')
const FIXTURE_PDF = path.join(WORKSPACE, 'pappers_hall_devkit_lite', 'papers', 'pdf', 'A01_react.pdf')

/** Collected assertions for the final report. */
const checks = []
/** Warnings captured from the fake logger. */
const warnings = []

/** Assert one named condition and record it. */
function check(name, condition, detail) {
  if (!condition) throw new Error(`FAILED: ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  checks.push(name)
}

/** Record one note (non-fatal observation). */
function note(name) {
  checks.push(`note: ${name}`)
}

/** Tiny assertion helper for async predicates. */
async function checkAsync(name, predicate, detail) {
  const value = await predicate()
  check(name, value === true || (typeof value === 'object' && value !== null), detail ?? value)
}

/**
 * Create one fake Cordis context sufficient for `applyHost`.
 *
 * The fake models exactly the parts the Host half is allowed to depend on:
 * effect cleanup, optional service lookup, optional injection, the tool registry,
 * the timer service, web-server routes and the attachment store.
 * @returns {object} fake context with test hooks.
 */
function createFakeContext() {
  const state = {
    topDisposers: [],
    tools: new Map(),
    routes: new Map(),
    intervals: new Set(),
    fibers: [],
    promptSections: new Map(),
    disposed: false,
  }

  /** A stub attachment store: saves nothing, returns a contract-shaped reference. */
  const attachments = {
    async saveImage({ data, mediaType = 'image/png', name }) {
      const bytes = data instanceof Uint8Array ? data.byteLength : Buffer.byteLength(String(data ?? ''))
      return {
        attachmentId: `sha256:${'0'.repeat(64)}`,
        mediaType,
        bytes,
        width: 400,
        height: 300,
        ...(name === undefined ? {} : { name }),
      }
    },
  }

  /** Register one disposer and return it unchanged. */
  const track = (disposer, owned) => {
    owned.push(disposer)
    return disposer
  }

  /** Build one context view bound to an optional owned-disposer list. */
  const makeContext = (services, owned) => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (...args) => warnings.push(args.map((value) => String(value)).join(' ')),
      error: (...args) => warnings.push(args.map((value) => String(value)).join(' ')),
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
        if (name === 'title') return undefined
        return services[name]
      },
      effect(execute) {
        let result
        try {
          result = execute()
        } catch (error) {
          throw error
        }
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          const promise = Promise.resolve(result).then((disposer) => {
            track(disposer, owned)
            state.topDisposers.push(disposer)
            return disposer
          })
          return { then: (resolve, reject) => promise.then(resolve, reject) }
        }
        if (typeof result === 'function') {
          track(result, owned)
          state.topDisposers.push(result)
          return { then: (resolve) => resolve(result) }
        }
        throw new TypeError('fake ctx.effect: body must return a disposer or a promise of one')
      },
      inject(dependencies, callback) {
        const available = dependencies.every((name) => services[name] !== undefined)
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
        const fiberOwned = []
        state.fibers.push(fiber)
        if (available) {
          const childServices = { ...services }
          const child = makeContext(childServices, fiberOwned)
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

  /** Stub system-prompt registry: records sections and disposes them like the real service. */
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

  const services = {
    tools: undefined,
    timer: undefined,
    webServer,
    attachments,
    systemPrompt,
  }
  const ctx = makeContext(services, [])
  // Required services in the real row are injected by the Loader; the fake
  // exposes them the same way `ctx.get()` would resolve them.
  services.tools = ctx.tools
  services.timer = ctx.timer
  ctx.tools = ctx.tools
  ctx.timer = ctx.timer

  /** Fire every registered interval once (manual worker tick). */
  async function fireTimers() {
    for (const entry of [...state.intervals]) entry.callback()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  /** Full teardown of everything the fake context owns. */
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

  return { ctx, state, webServer, attachments, fireTimers, disposeAll }
}

/**
 * Invoke the registered HTTP handler with a synthetic node:http request.
 * @param {Function} handler prefix route handler.
 * @param {object} request method/url/body.
 * @returns {Promise<{status:number, headers:object, body:Buffer}>} response facts.
 */
async function callHttp(handler, { method = 'GET', url = '/', body } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(body)]
  const req = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = {}
  const response = {
    status: 0,
    headers: {},
    chunks: [],
    headersSent: false,
    writableEnded: false,
  }
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  response.writeHead = (status, headers) => {
    response.status = status
    response.headers = headers ?? {}
    response.headersSent = true
  }
  response.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) response.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    response.writableEnded = true
    resolveDone()
  }
  response.destroy = () => {
    response.writableEnded = true
    resolveDone()
  }
  await handler(req, response)
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))])
  return { status: response.status, headers: response.headers, body: Buffer.concat(response.chunks) }
}

/** Main selftest. */
async function main() {
  const started = Date.now()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pappers-hall-selftest-'))
  const fake = createFakeContext()
  let service
  /** Fetch one registered tool definition for direct execute() calls. */
  const toolDefinition = (name) => {
    const definition = fake.state.tools.get(name)
    if (definition === undefined) throw new Error(`tool ${name} is not registered`)
    return definition
  }
  try {
    assert.ok(await fileExists(FIXTURE_PDF), `fixture PDF missing: ${FIXTURE_PDF}`)
    service = await applyHost(fake.ctx, {
      dataDir,
      // The selftest must never touch the public translation endpoints; force every
      // engine to fail so the fallback chain and honest reasons are deterministic.
      translationForcedFailures: ['tencent', 'google', 'mymemory', 'libretranslate', 'llm'],
      // Never spawn the real Python embedding worker inside the offline selftest;
      // the vector channel must degrade honestly.
      embeddingPython: '/nonexistent/pappers-hall/embedding/venv/bin/python',
      // Keep OCR deterministic even if the developer machine has it installed.
      ocrDir: '/nonexistent/pappers-hall/ocr',
      ocrPython: '/nonexistent/pappers-hall/ocr/venv/bin/python',
    })
    check('applyHost returned an active service', service.active === true && typeof service.dispose === 'function')
    check('database file created in dataDir', (await fileExists(service.dbPath)) === true, service.dbPath)
    const userVersion = service.domain.db.prepare('PRAGMA user_version').get()?.user_version
    const tableNames = service.domain.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    check('migration wrote user_version=8', Number(userVersion) === 8, userVersion)
    check(
      'v0.17 notes workbench tables exist',
      ['note_docs', 'note_folders', 'note_paper_links', 'note_revisions', 'note_embeddings'].every((table) => tableNames.includes(table)),
      tableNames.filter((name) => name.startsWith('note_')),
    )
    check(
      'v0.3 tables exist',
      ['operations', 'papers_journal', 'saved_searches'].every((table) => tableNames.includes(table)),
      tableNames.filter((name) => ['operations', 'papers_journal', 'saved_searches'].includes(name)),
    )
    check(
      'v0.4 translation tables exist',
      ['mt_cache', 'mt_events', 'embeddings'].every((table) => tableNames.includes(table)),
      tableNames.filter((name) => ['mt_cache', 'mt_events', 'embeddings'].includes(name)),
    )

    // ---- registrations ------------------------------------------------
    const toolNames = [...fake.state.tools.keys()].sort()
    const expectedTools = [
      'notes_edit',
      'notes_get',
      'notes_search',
      'papers_annotations',
      'papers_changes',
      'papers_get',
      'papers_get_figure',
      'papers_get_passage',
      'papers_pdf',
      'papers_list',
      'papers_manage',
      'papers_overview',
      'papers_references',
      'papers_search',
      'papers_translate',
    ].sort()
    check('15 consolidated papers_* + notes_* tools registered', JSON.stringify(toolNames) === JSON.stringify(expectedTools), toolNames)
    const agentDiagnostics = await service.api.call('diagnostics')
    check(
      'diagnostics.agent lists tools and promptSection',
      agentDiagnostics.agent?.tools?.length === 15 &&
        ['papers_search', 'papers_get', 'papers_get_passage', 'papers_list', 'papers_manage', 'papers_pdf', 'notes_search', 'notes_edit'].every((name) => agentDiagnostics.agent.tools.includes(name)) &&
        agentDiagnostics.agent.promptSection === true,
      agentDiagnostics.agent,
    )
    // Test-only compatibility aliases for the pre-consolidation direct tool
    // calls below. The public Agent surface is the 13 merged tools above; these
    // aliases keep the old behavioral assertions exercising the same facades.
    const callMerged = (name, args, exec) => fake.state.tools.get(name).execute(args, exec)
    const legacyAliases = {
      papers_import_file: (args, exec) => callMerged('papers_pdf', Object.assign({ action: args.confirm === true ? 'import' : 'inspect' }, args), exec),
      papers_get_annotations: (args, exec) => callMerged('papers_annotations', Object.assign({ action: 'list' }, args), exec),
      papers_annotate: (args, exec) => callMerged('papers_annotations', Object.assign({ action: 'create' }, args), exec),
      papers_abstracts: (args, exec) => callMerged('papers_search', Object.assign({ mode: 'abstracts' }, args), exec),
      papers_related: (args, exec) => callMerged('papers_search', Object.assign({ mode: 'related' }, args), exec),
      papers_folders: (args, exec) => callMerged('papers_manage', args, exec),
      papers_update: (args, exec) => callMerged('papers_manage', Object.assign({ action: 'update' }, args), exec),
      papers_folder_hints: (args, exec) => callMerged('papers_manage', Object.assign({ action: 'hints' }, args), exec),
      papers_cite: (args, exec) => callMerged('papers_get', Object.assign({ view: 'cite' }, args), exec),
      papers_get_outline: (args, exec) => callMerged('papers_get', Object.assign({ view: 'outline', paperId: args.paper_id }, args), exec),
      papers_propose_changes: (args, exec) => callMerged('papers_changes', Object.assign({ action: 'propose' }, args), exec),
      papers_apply_changes: (args, exec) => callMerged('papers_changes', Object.assign({ action: 'apply' }, args), exec),
      papers_index_status: async (args, exec) => (await callMerged('papers_overview', { include_status: true }, exec)).indexStatus,
      notes_list: (args, exec) => callMerged('notes_search', args, exec),
      notes_search: (args, exec) => callMerged('notes_search', args, exec),
      notes_create: (args, exec) => callMerged('notes_edit', Object.assign({ action: 'create' }, args), exec),
      notes_update: (args, exec) => callMerged('notes_edit', Object.assign({ action: 'update' }, args), exec),
      notes_link_papers: (args, exec) => callMerged('notes_edit', Object.assign({ action: args.action || 'link' }, args), exec),
    }
    for (const [name, execute] of Object.entries(legacyAliases)) {
      if (!fake.state.tools.has(name)) fake.state.tools.set(name, { name, execute })
    }

    check('web route registered under /pappers-hall/', fake.state.routes.has('/pappers-hall'))
    // The composed web server matches a prefix as `pathname === prefix` or
    // `pathname.startsWith(prefix + '/')`; reproduce that rule here so a
    // trailing-slash regression in ROUTE_PREFIX fails the selftest.
    const registeredPrefix = '/pappers-hall'
    const prefixMatches = (pathname) => pathname === registeredPrefix || pathname.startsWith(`${registeredPrefix}/`)
    check('registered prefix matches /pappers-hall/api', prefixMatches('/pappers-hall/api') && prefixMatches('/pappers-hall/page/x/1.png'))
    check('worker timer registered', fake.state.intervals.size === 1, fake.state.intervals.size)
    check('material-token system prompt section registered', service.promptRegistered === true && fake.state.promptSections.has('plugin:pappers-hall-materials'), [...fake.state.promptSections.keys()])
    check(
      'v0.6 management system prompt section registered',
      fake.state.promptSections.has('plugin:pappers-hall-management'),
      [...fake.state.promptSections.keys()],
    )
    const fencedTerms = extractQueryTerms('Sure! ```json\n{"terms":["crop model","reinforcement learning","workflow diagram"]}\n```')
    check('AI expansion parser handles fenced JSON', fencedTerms.source === 'model' && fencedTerms.terms.includes('crop model'), fencedTerms)
    const proseTerms = extractQueryTerms('The relevant terms are: crop model (作物模型), reinforcement learning, and "workflow"')
    check('AI expansion parser recovers terms from prose', proseTerms.source === 'model' && proseTerms.terms.some((term) => term.toLowerCase().includes('crop model')), proseTerms)
    const fallbackTerms = extractQueryTerms('这是一段中文解释，没有英文术语。', '把作物模型和强化学习连起来的流程图')
    check('AI expansion has a deterministic fallback', fallbackTerms.source === 'fallback' && fallbackTerms.terms.length >= 3, fallbackTerms)
    const promptText = fake.state.promptSections.get('plugin:pappers-hall-materials')?.text ?? ''
    check('system prompt explains reference chip scope', promptText.includes('reference chip') && promptText.includes('papers_references') && promptText.includes('reference_bundle'), promptText.slice(0, 120))

    // ---- status/diagnostics before import ------------------------------
    const status0 = await service.api.call('status')
    check('empty library status', status0.counts.papers === 0 && status0.counts.trash === 0, status0.counts)
    check('status reports vector unavailable', status0.index.channels.vector === 'unavailable')
    check('status lists honest degradations', Array.isArray(status0.degraded) && status0.degraded.some((entry) => entry.channel === 'vector'))
    const diagnostics = await service.api.call('diagnostics')
    check('diagnostics reports pdfText capability', diagnostics.capabilities.pdfText === 'ready', diagnostics.capabilities)
    check('diagnostics reports the material-token prompt section', diagnostics.prompt?.materialsSection === 'ready', diagnostics.prompt)
    check('diagnostics reports v0.2 features', diagnostics.features?.annotationsV2 === true && diagnostics.features?.readerBlocks === true && diagnostics.features?.readerLayer === true, diagnostics.features)
    check('diagnostics reports the text layer renderer', diagnostics.renderer?.textLayer === true, diagnostics.renderer)
    note(`poppler version: ${diagnostics.versions.find((entry) => entry.name === 'poppler')?.version}`)

    // ---- AI unavailable degradation (fake ctx has no llm/default model) ----
    const aiStatus = await service.api.call('ai.status')
    check('ai.status is honestly unavailable without an llm service', aiStatus.available === false && typeof aiStatus.reason === 'string', aiStatus)
    const aiAsk = await service.api.call('ai.ask', { prompt: 'What is the main contribution?', paperId: 'ph-000000000000' })
    check('ai.ask degrades without throwing', aiAsk.status === 'unavailable' && typeof aiAsk.reason === 'string', aiAsk)
    const aiComplete = await service.api.call('ai.complete', { prompt: 'Format this note as JSON.' })
    check('ai.complete degrades without throwing when no llm service is mounted', aiComplete.status === 'unavailable' && typeof aiComplete.reason === 'string', aiComplete)
    // v0.14: free engines now include Tencent Transmart, so "no AI" no longer
    // implies "no translation". Degradation is asserted deterministically by
    // turning every free engine off and asking for a quick (free-only) call.
    await service.api.call('settings.update', {
      patch: { translation: { providers: { tencent: false, google: false, mymemory: false, llm: true } } },
      operationId: 'selftest-quick-no-free',
    })
    const aiTranslateText = await service.api.call('translate.text', { text: 'hello world', target: 'zh', quick: true })
    check(
      'quick translate degrades honestly when every free engine is disabled',
      aiTranslateText.status === 'unavailable' && aiTranslateText.translation === null && aiTranslateText.suggestAi === true && typeof aiTranslateText.reason === 'string',
      aiTranslateText,
    )
    await service.api.call('settings.update', {
      patch: { translation: { providers: { tencent: true, google: true, mymemory: true, llm: true } } },
      operationId: 'selftest-quick-restore',
    })
    check('diagnostics ai block mirrors availability', diagnostics.ai?.available === false)

    // ---- import through the public API ---------------------------------
    const importStarted = Date.now()
    const imported = await service.api.call('library.import', { paths: [FIXTURE_PDF] })
    check('import accepted exactly one PDF', imported.accepted === 1, imported)
    check('import reported no errors', Array.isArray(imported.errors) && imported.errors.length === 0, imported.errors)
    check('import returned a job id', typeof imported.jobId === 'string' && imported.jobId.startsWith('jb-'))
    check(
      'import leaves classification to the Agent by default (no auto-folder)',
      imported.classification !== undefined &&
        imported.classification.status === 'skipped' &&
        /agent-driven/i.test(String(imported.classification.reason ?? '')),
      imported.classification,
    )
    const pendingList = await service.api.call('library.list', {})
    check('paper visible immediately while processing', pendingList.total === 1 && pendingList.items[0].processing.state === 'pending', pendingList.items[0]?.processing)

    // ---- background job driven by the injected timer --------------------
    await fake.fireTimers()
    await service.queue.drain()
    const job = service.queue.get(imported.jobId)
    check('import job succeeded', job?.state === 'succeeded', job)
    const paperId = imported.acceptedItems[0].paperId
    const detail = await service.api.call('library.get', { id: paperId })
    check('paper processing ready after job', detail.processing.state === 'ready', detail.processing)
    check('page count extracted', detail.pageCount === 33, detail.pageCount)
    check('manifest metadata merged', detail.title.includes('ReAct') && detail.year === 2023, { title: detail.title, year: detail.year })
    check('manifest Chinese title merged', typeof detail.titleZh === 'string' && detail.titleZh.includes('ReAct'), detail.titleZh)
    check('license from manifest', detail.license === 'CC-BY-4.0', detail.license)
    check('metadata diff recorded', Array.isArray(detail.metadataDiff) && detail.metadataDiff.length > 0, detail.metadataDiff)
    check('v0.2 paper structure state ready', detail.structureState === 'ready', detail.structureState)
    check('v0.2 fileInfo exposed', detail.fileInfo?.sha256?.length === 64 && detail.fileInfo.bytes > 0 && typeof detail.fileInfo.path === 'string', detail.fileInfo)
    check('v0.2 abstract extracted from PDF layout', typeof detail.abstract === 'string' && detail.abstract.length > 80 && detail.abstractSource === 'pdf', { source: detail.abstractSource, chars: detail.abstract?.length })
    check(
      'v0.6 paper detail has no derived read-only field collection',
      Array.isArray(detail.collections) && detail.collections.every((collection) => collection.kind !== 'field'),
      detail.collections,
    )
    check('v0.2 tags array always present', Array.isArray(detail.tags), detail.tags)
    check('v0.2 read flag present', typeof detail.read === 'boolean', detail.read)
    note(`import pipeline took ${Date.now() - importStarted}ms`)

    // ---- page text and rendering --------------------------------------
    const page2 = await service.api.call('reader.page', { id: paperId, page: 2 })
    check('page 2 text is non-empty', typeof page2.text === 'string' && page2.text.length > 100, page2.text?.length)
    check('page 2 has page geometry', page2.width > 0 && page2.height > 0, { width: page2.width, height: page2.height })
    const reader = await service.api.call('reader.open', { id: paperId, page: 2 })
    check('reader.open lists every page', reader.pages.length === 33, reader.pages.length)
    check('reader.open returns a table of contents', Array.isArray(reader.toc) && reader.toc.length > 0, reader.toc?.length)
    check('reader.open currentPage honoured', reader.currentPage === 2)
    check('reader.open returns version identity', reader.version?.sha256?.length === 64, reader.version)

    // ---- reader v0.2 structure / layer / outline ----------------------
    check('reader.page returns real blocks', Array.isArray(page2.blocks) && page2.blocks.length > 3, page2.blocks?.length)
    check('reader.page blocks carry role/bbox/lines', page2.blocks.every((block) => typeof block.role === 'string' && block.bbox && Number.isFinite(block.bbox.x) && Array.isArray(block.lines)), page2.blocks?.[0])
    check('reader.page block roles include body and caption', page2.blocks.some((block) => block.role === 'body') && page2.blocks.some((block) => block.role === 'caption'), [...new Set(page2.blocks.map((block) => block.role))])
    let headingPage = null
    for (let page = 2; page <= 10; page += 1) {
      const candidate = await service.api.call('reader.page', { id: paperId, page })
      if (Array.isArray(candidate.blocks) && candidate.blocks.some((block) => block.role === 'heading')) {
        headingPage = candidate
        break
      }
    }
    check('reader.page detects real heading blocks on body pages', headingPage !== null, headingPage?.page ?? null)
    const page1 = await service.api.call('reader.page', { id: paperId, page: 1 })
    const page1Lengths = (page1.blocks ?? []).map((block) => String(block.text ?? '').length).sort((left, right) => left - right)
    const page1Median = page1Lengths[Math.floor(page1Lengths.length / 2)] ?? 0
    check('reader.page page 1 is paragraph-level', page1.blocks.length >= 4 && page1Median >= 40, { blocks: page1.blocks.length, median: page1Median })
    check('reader.page block text has no control characters', page1.blocks.every((block) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(String(block.text ?? ''))))
    check('reader.page reports rendered pixel size', page2.widthPx === 1400 && page2.heightPx > 1000, { widthPx: page2.widthPx, heightPx: page2.heightPx })
    check('reader.page reports per-page annotation count', typeof page2.annotationCount === 'number', page2.annotationCount)
    check('reader.page structure ready', page2.structureState === 'ready', page2.structureState)
    const layer = await service.api.call('reader.layer', { id: paperId, page: 2 })
    check('reader.layer returns words and lines in PDF points', layer.words.length > 50 && layer.lines.length > 5, { words: layer.words.length, lines: layer.lines.length })
    check('reader.layer words are compact {t,x,y,w,h}', layer.words.every((word) => typeof word.t === 'string' && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(word[key]))), layer.words[0])
    check('reader.layer coordinates are 2-decimal at most', layer.words.slice(0, 50).every((word) => String(word.x).split('.')[1]?.length === undefined || String(word.x).split('.')[1].length <= 2))
    const outline = await service.api.call('reader.outline', { id: paperId })
    check('reader.outline returns heading items', Array.isArray(outline.items) && outline.items.length > 0 && outline.items[0].page >= 1, outline.items?.slice(0, 3))
    const pageText = await service.api.call('reader.pageText', { id: paperId, page: 2 })
    check('reader.pageText keeps v0.1 compatibility', pageText.page === 2 && pageText.text.length > 100)
    const cachedPageStarted = Date.now()
    await service.api.call('reader.page', { id: paperId, page: 2 })
    const cachedPageMs = Date.now() - cachedPageStarted
    check('cached reader.page responds under 150ms', cachedPageMs < 150, `${cachedPageMs}ms`)

    // ---- two-column reading order on a real two-column paper ----------
    const clipPdf = path.join(WORKSPACE, 'pappers_hall_devkit_lite', 'papers', 'pdf', 'V01_CLIP.pdf')
    if (await fileExists(clipPdf)) {
      const clipImport = await service.api.call('library.import', { paths: [clipPdf] })
      await service.queue.drain()
      const clipId = clipImport.acceptedItems[0]?.paperId
      let columnPage = null
      for (let page = 1; page <= Math.min(12, 20); page += 1) {
        const candidate = await service.api.call('reader.page', { id: clipId, page })
        if (candidate.columns === 2 && candidate.blocks.filter((block) => block.role === 'body').length > 4) {
          columnPage = candidate
          break
        }
      }
      check('two-column page detected on a real two-column paper', columnPage !== null, clipId)
      if (columnPage !== null) {
        // Body blocks must be ordered by (column, y): no left-column block after a
        // right-column block within the same band sequence.
        const bodyOrder = columnPage.blocks.filter((block) => block.role === 'body' || block.role === 'list' || block.role === 'heading')
        let lastColumn = -1
        let ordered = true
        for (const block of bodyOrder) {
          if (block.column < lastColumn) ordered = false
          lastColumn = Math.max(lastColumn, block.column)
        }
        check('two-column blocks follow reading order', ordered, bodyOrder.slice(0, 8).map((block) => `${block.column}:${Math.round(block.bbox.y)}`))
        check('two-column blocks carry column indexes', bodyOrder.every((block) => block.column === 0 || block.column === 1))
      }
      await service.api.call('library.purge', { ids: [clipId], operationId: 'selftest-purge-clip' })
      await service.queue.drain()
    } else {
      note('V01_CLIP.pdf fixture missing; two-column check skipped')
    }

    // ---- C05: Nature-style abstract fallback + two-column order ------
    const c05Pdf = path.join(WORKSPACE, 'pappers_hall_devkit_lite', 'papers', 'pdf', 'C05_climate_yield_variability.pdf')
    if (await fileExists(c05Pdf)) {
      const c05Import = await service.api.call('library.import', { paths: [c05Pdf] })
      await service.queue.drain()
      const c05Id = c05Import.acceptedItems[0]?.paperId
      const c05Detail = await service.api.call('library.get', { id: c05Id })
      const c05Abstract = String(c05Detail.abstract ?? '')
      check('abstract fallback fills a Nature-style paper', c05Abstract.length > 200, { chars: c05Abstract.length, source: c05Detail.abstractSource })
      check('abstract fallback is labelled pdf-heuristic', c05Detail.abstractSource === 'pdf-heuristic', c05Detail.abstractSource)
      let twoColumnOrdered = null
      for (let page = 2; page <= 10; page += 1) {
        const candidate = await service.api.call('reader.page', { id: c05Id, page })
        if ((candidate.columns ?? 1) < 2) continue
        const body = (candidate.blocks ?? []).filter((block) => block.role === 'body')
        if (body.length <= 4) continue
        let ordered = true
        let previous = null
        for (const block of body) {
          if (previous !== null) {
            if (block.column < previous.column) ordered = false
            if (block.column === previous.column && block.bbox.y + 1 < previous.y) ordered = false
          }
          previous = { column: block.column, y: block.bbox.y }
        }
        twoColumnOrdered = { page, ordered, blocks: body.length, columns: candidate.columns }
        if (ordered) break
      }
      check('two-column body blocks sorted by (column, y)', twoColumnOrdered !== null && twoColumnOrdered.ordered === true, twoColumnOrdered)

      // ---- Chinese long-question figure recall (v0.1 LIFE.09/12 regression) ----
      const figureQuestion =
        '第 4 页上下都有四幅世界地图。图 2 和图 3 分别在表达什么？图 2 图注里 1.0 的含义是不是产量提高了 100%？'
      const figureSearch = await service.api.call('figures.search', { q: figureQuestion, limit: 20, mode: 'text' })
      const auditedFigure = figureSearch.items.find(
        (item) =>
          (item.paper?.id ?? item.paperId) === c05Id &&
          Number(item.page ?? item.figure?.page) === 4 &&
          /figure\s*(2|3)/i.test(String(item.figure?.label ?? '')),
      )
      check(
        'Chinese figure question recalls the audited C05 p4 figures',
        auditedFigure !== undefined,
        figureSearch.items.slice(0, 5).map((item) => `${item.figure?.label ?? '?'}@p${item.page} ${item.paper?.title?.slice(0, 24)}`),
      )
      check(
        'figure search reports deterministic signal channel',
        figureSearch.channels.some((channel) => channel.name === 'figure_signals' && channel.status === 'ok'),
        figureSearch.channels.map((channel) => `${channel.name}:${channel.status}`),
      )
      check(
        'figure search keeps the image-embedding degradation honest',
        figureSearch.channels.some((channel) => channel.name === 'image_embedding' && channel.status === 'degraded'),
      )

      // ---- long-query regression: a full title must find its own paper ----
      const c05Title = 'Climate variation explains a third of global crop yield variability'
      const longQuery = await service.api.call('search.query', { q: c05Title, scope: 'papers', limit: 10 })
      check(
        'long title query keeps the exact paper in the top 3',
        longQuery.items.slice(0, 3).some((hit) => hit.paperId === c05Id),
        longQuery.items.slice(0, 4).map((hit) => `${hit.title.slice(0, 40)}`),
      )
      check('long title query ranks the exact paper first', longQuery.items[0]?.paperId === c05Id, longQuery.items[0]?.title)
      check('search.query returns a numeric total', typeof longQuery.total === 'number' && longQuery.total >= 1, longQuery.total)
      const shortQuery = await service.api.call('search.query', { q: 'crop yield variability', scope: 'papers', limit: 10 })
      check('short query still finds the paper in the top 3', shortQuery.items.slice(0, 3).some((hit) => hit.paperId === c05Id), shortQuery.items.slice(0, 3).map((hit) => hit.title.slice(0, 40)))
      const paginatedQuery = await service.api.call('search.query', { q: c05Title, scope: 'papers', limit: 1, offset: 1 })
      check('paginated search reports the full total', paginatedQuery.total >= 2 && paginatedQuery.items.length === 1, { total: paginatedQuery.total, items: paginatedQuery.items.length })
      await service.api.call('library.purge', { ids: [c05Id], operationId: 'selftest-purge-c05' })
      await service.queue.drain()
    } else {
      note('C05 fixture missing; Nature-style abstract fallback check skipped')
    }

    // ---- figures ------------------------------------------------------
    const figures = await service.api.call('figures.list', { paperId })
    check('at least one figure detected', figures.length >= 1, figures.length)
    const captionFigure = figures.find((figure) => /figure\s*1/i.test(`${figure.label ?? ''} ${figure.caption ?? ''}`))
    check('Figure 1 caption detected', captionFigure !== undefined, figures.map((figure) => figure.label))
    check('figure has rendered image url', typeof captionFigure?.imageUrl === 'string' && captionFigure.imageUrl.includes('/pappers-hall/figure/'))
    const figureFile = path.join(service.layout.figuresDir, service.domain.figureRow(captionFigure.id).file_name)
    check('figure PNG written to data dir', (await fileExists(figureFile)) === true, figureFile)
    const figureBytes = await readFile(figureFile)
    check('figure PNG is a real PNG', figureBytes.length > 1000 && figureBytes.readUInt32BE(0) === 0x89504e47, figureBytes.length)

    // ---- text search ---------------------------------------------------
    const searchResult = await service.api.call('search.query', { q: 'ReAct', scope: 'library' })
    check('search finds the paper for "ReAct"', searchResult.items.length > 0, searchResult.items.length)
    check('search hit belongs to the imported paper', searchResult.items.some((hit) => hit.paperId === paperId), searchResult.items[0])
    check('search reports FTS channel ok', searchResult.channels.some((channel) => channel.name === 'fts5' && channel.status === 'ok'), searchResult.channels)
    check('search reports AI channels as degraded when unavailable', searchResult.channels.some((channel) => channel.name === 'ai_expand' && channel.status === 'degraded') && searchResult.channels.some((channel) => channel.name === 'ai_rerank' && channel.status === 'degraded'), searchResult.channels.map((channel) => `${channel.name}:${channel.status}`))
    const searchAiOff = await service.api.call('search.query', { q: 'ReAct', ai: 'off' })
    check('search ai:"off" reports off channels', searchAiOff.channels.some((channel) => channel.name === 'ai_expand' && channel.status === 'off'), searchAiOff.channels.map((channel) => `${channel.name}:${channel.status}`))
    check('AI expansion never fabricates semantic reasons', searchResult.items.every((hit) => !hit.reasons.includes('ai_semantic_expansion')), searchResult.items.map((hit) => hit.reasons))
    const bodySearch = await service.api.call('search.query', { q: 'language model reasoning', scope: 'body' })
    check('body scope returns page-level hits', bodySearch.items.length > 0 && bodySearch.items[0].page >= 1, bodySearch.items[0])
    const annotation = await service.api.call('annotations.create', {
      paperId,
      page: 2,
      text: '开发测试批注：核对 ReAct 的推理与行动交替',
      quote: 'ReAct',
      origin: 'test_note',
    })
    check('annotation created', typeof annotation.annotation?.id === 'string')
    const annotationSearch = await service.api.call('search.query', { q: '推理与行动交替', scope: 'annotations' })
    check('CJK annotation searchable through LIKE channel', annotationSearch.items.length === 1, annotationSearch.items.length)
    check('annotation search hit carries page and reason', annotationSearch.items[0]?.page >= 1 && annotationSearch.items[0]?.reasons.includes('annotation_match'), annotationSearch.items[0])

    // ---- annotations v0.2 (kind/rects/comment) ------------------------
    const highlight = await service.api.call('annotations.create', {
      paperId,
      page: 2,
      kind: 'highlight',
      rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }, { x: 0.1, y: 0.23, w: 0.2, h: 0.02 }],
      quote: 'ReAct is a general paradigm',
      comment: '核心论点：推理与行动交替',
      color: 'green',
      origin: 'user_note',
      operationId: 'selftest-annotation-v2-1',
    })
    check('annotations v2 highlight created with normalized rects', highlight.annotation?.kind === 'highlight' && highlight.annotation.rects.length === 2 && highlight.annotation.comment.includes('核心论点'), highlight.annotation)
    check('annotations v2 keeps legacy rect/text fields', highlight.annotation.text === '核心论点：推理与行动交替' && highlight.annotation.rect === null, { text: highlight.annotation.text, rect: highlight.annotation.rect })
    const highlightAgain = await service.api.call('annotations.create', {
      paperId,
      page: 2,
      kind: 'highlight',
      rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
      quote: 'ReAct is a general paradigm',
      comment: '核心论点：推理与行动交替',
      color: 'green',
      origin: 'user_note',
      operationId: 'selftest-annotation-v2-1',
    })
    check('annotation operationId idempotent', highlightAgain.annotation.id === highlight.annotation.id)
    let rectError = null
    try {
      await service.api.call('annotations.create', { paperId, page: 2, kind: 'area', rects: [{ x: 1.4, y: 0, w: 0.2, h: 0.1 }], comment: 'bad rect' })
    } catch (error) {
      rectError = error
    }
    check('annotations v2 rejects out-of-range rects', rectError !== null, rectError?.code)
    const updatedHighlight = await service.api.call('annotations.update', { id: highlight.annotation.id, comment: '更新后的批注', color: 'blue', expectedRevision: 0 })
    check('annotations v2 update with expectedRevision', updatedHighlight.annotation.comment === '更新后的批注' && updatedHighlight.annotation.color === 'blue' && updatedHighlight.annotation.revision === 1, updatedHighlight.annotation)
    let conflictError = null
    try {
      await service.api.call('annotations.update', { id: highlight.annotation.id, comment: 'stale', expectedRevision: 0 })
    } catch (error) {
      conflictError = error
    }
    check('annotations v2 stale revision conflicts', conflictError !== null && conflictError.code === 'conflict', conflictError?.code)
    const highlightList = await service.api.call('annotations.list', { paperId, state: 'active' })
    check('annotations.list returns both v0.1 and v0.2 annotations', highlightList.length === 2 && highlightList.every((annotation) => typeof annotation.kind === 'string'), highlightList.map((annotation) => annotation.kind))
    const annotationSearchV2 = await service.api.call('search.query', { q: '更新后的批注', scope: 'annotations' })
    check('v0.2 annotation comment is searchable with rects', annotationSearchV2.items.length >= 1 && Array.isArray(annotationSearchV2.items[0].rects) && annotationSearchV2.items[0].rects.length === 2, annotationSearchV2.items[0])
    const annotationsTool = await toolDefinition('papers_get_annotations').execute({ paper_id: paperId })
    check('papers_get_annotations returns page/rects/comment', annotationsTool.annotations.length >= 2 && annotationsTool.annotations.every((annotation) => annotation.page >= 1 && Array.isArray(annotation.rects)), annotationsTool.annotations.length)
    const annotateTool = await toolDefinition('papers_annotate').execute({ paper_id: paperId, page: 2, kind: 'note', comment: 'Agent 标注：方法部分需要复核' })
    check('papers_annotate creates an ai_explanation annotation', annotateTool.annotation?.origin === 'ai_explanation', annotateTool.annotation?.origin)
    const deletedHighlight = await service.api.call('annotations.delete', { id: highlight.annotation.id, operationId: 'selftest-annotation-delete-1' })
    check('annotations v2 delete is a soft state change', deletedHighlight.ok === true && deletedHighlight.state === 'trash', deletedHighlight)
    const afterAnnotationDelete = await service.api.call('annotations.list', { paperId })
    check('deleted annotation leaves the active list', afterAnnotationDelete.every((annotation) => annotation.id !== highlight.annotation.id))
    const annotationSearchAfterDelete = await service.api.call('search.query', { q: '更新后的批注', scope: 'annotations' })
    check('deleted annotation leaves annotation search', annotationSearchAfterDelete.items.every((hit) => hit.id !== highlight.annotation.id))
    const createdNote = await service.api.call('notes.create', { paperId, text: '联合检索测试笔记：ReAct interleaves thought and action', sourceRefs: [{ kind: 'paper', id: paperId }], origin: 'user_note', title: '测试笔记', operationId: 'selftest-note-1' })
    const repeatedNote = await service.api.call('notes.create', { paperId, text: '联合检索测试笔记：ReAct interleaves thought and action', sourceRefs: [{ kind: 'paper', id: paperId }], origin: 'user_note', title: '测试笔记', operationId: 'selftest-note-1' })
    check('operationId idempotency returns the same note', createdNote.note.id === repeatedNote.note.id)
    const noteSearch = await service.api.call('search.query', { q: 'interleaves thought', scope: 'notes' })
    check('note indexed and searchable', noteSearch.items.length === 1 && noteSearch.items[0].id === createdNote.note.id, noteSearch.items)

    // ---- v0.17 notes workbench (note_docs / folders / revisions / links) ----
    // The legacy paper-note surface above must keep working; this block exercises
    // the new long-form notes API on the same temp database and always cleans up.
    const wbFolder = await service.api.call('notes.folders.create', { name: '阅读笔记', color: '#336699', operationId: 'selftest-wb-folder-1' })
    check('notes.folders.create returns nf- id', typeof wbFolder.folder?.id === 'string' && wbFolder.folder.id.startsWith('nf-'), wbFolder)
    const wbChild = await service.api.call('notes.folders.create', { name: '子夹', parentId: wbFolder.folder.id })
    const wbTree = await service.api.call('notes.folders.tree')
    const wbRoot = wbTree.folders.find((folder) => folder.id === wbFolder.folder.id)
    check('notes.folders.tree nests parent and child', wbRoot?.children?.some((folder) => folder.id === wbChild.folder.id) === true, wbTree.folders)
    const wbNote = await service.api.call('notes.create', {
      title: '阅读器笔记',
      content: 'ReAct 把推理与行动交替起来。\n\n- 关键点一\n- 关键点二',
      folderId: wbFolder.folder.id,
      paperIds: [paperId],
      operationId: 'selftest-wb-note-1',
    })
    const wbId = wbNote.note?.id
    check('notes.create returns note- id and preserves content_md', typeof wbId === 'string' && wbId.startsWith('note-') && wbNote.note.contentMd.includes('推理与行动'), wbNote.note)
    check('notes.create links paper and folder', wbNote.note.folderId === wbFolder.folder.id && wbNote.note.paperLinks?.[0]?.paperId === paperId, wbNote.note.paperLinks)
    const wbList = await service.api.call('notes.list', { folderId: wbFolder.folder.id })
    check('notes.list filters by folder subtree', wbList.total === 1 && wbList.items[0].id === wbId, wbList)
    const wbListByPaper = await service.api.call('notes.list', { paperId })
    check('notes.list filters by linked paper', wbListByPaper.total === 1 && wbListByPaper.items[0].id === wbId, wbListByPaper.total)
    const wbConflict = await service.api.call('notes.update', { id: wbId, patch: { title: '冲突' }, expectedRevision: 999 }).then(() => null, (error) => error)
    check('notes.update rejects a stale expectedRevision with conflict', wbConflict?.code === 'conflict' && (wbConflict?.meta?.currentRevision ?? wbConflict?.detail?.currentRevision) === wbNote.note.revision, wbConflict)
    const wbUpdate = await service.api.call('notes.update', {
      id: wbId,
      patch: { contentJson: { sections: [{ id: 's1', title: '核心思想', blocks: [{ type: 'paragraph', text: 'ReAct 交替推理与行动' }, { type: 'bullets', items: ['思考', '行动'] }] }] }, beautifiedRevision: wbNote.note.revision, formatVersion: 1 },
      expectedRevision: wbNote.note.revision,
    })
    check(
      'beautify writes only content_json (content_md untouched)',
      wbUpdate.note.contentMd === wbNote.note.contentMd && wbUpdate.note.contentJson?.sections?.[0]?.title === '核心思想' && wbUpdate.note.revision === wbNote.note.revision + 1,
      wbUpdate.note,
    )
    const wbJsonSearch = await service.api.call('notes.search', { q: '核心思想' })
    check('notes.search indexes content_json semantic text', wbJsonSearch.items.some((item) => item.noteId === wbId), wbJsonSearch.items.map((item) => item.noteId))
    const wbRevisions = await service.api.call('notes.revisions', { id: wbId })
    check('notes.revisions keeps pre-update snapshots', wbRevisions.items.length >= 2 && wbRevisions.items.every((item) => typeof item.revision === 'number'), wbRevisions.items)
    const wbRestored = await service.api.call('notes.restoreRevision', { id: wbId, revision: wbRevisions.items[wbRevisions.items.length - 1].revision })
    check('notes.restoreRevision restores content and increments revision', wbRestored.note.contentMd === wbNote.note.contentMd && wbRestored.note.revision > wbUpdate.note.revision, wbRestored.note.revision)
    const wbSearch = await service.api.call('notes.search', { q: '推理与行动' })
    check('notes.search finds the note (FTS/LIKE)', wbSearch.items.some((item) => item.noteId === wbId) && wbSearch.channels.like > 0, wbSearch.channels)
    const wbSearchPaper = await service.api.call('notes.search', { q: 'ReAct', paperId })
    check('notes.search applies the paper filter', wbSearchPaper.items.every((item) => item.paperIds.includes(paperId)), wbSearchPaper.items)
    const wbLink = await service.api.call('notes.link', { noteId: wbId, paperIds: [paperId], anchor: { page: 3 } })
    check('notes.link is idempotent enough to keep one row per paper', wbLink.note.paperLinks.filter((link) => link.paperId === paperId).length === 1, wbLink.note.paperLinks)
    const wbUnlink = await service.api.call('notes.unlink', { noteId: wbId, paperIds: [paperId] })
    check('notes.unlink removes the paper link', wbUnlink.note.paperIds.length === 0, wbUnlink.note.paperIds)
    const wbExport = await service.api.call('notes.export', { ids: [wbId], format: 'both' })
    check('notes.export returns markdown and json', wbExport.items?.[0]?.content?.includes('阅读器笔记') === true && typeof wbExport.json === 'string' && wbExport.json.includes('contentMd'), wbExport.format)
    const wbFolderDelete = await service.api.call('notes.folders.delete', { id: wbChild.folder.id })
    check('notes.folders.delete moves children/notes up instead of deleting notes', wbFolderDelete.movedNotes >= 0 && (await service.api.call('notes.get', { id: wbId })).note.folderId === wbFolder.folder.id, wbFolderDelete)
    const wbTrash = await service.api.call('notes.delete', { ids: [wbId], operationId: 'selftest-wb-trash-1' })
    check('notes.delete soft-deletes into the recycle bin', wbTrash.trashed === true && (await service.api.call('notes.get', { id: wbId })).note.state === 'trash')
    const wbListAfterTrash = await service.api.call('notes.list', { folderId: wbFolder.folder.id })
    check('trashed notes leave notes.list', wbListAfterTrash.total === 0, wbListAfterTrash.total)
    const wbSearchAfterTrash = await service.api.call('notes.search', { q: '推理与行动' })
    check('trashed notes leave notes.search', wbSearchAfterTrash.items.every((item) => item.noteId !== wbId), wbSearchAfterTrash.items.map((item) => item.noteId))
    await service.api.call('notes.restore', { ids: [wbId], operationId: 'selftest-wb-restore-1' })
    check('notes.restore returns the note to active', (await service.api.call('notes.get', { id: wbId })).note.state === 'active')
    const wbUpdateUndo = await service.api.call('notes.update', { id: wbId, patch: { title: '临时标题' } })
    const wbUndo = await service.api.call('operations.undo', { operationId: wbUpdateUndo.operationId })
    check('operations.undo restores the previous note title', wbUndo.status === 'undone' && (await service.api.call('notes.get', { id: wbId })).note.title === wbNote.note.title, wbUndo.status)
    await service.api.call('notes.delete', { ids: [wbId] })
    const wbPurge = await service.api.call('notes.purge', { ids: [wbId], operationId: 'selftest-wb-purge-1' })
    check('notes.purge permanently deletes only after an explicit call', wbPurge.purged === 1 && (await service.api.call('notes.get', { id: wbId }).then(() => null, (error) => error))?.code === 'not_found')
    await service.api.call('notes.folders.delete', { id: wbFolder.folder.id })
    const wbStatus = await service.api.call('status')
    check('status counts the notes workbench separately from legacy notes', wbStatus.counts.noteDocs === 0 && wbStatus.counts.noteTrash === 0 && wbStatus.counts.noteFolders === 0, wbStatus.counts)


    // ---- collections & tags (Zotero-style management) -----------------
    const collectionsInitial = await service.api.call('library.collections.list')
    check(
      'v0.6 collections list has no read-only field rows',
      collectionsInitial.items.every((collection) => collection.kind !== 'field'),
      collectionsInitial.items,
    )
    const customCollection = await service.api.call('library.collections.create', { name: '精读清单', color: 'blue', operationId: 'selftest-collection-1' })
    check('custom collection created', customCollection.collection?.kind === 'custom' && customCollection.collection.name === '精读清单')
    const assigned = await service.api.call('library.collections.assign', { collectionId: customCollection.collection.id, paperIds: [paperId], add: true })
    check('collection assignment works', assigned.results[0]?.ok === true)
    const collectionsAfterAssign = await service.api.call('library.collections.list')
    check('collection count updates', collectionsAfterAssign.items.find((collection) => collection.id === customCollection.collection.id)?.count === 1, collectionsAfterAssign.items)
    const listByCollection = await service.api.call('library.list', { collectionId: customCollection.collection.id })
    check('library.list filters by collectionId', listByCollection.total === 1 && listByCollection.items[0].id === paperId, listByCollection.total)
    const renamedCollection = await service.api.call('library.collections.update', { id: customCollection.collection.id, name: '重点论文', order: 3 })
    check('collection rename/order works', renamedCollection.collection.name === '重点论文' && renamedCollection.collection.order === 3, renamedCollection.collection)

    const tagsInitial = await service.api.call('library.update', { id: paperId, patch: { addTags: ['精读', 'Agent'] } })
    check('library.update addTags works', tagsInitial.paper.tags.includes('精读') && tagsInitial.paper.tags.includes('Agent'), tagsInitial.paper.tags)
    const tagsList = await service.api.call('tags.list')
    check('tags.list reports usage counts', tagsList.items.some((tag) => tag.name === '精读' && tag.count === 1), tagsList.items)
    const listByTag = await service.api.call('library.list', { tag: '精读' })
    check('library.list filters by tag', listByTag.total === 1 && listByTag.items[0].tags.includes('精读'), listByTag.total)
    const listByTagsAnd = await service.api.call('library.list', { tags: ['精读', 'Agent'] })
    check('library.list multi-tag filter is AND', listByTagsAnd.total === 1, listByTagsAnd.total)
    const renamedTag = await service.api.call('tags.rename', { from: 'Agent', to: '智能体' })
    check('tags.rename moves the tag', renamedTag.renamed === 1 && (await service.api.call('tags.list')).items.some((tag) => tag.name === '智能体'))
    const listByAuthorsSort = await service.api.call('library.list', { sort: 'authors' })
    check('library.list sort=authors works', listByAuthorsSort.total === 1)
    const listByYearSort = await service.api.call('library.list', { sort: 'year' })
    check('library.list sort=year works', listByYearSort.total === 1)
    const removedTags = await service.api.call('library.update', { id: paperId, patch: { removeTags: ['精读'] } })
    check('library.update removeTags works', removedTags.paper.tags.includes('智能体') && !removedTags.paper.tags.includes('精读'), removedTags.paper.tags)
    const deletedTag = await service.api.call('tags.delete', { name: '智能体' })
    check('tags.delete removes the tag', deletedTag.ok === true)
    const setRead = await service.api.call('library.setRead', { id: paperId, read: true })
    check('library.setRead v0.2 single-paper signature', setRead.ok === true && setRead.read === true, setRead)
    const deletedCollection = await service.api.call('library.collections.delete', { id: customCollection.collection.id })
    check('custom collection deleted', deletedCollection.ok === true)
    const listAfterCollectionDelete = await service.api.call('library.list', { collectionId: customCollection.collection.id }).catch((error) => error)
    check('deleted collection id no longer resolves', listAfterCollectionDelete instanceof Error === true, listAfterCollectionDelete?.code)

    // ---- figures.search -------------------------------------------------
    const figureSearch = await service.api.call('figures.search', { q: 'prompting methods' })
    check('figure caption search returns Figure 1', figureSearch.items.some((item) => item.figure.id === captionFigure.id), figureSearch.items.map((item) => item.figure.id))
    const similarSearch = await service.api.call('figures.search', { figureId: captionFigure.id, mode: 'similar' })
    check(
      'figures.search figureId runs the dHash near-duplicate channel',
      similarSearch.channels.some((channel) => channel.name === 'visual_near_duplicate' && channel.status === 'ok'),
      similarSearch.channels,
    )
    check('figures.search figureId never returns the source figure itself', similarSearch.items.every((item) => item.figure.id !== captionFigure.id), similarSearch.items.length)
    const imageSearch = await service.api.call('figures.search', { imageBase64: figureBytes.toString('base64'), mode: 'image' })
    check('dHash screenshot search finds the same figure', imageSearch.items.some((item) => item.figure.id === captionFigure.id), imageSearch.items.length)
    check('figure search states image embedding degradation', figureSearch.channels.some((channel) => channel.name === 'image_embedding' && channel.status === 'degraded'))

    // ---- HTTP API + assets ---------------------------------------------
    const httpStatus = await callHttp(service.handler, {
      method: 'POST',
      url: '/pappers-hall/api',
      body: JSON.stringify({ method: 'status', params: {} }),
    })
    const httpPayload = JSON.parse(httpStatus.body.toString('utf8'))
    check('HTTP POST /pappers-hall/api returns ok envelope', httpStatus.status === 200 && httpPayload.ok === true, httpStatus.status)
    const httpPage = await callHttp(service.handler, { method: 'GET', url: `/pappers-hall/page/${paperId}/2.png?width=640` })
    check('page image route returns PNG', httpPage.status === 200 && httpPage.headers['content-type'] === 'image/png' && httpPage.body.readUInt32BE(0) === 0x89504e47, httpPage.status)
    const httpFigure = await callHttp(service.handler, { method: 'GET', url: `/pappers-hall/figure/${captionFigure.id}.png?width=320` })
    check('figure image route returns PNG', httpFigure.status === 200 && httpFigure.body.readUInt32BE(0) === 0x89504e47, httpFigure.status)
    const httpThumb = await callHttp(service.handler, { method: 'GET', url: `/pappers-hall/thumb/${paperId}.png` })
    check('thumbnail route returns PNG', httpThumb.status === 200 && httpThumb.body.readUInt32BE(0) === 0x89504e47, httpThumb.status)
    const httpPdf = await callHttp(service.handler, { method: 'GET', url: `/pappers-hall/pdf/${paperId}` })
    check('PDF route returns original bytes', httpPdf.status === 200 && httpPdf.body.subarray(0, 5).toString('latin1') === '%PDF-', httpPdf.status)
    const httpUnknown = await callHttp(service.handler, { method: 'POST', url: '/pappers-hall/api', body: JSON.stringify({ method: 'no.such.method', params: {} }) })
    check('unknown API method maps to a 400 envelope', httpUnknown.status === 400 && JSON.parse(httpUnknown.body.toString('utf8')).ok === false)
    const traversal = await callHttp(service.handler, { method: 'GET', url: '/pappers-hall/pdf/..%2F..%2Fetc%2Fpasswd' })
    check('path traversal attempt rejected', traversal.status === 400 || traversal.status === 404, traversal.status)

    // ---- Agent tools ----------------------------------------------------
    const tools = fake.state.tools
    const searchToolValue = await tools.get('papers_search').execute({ query: 'ReAct', scope: 'library', limit: 5 })
    check('papers_search returns hits', Array.isArray(searchToolValue.items) && searchToolValue.items.length > 0)
    const passageToolValue = await tools.get('papers_get_passage').execute({ paper_id: paperId, page: 2 })
    check('papers_get_passage returns full text', passageToolValue.depth === 'fulltext' && passageToolValue.text.length > 100)
    const figureToolValue = await tools.get('papers_get_figure').execute({ figure_id: captionFigure.id }, { agent: undefined })
    check('papers_get_figure saves an image attachment', figureToolValue.image?.status === 'ready' && figureToolValue.imageAttachmentRef !== undefined)
    const figureBlocks = tools.get('papers_get_figure').output.render({ figure_id: captionFigure.id }, figureToolValue)
    check('papers_get_figure render returns a real ImageBlock', figureBlocks.some((block) => block.type === 'image' && block.attachment !== undefined), figureBlocks.map((block) => block.type))
    const indexStatus = await tools.get('papers_index_status').execute({})
    check('papers_index_status reports counts', indexStatus.counts.papers === 1)
    const cite = await tools.get('papers_cite').execute({ paper_ids: [paperId], style: 'apa' })
    check('papers_cite formats a citation', cite.citations.length === 1 && cite.citations[0].text.includes('ReAct'))
    const translated = await tools.get('papers_translate').execute({ text: 'hello world', target: 'zh' })
    // v0.14: Tencent Transmart is a free engine available without a DSH translator,
    // so success through a real free engine (never llm) or an honest degradation are
    // both valid; what must never happen is a fabricated translation.
    check(
      'papers_translate uses a real free engine or degrades honestly',
      (translated.status === 'translated' && typeof translated.translation === 'string' && translated.provenance?.engine !== 'llm') ||
        (translated.status === 'unavailable' && (typeof translated.reason === 'string' || typeof translated.provenance?.reason === 'string')),
      translated,
    )
    const proposed = await tools.get('papers_propose_changes').execute({
      operations: [{ op: 'set_title_zh', paper_id: paperId, title_zh: 'ReAct：协同推理与行动' }],
    })
    check('papers_propose_changes registers a proposal', proposed.operations[0].ok === true, proposed)
    const applied = await tools.get('papers_apply_changes').execute({ proposal_id: proposed.proposal_id, operation_id: 'selftest-apply-1' })
    check('papers_apply_changes applies the title change', applied.results[0].ok === true, applied)
    const appliedAgain = await tools.get('papers_apply_changes').execute({ proposal_id: proposed.proposal_id, operation_id: 'selftest-apply-1' })
    check('papers_apply_changes is idempotent', appliedAgain.undo_token === applied.undo_token, appliedAgain)

    // ---- reference bundle + tool scope ----------------------------------
    const bundle = await service.api.call('references.commit', {
      sessionId: 'selftest-session',
      items: [{ kind: 'paper', id: paperId }, { kind: 'figure', id: captionFigure.id }],
      operationId: 'selftest-bundle-1',
    })
    check('references.commit creates an immutable bundle', typeof bundle.bundleId === 'string' && bundle.materials.length === 2)
    check(
      'bundle token carries no protocol id',
      typeof bundle.token === 'string' && !/bn-/.test(bundle.token) && bundle.token.length <= 60,
      bundle.token,
    )
    check('bundle token mentions material counts', bundle.token.includes('篇论文') && bundle.token.includes('张图'), bundle.token)
    const resolvedBundle = await service.api.call('references.resolve', { bundleId: bundle.bundleId, sessionId: 'selftest-session' })
    check('references.resolve validates both materials', resolvedBundle.valid.length === 2 && resolvedBundle.invalid.length === 0)
    const latest = await tools.get('papers_references').execute({})
    check('papers_references resolves the session bundle', latest.status === 'ok' && latest.bundle_id === bundle.bundleId && latest.count === 2, latest.bundle_id)
    const bundleScoped = await tools.get('papers_search').execute({ query: 'ReAct', scope: 'reference_bundle', bundle_id: latest.bundle_id })
    check('bundle-scoped search accepts the resolved bundle id', bundleScoped.items.length > 0 && bundleScoped.bundle?.id === bundle.bundleId, bundleScoped.bundle)
    check('bundle-scoped search only returns bundled materials', bundleScoped.items.every((hit) => hit.paperId === paperId || hit.id === paperId), bundleScoped.items)
    const missingBundle = await tools.get('papers_search').execute({ query: 'ReAct', scope: 'reference_bundle', bundle_id: 'bn-000000000000' })
    check('unknown bundle token returns unavailable', missingBundle.status === 'unavailable', missingBundle.status)

    // ---- lazy structure generation for v0.1 libraries ------------------
    service.domain.db.prepare("UPDATE paper_pages SET layout_json = NULL, structure_state = 'pending', block_count = 0, word_count = 0 WHERE paper_id = ?").run(paperId)
    service.domain.db.prepare("UPDATE papers SET structure_state = 'pending' WHERE id = ?").run(paperId)
    const pendingPage = await service.api.call('reader.page', { id: paperId, page: 2 })
    check('legacy page reports structureState pending', pendingPage.structureState === 'pending' && Array.isArray(pendingPage.blocks) && pendingPage.blocks.length === 0, pendingPage.structureState)
    check('lazy structure job was scheduled with an id', typeof pendingPage.jobId === 'string' && pendingPage.jobId.startsWith('jb-'), pendingPage.jobId)
    const pendingAgain = await service.api.call('reader.page', { id: paperId, page: 2 })
    check('repeated reader.page reuses the running structure job', pendingAgain.jobId === pendingPage.jobId, { first: pendingPage.jobId, second: pendingAgain.jobId })
    await service.queue.drain()
    const regeneratedPage = await service.api.call('reader.page', { id: paperId, page: 2 })
    check('lazy structure job filled real blocks', regeneratedPage.structureState === 'ready' && regeneratedPage.blocks.length > 3, { state: regeneratedPage.structureState, blocks: regeneratedPage.blocks.length })
    const regeneratedLayer = await service.api.call('reader.layer', { id: paperId, page: 2 })
    check('lazy structure job filled the word layer', regeneratedLayer.words.length > 50, regeneratedLayer.words.length)

    // ---- AI translate/ask degradation with a real page ------------------
    const translateBlocks = await service.api.call('translate.blocks', { paperId, page: 2, target: 'zh' })
    check('translate.blocks degrades per block with a reason', translateBlocks.blocks.length > 0 && translateBlocks.blocks.every((block) => block.status === 'unavailable' && block.translation === null && typeof block.reason === 'string'), translateBlocks.blocks?.slice(0, 2))
    check('translate.blocks reports provenance and a reason', typeof translateBlocks.provenance?.promptVersion === 'string' && typeof translateBlocks.reason === 'string', translateBlocks.provenance)
    const translateTitleUnavailable = await service.api.call('translate.title', { ids: [paperId] })
    check('translate.title keeps an existing metadata title', translateTitleUnavailable.results[0]?.status === 'from_metadata' && translateTitleUnavailable.results[0]?.titleZh.includes('ReAct'), translateTitleUnavailable.results[0])
    const askWithImage = await service.api.call('ai.ask', { paperId, page: 2, prompt: '总结这一页', includeImage: true })
    check('ai.ask includeImage degrades without an llm service', askWithImage.status === 'unavailable' && typeof askWithImage.reason === 'string', askWithImage)

    // ---- delete / restore lifecycle -------------------------------------
    const beforeDelete = await service.api.call('library.get', { id: paperId })
    const deletion = await service.api.call('library.delete', { ids: [paperId], operationId: 'selftest-delete-1' })
    check('delete moves the paper to trash', deletion.results[0].state === 'trash' && deletion.trashCount === 1)
    const listAfterDelete = await service.api.call('library.list', {})
    check('trashed paper leaves the active list', listAfterDelete.total === 0, listAfterDelete.total)
    const searchAfterDelete = await service.api.call('search.query', { q: 'ReAct', scope: 'library' })
    check('trashed paper is excluded from search immediately', searchAfterDelete.items.length === 0, searchAfterDelete.items)
    const trashedDetail = await service.api.call('library.get', { id: paperId })
    check('trashed paper reports state=trash', trashedDetail.state === 'trash' && trashedDetail.epoch > beforeDelete.epoch, { state: trashedDetail.state, epoch: trashedDetail.epoch })
    const toolAfterDelete = await tools.get('papers_get_passage').execute({ paper_id: paperId })
    check('tools refuse trashed sources', toolAfterDelete.status === 'unavailable', toolAfterDelete)

    const restoration = await service.api.call('library.restore', { ids: [paperId], operationId: 'selftest-restore-1' })
    check('restore returns a new lifecycle epoch', restoration.results[0].ok === true && restoration.epoch > trashedDetail.epoch, restoration)
    const restoredDetail = await service.api.call('library.get', { id: paperId })
    check('restored paper is active with a fresh epoch', restoredDetail.state === 'active' && restoredDetail.epoch === restoration.epoch)
    const searchAfterRestore = await service.api.call('search.query', { q: 'ReAct', scope: 'library' })
    check('restored paper is searchable again', searchAfterRestore.items.some((hit) => hit.paperId === paperId), searchAfterRestore.items.length)
    const pageAfterRestore = await service.api.call('reader.page', { id: paperId, page: 2 })
    check('restored paper keeps its extracted pages', pageAfterRestore.text.length > 100)

    // ---- upload path + duplicate detection ------------------------------
    const fixtureBytes = await readFile(FIXTURE_PDF)
    const uploadImport = await service.api.call('library.import', {
      uploads: [{ name: 'A01_react.pdf', base64: fixtureBytes.toString('base64') }],
    })
    check('upload import accepts base64 bytes', uploadImport.accepted === 0 && Array.isArray(uploadImport.errors) && uploadImport.errors.length === 0, uploadImport)
    check('upload import deduplicates identical bytes', uploadImport.duplicates.length === 1 && uploadImport.duplicates[0].reason === 'same_file', uploadImport.duplicates)
    await service.queue.drain()
    const badUpload = await service.api.call('library.import', { uploads: [{ name: 'not-a-pdf.pdf', base64: Buffer.from('hello').toString('base64') }] })
    check('non-PDF upload is rejected with invalid_pdf', badUpload.errors.length === 1 && badUpload.errors[0].code === 'invalid_pdf', badUpload.errors)

    // ---- pagination / sorting / filters ---------------------------------
    const bibtexPath = path.join(dataDir, 'selftest-bibliography.bib')
    await writeFile(
      bibtexPath,
      `@article{selftest2024,\n  title = {A Selftest Paper About Retrieval},\n  author = {Doe, Jane and Roe, Richard},\n  year = {2024},\n  journal = {Journal of Selftests},\n  doi = {10.9999/selftest.2024.1}\n}\n`,
      'utf8',
    )
    const bibImport = await service.api.call('library.import', { paths: [bibtexPath], format: 'bibtex' })
    check('bibliography import accepted one record', bibImport.accepted === 1 && bibImport.errors.length === 0, bibImport)
    await service.queue.drain()
    const list = await service.api.call('library.list', { sort: 'title', limit: 10 })
    check('library.list pagination envelope', Array.isArray(list.items) && list.total === 2 && list.limit === 10 && list.offset === 0, list.total)
    const filtered = await service.api.call('library.list', { query: 'Selftest Paper' })
    check('library.list text filter works', filtered.items.length === 1 && filtered.items[0].year === 2024, filtered.total)
    const exports = await service.api.call('export.bibtex', { ids: [paperId] })
    check('export.bibtex produces an entry', exports.content.includes('@article') && exports.filename.endsWith('.bib'))
    const csl = await service.api.call('export.csl', { ids: [paperId] })
    check('export.csl produces valid JSON', JSON.parse(csl.content)[0].title.includes('ReAct'))
    const locations = await service.api.call('export.locations', { ids: [paperId] })
    check('export.locations includes annotation anchors with v0.2 rects', JSON.parse(locations.content)[0].locations.length >= 1 && Array.isArray(JSON.parse(locations.content)[0].locations[0].rects), JSON.parse(locations.content)[0].locations.length)
    const notesExport = await service.api.call('export.notes', { ids: [paperId] })
    check('export.notes renders markdown', notesExport.content.includes('测试笔记'))
    // ---- v0.3 journal metrics -----------------------------------------
    const manualMetrics = await service.api.call('metrics.update', {
      paperId,
      fields: { impactFactor: 12.5, impactFactorYear: 2024, quartile: 'Q1', citationCount: 321, keywords: ['强化学习', 'Agent'] },
    })
    check(
      'metrics.update writes manual journal metrics',
      manualMetrics.metrics.impactFactor === 12.5 && manualMetrics.metrics.impactFactorYear === 2024 && manualMetrics.metrics.quartile === 'Q1',
      manualMetrics.metrics,
    )
    check('metrics.update writes citationCount and source=manual', manualMetrics.metrics.citationCount === 321 && manualMetrics.metrics.source === 'manual', manualMetrics.metrics)
    check('metrics.update writes keywords', manualMetrics.paper.keywords.includes('强化学习') && manualMetrics.paper.keywords.includes('Agent'), manualMetrics.paper.keywords)
    check('library.get exposes citationKey and metrics', typeof manualMetrics.paper.citationKey === 'string' && manualMetrics.paper.metrics.canRefresh === false, { key: manualMetrics.paper.citationKey, canRefresh: manualMetrics.paper.metrics.canRefresh })
    const offlineRefresh = await service.api.call('metrics.refresh', { paperIds: [paperId] })
    check(
      'metrics.refresh refuses network unless explicitly allowed',
      offlineRefresh.network === false && offlineRefresh.results[0].status === 'unavailable' && /allowNetwork/.test(offlineRefresh.results[0].reason),
      offlineRefresh.results[0],
    )
    const noDoiRefresh = await service.api.call('metrics.refresh', { paperIds: [paperId], allowNetwork: true })
    check('metrics.refresh reports no-doi without inventing values', noDoiRefresh.results[0].status === 'failed' && noDoiRefresh.results[0].reason === 'no-doi', noDoiRefresh.results[0])
    const metricsAfterRefresh = await service.api.call('library.get', { id: paperId })
    check('failed refresh does not overwrite manual impact factor', metricsAfterRefresh.metrics.impactFactor === 12.5, metricsAfterRefresh.metrics)
    check('OpenAlex 2yr mean citedness never becomes impactFactor', metricsAfterRefresh.metrics.twoYearMeanCitedness === null || metricsAfterRefresh.metrics.twoYearMeanCitedness !== metricsAfterRefresh.metrics.impactFactor)
    const metricsReset = await service.api.call('metrics.reset', { paperId })
    check(
      'metrics.reset clears manual fields and source',
      metricsReset.metrics.impactFactor === null && metricsReset.metrics.citationCount === null && metricsReset.metrics.source === null,
      metricsReset.metrics,
    )
    const reAppliedMetrics = await service.api.call('metrics.update', {
      paperId,
      fields: { impactFactor: 12.5, impactFactorYear: 2024, quartile: 'Q1', citationCount: 321 },
    })
    check('metrics.update still works after reset', reAppliedMetrics.metrics.impactFactor === 12.5 && reAppliedMetrics.metrics.source === 'manual')

    // ---- v0.3 citations / annotation export ----------------------------
    const bibCitation = await service.api.call('citation.format', { ids: [paperId, list.items.find((item) => item.id !== paperId).id], style: 'bibtex' })
    check('citation.format bibtex covers both papers', bibCitation.count === 2 && bibCitation.content.includes('@article') && bibCitation.content.includes(' and '), bibCitation.count)
    for (const style of ['apa', 'gbt7714', 'ris', 'csljson']) {
      const formatted = await service.api.call('citation.format', { ids: [paperId], style })
      check(`citation.format ${style} produces content`, typeof formatted.content === 'string' && formatted.content.includes('ReAct'), style)
    }
    const keys = await service.api.call('citation.key', { ids: [paperId] })
    check('citation.key returns a readable author-year key', /^[a-z]+\d{4}/.test(keys.keys[0].key) && keys.keys[0].source === 'authoryear', keys.keys[0])
    const annotationMarkdown = await service.api.call('export.annotations', { paperId, format: 'markdown' })
    check('export.annotations markdown includes page and text', annotationMarkdown.count >= 1 && annotationMarkdown.content.includes('第 2 页'), annotationMarkdown.content.slice(0, 80))
    const annotationJson = await service.api.call('export.annotations', { paperId, format: 'json' })
    check('export.annotations json is parseable', JSON.parse(annotationJson.content).annotations.length === annotationMarkdown.count)

    // ---- v0.3 reading list filter / sorting ----------------------------
    await service.api.call('library.setRead', { id: paperId, read: false })
    await service.api.call('library.update', { id: paperId, patch: { readingProgress: 40 } })
    const reading = await service.api.call('library.list', { reading: 'reading' })
    check('library.list reading=reading filters in-progress papers', reading.items.some((item) => item.id === paperId), reading.total)
    const toRead = await service.api.call('library.list', { reading: 'to-read' })
    check('library.list reading=to-read excludes in-progress paper', toRead.items.every((item) => item.id !== paperId), toRead.total)
    await service.api.call('library.update', { id: paperId, patch: { readingProgress: 100 } })
    const readList = await service.api.call('library.list', { reading: 'read' })
    check('library.list reading=read includes finished paper', readList.items.some((item) => item.id === paperId), readList.total)
    const citationSort = await service.api.call('library.list', { sort: 'citations' })
    check('library.list sort=citations puts the cited paper first', citationSort.items[0]?.id === paperId, citationSort.items.map((item) => `${item.id}:${item.citationCount ?? 'null'}`))
    const ifSort = await service.api.call('library.list', { sort: 'impactFactor' })
    check('library.list sort=impactFactor puts measured journal first', ifSort.items[0]?.id === paperId, ifSort.items.map((item) => item.title.slice(0, 20)))

    // ---- v0.3 citation list/detail consistency -------------------------
    const bibPaperId = list.items.find((item) => item.id !== paperId).id
    service.domain.db
      .prepare('UPDATE papers SET citation_count = NULL, metrics_json = ? WHERE id = ?')
      .run(JSON.stringify({ citedByCount: 999, source: 'openalex', updatedAt: new Date().toISOString() }), bibPaperId)
    const autoDetail = await service.api.call('library.get', { id: bibPaperId })
    const autoSort = await service.api.call('library.list', { sort: 'citations', limit: 3 })
    check(
      'detail citationCount falls back to automatic metrics when the column is null',
      autoDetail.metrics.citationCount === 999,
      autoDetail.metrics.citationCount,
    )
    check(
      'sort=citations uses the same automatic value as the detail',
      autoSort.items[0]?.id === bibPaperId && autoSort.items[0]?.citationCount === 999,
      autoSort.items.map((item) => `${item.id}:${item.citationCount ?? 'null'}`),
    )
    const resetAuto = await service.api.call('metrics.reset', { paperId: bibPaperId })
    check(
      'metrics.reset restores the automatic citationCount from paper metrics_json',
      resetAuto.metrics.citationCount === 999 && resetAuto.metrics.source === 'openalex',
      resetAuto.metrics,
    )
    const sortAfterReset = await service.api.call('library.list', { sort: 'citations', limit: 3 })
    check('reset keeps list/detail citation ordering consistent', sortAfterReset.items[0]?.id === bibPaperId, sortAfterReset.items.map((item) => `${item.id}:${item.citationCount ?? 'null'}`))
    // Leave a NULL column behind so the remount migration backfill is exercised.
    service.domain.db.prepare('UPDATE papers SET citation_count = NULL WHERE id = ?').run(bibPaperId)

    // ---- v0.3 operations journal + undo --------------------------------
    const undoAnnotation = await service.api.call('annotations.create', { paperId, page: 2, kind: 'note', comment: '撤销测试批注' })
    check('reversible write returns an operationId', typeof undoAnnotation.operationId === 'string' && undoAnnotation.operationId.startsWith('op-'), undoAnnotation.operationId)
    const recentOps = await service.api.call('operations.recent', { limit: 10 })
    check('operations.recent lists the journal', recentOps.items.some((operation) => operation.id === undoAnnotation.operationId && operation.kind === 'annotation.create'), recentOps.items.slice(0, 3))
    const undoneCreate = await service.api.call('operations.undo', { operationId: undoAnnotation.operationId })
    check('operations.undo reverts annotation.create', undoneCreate.status === 'undone', undoneCreate)
    const afterUndoCreate = await service.api.call('annotations.list', { paperId })
    check('undone annotation leaves the active list', afterUndoCreate.every((annotation) => annotation.id !== undoAnnotation.annotation.id))
    const undoneTwice = await service.api.call('operations.undo', { operationId: undoAnnotation.operationId })
    check('operations.undo is idempotent', undoneTwice.status === 'already_undone', undoneTwice.status)

    const colorTarget = afterUndoCreate[0]
    const updateOp = await service.api.call('annotations.update', { id: colorTarget.id, color: 'purple' })
    const revertedUpdate = await service.api.call('operations.undo', { operationId: updateOp.operationId })
    const afterUpdateUndo = await service.api.call('annotations.list', { paperId })
    check('operations.undo reverts annotation.update', revertedUpdate.status === 'undone' && afterUpdateUndo.find((annotation) => annotation.id === colorTarget.id)?.color === colorTarget.color, afterUpdateUndo.find((annotation) => annotation.id === colorTarget.id)?.color)
    const deleteOp = await service.api.call('annotations.delete', { id: colorTarget.id })
    await service.api.call('operations.undo', { operationId: deleteOp.operationId })
    const afterDeleteUndo = await service.api.call('annotations.list', { paperId })
    check('operations.undo restores annotation.delete', afterDeleteUndo.some((annotation) => annotation.id === colorTarget.id))
    const readOp = await service.api.call('library.setRead', { id: paperId, read: false })
    await service.api.call('operations.undo', { operationId: readOp.operationId })
    const afterReadUndo = await service.api.call('library.get', { id: paperId })
    check('operations.undo restores read flag', afterReadUndo.read === true, afterReadUndo.read)
    const titleBefore = afterReadUndo.titleZh
    const updatePaperOp = await service.api.call('library.update', { id: paperId, patch: { titleZh: '撤销后的标题' } })
    await service.api.call('operations.undo', { operationId: updatePaperOp.operationId })
    const afterPaperUndo = await service.api.call('library.get', { id: paperId })
    check('operations.undo restores paper fields', afterPaperUndo.titleZh === titleBefore, { before: titleBefore, after: afterPaperUndo.titleZh })
    const undoCollection = await service.api.call('library.collections.create', { name: '撤销收藏夹' })
    const assignOp = await service.api.call('library.collections.assign', { collectionId: undoCollection.collection.id, paperIds: [paperId], add: true })
    await service.api.call('operations.undo', { operationId: assignOp.operationId })
    const afterAssignUndo = await service.api.call('library.list', { collectionId: undoCollection.collection.id })
    check('operations.undo reverts collection assignment', afterAssignUndo.total === 0, afterAssignUndo.total)
    await service.api.call('library.collections.delete', { id: undoCollection.collection.id })

    // ---- v0.3 duplicates + merge ---------------------------------------
    // A duplicate row is inserted directly (the import pipeline correctly
    // de-duplicates identical titles at import time; the merge feature must still
    // handle a library that already contains duplicates, e.g. from v0.1 imports).
    const duplicateId = 'ph-selftestdup1'
    const nowStamp = new Date().toISOString()
    service.domain.db
      .prepare(
        `INSERT INTO papers(id, title, authors_json, year, venue, state, added_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0)`,
      )
      .run(
        duplicateId,
        'ReAct: Synergizing Reasoning and Acting in Language Models',
        JSON.stringify([{ family: 'Yao', given: 'Shunyu' }]),
        2023,
        'ICLR',
        nowStamp,
        nowStamp,
      )
    const duplicates = await service.api.call('library.duplicates')
    const titleGroup = duplicates.groups.find((group) => group.reason === 'title' && group.items.some((item) => item.id === duplicateId))
    check('library.duplicates groups title duplicates', titleGroup !== undefined && titleGroup.items.length >= 2, duplicates.groups.map((group) => group.reason))
    // Same manifest links on both papers reproduce the real UNIQUE(paper_id,kind,url)
    // collision that used to abort library.merge.
    const sourceStamp = new Date().toISOString()
    const insertSource = service.domain.db.prepare(
      "INSERT OR IGNORE INTO sources(paper_id, kind, url, retrieved_at) VALUES (?, 'test_manifest', ?, ?)",
    )
    insertSource.run(paperId, 'https://example.org/shared-source', sourceStamp)
    insertSource.run(duplicateId, 'https://example.org/shared-source', sourceStamp)
    insertSource.run(duplicateId, 'https://example.org/duplicate-only-source', sourceStamp)
    await service.api.call('library.update', { id: duplicateId, patch: { addTags: ['合并标签'] } })
    await service.api.call('library.setRead', { id: duplicateId, read: true })
    const mergeCollection = await service.api.call('library.collections.create', { name: '合并收藏夹' })
    await service.api.call('library.collections.assign', { collectionId: mergeCollection.collection.id, paperIds: [duplicateId], add: true })
    const merged = await service.api.call('library.merge', { primaryId: paperId, duplicateIds: [duplicateId], operationId: 'selftest-merge-1' })
    check('library.merge trashes the duplicate', merged.trashed.includes(duplicateId) && merged.merged === 1, merged)
    const mergedDetail = await service.api.call('library.get', { id: paperId })
    check('merge brings tags/collections/read to the primary', mergedDetail.tags.includes('合并标签') && mergedDetail.collections.some((collection) => collection.name === '合并收藏夹') && mergedDetail.read === true, { tags: mergedDetail.tags, read: mergedDetail.read })
    check(
      'merge moves sources without violating the unique index',
      mergedDetail.sources.some((source) => source.url === 'https://example.org/shared-source') &&
        mergedDetail.sources.some((source) => source.url === 'https://example.org/duplicate-only-source'),
      mergedDetail.sources.map((source) => source.url),
    )
    const trashedDuplicate = await service.api.call('library.get', { id: duplicateId })
    check('merged duplicate is in the recycle bin', trashedDuplicate.state === 'trash')
    const mergeUndo = await service.api.call('operations.undo', { operationId: merged.operationId })
    check('operations.undo reverts library.merge', mergeUndo.status === 'undone', mergeUndo)
    const restoredDuplicate = await service.api.call('library.get', { id: duplicateId })
    check('merge undo restores the duplicate paper', restoredDuplicate.state === 'active')
    check(
      'merge undo restores the duplicate sources',
      restoredDuplicate.sources.some((source) => source.url === 'https://example.org/duplicate-only-source'),
      restoredDuplicate.sources.map((source) => source.url),
    )
    const primaryAfterUndo = await service.api.call('library.get', { id: paperId })
    check('merge undo removes merged tags from primary', primaryAfterUndo.tags.includes('合并标签') === false, primaryAfterUndo.tags)
    await service.api.call('library.collections.delete', { id: mergeCollection.collection.id })
    await service.api.call('library.purge', { ids: [duplicateId], operationId: 'selftest-purge-duplicate' })

    // ---- v0.3 saved searches -------------------------------------------
    const saved = await service.api.call('saved_searches.create', { name: '未读 ReAct', query: { q: 'ReAct', reading: 'to-read' } })
    const savedList = await service.api.call('saved_searches.list')
    check('saved_searches.create/list work', savedList.items.some((item) => item.id === saved.savedSearch.id && item.name === '未读 ReAct'), savedList.items.length)
    const savedUpdate = await service.api.call('saved_searches.update', { id: saved.savedSearch.id, name: 'ReAct 待读' })
    check('saved_searches.update renames', savedUpdate.savedSearch.name === 'ReAct 待读')
    const savedDelete = await service.api.call('saved_searches.delete', { id: saved.savedSearch.id })
    check('saved_searches.delete removes it', savedDelete.ok === true && (await service.api.call('saved_searches.list')).items.length === 0)

    // ---- v0.3 AI fast mode degradation (fake ctx has no llm) -----------
    const fastTranslation = await service.api.call('translate.text', { text: 'fast mode test', fast: true })
    check(
      'translate.text fast degrades honestly with fast flag and elapsedMs',
      fastTranslation.status === 'unavailable' && fastTranslation.fast === true && fastTranslation.reasoningEffort === null && typeof fastTranslation.elapsedMs === 'number',
      fastTranslation,
    )
    const quickTranslation = await service.api.call('ai.quickTranslate', { text: 'Quick translation test sentence.' })
    check('ai.quickTranslate is the fast alias', quickTranslation.status === 'unavailable' && quickTranslation.fast === true, quickTranslation)
    const fastAsk = await service.api.call('ai.ask', { prompt: 'fast answer?', paperId, mode: 'fast' })
    check('ai.ask mode=fast degrades with fast marker', fastAsk.status === 'unavailable' && fastAsk.fast === true, fastAsk)
    const fastBlocks = await service.api.call('translate.blocks', { paperId, page: 2, fast: true })
    check('translate.blocks fast exposes fast/effort fields', fastBlocks.fast === true && 'reasoningEffort' in fastBlocks, { fast: fastBlocks.fast, effort: fastBlocks.reasoningEffort })

    // ---- v0.4 free translation engine chain ---------------------------
    const providers = await service.api.call('translate.providers')
    const providerIds = providers.items.map((item) => item.id)
    check(
      'translate.providers lists the real engine catalogue',
      ['tencent', 'google', 'mymemory', 'llm', 'libretranslate'].every((id) => providerIds.includes(id)) && providers.preferred === 'auto',
      providers,
    )
    check(
      'translate.providers exposes fallback chain + fallbackEnabled',
      Array.isArray(providers.fallback) && providers.fallback.join(',') === 'tencent,google,mymemory,llm' && providers.fallbackEnabled === true,
      { fallback: providers.fallback, fallbackEnabled: providers.fallbackEnabled },
    )
    const googleEngine = providers.items.find((item) => item.id === 'google')
    const llmEngine = providers.items.find((item) => item.id === 'llm')
    check('google engine is marked free+unofficial', googleEngine.free === true && googleEngine.unofficial === true, googleEngine)
    check('LLM is never presented as a free engine', llmEngine.free === false, llmEngine)
    const libreEngine = providers.items.find((item) => item.id === 'libretranslate')
    check('libretranslate stays unconfigured without libreUrl', libreEngine.configured === false && libreEngine.available === false, libreEngine)
    check('providers include the unofficial disclaimer', /非官方/.test(providers.disclaimer), providers.disclaimer)
    const enginesMeta = await service.api.call('diagnostics')
    check(
      'diagnostics.translation exposes providers',
      Array.isArray(enginesMeta.translation?.providers) && enginesMeta.translation.providers.length >= 4,
      enginesMeta.translation,
    )
    const settings0 = await service.api.call('translate.settings', {})
    check(
      'translate.settings GET returns {provider, fallback:boolean}',
      settings0.provider === 'auto' && settings0.fallback === true && Array.isArray(settings0.providers?.items),
      { provider: settings0.provider, fallback: settings0.fallback },
    )
    const settings1 = await service.api.call('translate.settings', { provider: 'mymemory' })
    check('translate.settings persists provider', settings1.provider === 'mymemory' && settings1.fallback === true, settings1)
    let settingsError = null
    try {
      await service.api.call('translate.settings', { provider: 'not-a-provider' })
    } catch (error) {
      settingsError = error
    }
    check('translate.settings rejects unknown providers', settingsError !== null && settingsError.code === 'invalid', settingsError?.code)
    await service.api.call('translate.settings', { provider: 'auto' })
    check('translate.settings resets to auto', (await service.api.call('translate.settings', {})).provider === 'auto')
    const detectEn = await service.api.call('translate.detect', { text: 'We propose a sparse attention mechanism for long documents.' })
    const detectZh = await service.api.call('translate.detect', { text: '我们提出一种面向长文档的稀疏注意力机制，并在检索任务上验证。' })
    check('translate.detect recognises Latin text', detectEn.language === 'en', detectEn)
    check('translate.detect recognises Chinese text', detectZh.language === 'zh', detectZh)
    const skipped = await service.api.call('translate.text', { text: '这段文字已经是中文，不需要再翻译。', target: 'zh' })
    check('translate.text skips already-Chinese source', skipped.status === 'translated' && skipped.skipped === true && skipped.provider === 'none', skipped)
    const multilineQuote =
      'While large language models (LLMs) have demonstrated impressive performance\nacross tasks in language understanding and interactive decision making, their abilities\nfor reasoning (e.g. chain-of-thought prompting) and acting have primarily been studied as separate topics.'
    const normalizedQuote = normalizeTranslationInput(multilineQuote)
    check(
      'translation normalizes multi-line quotes to one sentence stream',
      !normalizedQuote.includes('\n') &&
        normalizedQuote.includes('performance across tasks') &&
        !/\s{2,}/.test(normalizedQuote),
      normalizedQuote.slice(0, 100),
    )
    const longSentenceSource = normalizeTranslationInput('Sentence one describes the method in detail. '.repeat(40))
    const sentenceChunks = splitTextChunks(longSentenceSource, 450)
    check(
      'MyMemory chunking is sentence-based, <=450 chars and word-safe',
      sentenceChunks.length > 1 &&
        sentenceChunks.every((chunk) => chunk.length <= 450 && chunk.trim() === chunk) &&
        sentenceChunks.join(' ').split(' ').length === longSentenceSource.split(' ').length,
      sentenceChunks.map((chunk) => chunk.length),
    )
    const brokenQuality = evaluateTranslationQuality(
      'While large language models have shown strong performance across tasks in language understanding',
      'While 跨 能力 大 tasks language 推理 在语言中 模特',
    )
    check('quality gate flags word-by-word engine output', brokenQuality.suspicious === true, brokenQuality)
    const goodQuality = evaluateTranslationQuality(
      'While large language models have shown strong performance across tasks in language understanding',
      '大型语言模型在语言理解等各类任务上表现出强大性能。',
    )
    check('quality gate accepts a real Chinese translation', goodQuality.suspicious === false, goodQuality)
    const shortQuality = evaluateTranslationQuality('A long English paragraph that explains the retrieval method in detail.', '短')
    check('quality gate flags too-short output', shortQuality.suspicious === true, shortQuality)
    const allFail = await service.api.call('translate.text', { text: multilineQuote, target: 'zh' })
    check(
      'forced engine failures degrade through the whole chain with reasons',
      allFail.status === 'unavailable' &&
        allFail.translation === null &&
        Array.isArray(allFail.failures) &&
        allFail.failures.length === 4 &&
        /tencent\(forced_failure\)/.test(allFail.reason) &&
        /google\(forced_failure\)/.test(allFail.reason) &&
        /mymemory\(forced_failure\)/.test(allFail.reason) &&
        /llm\(forced_failure\)/.test(allFail.reason),
      { reason: allFail.reason, failures: allFail.failures },
    )
    const explicitFail = await service.api.call('translate.text', { text: 'Another paragraph.', provider: 'mymemory' })
    check(
      'explicit provider failure names that engine',
      explicitFail.status === 'unavailable' && /mymemory\(forced_failure\)/.test(explicitFail.reason),
      explicitFail.reason,
    )
    const quickStart = Date.now()
    const quickFail = await service.api.call('translate.text', { text: 'Academic passages must remain complete after translation.', target: 'zh', quick: true })
    const quickElapsed = Date.now() - quickStart
    check(
      'translate.text quick is free-only and never silently falls back to the LLM',
      quickFail.status === 'unavailable' &&
        quickFail.mode === 'free' &&
        quickFail.freeOnly === true &&
        quickFail.suggestAi === true &&
        quickFail.fast === true &&
        Array.isArray(quickFail.failures) &&
        quickFail.failures.length === 3 &&
        quickFail.failures.every((failure) => failure.provider === 'tencent' || failure.provider === 'google' || failure.provider === 'mymemory') &&
        !JSON.stringify(quickFail).includes('llm(') &&
        quickElapsed < 6000,
      { status: quickFail.status, mode: quickFail.mode, suggestAi: quickFail.suggestAi, failures: quickFail.failures, elapsed: quickElapsed },
    )
    check(
      'quick failure reason is user-facing and suggests AI 精译',
      /免费引擎/.test(String(quickFail.reason)) && /AI 精译/.test(String(quickFail.reason)),
      quickFail.reason,
    )
    const quickWithLlm = await service.api.call('translate.text', { text: 'Quick mode must not use the LLM.', target: 'zh', quick: true, provider: 'llm' })
    check(
      'quick with an explicit LLM provider is rejected honestly',
      quickWithLlm.status === 'unavailable' && quickWithLlm.suggestAi === true && /快速翻译只使用免费引擎/.test(String(quickWithLlm.reason)),
      quickWithLlm.reason,
    )
    const quickSkip = await service.api.call('translate.text', { text: '这段文字已经是中文，不需要翻译。', target: 'zh', quick: true })
    check(
      'quick result carries mode/freeOnly/suggestAi fields even when skipped',
      quickSkip.mode === 'none' && quickSkip.freeOnly === true && quickSkip.suggestAi === false,
      { mode: quickSkip.mode, freeOnly: quickSkip.freeOnly },
    )
    const fastAi = await service.api.call('ai.quickTranslate', { text: 'Quick AI translation probe sentence.', target: 'zh' })
    check(
      'ai.quickTranslate reports fast/reasoningEffort and the v2 prompt version',
      fastAi.fast === true &&
        'reasoningEffort' in fastAi &&
        fastAi.provenance?.promptVersion === PROMPT_VERSIONS.translateText &&
        PROMPT_VERSIONS.translateText === 'translate-text-v2',
      { fast: fastAi.fast, effort: fastAi.reasoningEffort, promptVersion: fastAi.provenance?.promptVersion },
    )
    const blocksTranslate = await service.api.call('translate.blocks', { paperId, page: 2, target: 'zh', fast: true })
    check(
      'translate.blocks reports per-block engine failure honestly',
      blocksTranslate.blocks.length > 0 &&
        blocksTranslate.blocks.every(
          (block) =>
            block.status === 'unavailable' &&
            typeof block.reason === 'string' &&
            'provider' in block &&
            'translation' in block &&
            typeof block.cached === 'boolean',
        ) &&
        blocksTranslate.fast === true,
      blocksTranslate.blocks?.slice(0, 2),
    )

    // ---- v0.4 discover / feed -----------------------------------------
    await service.api.call('reader.page', { id: paperId, page: 2 })
    await service.api.call('library.update', { id: paperId, patch: { addTags: ['侧栏发现'] } })
    const feedStarted = Date.now()
    const feed = await service.api.call('discover.feed', { limit: 5 })
    const feedMs = Date.now() - feedStarted
    check('discover.feed returns the documented sections', ['stats', 'continueReading', 'unread', 'annotated', 'collections', 'tags', 'recentAnnotations', 'recentFigures'].every((key) => key in feed), Object.keys(feed))
    check(
      'discover.feed stats counts are consistent',
      feed.stats.papers === 2 &&
        feed.stats.papers === feed.stats.unread + feed.stats.read &&
        feed.stats.reading <= feed.stats.unread &&
        feed.stats.annotations >= 1 &&
        feed.stats.collections >= 0 &&
        feed.stats.tags >= 1 &&
        typeof feed.stats.figures === 'number' &&
        typeof feed.stats.notes === 'number' &&
        typeof feed.stats.trash === 'number',
      feed.stats,
    )
    check('discover.feed stats counts figures for the sidebar badge', feed.stats.figures >= 1, feed.stats.figures)
    const tile =
      feed.continueReading.find((entry) => entry.id === paperId) ??
      feed.annotated.find((entry) => entry.id === paperId) ??
      feed.unread.find((entry) => entry.id === paperId) ??
      feed.unread[0]
    const tileFields = ['id', 'title', 'titleZh', 'authors', 'year', 'venue', 'tags', 'read', 'readingProgress', 'annotationCount', 'figureCount', 'lastReadAt', 'addedAt', 'citationCount', 'impactFactor', 'hasPdf']
    check('discover.feed PaperTile has every documented field', tile !== undefined && tileFields.every((key) => key in tile), tile === undefined ? null : Object.keys(tile))
    check('discover.feed hasPdf reflects a stored version', tile?.hasPdf === true, tile?.hasPdf)
    check('discover.feed continueReading tracks last_read_at', feed.continueReading.some((entry) => entry.id === paperId && entry.lastReadAt !== null), feed.continueReading.map((entry) => entry.id))
    check('discover.feed annotated section lists the annotated paper', feed.annotated.some((entry) => entry.id === paperId), feed.annotated.map((entry) => entry.id))
    check('discover.feed recentAnnotations carry paper/page/kind', feed.recentAnnotations.length >= 1 && feed.recentAnnotations.every((entry) => typeof entry.paperId === 'string' && Number.isInteger(entry.page) && typeof entry.kind === 'string'), feed.recentAnnotations.slice(0, 2))
    check('discover.feed recentFigures carry image urls', feed.recentFigures.length >= 1 && feed.recentFigures.every((entry) => entry.imageUrl.startsWith('/pappers-hall/figure/') && entry.captionThumbUrl.includes('width=320')), feed.recentFigures.slice(0, 2))
    check('discover.feed responds under 100ms', feedMs < 100, `${feedMs}ms`)
    const annotationFeed = await service.api.call('annotations.feed', { limit: 2 })
    check('annotations.feed returns newest-first items', annotationFeed.items.length >= 1 && annotationFeed.items.every((entry) => typeof entry.paperTitle === 'string' && typeof entry.createdAt === 'string'), annotationFeed.items.slice(0, 2))
    check('annotations.feed reports pagination cursor', typeof annotationFeed.hasMore === 'boolean' && (annotationFeed.items.length === 0 || typeof annotationFeed.nextBefore === 'string'), { hasMore: annotationFeed.hasMore, nextBefore: annotationFeed.nextBefore })
    const annotationFeedPaged = await service.api.call('annotations.feed', { limit: 1 })
    const annotationFeedNext = await service.api.call('annotations.feed', { limit: 1, before: annotationFeedPaged.nextBefore })
    check(
      'annotations.feed pages by created_at cursor',
      annotationFeedNext.items.length === 0 || annotationFeedNext.items[0].id !== annotationFeedPaged.items[0]?.id,
      { first: annotationFeedPaged.items[0]?.id, next: annotationFeedNext.items[0]?.id },
    )
    const annotationColors = [...new Set((await service.api.call('annotations.list', { paperId })).map((annotation) => annotation.color).filter((color) => typeof color === 'string'))]
    if (annotationColors.length > 0) {
      const coloredFeed = await service.api.call('annotations.feed', { paperId, colors: [annotationColors[0]] })
      check('annotations.feed filters by color', coloredFeed.items.every((entry) => entry.color === annotationColors[0]), coloredFeed.items.map((entry) => entry.color))
    }
    const kindFeed = await service.api.call('annotations.feed', { paperId, kinds: ['note'] })
    check('annotations.feed filters by kind', kindFeed.items.every((entry) => entry.kind === 'note'), kindFeed.items.map((entry) => entry.kind))
    const annotatedFeed = await service.api.call('annotations.feed', { paperId, query: '撤销' })
    check('annotations.feed text filter works', annotatedFeed.items.every((entry) => `${entry.quote ?? ''}${entry.comment ?? ''}`.includes('撤销')), annotatedFeed.items.length)
    const tiles = await service.api.call('library.tiles', { ids: [paperId] })
    check('library.tiles returns requested tiles in order', tiles.items.length === 1 && tiles.items[0].id === paperId, tiles.items.length)

    // ---- v0.5-B embedding component (honest offline degradation) ----
    const embeddingStatus = await service.api.call('embedding.status')
    check(
      'embedding.status reports an honest unavailable component',
      embeddingStatus.available === false &&
        embeddingStatus.configured === false &&
        typeof embeddingStatus.lastError === 'string' &&
        embeddingStatus.setupScript === 'scripts/setup-embedding.sh',
      { available: embeddingStatus.available, configured: embeddingStatus.configured, lastError: embeddingStatus.lastError },
    )
    check(
      'embedding.status exposes index/counts facts',
      typeof embeddingStatus.indexVersion === 'string' || embeddingStatus.indexVersion === null,
      { indexVersion: embeddingStatus.indexVersion, counts: embeddingStatus.counts },
    )
    const embeddingIndex = await service.api.call('embedding.index', {})
    check('embedding.index degrades honestly without the component', embeddingIndex.status === 'unavailable' && typeof embeddingIndex.reason === 'string', embeddingIndex)
    const statusWithVector = await service.api.call('status')
    check(
      'status.index.vectorInfo carries model/dims/reason',
      statusWithVector.index?.vectorInfo !== undefined &&
        typeof statusWithVector.index.vectorInfo === 'object' &&
        'model' in statusWithVector.index.vectorInfo &&
        'reason' in statusWithVector.index.vectorInfo,
      statusWithVector.index?.vectorInfo,
    )
    const diagnosticsV5 = await service.api.call('diagnostics')
    check(
      'diagnostics.embedding mirrors the component facts',
      diagnosticsV5.embedding !== null && diagnosticsV5.embedding !== undefined && diagnosticsV5.embedding.configured === false,
      diagnosticsV5.embedding,
    )
    check(
      'diagnostics.capabilities.vector is derived, not a stale mount snapshot',
      diagnosticsV5.capabilities.vector === 'unavailable',
      diagnosticsV5.capabilities.vector,
    )
    const vectorOff = await service.api.call('search.query', { q: 'ReAct', vector: false })
    const vectorOffChannel = (vectorOff.channels ?? []).find((channel) => channel.name === 'vector')
    check(
      'search.query vector:false is a pure-keyword baseline',
      vectorOffChannel !== undefined &&
        vectorOffChannel.status === 'off' &&
        vectorOff.items.every((hit) => !(hit.reasons ?? []).includes('vector_similarity')),
      { channel: vectorOffChannel, items: vectorOff.items.length },
    )
    const vectorDegraded = await service.api.call('search.query', { q: 'reinforcement learning agriculture', filters: { favorite: false } })
    const vectorChannel = (vectorDegraded.channels ?? []).find((channel) => channel.name === 'vector')
    check(
      'search.query reports vector channel unavailable instead of faking hits',
      vectorChannel !== undefined && vectorChannel.status === 'unavailable' && typeof vectorChannel.note === 'string',
      vectorChannel,
    )
    check('search.query keyword results survive vector degradation', Array.isArray(vectorDegraded.items))
    const longPageText = 'This page paragraph explains the retrieval method in detail. '.repeat(40)
    const pageChunks = chunkPageText(longPageText, { min: 600, max: 800, overlap: 80 })
    check(
      'page chunks respect the 800-char ceiling and actually chunk',
      pageChunks.length > 1 && pageChunks.every((chunk) => chunk.length <= 800 && chunk.trim() === chunk),
      pageChunks.map((chunk) => chunk.length),
    )
    const keywordHits = [
      { kind: 'paper', id: 'ph-a', paperId: 'ph-a', title: 'Exact title match', tier: 4, reasons: ['title or abstract match'] },
      { kind: 'paper', id: 'ph-b', paperId: 'ph-b', title: 'Keyword match', tier: 2, reasons: ['full text match'] },
    ]
    const vectorHits = [
      { kind: 'paper', id: 'ph-b', paperId: 'ph-b', title: 'Keyword match', tier: 0, score: 0.82, reasons: ['vector_similarity'] },
      { kind: 'paper', id: 'ph-c', paperId: 'ph-c', title: 'Semantic only match', tier: 0, score: 0.71, reasons: ['vector_similarity'] },
    ]
    const fused = fuseVectorHits(keywordHits, vectorHits)
    check(
      'RRF fusion keeps exact hits first and merges vector reasons',
      fused.length === 3 &&
        fused[0].id === 'ph-a' &&
        fused.some((hit) => hit.id === 'ph-b' && hit.reasons.includes('vector_similarity')) &&
        fused.some((hit) => hit.id === 'ph-c' && hit.reasons.includes('vector_similarity')),
      fused.map((hit) => ({ id: hit.id, reasons: hit.reasons })),
    )

    // ---- v0.5 folders / single favorite / filters ---------------------
    const favoriteOn = await service.api.call('library.setFavorite', { ids: [paperId], favorite: true })
    check('library.setFavorite marks the paper', favoriteOn.results[0]?.ok === true && favoriteOn.favoriteCount >= 1, favoriteOn)
    const favoriteDetail = await service.api.call('library.get', { id: paperId })
    check('library.get exposes favorite', favoriteDetail.favorite === true, favoriteDetail.favorite)
    const favoriteList = await service.api.call('library.list', { favorite: true })
    check('library.list favorite filter keeps only favorites', favoriteList.items.length === 1 && favoriteList.items[0].id === paperId, favoriteList.total)
    const favoriteSort = await service.api.call('library.list', { sort: 'favorite' })
    check('library.list sort=favorite puts the favorite first', favoriteSort.items[0]?.id === paperId && favoriteSort.items[0]?.favorite === true)
    const favoriteFeed = await service.api.call('discover.feed', { limit: 5 })
    check('discover.feed adds favorite stats/section', favoriteFeed.stats.favorite >= 1 && favoriteFeed.favorite.some((entry) => entry.id === paperId), { stats: favoriteFeed.stats.favorite, section: favoriteFeed.favorite.map((entry) => entry.id) })
    check('discover.feed exposes the folder tree', Array.isArray(favoriteFeed.folders) && Array.isArray(favoriteFeed.folderCounts), favoriteFeed.folders?.length)
    await service.api.call('operations.undo', { operationId: favoriteOn.operationId })
    check('undo restores the favorite flag', (await service.api.call('library.get', { id: paperId })).favorite === false)

    const rootFolder = await service.api.call('library.collections.create', { name: '根文件夹' })
    const childFolder = await service.api.call('library.collections.create', { name: '子文件夹', parentId: rootFolder.collection.id })
    const grandFolder = await service.api.call('library.collections.create', { name: '孙文件夹', parentId: childFolder.collection.id })
    check('nested folder create returns parentId', childFolder.collection.parentId === rootFolder.collection.id && grandFolder.collection.parentId === childFolder.collection.id, childFolder.collection)
    let depthError = null
    const v6TreeKinds = []
    const collectTreeKinds = (nodes) => {
      for (const node of nodes) {
        v6TreeKinds.push(node.kind)
        collectTreeKinds(node.children ?? [])
      }
    }
    collectTreeKinds((await service.api.call('library.folders.tree')).items)
    check('v0.6 folder tree has no read-only field kind', v6TreeKinds.length > 0 && v6TreeKinds.every((kind) => kind === 'folder'), v6TreeKinds)
    try {
      await service.api.call('library.collections.update', { id: childFolder.collection.id, parentId: grandFolder.collection.id })
    } catch (error) {
      depthError = error
    }
    check('folders cannot be moved into their own descendants', depthError !== null && depthError.code === 'invalid', depthError?.code)
    await service.api.call('library.collections.assign', { collectionId: childFolder.collection.id, paperIds: [paperId], add: true })
    await service.api.call('library.collections.assign', { collectionId: rootFolder.collection.id, paperIds: [bibPaperId], add: true })
    const folderTree1 = await service.api.call('library.folders.tree')
    const rootNode = folderTree1.items.find((item) => item.id === rootFolder.collection.id)
    const childNode = rootNode?.children.find((item) => item.id === childFolder.collection.id)
    check(
      'folder tree counts direct+descendant papers',
      rootNode?.count === 2 && rootNode?.directCount === 1 && childNode?.count === 1,
      { root: { count: rootNode?.count, directCount: rootNode?.directCount }, child: childNode?.count },
    )
    const subtreeList = await service.api.call('library.list', { folderId: rootFolder.collection.id })
    const childList = await service.api.call('library.list', { folderId: childFolder.collection.id })
    check('library.list folderId includes descendant folders', subtreeList.total === 2 && childList.total === 1 && childList.items[0].id === paperId, { root: subtreeList.total, child: childList.total })

    // The same paper in several descendants (and directly) must be counted once.
    await service.api.call('library.collections.assign', { collectionId: grandFolder.collection.id, paperIds: [paperId, bibPaperId], add: true })
    const folderTreeDistinct = await service.api.call('library.folders.tree')
    const findNode = (nodes, id) => {
      for (const node of nodes) {
        if (node.id === id) return node
        const found = findNode(node.children ?? [], id)
        if (found !== undefined) return found
      }
      return undefined
    }
    const rootDistinct = findNode(folderTreeDistinct.items, rootFolder.collection.id)
    check(
      'folder tree counts unique papers across descendants (matches library.list)',
      rootDistinct?.count === 2 &&
        rootDistinct?.directCount === 1 &&
        findNode(folderTreeDistinct.items, grandFolder.collection.id)?.count === 2 &&
        (await service.api.call('library.list', { folderId: rootFolder.collection.id })).total === 2,
      { root: rootDistinct?.count, direct: rootDistinct?.directCount, grand: findNode(folderTreeDistinct.items, grandFolder.collection.id)?.count },
    )
    await service.api.call('library.update', { id: paperId, patch: { addTags: ['筛选A', '筛选B'] } })
    await service.api.call('library.update', { id: bibPaperId, patch: { addTags: ['筛选B'] } })
    const andTags = await service.api.call('library.list', { tags: ['筛选A', '筛选B'] })
    check('library.list tags filter is AND', andTags.total === 1 && andTags.items[0].id === paperId, andTags.total)
    await service.api.call('library.setFavorite', { ids: [paperId], favorite: true })
    const searchRoot = await service.api.call('search.query', { q: 'Selftest', filters: { folderId: rootFolder.collection.id } })
    const searchChild = await service.api.call('search.query', { q: 'ReAct', filters: { folderId: childFolder.collection.id } })
    check(
      'search.query applies folderId filter (with descendants) to hits',
      searchRoot.items.length === 1 && searchRoot.items[0].paperId === bibPaperId && searchChild.items.every((hit) => hit.paperId === paperId),
      { root: searchRoot.items.map((hit) => hit.paperId), child: searchChild.items.map((hit) => hit.paperId) },
    )
    const searchFavorite = await service.api.call('search.query', { q: 'ReAct', filters: { favorite: true } })
    check('search.query applies favorite filter', searchFavorite.items.length >= 1 && searchFavorite.items.every((hit) => hit.paperId === paperId), searchFavorite.items.length)
    const searchTags = await service.api.call('search.query', { q: 'ReAct', filters: { tags: ['筛选A', '筛选B'] } })
    const searchTagsMiss = await service.api.call('search.query', { q: 'ReAct', filters: { tags: ['不存在的标签'] } })
    check(
      'search.query applies tags AND filter',
      searchTags.items.length >= 1 && searchTags.items.every((hit) => hit.paperId === paperId) && searchTagsMiss.items.length === 0,
      { hit: searchTags.items.length, miss: searchTagsMiss.items.length },
    )
    const searchTopLevel = await service.api.call('search.query', { q: 'ReAct', favorite: true })
    check('search.query accepts top-level filter aliases', searchTopLevel.items.every((hit) => hit.paperId === paperId), searchTopLevel.items.length)
    const feedWithFolder = await service.api.call('annotations.feed', { folderId: childFolder.collection.id })
    check('annotations.feed supports folderId filter', feedWithFolder.items.every((entry) => entry.paperId === paperId), feedWithFolder.items.length)
    const updateFolderOp = await service.api.call('library.collections.update', { id: childFolder.collection.id, name: '子文件夹改名' })
    check('folder rename works and is journaled', updateFolderOp.collection.name === '子文件夹改名')
    await service.api.call('operations.undo', { operationId: updateFolderOp.operationId })
    const findFolderNode = (nodes, id) => {
      for (const node of nodes) {
        if (node.id === id) return node
        const found = findFolderNode(node.children ?? [], id)
        if (found !== undefined) return found
      }
      return undefined
    }
    const treeAfterRenameUndo = await service.api.call('library.folders.tree')
    check('undo restores folder name', findFolderNode(treeAfterRenameUndo.items, childFolder.collection.id)?.name === '子文件夹')
    const deleteFolderOp = await service.api.call('library.collections.delete', { id: childFolder.collection.id })
    const treeAfterDelete = await service.api.call('library.folders.tree')
    const rootAfterDelete = treeAfterDelete.items.find((item) => item.id === rootFolder.collection.id)
    check(
      'deleting a folder promotes its children to the parent',
      rootAfterDelete?.children.some((item) => item.id === grandFolder.collection.id) && !rootAfterDelete?.children.some((item) => item.id === childFolder.collection.id),
      rootAfterDelete?.children.map((item) => item.id),
    )
    await service.api.call('operations.undo', { operationId: deleteFolderOp.operationId })
    const treeAfterUndo = await service.api.call('library.folders.tree')
    const rootAfterUndo = treeAfterUndo.items.find((item) => item.id === rootFolder.collection.id)
    check(
      'undo restores the deleted folder and its children',
      rootAfterUndo?.children.some((item) => item.id === childFolder.collection.id) &&
        rootAfterUndo?.children.find((item) => item.id === childFolder.collection.id)?.children.some((item) => item.id === grandFolder.collection.id),
      rootAfterUndo?.children.map((item) => item.id),
    )
    const createdFolderOp = await service.api.call('library.collections.create', { name: '临时文件夹' })
    await service.api.call('operations.undo', { operationId: createdFolderOp.operationId })
    check('undo removes a created folder', (await service.api.call('library.folders.tree')).items.every((item) => item.id !== createdFolderOp.collection.id))
    await service.api.call('library.collections.delete', { id: rootFolder.collection.id })
    check('deleting the root folder keeps the papers (no paper deleted)', (await service.api.call('library.list', {})).total === 2)

    // ---- v0.6 field->folder migration + classify + management tools ----
    {
      // Unit-level migration proof: a legacy read-only field collection gets folded
      // into an editable folder with explicit membership rows.
      const nowIso = new Date().toISOString()
      const legacyId = 'cl-selftestfield'
      service.domain.db
        .prepare("INSERT OR REPLACE INTO collections(id, name, color, sort_order, kind, field_key, created_at, updated_at) VALUES (?, '测试领域V6', NULL, 900, 'field', '测试领域V6', ?, ?)")
        .run(legacyId, nowIso, nowIso)
      service.domain.db.prepare('UPDATE papers SET field = ? WHERE id = ?').run('测试领域V6', bibPaperId)
      const migrationFacts = applyV6Migration(service.domain.db)
      const foldedRow = service.domain.db.prepare('SELECT kind FROM collections WHERE id = ?').get(legacyId)
      const foldedMembership = service.domain.db
        .prepare('SELECT COUNT(*) AS count FROM paper_collections WHERE collection_id = ? AND paper_id = ?')
        .get(legacyId, bibPaperId)
      check(
        'v0.6 migration folds field collection into an editable folder with members',
        migrationFacts.folded >= 1 && foldedRow.kind === 'folder' && Number(foldedMembership.count) === 1,
        { migrationFacts, kind: foldedRow.kind, membership: Number(foldedMembership.count) },
      )
      const foldedRename = await service.api.call('library.collections.update', { id: legacyId, name: '测试领域V6改名' })
      check('v0.6 former field folder is editable', foldedRename.collection.name === '测试领域V6改名', foldedRename.collection)
      await service.api.call('library.collections.delete', { id: legacyId })
      service.domain.db.prepare('UPDATE papers SET field = NULL WHERE id = ?').run(bibPaperId)

      // classify: embedding component is disabled in the offline selftest.
      const classifyUnavailable = await service.api.call('library.classify', { paperIds: [paperId] })
      check(
        'library.classify reports unavailable without embedding',
        classifyUnavailable.status === 'unavailable' && /embedding unavailable/i.test(classifyUnavailable.reason),
        classifyUnavailable,
      )
      // apply + undo with explicit decisions (no embedding needed).
      const appliedClassify = service.domain.classifyApply([
        { paperId, action: 'create', newFolderName: '自动归类测试', confidence: 0.5 },
      ])
      const classifyFolder = appliedClassify.createdFolders?.[0]
      check(
        'classifyApply creates a topic folder and journals the operation',
        appliedClassify.applied.length === 1 &&
          appliedClassify.createdFolders.length === 1 &&
          classifyFolder.name === '自动归类测试' &&
          typeof appliedClassify.operationId === 'string',
        appliedClassify,
      )
      const classifyTree = await service.api.call('library.folders.tree')
      check('classifyApply folder appears in the tree', classifyTree.items.some((item) => item.id === classifyFolder.id))
      await service.api.call('operations.undo', { operationId: appliedClassify.operationId })
      const afterClassifyUndo = await service.api.call('library.folders.tree')
      check(
        'undo removes the auto-created folder and its membership',
        afterClassifyUndo.items.every((item) => item.id !== classifyFolder.id) &&
          service.domain.db.prepare('SELECT COUNT(*) AS count FROM paper_collections WHERE paper_id = ? AND collection_id = ?').get(paperId, classifyFolder.id).count === 0,
      )
      // classify into an existing folder, then undo just the membership.
      const assignTarget = await service.api.call('library.collections.create', { name: '归类目标夹' })
      const appliedAssign = service.domain.classifyApply([{ paperId, action: 'assign', folderId: assignTarget.collection.id, confidence: 0.9 }])
      check('classifyApply assigns into an existing folder', appliedAssign.applied[0]?.folderId === assignTarget.collection.id && appliedAssign.createdFolders.length === 0, appliedAssign)
      await service.api.call('operations.undo', { operationId: appliedAssign.operationId })
      check(
        'undo removes only the auto-assigned membership',
        service.domain.db.prepare('SELECT COUNT(*) AS count FROM paper_collections WHERE paper_id = ? AND collection_id = ?').get(paperId, assignTarget.collection.id).count === 0,
      )
      await service.api.call('library.collections.delete', { id: assignTarget.collection.id })

      // management tools
      const tools = fake.state.tools
      const overview = await tools.get('papers_overview').execute({})
      check(
        'papers_overview returns stats/folders/tags/embedding facts',
        overview.status === 'ok' &&
          typeof overview.stats?.papers === 'number' &&
          Array.isArray(overview.folders) &&
          Array.isArray(overview.tags) &&
          overview.embedding !== undefined,
        { stats: overview.stats, folders: overview.folders?.length },
      )
      const treeValue = await tools.get('papers_folders').execute({ action: 'tree' })
      check('papers_folders tree action works', treeValue.status === 'ok' && Array.isArray(treeValue.tree), treeValue.total)
      const createdByTool = await tools.get('papers_folders').execute({ action: 'create', name: '工具创建夹' })
      check('papers_folders create action works', createdByTool.status === 'ok' && typeof createdByTool.result?.collection?.id === 'string', createdByTool.result)
      const toolFolderId = createdByTool.result.collection.id
      const renamedByTool = await tools.get('papers_folders').execute({ action: 'rename', id: toolFolderId, name: '工具改名夹' })
      check('papers_folders rename action works', renamedByTool.status === 'ok' && renamedByTool.result.collection.name === '工具改名夹')
      const assignedByTool = await tools.get('papers_folders').execute({ action: 'assign', folderId: toolFolderId, paperIds: [paperId] })
      check(
        'papers_folders assign/unassign actions work',
        assignedByTool.status === 'ok' && assignedByTool.result.results[0]?.ok === true,
        assignedByTool.result,
      )
      const unassignedByTool = await tools.get('papers_folders').execute({ action: 'unassign', folderId: toolFolderId, paperIds: [paperId] })
      check('papers_folders unassign action works', unassignedByTool.status === 'ok' && unassignedByTool.result.results[0]?.ok === true)
      const deletedByTool = await tools.get('papers_folders').execute({ action: 'delete', id: toolFolderId })
      check('papers_folders delete action keeps papers', deletedByTool.status === 'ok' && (await service.api.call('library.list', {})).total === 2, deletedByTool.result)

      const relatedUnavailable = await tools.get('papers_related').execute({ paperId })
      check(
        'papers_related degrades honestly without embedding',
        relatedUnavailable.status === 'unavailable' && /embedding/i.test(String(relatedUnavailable.reason ?? '')),
        relatedUnavailable,
      )
      const listTool = await tools.get('papers_list').execute({ limit: 5 })
      check(
        'papers_list returns basic metadata without embedding',
        listTool.status === 'ok' && Array.isArray(listTool.items) && listTool.items.length >= 1 && listTool.items[0].paperId === paperId,
        { status: listTool.status, count: listTool.items?.length },
      )
      const abstractSingle = await tools.get('papers_abstracts').execute({ paperId })
      check(
        'papers_abstracts reads one paper quickly',
        abstractSingle.status === 'ok' && abstractSingle.count === 1 && abstractSingle.items[0].paperId === paperId && typeof abstractSingle.items[0].abstract === 'string',
        { status: abstractSingle.status, count: abstractSingle.count },
      )
      const abstractBatch = await tools.get('papers_abstracts').execute({ paperIds: [paperId] })
      check(
        'papers_abstracts supports a batch of ids',
        abstractBatch.status === 'ok' && abstractBatch.count === 1 && abstractBatch.items[0].paperId === paperId,
        { status: abstractBatch.status, count: abstractBatch.count },
      )
      const getTool = await tools.get('papers_get').execute({ paperId })
      check(
        'papers_get returns paper detail with folders/figures',
        getTool.status === 'ok' && getTool.paper?.paperId === paperId && Array.isArray(getTool.paper.folders),
        { status: getTool.status, paper: getTool.paper?.paperId },
      )
      const updateTool = await tools.get('papers_update').execute({ paperId, patch: { read: true } })
      check('papers_update edits basic metadata', updateTool.status === 'ok', updateTool)
      const hintsTool = await tools.get('papers_folder_hints').execute({ paperIds: [paperId] })
      check(
        'papers_folder_hints is read-only and degrades honestly without embedding',
        hintsTool.status === 'unavailable' && hintsTool.referenceOnly === true && /embedding unavailable/i.test(hintsTool.reason),
        hintsTool,
      )

      // papers_import_file: preview must not write; invalid path is explicit.
      const beforePreview = (await service.api.call('library.list', {})).total
      const preview = await tools.get('papers_import_file').execute({ path: FIXTURE_PDF, confirm: false })
      check(
        'papers_import_file preview returns readable evidence without writing',
        preview.status === 'preview' &&
          preview.looksLikePaper === true &&
          typeof preview.title === 'string' &&
          typeof preview.contentSample === 'string' &&
          preview.contentSample.length > 0 &&
          (await service.api.call('library.list', {})).total === beforePreview,
        { status: preview.status, title: preview.title, looksLikePaper: preview.looksLikePaper, signals: preview.signals, sampleLength: preview.contentSample?.length },
      )
      const invalidPreview = await tools.get('papers_import_file').execute({ path: '/nonexistent/selftest.pdf' })
      check('papers_import_file reports invalid paths explicitly', invalidPreview.status === 'invalid' && /does not exist/.test(invalidPreview.reason), invalidPreview)
      const duplicatePreview = await tools.get('papers_import_file').execute({ path: FIXTURE_PDF, confirm: true })
      check('papers_import_file confirm on an existing paper returns duplicate', duplicatePreview.status === 'duplicate' && typeof duplicatePreview.paperId === 'string', duplicatePreview)
      // confirm-import a NEW PDF copy (fixture bytes + unique trailer so the hash is
      // new); classification degrades without embedding but the import must succeed.
      const variantPdf = path.join(dataDir, 'selftest-v06-new-paper.pdf')
      const variantBytes = Buffer.concat([await readFile(FIXTURE_PDF), Buffer.from('\n% selftest v06 variant\n')])
      await writeFile(variantPdf, variantBytes)
      const variantPreview = await tools.get('papers_import_file').execute({ path: variantPdf, confirm: false })
      check(
        'papers_import_file preview reads a new PDF without writing',
        variantPreview.status === 'preview' && variantPreview.looksLikePaper === true && (await service.api.call('library.list', {})).total === 2,
        { status: variantPreview.status, title: variantPreview.title },
      )
      const importToolResult = await tools.get('papers_import_file').execute({ path: variantPdf, confirm: true })
      check(
        'papers_import_file confirm imports a new PDF unclassified (agent-driven)',
        importToolResult.status === 'imported' &&
          typeof importToolResult.paperId === 'string' &&
          importToolResult.classification?.status === 'skipped',
        { status: importToolResult.status, paperId: importToolResult.paperId, classification: importToolResult.classification?.status },
      )
      const importedJobId = importToolResult.jobId ?? importToolResult.import?.jobId ?? null
      if (importedJobId !== null) {
        await service.api.call('jobs.cancel', { id: importedJobId })
      }
      await service.api.call('library.purge', { ids: [importToolResult.paperId], operationId: 'selftest-purge-v06-import' })
      check('v0.6 imported test paper is purged again', (await service.api.call('library.list', {})).total === 2)
    }

    // ---- v0.11 settings center / model installation / OCR -------------
    {
      const pageColumns = service.domain.db.prepare('PRAGMA table_info(paper_pages)').all().map((column) => column.name)
      check('v0.11 migration adds OCR page columns', pageColumns.includes('ocr_text') && pageColumns.includes('ocr_updated_at'), pageColumns.filter((name) => name.startsWith('ocr')))
      const settingsInitial = await service.api.call('settings.get')
      check(
        'settings.get exposes features/models/translation/index/diagnostics',
        settingsInitial.features !== null &&
          typeof settingsInitial.features.vectorSearch === 'boolean' &&
          settingsInitial.models?.embedding?.kind === 'embedding' &&
          settingsInitial.models?.ocr?.kind === 'ocr' &&
          Array.isArray(settingsInitial.translation?.providers) &&
          settingsInitial.index !== undefined &&
          settingsInitial.diagnostics !== undefined,
        { features: settingsInitial.features, embedding: settingsInitial.models?.embedding?.installed, ocr: settingsInitial.models?.ocr?.installed },
      )
      check(
        'settings.get reports honest model installation state',
        settingsInitial.models.embedding.installed === false &&
          settingsInitial.models.embedding.installable === true &&
          settingsInitial.models.ocr.installed === false &&
          settingsInitial.models.ocr.engine === 'rapidocr-onnxruntime' &&
          typeof settingsInitial.models.ocr.reason === 'string',
        { embedding: settingsInitial.models.embedding.installed, ocr: settingsInitial.models.ocr.installed, reason: settingsInitial.models.ocr.reason },
      )
      check(
        'settings.get lists the real translation providers',
        settingsInitial.translation.providers.map((provider) => provider.id).join(',') === 'tencent,google,mymemory,llm' &&
          settingsInitial.translation.providers.every((provider) => typeof provider.enabled === 'boolean'),
        settingsInitial.translation.providers,
      )
      const updated = await service.api.call('settings.update', {
        patch: { features: { vectorSearch: false, bogus: true }, translation: { fallbackEnabled: false } },
      })
      check(
        'settings.update persists valid switches and reports applied/ignored',
        updated.features.vectorSearch === false &&
          updated.translation.fallbackEnabled === false &&
          Array.isArray(updated.applied) &&
          updated.applied.includes('features.vectorSearch') &&
          updated.ignored.includes('features.bogus'),
        { applied: updated.applied, ignored: updated.ignored },
      )
      const persistedSettings = await service.api.call('settings.get')
      check('settings.update persists across settings.get', persistedSettings.features.vectorSearch === false && persistedSettings.translation.fallbackEnabled === false)
      const vectorOffResult = await service.api.call('search.query', { q: 'ReAct', ai: 'off' })
      const vectorOffChannel = (vectorOffResult.channels ?? []).find((channel) => channel.name === 'vector')
      check(
        'vectorSearch=false turns the vector channel off (no fake hits)',
        vectorOffChannel !== undefined && vectorOffChannel.status === 'off' && vectorOffChannel.note.includes('设置'),
        vectorOffChannel,
      )
      const statusVectorOff = await service.api.call('status')
      check(
        'vectorSearch=false removes vector from status.degraded',
        (statusVectorOff.degraded ?? []).every((entry) => entry.channel !== 'vector'),
        statusVectorOff.degraded,
      )
      const diagnosticsVectorOff = await service.api.call('diagnostics')
      check('diagnostics.capabilities.vector reports disabled when switched off', diagnosticsVectorOff.capabilities.vector === 'disabled', diagnosticsVectorOff.capabilities.vector)
      await service.api.call('settings.update', { patch: { features: { vectorSearch: true }, translation: { fallbackEnabled: true } } })
      check('settings switches restore', (await service.api.call('settings.get')).features.vectorSearch === true)
      const operationId = 'selftest-settings-op-1'
      const opFirst = await service.api.call('settings.update', { operationId, patch: { features: { autoIndex: false } } })
      const opSecond = await service.api.call('settings.update', { operationId, patch: { features: { autoIndex: false } } })
      check('settings.update is idempotent per operationId', opFirst.features.autoIndex === false && opSecond.features.autoIndex === false, opSecond.features.autoIndex)
      await service.api.call('settings.update', { patch: { features: { autoIndex: true } } })
      let allProvidersOff = null
      try {
        await service.api.call('settings.update', { patch: { translation: { providers: { tencent: false, google: false, mymemory: false, llm: false } } } })
      } catch (error) {
        allProvidersOff = error
      }
      check('settings.update refuses to disable every translation engine', allProvidersOff !== null && allProvidersOff.code === 'invalid', allProvidersOff?.code)
      const providerOff = await service.api.call('settings.update', { patch: { translation: { providers: { google: false } } } })
      const googleProvider = providerOff.translation.providers.find((provider) => provider.id === 'google')
      check('settings.update can disable one translation provider', googleProvider.enabled === false, googleProvider)
      const translateProvidersAfter = await service.api.call('translate.providers')
      check(
        'translate.providers reflects disabled engines',
        translateProvidersAfter.items.find((item) => item.id === 'google')?.enabled === false,
        translateProvidersAfter.items.map((item) => `${item.id}:${item.enabled}`),
      )
      await service.api.call('settings.update', { patch: { translation: { providers: { google: true } } } })
      // Model install channel: enqueue + cancel without downloading anything.
      const embeddingInstall = await service.api.call('models.install', { kind: 'embedding' })
      check(
        'models.install embedding queues a real model.install job',
        embeddingInstall.status === 'queued' && typeof embeddingInstall.job?.id === 'string' && embeddingInstall.job.kind === 'model.install',
        embeddingInstall,
      )
      const cancelled = await service.api.call('models.cancel', { kind: 'embedding' })
      check('models.cancel cancels the install job', cancelled.status === 'cancelled' && cancelled.job?.state === 'cancelled', cancelled)
      const ocrInstall = await service.api.call('models.install', { kind: 'ocr' })
      check('models.install ocr queues its own job', ocrInstall.status === 'queued' && ocrInstall.job?.kind === 'model.install', ocrInstall.status)
      const ocrCancelled = await service.api.call('models.cancel', { kind: 'ocr' })
      check('models.cancel cancels the OCR install job', ocrCancelled.status === 'cancelled', ocrCancelled.status)
      const invalidInstall = await service.api.call('models.install', { kind: 'magic' })
      check('models.install rejects unknown kinds', invalidInstall.status === 'invalid' && /unsupported/.test(invalidInstall.reason), invalidInstall)
      const rebuild = await service.api.call('models.rebuildIndex', {})
      check('models.rebuildIndex reports honest unavailable without embedding', rebuild.status === 'unavailable' && typeof rebuild.reason === 'string', rebuild)
      const ocrIndex = await service.api.call('ocr.index', {})
      check('ocr.index is unavailable while OCR is not installed', ocrIndex.status === 'unavailable' && /未安装/.test(ocrIndex.reason), ocrIndex)
      const statusOcr = await service.api.call('status')
      check(
        'status exposes OCR facts',
        statusOcr.ocr !== undefined && statusOcr.ocr.available === false && statusOcr.ocr.installed === false && typeof statusOcr.ocr.pages === 'number',
        statusOcr.ocr,
      )
      const diagnosticsOcr = await service.api.call('diagnostics')
      check('diagnostics.capabilities.ocr is honest', diagnosticsOcr.capabilities.ocr === 'unavailable' && diagnosticsOcr.ocr !== null, diagnosticsOcr.capabilities.ocr)
      const degradedOcr = (statusOcr.degraded ?? []).find((entry) => entry.channel === 'ocr')
      check('degraded OCR entry is marked optional with user-facing reason', degradedOcr?.severity === 'optional' && /OCR 未安装/.test(degradedOcr.reason), degradedOcr)
      const translationTest = await service.api.call('translation.test', {})
      check(
        'translation.test returns a real honest result',
        typeof translationTest.ok === 'boolean' && typeof translationTest.latencyMs === 'number' && (translationTest.ok === true || typeof translationTest.reason === 'string'),
        translationTest,
      )
      // OCR text fallback for reader + page FTS/LIKE channels.
      const originalPage = service.domain.db.prepare('SELECT text FROM paper_pages WHERE paper_id = ? AND page = 2').get(paperId)
      service.domain.db.prepare('UPDATE paper_pages SET text = ?, ocr_text = ? WHERE paper_id = ? AND page = 2').run('', 'ocrfallbackprobe text from a scanned page', paperId)
      const pageTextOcr = await service.api.call('reader.pageText', { id: paperId, page: 2 })
      check('reader.pageText falls back to OCR text on scanned pages', pageTextOcr.source === 'ocr' && pageTextOcr.text.includes('ocrfallbackprobe'), pageTextOcr)
      service.domain.attachments.search.indexPages(paperId)
      const ocrSearch = await service.api.call('search.query', { q: 'ocrfallbackprobe', ai: 'off' })
      check('OCR text is searchable through the page channels', ocrSearch.items.some((hit) => (hit.paperId ?? hit.id) === paperId), ocrSearch.items.length)
      service.domain.db.prepare('UPDATE paper_pages SET text = ?, ocr_text = NULL WHERE paper_id = ? AND page = 2').run(originalPage.text, paperId)
      service.domain.attachments.search.indexPages(paperId)
      await service.api.call('settings.update', { patch: { features: { autoIndex: true } } })
    }

    const purge = await service.api.call('library.purge', { ids: [paperId], operationId: 'selftest-purge-1' })
    check('purge removes the paper permanently', purge.results[0].ok === true)
    const afterPurge = await service.api.call('library.list', {})
    check('purge leaves the other paper untouched', afterPurge.total === 1, afterPurge.total)
    const purgeUndo = await service.api.call('operations.undo', { operationId: purge.operationId })
    check('operations.undo refuses to resurrect purged papers', purgeUndo.status === 'not_undoable' && /cannot be undone/.test(purgeUndo.reason ?? ''), purgeUndo)

    // ---- job controls ---------------------------------------------------
    const jobsList = await service.api.call('jobs.list')
    check('jobs.list returns items and summary', jobsList.items.length >= 2 && jobsList.summary.succeeded >= 1, jobsList.summary)
    const finishedJob = jobsList.items[0]
    const paused = await service.api.call('jobs.pause', { id: finishedJob.id })
    check('jobs.pause returns {job}', paused.job !== undefined && paused.job.id === finishedJob.id, paused)
    const resumed = await service.api.call('jobs.resume', { id: finishedJob.id })
    check('jobs.resume returns {job}', resumed.job?.id === finishedJob.id, resumed)
    const retried = await service.api.call('jobs.retry', { id: finishedJob.id })
    check('jobs.retry requeues the job', retried.job?.state === 'queued', retried.job?.state)
    const cancelled = await service.api.call('jobs.cancel', { id: finishedJob.id })
    check('jobs.cancel returns {job}', cancelled.job?.id === finishedJob.id, cancelled)

    // ---- diagnostics/capabilities after jobs ---------------------------
    const statusAfter = await service.api.call('status')
    check('status counts remaining paper', statusAfter.counts.papers === 1, statusAfter.counts)
    check(
      'status reports no pending jobs',
      statusAfter.counts.jobsPending === 0,
      { ...statusAfter.jobs, pendingJobs: (await service.api.call('jobs.list')).items.filter((job) => ['queued', 'running', 'retry_wait', 'paused'].includes(job.state)).map((job) => ({ id: job.id, kind: job.kind, state: job.state, attempts: job.attempts })) },
    )

    // ---- teardown ------------------------------------------------------
    for (const name of Object.keys(legacyAliases)) fake.state.tools.delete(name)
    await service.dispose()
    check('dispose clears the timer', fake.state.intervals.size === 0, fake.state.intervals.size)
    check('dispose clears tool registrations', fake.state.tools.size === 0, fake.state.tools.size)
    check('dispose clears the web route', fake.state.routes.size === 0, [...fake.state.routes.keys()])
    check('dispose clears the system prompt section', fake.state.promptSections.size === 0, [...fake.state.promptSections.keys()])
    await service.dispose()
    check('dispose is idempotent', true)
    await fake.disposeAll()

    // ---- remount preserves data ----------------------------------------
    const secondFake = createFakeContext()
    const second = await applyHost(secondFake.ctx, { dataDir })
    const preserved = await second.api.call('library.list', {})
    check('remount after dispose preserves library data', preserved.total === 1, preserved.total)
    check('remount keeps user_version=8 and v0.8 note tables', Number(second.domain.db.prepare('PRAGMA user_version').get()?.user_version) === 8 &&
      ['note_docs', 'note_revisions', 'note_embeddings'].every((table) =>
        second.domain.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined,
      ))
    const backfilledSort = await second.api.call('library.list', { sort: 'citations', limit: 3 })
    check(
      'remount backfills citation_count from metrics_json',
      backfilledSort.items[0]?.citationCount === 999,
      backfilledSort.items.map((item) => `${item.id}:${item.citationCount ?? 'null'}`),
    )
    await second.dispose()
    await secondFake.disposeAll()

    // ---- bibliography parsers (unit-level) ------------------------------
    const { parseBibtex, parseRis, parseCslJson } = await import('./ingest.js')
    const parsedBib = parseBibtex(`@inproceedings{k1, title={Alpha {Beta}}, author={Smith, John and Doe, Jane}, year={2021}, booktitle={Proc. Test}, doi={https://doi.org/10.1/ABC}}`)
    check('parseBibtex extracts title/author/year/doi', parsedBib.length === 1 && parsedBib[0].authors.length === 2 && parsedBib[0].doi === '10.1/abc', parsedBib)
    const parsedRis = parseRis('TY  - JOUR\nTI  - RIS Paper\nAU  - Doe, Jane\nPY  - 2022\nJO  - Journal\nDO  - 10.2/XYZ\nER  - \n')
    check('parseRis extracts a record', parsedRis.length === 1 && parsedRis[0].title === 'RIS Paper' && parsedRis[0].year === 2022, parsedRis)
    const parsedCsl = parseCslJson(JSON.stringify([{ title: 'CSL Paper', author: [{ given: 'A', family: 'B' }], issued: { 'date-parts': [[2020]] }, DOI: '10.3/csl' }]))
    check('parseCslJson extracts a record', parsedCsl.length === 1 && parsedCsl[0].year === 2020 && parsedCsl[0].doi === '10.3/csl', parsedCsl)

    if (warnings.length > 0) note(`captured ${warnings.length} expected warning(s)`)
    const elapsed = Date.now() - started
    console.log(`\nPASS — ${checks.filter((entry) => !entry.startsWith('note:')).length} checks, ${elapsed}ms\n`)
    for (const entry of checks) console.log(`  ✓ ${entry}`)
  } finally {
    if (service !== undefined && service.active) await service.dispose().catch(() => {})
    await fake.disposeAll().catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Whether a path is an existing regular file. */
async function fileExists(filePath) {
  try {
    const { stat } = await import('node:fs/promises')
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

main().catch((error) => {
  console.error('\nFAIL —', error?.message ?? error)
  if (error?.stack !== undefined) console.error(error.stack)
  process.exitCode = 1
})
