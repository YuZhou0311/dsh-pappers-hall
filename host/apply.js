/**
 * Host assembly for the Pappers-Hall plugin.
 *
 * `applyHost(ctx, config)` opens the plugin-owned SQLite library, wires the
 * domain store, search, ingest pipeline and persistent job worker, registers the
 * Agent tools and (when the profile composes one) the `/pappers-hall/` HTTP
 * routes, then returns a service object whose `dispose()` releases everything.
 *
 * Design rules enforced here:
 * - Every registration happens inside one `ctx.effect`, whose cleanup closes the
 *   database, stops the worker and disposes routes/tools. The returned
 *   `dispose()` delegates to the same cleanup and is idempotent, so the root
 *   plugin row (`ctx.effect(() => () => service.dispose())`) can call it safely
 *   after an HMR unload already ran the effect.
 * - Optional services (webServer, attachments, translator, subprocess) degrade:
 *   a missing service is reported in `status()/diagnostics()` and never throws.
 * - A second `applyHost` in the same process first disposes the previous
 *   installation, so a reload never duplicates routes, tools or timers.
 *
 * @module pappers-hall/host/apply
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { closeDatabase, openDatabase, migrate, probeFts5, SCHEMA_VERSION, readUserVersion } from './db.js'
import { createAi } from './ai.js'
import { createTranslate } from './translate.js'
import { createApi, createWebHandler, DEFAULT_BODY_LIMIT_BYTES } from './api.js'
import { createBackup, importBackup } from './backup.js'
import { createClassify } from './classify.js'
import { createEmbedding } from './embedding.js'
import { createModels } from './models.js'
import { createOcr } from './ocr.js'
import { createSettings } from './settings.js'
import { createIngest } from './ingest.js'
import { createJobQueue } from './jobs.js'
import { createCommandRunner, createPdfTools } from './pdf.js'
import { ensureLayout, layoutFor, readJsonIfPresent, readPluginVersion, resolveDataDir, resolveFixtureDir, clampInt } from './paths.js'
import { createSearch } from './search.js'
import { createStore, emptyManifest, manifestIndex } from './store.js'
import { createNotes } from './notes.js'
import { buildToolDefinitions, prunePdfPreviewCache } from './tools.js'
import { createNoteAgent } from './note-agent.js'

/** Plugin id used by `status`, the Loader row and the Client. */
export const PLUGIN_ID = 'dsh-pappers-hall'

/**
 * HTTP prefix owned by this plugin.
 *
 * The web server matches a prefix only when the request path equals it or starts
 * with `${prefix}/`, so the registered prefix must NOT carry a trailing slash —
 * otherwise `/pappers-hall/api` would never match. The public URL space is still
 * `/pappers-hall/*`, exactly as the contract specifies.
 */
export const ROUTE_PREFIX = '/pappers-hall'

/**
 * Fixed system-prompt guidance for the composer reference chip.
 *
 * The Client keeps the attachment out of the message text (it is a chip above
 * the composer), so this section teaches the model to resolve it through
 * `papers_references` and then read only that bundle. Registered through the optional `systemPrompt` service and disposed
 * with the other registrations.
 */
export const MATERIALS_PROMPT =
  'The user can attach Pappers-Hall materials (papers, figures, annotations, notes) to a message with the ' +
  'reference chip above the composer. Nothing about that attachment appears in the message text, so when the ' +
  'message asks about papers or notes, call papers_references (no arguments) once to get the attached bundle_id ' +
  'and its material list. If it returns status:"empty", nothing is attached — answer from the library or ask. ' +
  'When a bundle is returned, read it with papers_search scope:"reference_bundle" and that bundle_id instead of ' +
  'scanning the whole library. For notes use kinds:["note"]: bundle-scoped results include the note id, ' +
  'title, snippet and text, so do not guess which note was attached and do not scan the whole note library; ' +
  'use notes_get with the returned note id if the full note is needed. For papers use papers_get_passage or ' +
  'papers_get_figure with the same bundle_id. papers_get_figure returns the real figure image; when its JSON ' +
  'reports image.status other than "ready", say the image is unavailable instead of describing it.'

/** Stable system-prompt section name owned by this plugin. */
export const MATERIALS_PROMPT_SECTION = 'plugin:pappers-hall-materials'

/**
 * v0.6 system-prompt guidance: DSH manages the paper library for the user.
 *
 * This is what makes the Agent use the management tools proactively: find
 * related literature, ALWAYS preview a PDF and ask before importing it into the
 * paper center, auto-organize through folders, and never invent papers.
 */
export const MANAGEMENT_PROMPT =
  'You are connected to the user\'s Pappers-Hall paper center through papers_* tools. ' +
  'When the user asks to find literature, recommends papers, or asks what exists on a topic: call papers_search (mode:"search" or "related") first; for an exact title/DOI pass ai:false ' +
  '(semantic neighbors; Chinese queries work), then papers_get_passage when you need exact text. Never invent papers, numbers or quotes. ' +
  'For 精读/全文/逐段/方法细节/结果表 requests: call papers_get with view:"outline" first, then read every relevant page in batches ' +
  'with papers_get_passage pages:[...] or page_start/page_end, and state which pages were covered. Do not answer a deep-read ' +
  'request from the abstract or a few key pages. For a quick “讲什么” summary, selective reading is acceptable but do not claim it was a full read. ' +
  'Do not rely on figure/table captions alone: before summarizing or evaluating a paper, inspect its key visuals. For a library paper use ' +
  'papers_get view:"outline" (figures list) then papers_get_figure; for an unimported PDF use papers_pdf read/inspect (which return a visuals ' +
  'list of label/page/caption) then papers_pdf action:"view" with the label. For a quick summary inspect at least the main results figure/table; ' +
  'for a deep read cover every figure/table cited by the results and say what the visual actually shows. ' +
  'In summaries, attach page numbers (e.g. p.8) and figure/table labels to key quantitative claims. If you only read a caption, ' +
  'say so instead of implying you viewed the image. After importing, report only metadata edits you actually performed. ' +
  'For an unimported local PDF path/attachment, do not run bash/pdftotext/pdfimages and do not search the library first: use papers_pdf. ' +
  'It works for any PDF, not just papers; inspect/looksLikePaper is advisory, while read/view/ocr still work for non-paper documents. ' +
  'Call action:"inspect" to decide whether it is a paper, action:"read" for page text, and action:"view" with page or label (e.g. Figure 2) ' +
  'to inspect a figure/table as a real image. If action:"read" reports no_text_layer (image-only PDF), use action:"view" or action:"ocr" ' +
  '(when the paper-centre OCR service is installed/enabled); do not fall back to bash/pdftotext. ' +
  'When the user uploads a PDF or mentions a PDF path/attachment: FIRST call papers_pdf with action:"inspect" to inspect it, ' +
  'then read its contentSample/signals and decide whether it is genuinely an academic paper. Only if it is a paper, briefly say what it is and ' +
  'ask whether to add it to the paper center; only after explicit agreement call papers_pdf action:"import" with confirm:true. If it is not a paper (invoice, slides, form, ' +
  'random document), say so and do not ask to import. Import does NOT auto-classify: the paper lands unclassified, so after importing tell the ' +
  'user it is unclassified and offer to read it and organize it yourself. If the user declines, do not import. ' +
  'ORGANIZE LIKE A HUMAN LIBRARIAN, NOT LIKE A CLASSIFIER: when the user asks to classify/organize papers, first READ them with papers_list ' +
  '(metadata + abstract) and papers_get / papers_get_passage when details matter; identify each paper\'s domain, method and research question; ' +
  'then design a small, explainable taxonomy (usually 2–6 top-level folders with topic names, no folder named after a single paper, no empty folder) ' +
  'and apply it with papers_manage (folder actions create/rename/assign/unassign; action:"hints" is reference only). Embedding hints are references ONLY — ' +
  'never let a similarity score make the decision, and never create a folder just because a threshold was crossed. Explain the grouping criteria ' +
  'and the placement of borderline papers; confirm with the user before deleting folders or moving many papers at once. ' +
  'Use papers_get view:"cite" for citations, papers_get_figure / papers_pdf for real images, and never add/remove tags (tags are human-only). ' +
  'A conversation reference like `@论文中心(paper:ph-… )` or `@论文中心(folder:cl-… )` means the user attached that paper/folder: resolve it with the papers_* tools.'

/** Stable system-prompt section name for v0.6 management guidance. */
export const MANAGEMENT_PROMPT_SECTION = 'plugin:pappers-hall-management'

/** Only one installation may be active per process; reloads dispose the previous one. */
let activeInstallation = null

/** Serializes overlapping `applyHost` calls (Loader reload during startup). */
let applyChain = Promise.resolve()

/**
 * @typedef {object} HostService
 * @property {string} id plugin id.
 * @property {string} version plugin package version.
 * @property {string} dataDir absolute data directory.
 * @property {string} dbPath absolute SQLite path.
 * @property {object} layout owned path table.
 * @property {object} domain domain store (internal/test surface).
 * @property {object} api JSON API facade.
 * @property {object} queue job queue (internal/test surface).
 * @property {object} search search service.
 * @property {object} ingest ingestion service.
 * @property {object} pdf poppler facade.
 * @property {object[]} degraded known degradation entries at mount time.
 * @property {() => Promise<void>} dispose idempotent teardown.
 */

/**
 * Mount the Pappers-Hall Host half.
 * @param {object} ctx Cordis plugin context.
 * @param {object} [config] plugin row config.
 * @returns {Promise<HostService>} the mounted service.
 */
export function applyHost(ctx, config = {}) {
  const task = applyChain.then(() => applyHostNow(ctx, config ?? {}))
  // Keep the chain alive after a failed mount so a retry can still run.
  applyChain = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

/**
 * Resolve and sanity-check the row config; unknown keys are ignored on purpose
 * so a newer Client/row cannot fail the whole plugin.
 * @param {object} config raw row config.
 * @returns {object} resolved config.
 */
export function resolveConfig(config = {}) {
  const pdfTools = config.pdfTools !== null && typeof config.pdfTools === 'object' ? config.pdfTools : undefined
  return {
    dataDir: resolveDataDir(config),
    fixtureDir: resolveFixtureDir(config),
    testMode: config.testMode === true,
    pdfTools,
    workerPollMs: clampInt(config.workerPollMs ?? 1000, 200, 60_000, 1000),
    leaseMs: clampInt(config.leaseMs ?? 60_000, 5_000, 3_600_000, 60_000),
    maxFiguresPerPaper: clampInt(config.maxFiguresPerPaper ?? 80, 0, 500, 80),
    figureDpi: clampInt(config.figureDpi ?? 120, 40, 300, 120),
    figureSearchMaxDistance: clampInt(config.figureSearchMaxDistance ?? 10, 0, 32, 10),
    bodyLimitBytes: clampInt(config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES, 1_048_576, 200 * 1024 * 1024, DEFAULT_BODY_LIMIT_BYTES),
    commandTimeoutMs: clampInt(config.commandTimeoutMs ?? 120_000, 5_000, 600_000, 120_000),
    // v0.2 AI channel (LLM direct). All limits are explicit so a slow profile
    // can never turn a paper read into an unbounded model wait.
    aiTimeoutMs: clampInt(config.aiTimeoutMs ?? 25_000, 2_000, 180_000, 25_000),
    aiMaxConcurrency: clampInt(config.aiMaxConcurrency ?? 2, 1, 8, 2),
    aiMaxInputChars: clampInt(config.aiMaxInputChars ?? 6_000, 500, 60_000, 6_000),
    aiMaxOutputTokens: clampInt(config.aiMaxOutputTokens ?? 1_600, 64, 16_000, 1_600),
    aiCacheTtlHours: clampInt(config.aiCacheTtlHours ?? 72, 1, 8_760, 72),
    aiRerank: config.aiRerank !== false,
    aiRerankTimeoutMs: clampInt(config.aiRerankTimeoutMs ?? 8_000, 2_000, 30_000, 8_000),
    aiProvider: typeof config.aiProvider === 'string' ? config.aiProvider : undefined,
    aiModel: typeof config.aiModel === 'string' ? config.aiModel : undefined,
    translationProvider: typeof config.translationProvider === 'string' ? config.translationProvider : undefined,
    translationFallback: config.translationFallback !== false,
    translationTimeoutMs: clampInt(config.translationTimeoutMs ?? 6_000, 1_000, 30_000, 6_000),
    translationMaxConcurrency: clampInt(config.translationMaxConcurrency ?? 2, 1, 4, 2),
    translationCacheTtlHours: clampInt(config.translationCacheTtlHours ?? 720, 1, 8_760, 720),
    translationForcedFailures: Array.isArray(config.translationForcedFailures) ? config.translationForcedFailures : [],
    libreUrl: typeof config.libreUrl === 'string' ? config.libreUrl : undefined,
    libreApiKey: typeof config.libreApiKey === 'string' ? config.libreApiKey : undefined,
    // v0.5-B local embedding component (optional; setup script installs it).
    embeddingPython: typeof config.embeddingPython === 'string' && config.embeddingPython !== '' ? config.embeddingPython : undefined,
    embeddingCacheDir: typeof config.embeddingCacheDir === 'string' && config.embeddingCacheDir !== '' ? config.embeddingCacheDir : undefined,
    embeddingModel: typeof config.embeddingModel === 'string' && config.embeddingModel !== '' ? config.embeddingModel : undefined,
    embeddingDisabled: config.embeddingDisabled === true,
    embeddingBatchSize: clampInt(config.embeddingBatchSize ?? 16, 1, 64, 16),
    embeddingReadyTimeoutMs: clampInt(config.embeddingReadyTimeoutMs ?? 25_000, 1_000, 120_000, 25_000),
    embeddingRequestTimeoutMs: clampInt(config.embeddingRequestTimeoutMs ?? 60_000, 1_000, 300_000, 60_000),
    // v0.11 optional OCR component (user-installed from the settings panel).
    ocrDir: typeof config.ocrDir === 'string' && config.ocrDir !== '' ? config.ocrDir : undefined,
    ocrPython: typeof config.ocrPython === 'string' && config.ocrPython !== '' ? config.ocrPython : undefined,
    ocrRenderWidth: clampInt(config.ocrRenderWidth ?? 1600, 600, 2400, 1600),
    python3: typeof config.python3 === 'string' && config.python3 !== '' ? config.python3 : undefined,
    classifyThreshold: Number.isFinite(Number(config.classifyThreshold)) ? Number(config.classifyThreshold) : undefined,
  }
}

/** Build a logger adapter that works with and without a Cordis logger. */
function makeLogger(ctx) {
  const target = ctx?.logger
  const forward = (level, args) => {
    try {
      if (target !== undefined && typeof target[level] === 'function') {
        target[level](...args)
        return
      }
    } catch {
      // Never let logging break plugin lifecycle.
    }
    if (level === 'warn' || level === 'error') console[level](...args)
  }
  return {
    debug: (...args) => forward('debug', args),
    info: (...args) => forward('info', args),
    warn: (...args) => forward('warn', args),
    error: (...args) => forward('error', args),
  }
}

/**
 * Detect the running DSH version without importing DSH packages (profile
 * installs do not resolve them). Uses the profile's `pluginPackages` service
 * when composed, then falls back to `unknown`.
 * @param {object} ctx Cordis context.
 * @returns {Promise<string>} host version label.
 */
async function detectHostVersion(ctx) {
  try {
    const packages = typeof ctx?.get === 'function' ? ctx.get('pluginPackages') : undefined
    if (packages !== undefined && typeof packages.packageOf === 'function') {
      for (const specifier of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot']) {
        const found = packages.packageOf(specifier, import.meta.url)
        const version = found?.version ?? found?.manifest?.version
        if (typeof version === 'string' && version !== '') return version
      }
    }
  } catch {
    // Package metadata is diagnostic-only.
  }
  if (typeof process.env.DSH_VERSION === 'string' && process.env.DSH_VERSION !== '') return process.env.DSH_VERSION
  // The composed client graph carries the exact Host release (version + commit).
  try {
    const modules = typeof ctx?.get === 'function' ? ctx.get('clientModules') : undefined
    const release = typeof modules?.graph === 'function' ? modules.graph()?.release : undefined
    if (typeof release?.version === 'string' && release.version !== '') {
      return release.commit ? `${release.version}+${String(release.commit).slice(0, 8)}` : release.version
    }
  } catch {
    // Release metadata is diagnostic-only.
  }
  // Desktop Electron: the runtime package inside app.asar declares the version.
  try {
    const resources = process.resourcesPath
    if (typeof resources === 'string' && resources !== '') {
      const manifest = JSON.parse(readFileSync(path.join(resources, 'app.asar', 'dsh', 'package.json'), 'utf8'))
      if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
    }
  } catch {
    // A non-Electron Host simply has no resources path.
  }
  return 'unknown'
}

/**
 * Load the developer manifest when the fixture checkout is present.
 * @param {string} fixtureDir fixture root candidate.
 * @returns {Promise<object>} manifest index (empty when absent).
 */
async function loadManifest(fixtureDir) {
  const manifest = await readJsonIfPresent(path.join(fixtureDir, 'papers', 'manifest.json'))
  if (manifest === undefined) return emptyManifest()
  try {
    return manifestIndex(manifest)
  } catch {
    return emptyManifest()
  }
}

/** Env-gated lifecycle trace, used by the selftest and by field diagnostics. */
function trace(...args) {
  if (process.env.PAPPERS_HOST_TRACE === '1') console.error('[pappers-hall]', ...args)
}

/** Dispose one previous installation, tolerating partial teardown. */
async function disposePrevious(logger) {
  if (activeInstallation === null) return
  const previous = activeInstallation
  activeInstallation = null
  try {
    await previous.dispose()
  } catch (error) {
    logger?.warn?.(`pappers-hall: previous installation cleanup failed: ${String(error?.message ?? error)}`)
  }
}

/** Real mount implementation. */
async function applyHostNow(ctx, config) {
  trace('begin')
  const logger = makeLogger(ctx)
  await disposePrevious(logger)
  const resolved = resolveConfig(config ?? {})

  await ensureLayout(layoutFor(resolved.dataDir))
  const layout = layoutFor(resolved.dataDir)
  // Keep local PDF preview thumbnails bounded across restarts as well.
  await prunePdfPreviewCache(path.join(layout.tmpDir, 'pdf-previews'))
  trace('layout ready', layout.dataDir)
  const manifest = await loadManifest(resolved.fixtureDir)
  trace('manifest', manifest.available, manifest.byId?.size)
  const [pluginVersion, hostVersion] = await Promise.all([readPluginVersion(), detectHostVersion(ctx)])
  trace('versions', pluginVersion, hostVersion)

  const db = openDatabase(layout.dbPath)
  let fts5 = false
  try {
    const probe = probeFts5(db)
    const migration = migrate(db, { fts5: probe })
    fts5 = migration.fts5 === true
    trace('db migrated', fts5)
    if (probe !== true) logger.warn('pappers-hall: SQLite FTS5 unavailable; search degrades to deterministic LIKE scan')
  } catch (error) {
    closeDatabase(db)
    throw error
  }

  // The command runner prefers ctx.subprocess when composed; node fallback keeps
  // a minimal profile and the selftest functional.
  const run = createCommandRunner({ ctx, logger, defaultTimeoutMs: resolved.commandTimeoutMs })
  const pdf = createPdfTools({ run, commands: resolved.pdfTools, logger, timeoutMs: resolved.commandTimeoutMs })
  trace('detecting poppler')
  let detection
  try {
    detection = await pdf.detect()
    trace('poppler', detection.available, detection.version)
  } catch (error) {
    detection = { available: false, version: null, missing: [], versions: {} }
    logger.warn(`pappers-hall: PDF tool detection failed: ${String(error?.message ?? error)}`)
  }

  const identity = {
    pluginId: PLUGIN_ID,
    pluginVersion,
    hostVersion,
    pdfAvailable: detection.available === true,
  }
  const store = createStore({
    db,
    layout,
    fts5,
    config: resolved,
    logger,
    manifest,
    ctx,
    identity,
  })
  const ai = createAi({ ctx, store, layout, pdf, config: resolved, logger })
  const settings = createSettings({ db, config: resolved, logger, identity, layout })
  const translate = createTranslate({ ctx, store, ai, config: resolved, logger, settings })
  const embedding = createEmbedding({ db, config: resolved, logger, settings })
  // v0.17 notes workbench: own tables + FTS + independent note_embeddings index.
  // The embedding service is attached after construction so the vector channel can
  // degrade honestly when the optional local model is absent.
  const notes = createNotes({ db, logger })
  notes.attach({ embedding })
  const noteAgent = createNoteAgent({ ctx, notes, store, ai, layout, logger, config: resolved })
  const classify = createClassify({ db, embedding, ai, config: resolved, logger })
  const search = createSearch({
    db,
    store,
    embedding,
    settings,
    fts5,
    logger,
    ai,
    aiRerank: resolved.aiRerank,
    figureDistance: resolved.figureSearchMaxDistance,
  })
  const timer = (typeof ctx?.get === 'function' ? ctx.get('timer') : undefined) ?? ctx?.timer
  const queue = createJobQueue({
    db,
    logger,
    timer,
    pollMs: resolved.workerPollMs,
    leaseMs: resolved.leaseMs,
  })
  embedding.install(queue)
  const ocr = createOcr({ db, pdf, search, queue, layout, settings, config: resolved, logger })
  ocr.registerHandlers(queue)
  const models = createModels({ db, queue, embedding, ocr, settings, config: resolved, logger })
  models.registerHandlers(queue)
  settings.bind({ embedding, translate, search, store, models, ocr, queue })
  const ingest = createIngest({ store, search, pdf, queue, layout, config: resolved, logger, manifest })
  ingest.registerHandlers()
  trace('writer stack ready')
  store.attach({ search, ingest, queue, pdf, ai, translate, embedding, classify, settings, ocr, models, notes, ctx })
  try {
    const autoIndex = embedding.autoIndexIfNeeded()
    if (autoIndex !== undefined && autoIndex !== null && autoIndex.job !== undefined && autoIndex.job !== null) trace('embedding auto-index queued', autoIndex.job.id)
  } catch (error) {
    logger?.warn?.(`pappers-hall: embedding auto-index failed: ${String(error?.message ?? error)}`)
  }
  const api = createApi({ store, search, ingest, queue, settings, models, ocr, notes, noteAgent, layout })
  const webHandler = createWebHandler({
    api,
    store,
    pdf,
    layout,
    search,
    logger,
    bodyLimitBytes: resolved.bodyLimitBytes,
    backup: {
      export: () => createBackup({ db, layout, version: pluginVersion, schemaVersion: SCHEMA_VERSION }),
      import: (buffer) => importBackup({ db, layout, search, buffer }),
    },
  })
  const toolDefinitions = buildToolDefinitions({ store, search, ctx, layout, logger, config: resolved, classify, ingest, pdf, embedding, notes, ocr })
  trace('api+tools ready', toolDefinitions.length)

  /** Mount-time degradation facts (status() recomputes them live as well). */
  const degraded = []
  if (!detection.available) degraded.push({ channel: 'poppler', reason: `missing PDF tools: ${(detection.missing ?? []).join(', ') || 'unknown'}` })
  if (!fts5) degraded.push({ channel: 'fts', reason: 'FTS5 unavailable; LIKE scan only' })
  degraded.push({ channel: 'vector', reason: 'no embedding model installed' })
  degraded.push({ channel: 'ocr', reason: 'no OCR engine composed' })
  if ((typeof ctx?.get === 'function' ? ctx.get('translator') : undefined) === undefined) degraded.push({ channel: 'translation', reason: 'no translator service composed' })
  if ((typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined) === undefined) degraded.push({ channel: 'attachments', reason: 'no attachment service composed' })
  if ((typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined) === undefined) degraded.push({ channel: 'subprocess', reason: 'node:child_process fallback in use' })
  const aiFacts = ai.status()
  if (aiFacts.available !== true) degraded.push({ channel: 'ai', reason: aiFacts.reason ?? 'AI channel unavailable' })

  let disposed = false
  /** @type {import('./apply.js').HostService} */
  const service = {
    id: PLUGIN_ID,
    version: pluginVersion,
    dataDir: layout.dataDir,
    dbPath: layout.dbPath,
    layout,
    domain: store,
    api,
    queue,
    search,
    ingest,
    ai,
    translate,
    classify,
    settings,
    models,
    ocr,
    notes,
    pdf,
    degraded,
    config: resolved,
    /** Whether the material-token system-prompt section is registered. */
    promptRegistered: false,
    /** Internal handler used by the route registration (also exported for tests). */
    handler: webHandler,
    /**
     * True while this installation owns the process-level registration.
     * @returns {boolean}
     */
    get active() {
      return disposed === false
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await effectDisposeRef()
      } finally {
        if (activeInstallation === service) activeInstallation = null
      }
    },
  }

  /** Assigned by the effect below; used by `service.dispose`. */
  let effectDisposeRef = async () => {}
  /** Set by the effect body once the system-prompt section is registered. */
  let promptSectionRegistered = false
  /** v0.6 management prompt section registration flag. */
  let managementPromptRegistered = false

  trace('registering effects')
  let effectHandle
  try {
    effectHandle = ctx.effect(async () => {
      const disposers = []
      try {
        // ---- Agent tools --------------------------------------------
        if (ctx?.tools !== undefined && typeof ctx.tools.register === 'function') {
          for (const definition of toolDefinitions) {
            try {
              disposers.push(ctx.tools.register(definition))
            } catch (error) {
              logger.warn(`pappers-hall: tool registration failed for ${definition.name}: ${String(error?.message ?? error)}`)
            }
          }
        } else {
          logger.warn('pappers-hall: ctx.tools is unavailable; Agent tools were not registered')
        }

        // ---- System prompt guidance (optional service) ----------------
        // The Client's draft token is the only bundle identity the model sees, so
        // the Host must explain how to convert it into a tools call.
        const systemPrompt = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined
        if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
          try {
            const order =
              typeof systemPrompt.getSectionOrder === 'function' ? systemPrompt.getSectionOrder('FILE_REFERENCE') : undefined
            disposers.push(
              systemPrompt.section({
                name: MATERIALS_PROMPT_SECTION,
                order: Number.isFinite(order) ? order + 1 : 901,
                text: MATERIALS_PROMPT,
              }),
            )
            promptSectionRegistered = true
          } catch (error) {
            logger.warn(`pappers-hall: system prompt section registration failed: ${String(error?.message ?? error)}`)
          }
          try {
            const order =
              typeof systemPrompt.getSectionOrder === 'function' ? systemPrompt.getSectionOrder('FILE_REFERENCE') : undefined
            disposers.push(
              systemPrompt.section({
                name: MANAGEMENT_PROMPT_SECTION,
                order: Number.isFinite(order) ? order + 2 : 902,
                text: MANAGEMENT_PROMPT,
              }),
            )
            managementPromptRegistered = true
          } catch (error) {
            logger.warn(`pappers-hall: management prompt section registration failed: ${String(error?.message ?? error)}`)
          }
        } else {
          logger.debug('pappers-hall: systemPrompt service absent; material-token guidance is not registered (degraded)')
        }

        // Diagnostics: which agent tools / prompt section this host registered.
        try {
          store.setAgentFacts?.({ tools: toolDefinitions.map((definition) => definition.name), promptSection: promptSectionRegistered || managementPromptRegistered })
        } catch {}

        // ---- HTTP routes (optional service) --------------------------
        // `ctx.inject` re-runs the callback whenever webServer appears/disappears,
        // so a profile that composes the web server later still gets the route.
        let webRoutesMounted = false
        const mountWebRoutes = (webCtx) => {
          webCtx.effect(() => {
            const disposeRoute = webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: webHandler })
            webRoutesMounted = true
            return () => {
              webRoutesMounted = false
              disposeRoute()
            }
          }, 'pappers-hall: web routes')
        }
        if (typeof ctx?.inject === 'function') {
          try {
            const fiber = ctx.inject(['webServer'], (webCtx) => {
              mountWebRoutes(webCtx)
            })
            disposers.push(async () => {
              try {
                await fiber?.dispose?.()
              } catch (error) {
                logger.debug(`pappers-hall: web route fiber disposal failed: ${String(error?.message ?? error)}`)
              }
            })
            // A satisfied injection runs the callback before `inject` returns;
            // an unsatisfied one stays pending until the service appears. Give a
            // satisfied injection one macrotask to settle so mount reports the
            // route truthfully, without awaiting the fiber object itself (a
            // Cordis Fiber is itself a thenable and must not be awaited here).
            const webServerPresent = typeof ctx.get === 'function' && ctx.get('webServer') !== undefined
            if (webServerPresent && !webRoutesMounted) {
              for (let attempt = 0; attempt < 20 && !webRoutesMounted; attempt += 1) {
                await new Promise((resolve) => setImmediate(resolve))
              }
            }
          } catch (error) {
            logger.warn(`pappers-hall: web server injection failed: ${String(error?.message ?? error)}`)
          }
        } else if (typeof ctx?.get === 'function' && ctx.get('webServer') !== undefined) {
          mountWebRoutes(ctx)
        } else {
          logger.debug('pappers-hall: webServer service absent; HTTP routes stay unregistered (degraded)')
        }

        // ---- Persistent worker --------------------------------------
        queue.start()
        disposers.push(() => queue.stop())
        try {
          const maintenanceJobId = ingest.scheduleMaintenance()
          if (maintenanceJobId !== undefined) logger.info(`pappers-hall: v0.2 backfill job ${maintenanceJobId} queued`)
          const figureJobId = ingest.scheduleFigureRecovery()
          if (figureJobId !== undefined) logger.info(`pappers-hall: figure recovery job ${figureJobId} queued`)
          const repairJobId = ingest.scheduleFigureRepair()
          if (repairJobId !== undefined) logger.info(`pappers-hall: figure crop repair job ${repairJobId} queued`)
        } catch (error) {
          logger.warn(`pappers-hall: v0.2 backfill scheduling failed: ${String(error?.message ?? error)}`)
        }

        return async () => {
          try {
            translate.close()
          } catch (error) {
            logger.warn(`pappers-hall: translation close failed: ${String(error?.message ?? error)}`)
          }
          try {
            notes.close()
          } catch (error) {
            logger.warn(`pappers-hall: notes close failed: ${String(error?.message ?? error)}`)
          }
          try {
            embedding.close()
          } catch (error) {
            logger.warn(`pappers-hall: embedding close failed: ${String(error?.message ?? error)}`)
          }
          try {
            ocr.close()
          } catch (error) {
            logger.warn(`pappers-hall: OCR close failed: ${String(error?.message ?? error)}`)
          }
          try {
            ai.close()
          } catch (error) {
            logger.warn(`pappers-hall: AI close failed: ${String(error?.message ?? error)}`)
          }
          try {
            queue.stop()
          } catch (error) {
            logger.warn(`pappers-hall: worker stop failed: ${String(error?.message ?? error)}`)
          }
          for (const dispose of disposers.reverse()) {
            try {
              await dispose()
            } catch (error) {
              logger.debug(`pappers-hall: disposer failed: ${String(error?.message ?? error)}`)
            }
          }
          closeDatabase(db)
        }
      } catch (error) {
        for (const dispose of disposers.reverse()) {
          try {
            await dispose()
          } catch {}
        }
        closeDatabase(db)
        throw error
      }
    }, 'pappers-hall: host')
  } catch (error) {
    closeDatabase(db)
    throw error
  }
  try {
    effectDisposeRef = await effectHandle
    trace('effects installed')
  } catch (error) {
    closeDatabase(db)
    throw error
  }
  service.promptRegistered = promptSectionRegistered
  // `identity` is the shared object the store reads for diagnostics; mutating it
  // here lets `diagnostics` report the prompt section honestly after mount.
  identity.promptRegistered = promptSectionRegistered
  if (!promptSectionRegistered) {
    degraded.push({ channel: 'systemPrompt', reason: 'systemPrompt service unavailable; reference-bundle token guidance is not registered' })
  }
  activeInstallation = service
  logger.debug(`pappers-hall: mounted (dataDir=${layout.dataDir}, schema=${SCHEMA_VERSION}, actual=${readUserVersion(db)}, prompt=${promptSectionRegistered})`)
  return service
}

export { SCHEMA_VERSION }
