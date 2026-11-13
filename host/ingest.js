/**
 * Import pipeline for the Pappers-Hall Host half (contract §2.1
 * `library.import`, §5 PDF processing).
 *
 * `library.import` does only the synchronous part — validate, hash, deduplicate,
 * persist the paper/version row and copy the original PDF — then returns a job
 * id. Text extraction, caption detection, figure crops, dHash and FTS indexing
 * run in the persistent worker, so the library becomes visible immediately with
 * an honest `processing.pending` state.
 *
 * Every external command is bounded and every per-page/per-figure failure is
 * recorded as `partial`, never silently swallowed.
 *
 * @module pappers-hall/host/ingest
 */
import { statSync } from 'node:fs'
import { copyFile, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildOutline, buildReaderStructure, extractAbstract, LAYOUT_VERSION } from './layout.js'
import { flattenLayoutPages, PdfToolError } from './pdf.js'
import { atomicWriteFile, hashFile, isFile, nowIso, randomHex, readLeadingBytes } from './paths.js'
import { DomainError, invalid, normalizeTitleKey } from './store.js'

/** Caption line pattern: "Figure 1:", "Fig. 2.", "TABLE 3:", "Figure 4a:". */
const CAPTION_PATTERN = /^\s*(fig(?:ure)?\.?|table|algorithm)\s*([0-9]+[a-z]?|[ivx]+)?\s*[:.|]\s*/i

/** Formats accepted by `library.import` besides PDF. */
const BIBLIOGRAPHY_FORMATS = new Set(['bibtex', 'ris', 'csljson'])

/** Infer one input format from an explicit value, the extension, or file bytes. */
async function inferFormat(explicit, filePath) {
  if (typeof explicit === 'string' && explicit !== '' && explicit !== 'auto') return explicit
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.pdf') return 'pdf'
  if (extension === '.bib' || extension === '.bibtex') return 'bibtex'
  if (extension === '.ris') return 'ris'
  if (extension === '.json') return 'csljson'
  try {
    const head = (await readLeadingBytes(filePath, 512)).toString('utf8')
    if (head.startsWith('%PDF-')) return 'pdf'
    if (head.trimStart().startsWith('@')) return 'bibtex'
    if (/^TY\s{2}-/m.test(head)) return 'ris'
    if (head.trimStart().startsWith('[') || /"items"\s*:/.test(head)) return 'csljson'
  } catch {
    // Unreadable inputs are reported by the caller's stat/magic checks.
  }
  return 'pdf'
}

/** Map one thrown error to the API error codes used by import results. */
function importErrorCode(error) {
  if (error instanceof PdfToolError) return error.code
  if (error instanceof DomainError) return error.code
  return 'internal'
}

/**
 * Create the ingest service.
 * @param {object} options ingest options.
 * @param {object} options.store domain store.
 * @param {object} options.search search service.
 * @param {object} options.pdf poppler facade.
 * @param {object} options.queue job queue.
 * @param {object} options.layout owned path table.
 * @param {object} [options.config] plugin config.
 * @param {object} [options.logger] logger.
 * @param {object} options.manifest manifest index ({byId,bySha256,byTitle,fields,available}).
 * @returns {object} ingest service.
 */
export function createIngest({ store, search, pdf, queue, layout, config = {}, logger, manifest }) {
  const maxFiguresPerPaper = Number.isFinite(config.maxFiguresPerPaper) ? config.maxFiguresPerPaper : 80
  const figureDpi = Number.isFinite(config.figureDpi) ? config.figureDpi : 120

  /** Register the job handlers this pipeline owns. */
  function registerHandlers() {
    queue.register('import', (job, api) => processImportJob(job, api))
    queue.register('index', (job, api) => processIndexJob(job, api))
    queue.register('structure', (job, api) => processStructureJob(job, api))
    queue.register('figure-recovery', (job, api) => processFigureRecoveryJob(job, api))
  }

  /* ---------------------------------------------------------------- */
  /* Synchronous import request                                        */
  /* ---------------------------------------------------------------- */

  /**
   * `library.import` — validate/deduplicate/persist inputs, return a job id.
   *
   * Accepted papers are inserted before the job runs so the list shows them as
   * processing; the job then fills text, figures and the index.
   * @param {object} params paths/uploads/field/format/operationId.
   * @returns {Promise<object>} `{jobId, accepted, acceptedItems, duplicates, errors}`.
   */
  async function importRequest(params = {}) {
    const operationId = typeof params.operationId === 'string' ? params.operationId.trim() : ''
    const operationKey = operationId === '' ? null : `operation:library.import:${operationId}`
    if (operationKey !== null) {
      const previous = store.readSetting(operationKey)
      if (previous !== undefined) return previous
    }
    const field = typeof params.field === 'string' && params.field.trim() !== '' ? params.field.trim() : null
    const errors = []
    const duplicates = []
    const acceptedItems = []
    const temporaryUploads = []
    const pdfItems = []
    const bibliographyRecords = []

    try {
      const candidates = []
      if (Array.isArray(params.paths)) {
        for (const rawPath of params.paths) {
          if (typeof rawPath !== 'string' || rawPath.trim() === '') {
            errors.push({ path: String(rawPath ?? ''), code: 'invalid', message: 'empty path' })
            continue
          }
          const resolved = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(process.cwd(), rawPath)
          candidates.push({ path: resolved, displayPath: rawPath, temporary: false })
        }
      }
      if (Array.isArray(params.uploads)) {
        for (const [index, upload] of params.uploads.entries()) {
          const name = typeof upload?.name === 'string' ? upload.name : `upload-${index + 1}.pdf`
          const base64 = typeof upload?.base64 === 'string' ? upload.base64.replace(/^data:[^,]*,/, '') : ''
          if (base64 === '') {
            errors.push({ path: name, code: 'invalid', message: 'upload has no base64 payload' })
            continue
          }
          try {
            const bytes = Buffer.from(base64, 'base64')
            if (bytes.length === 0) throw new Error('decoded upload is empty')
            const temporary = path.join(layout.tmpDir, `upload-${process.pid}-${randomHex(6)}-${index}.pdf`)
            await writeFile(temporary, bytes)
            temporaryUploads.push(temporary)
            candidates.push({ path: temporary, displayPath: name, temporary: true })
          } catch (error) {
            errors.push({ path: name, code: 'invalid', message: String(error?.message ?? error) })
          }
        }
      }
      if (candidates.length === 0 && params.format === undefined) {
        throw invalid('library.import requires paths or uploads')
      }

      for (const candidate of candidates) {
        if (!(await isFile(candidate.path))) {
          errors.push({ path: candidate.displayPath, code: 'not_found', message: 'file does not exist or is not a regular file' })
          continue
        }
        const format = await inferFormat(params.format, candidate.path)
        if (BIBLIOGRAPHY_FORMATS.has(format)) {
          try {
            bibliographyRecords.push({ path: candidate.path, displayPath: candidate.displayPath, format, records: await parseBibliographyFile(candidate.path, format) })
          } catch (error) {
            errors.push({ path: candidate.displayPath, code: importErrorCode(error), message: String(error?.message ?? error) })
          }
          continue
        }
        if (format !== 'pdf') {
          errors.push({ path: candidate.displayPath, code: 'invalid', message: `unsupported import format ${format}` })
          continue
        }
        pdfItems.push(candidate)
      }

      // ---- PDF branch: validate, deduplicate, persist -----------------
      for (const candidate of pdfItems) {
        try {
          const magic = await readLeadingBytes(candidate.path, 5)
          if (magic.toString('latin1') !== '%PDF-') {
            errors.push({ path: candidate.displayPath, code: 'invalid_pdf', message: 'file does not start with %PDF-' })
            continue
          }
          const sha256 = await hashFile(candidate.path)
          const duplicate = store.db.prepare('SELECT paper_id FROM paper_versions WHERE sha256 = ?').get(sha256)
          if (duplicate !== undefined) {
            duplicates.push({ path: candidate.displayPath, paperId: duplicate.paper_id, reason: 'same_file' })
            continue
          }
          const manifestEntry = lookupManifest(candidate.path, sha256)
          const persisted = await persistPdfPaper({ candidate, sha256, manifestEntry, field })
          acceptedItems.push(persisted)
        } catch (error) {
          errors.push({ path: candidate.displayPath, code: importErrorCode(error), message: String(error?.message ?? error) })
        }
      }

      // ---- Bibliography branch: metadata-only papers ------------------
      for (const batch of bibliographyRecords) {
        for (const record of batch.records) {
          try {
            if (typeof record.title !== 'string' || record.title.trim() === '') continue
            const duplicate = findDuplicateRecord(record)
            if (duplicate !== undefined) {
              duplicates.push({ path: batch.displayPath, paperId: duplicate, reason: 'same_record' })
              continue
            }
            acceptedItems.push(persistBibliographyPaper(record, field, batch.format))
          } catch (error) {
            errors.push({ path: batch.displayPath, code: importErrorCode(error), message: String(error?.message ?? error) })
          }
        }
      }

      if (acceptedItems.length > 0) applyImportOrganization(acceptedItems.map((item) => item.paperId), params)
      // Nothing accepted (duplicates/errors only): no background job is needed.
      const job = acceptedItems.length === 0 ? null : queue.enqueue({
        kind: 'import',
        payload: { items: acceptedItems },
        idempotencyKey: operationId === '' ? undefined : `import:${operationId}`,
        total: acceptedItems.length,
        unit: 'papers',
        maxAttempts: 2,
      })
      const result = {
        jobId: job === null ? null : job.id,
        accepted: acceptedItems.length,
        acceptedItems,
        duplicates,
        errors,
      }
      // v0.6: DSH auto-organizes newly imported papers. An explicit target folder
      // wins (no redundant auto-folder); classification failure never blocks the
      // import and is reported in the result for the Client toast.
      if (acceptedItems.length > 0) {
        if (typeof params.collectionId === 'string' && params.collectionId !== '') {
          result.classification = { status: 'skipped', reason: 'explicit target folder was provided', applied: [], createdFolders: [] }
        } else if (params.autoClassify === true) {
          // Opt-in legacy behaviour. The default is agent-driven organization:
          // import only adds the paper; the Agent reads it with basic tools and
          // decides the folder itself (vector similarity is a hint, not a rule).
          try {
            result.classification = await store.classifyImportedPapers(acceptedItems.map((item) => item.paperId))
          } catch (error) {
            result.classification = { status: 'error', error: String(error?.message ?? error), applied: [], createdFolders: [] }
          }
        } else {
          result.classification = {
            status: 'skipped',
            reason: 'agent-driven classification: import leaves the paper unclassified; read it and organize with papers_folders',
            applied: [],
            createdFolders: [],
          }
        }
      }
      if (operationKey !== null) store.writeSetting(operationKey, result)
      store.recordEvent('library.import', null, { accepted: acceptedItems.length, duplicates: duplicates.length, errors: errors.length, jobId: job === null ? null : job.id })
      return result
    } finally {
      // Uploaded bytes are copied into the content-addressed store when accepted;
      // the staging file itself is never needed afterwards.
      for (const temporary of temporaryUploads) await rm(temporary, { force: true }).catch(() => {})
    }
  }

  /** Merge one PDF with manifest metadata and persist paper/version rows. */
  async function persistPdfPaper({ candidate, sha256, manifestEntry, field }) {
    const info = await pdf.info(candidate.path)
    if (info.encrypted) {
      throw new PdfToolError(`PDF is encrypted and cannot be ingested: ${path.basename(candidate.path)}`, 'encrypted', { path: candidate.path })
    }
    const stem = path.basename(candidate.path, path.extname(candidate.path))
    const title = pickText(manifestEntry?.title, info.title, stem)
    const authors = Array.isArray(manifestEntry?.authors) ? manifestEntry.authors : []
    const titleZh = pickText(manifestEntry?.title_zh, null)
    const fieldName = field ?? pickText(manifestEntry?.field_zh, null)
    const fieldId = pickText(manifestEntry?.field_id, null)
    const paperId = `ph-${randomHex(6)}`
    const versionId = `pv-${randomHex(5)}`
    const storedPath = path.join(layout.filesDir, `${sha256}.pdf`)
    if (!(await isFile(storedPath))) {
      const temporary = `${storedPath}.tmp-${process.pid}-${randomHex(4)}`
      await copyFile(candidate.path, temporary)
      await rename(temporary, storedPath)
    }
    const sourceVersion = manifestEntry?.source_version?.label ?? `pdf:${sha256.slice(0, 12)}`
    const metadataDiff = buildMetadataDiff(manifestEntry, info)
    const now = nowIso()
    const pageCount = Number.isFinite(info.pageCount) ? info.pageCount : 0
    store.transaction(() => {
      const db = store.db
      db.prepare(
        `INSERT INTO papers(
           id, title, title_zh, display_title, authors_json, year, venue, field, field_id, state, epoch, read,
           sha256, source_version, license, abstract, doi, arxiv_id, container_title, publication_date,
           volume, issue, pages, article_number, note, manifest_id, current_version_id,
           processing_json, metadata_diff_json, added_at, updated_at, revision, deleted_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?,
                 ?, ?, ?, ?, 0, NULL)`,
      ).run(
        paperId,
        title,
        titleZh,
        JSON.stringify(authors),
        toInteger(manifestEntry?.year),
        pickText(manifestEntry?.venue, null),
        fieldName,
        fieldId,
        sha256,
        sourceVersion,
        pickText(manifestEntry?.license, null),
        pickText(manifestEntry?.abstract, null),
        pickText(manifestEntry?.doi, null),
        pickText(manifestEntry?.arxiv_id, null),
        pickText(manifestEntry?.container_title, null),
        pickText(manifestEntry?.publication_date, null),
        pickText(manifestEntry?.volume, null),
        pickText(manifestEntry?.issue, null),
        pickText(manifestEntry?.pages, null),
        pickText(manifestEntry?.article_number, null),
        pickText(manifestEntry?.id, null),
        versionId,
        JSON.stringify({ state: 'pending', channels: { text: 'pending', figures: 'pending', index: 'pending' } }),
        JSON.stringify(metadataDiff),
        now,
        now,
      )
      db.prepare(
        'INSERT INTO paper_versions(id, paper_id, sha256, bytes, page_count, source_version, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(versionId, paperId, sha256, fileSizeSync(candidate.path), pageCount, sourceVersion, storedPath, now)
    })
    const sources = Array.isArray(manifestEntry?.sources) ? manifestEntry.sources.map((source) => ({ kind: source.kind, url: source.url })) : []
    if (manifestEntry?.pdf_url !== undefined) sources.push({ kind: 'downloaded_pdf', url: manifestEntry.pdf_url })
    if (sources.length > 0) store.replaceSources(paperId, sources)
    search.indexPaper(paperId)
    store.recordEvent('library.import.pdf', paperId, { sha256, manifestId: manifestEntry?.id ?? null })
    return { paperId, versionId }
  }

  /** Insert one bibliography-only paper (no PDF version). */
  function persistBibliographyPaper(record, field, format) {
    const paperId = `ph-${randomHex(6)}`
    const now = nowIso()
    const manifestEntry = record.title === undefined ? undefined : manifest?.byTitle?.get(normalizeTitleKey(record.title))
    const titleZh = pickText(manifestEntry?.title_zh, record.titleZh ?? null)
    const fieldName = field ?? pickText(manifestEntry?.field_zh, pickText(record.field, null))
    store.transaction(() => {
      store.db
        .prepare(
          `INSERT INTO papers(
             id, title, title_zh, display_title, authors_json, year, venue, field, field_id, state, epoch, read,
             sha256, source_version, license, abstract, doi, arxiv_id, container_title, publication_date,
             volume, issue, pages, article_number, note, manifest_id, current_version_id,
             processing_json, metadata_diff_json, added_at, updated_at, revision, deleted_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', 0, 0, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, NULL,
                   ?, '[]', ?, ?, 0, NULL)`,
        )
        .run(
          paperId,
          record.title,
          titleZh,
          JSON.stringify(Array.isArray(record.authors) ? record.authors : []),
          toInteger(record.year),
          pickText(record.venue, record.containerTitle ?? null),
          fieldName,
          pickText(manifestEntry?.field_id, null),
          `${format} import`,
          pickText(manifestEntry?.license, null),
          pickText(record.abstract, null),
          pickText(record.doi, null),
          pickText(record.arxivId, null),
          pickText(record.containerTitle, null),
          pickText(record.volume ?? null, null),
          pickText(record.issue ?? null, null),
          pickText(record.pages ?? null, null),
          pickText(manifestEntry?.id, null),
          JSON.stringify({ state: 'pending', channels: { text: 'none', figures: 'none', index: 'pending' } }),
          now,
          now,
        )
    })
    search.indexPaper(paperId)
    store.recordEvent('library.import.bibliography', paperId, { format })
    return { paperId, versionId: null }
  }

  /** Find an existing paper for one bibliography record (DOI first, then title+year). */
  function findDuplicateRecord(record) {
    const db = store.db
    if (typeof record.doi === 'string' && record.doi.trim() !== '') {
      const row = db.prepare('SELECT id FROM papers WHERE lower(doi) = lower(?) LIMIT 1').get(record.doi.trim())
      if (row !== undefined) return row.id
    }
    const titleKey = normalizeTitleKey(record.title)
    if (titleKey !== '') {
      for (const row of db.prepare('SELECT id, title, title_zh, year FROM papers').all()) {
        if (normalizeTitleKey(row.title) !== titleKey && normalizeTitleKey(row.title_zh) !== titleKey) continue
        if (record.year !== undefined && row.year !== null && Number(row.year) !== Number(record.year)) continue
        return row.id
      }
    }
    return undefined
  }

  /** Resolve manifest metadata for one PDF (hash first, then file name). */
  function lookupManifest(candidatePath, sha256) {
    if (manifest?.available !== true) return undefined
    const bySha = manifest.bySha256.get(sha256.toLowerCase())
    if (bySha !== undefined) return bySha
    const stem = path.basename(candidatePath, path.extname(candidatePath))
    const idMatch = /^([A-Z][0-9]{2})/.exec(stem)
    if (idMatch !== null) {
      const byId = manifest.byId.get(idMatch[1])
      if (byId !== undefined) return byId
    }
    const lowerStem = stem.toLowerCase()
    for (const entry of manifest.byId.values()) {
      if (typeof entry.local_path === 'string' && entry.local_path.toLowerCase().endsWith(`${lowerStem}.pdf`)) return entry
    }
    return undefined
  }

  /* ---------------------------------------------------------------- */
  /* Worker handlers                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Apply v0.2 import organization: tags and a target collection.
   *
   * Field collections are derived from `papers.field`, so importing into one sets
   * the paper field instead of writing a membership row.
   * @param {string[]} paperIds accepted paper ids.
   * @param {object} params import request parameters.
   */
  function applyImportOrganization(paperIds, params) {
    const tags = Array.isArray(params.tags) ? params.tags.map((tag) => (typeof tag === 'string' ? tag.trim() : '')).filter((tag) => tag !== '') : []
    const collectionId = typeof params.collectionId === 'string' && params.collectionId !== '' ? params.collectionId : undefined
    if (tags.length === 0 && collectionId === undefined) return
    const collection = collectionId === undefined ? undefined : store.db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId)
    if (collectionId !== undefined && collection === undefined) {
      throw invalid(`collection ${collectionId} does not exist`)
    }
    const now = nowIso()
    store.transaction(() => {
      for (const paperId of paperIds) {
        for (const name of tags) {
          const short = name.slice(0, 60)
          store.db.prepare('INSERT OR IGNORE INTO tags(name, created_at) VALUES (?, ?)').run(short, now)
          const tag = store.db.prepare('SELECT id FROM tags WHERE name = ?').get(short)
          if (tag !== undefined) {
            store.db.prepare('INSERT OR IGNORE INTO paper_tags(paper_id, tag_id, created_at) VALUES (?, ?, ?)').run(paperId, tag.id, now)
          }
        }
        if (collection !== undefined) {
          store.db
            .prepare('INSERT OR IGNORE INTO paper_collections(collection_id, paper_id, created_at) VALUES (?, ?, ?)')
            .run(collection.id, paperId, now)
        }
      }
    })
    for (const paperId of paperIds) search.indexPaper(paperId)
  }

  /**
   * Import job: extract text, detect/crop figures, then index.
   * @param {object} job parsed job.
   * @param {object} api worker helpers.
   * @returns {Promise<object>} job result.
   */
  async function processImportJob(job, api) {
    const items = Array.isArray(job.payload?.items) ? job.payload.items : []
    if (items.length === 0) return { accepted: 0, failed: [] }
    // Total work is page-count based so progress is comparable across papers.
    let totalPages = 0
    for (const item of items) {
      const version = item.versionId === null ? undefined : store.versionRow(item.versionId)
      totalPages += Math.max(1, Number(version?.page_count ?? 1))
    }
    let donePages = 0
    api.updateProgress(job, 0, totalPages, 'pages')
    const failed = []
    for (const item of items) {
      api.throwIfCancelled(job)
      api.heartbeat(job)
      const checkpoint = api.getCheckpoint(job, `paper:${item.paperId}`)
      const version = item.versionId === null ? undefined : store.versionRow(item.versionId)
      const pageCount = Math.max(1, Number(version?.page_count ?? 1))
      if (checkpoint?.status === 'done') {
        donePages += pageCount
        api.updateProgress(job, donePages, totalPages, 'pages')
        continue
      }
      try {
        if (item.versionId === null) {
          // Bibliography-only item: just make sure its metadata is indexed.
          search.indexPaper(item.paperId)
          const row = store.paperRow(item.paperId)
          if (row !== undefined) {
            store.setPaperStructure(item.paperId, 'ready', {})
            store.updateProcessing(item.paperId, {
              state: 'ready',
              channels: { text: 'none', figures: 'none', index: search.available ? 'ready' : 'partial', structure: 'none' },
            })
          }
        } else {
          await processPaper(item, job, api, (delta) => {
            donePages += delta
            api.updateProgress(job, donePages, totalPages, 'pages')
          })
        }
        api.checkpoint(job, `paper:${item.paperId}`, 'done', { pages: pageCount })
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'cancelled') throw error
        const message = String(error?.message ?? error)
        failed.push({ paperId: item.paperId, code: importErrorCode(error), message })
        logger?.warn?.(`pappers-hall: import of ${item.paperId} failed at page ${donePages}: ${message}`)
        const row = store.paperRow(item.paperId)
        if (row !== undefined) {
          store.updateProcessing(item.paperId, {
            state: 'failed',
            channels: { text: 'failed', figures: 'failed', index: search.available ? 'pending' : 'partial' },
            error: message.slice(0, 500),
          })
        }
        donePages += pageCount
        api.updateProgress(job, donePages, totalPages, 'pages')
      }
    }
    return { accepted: items.length - failed.length, failed }
  }

  /**
   * Extract and index one imported PDF.
   * @param {{paperId:string, versionId:string}} item persisted item.
   * @param {object} job running job.
   * @param {object} api worker helpers.
   * @param {(delta:number)=>void} advance progress callback.
   * @returns {Promise<void>}
   */
  /**
   * Extract text, real layout structure, figures and the abstract/outline for one
   * imported PDF, then publish the paper's processing state.
   *
   * A missing text layer is a real state (scanned PDF) and a failed structure pass
   * degrades to `structure_state='failed'`; neither aborts the batch nor invents
   * content.
   */
  async function processPaper(item, job, api, advance) {
    const version = store.versionRow(item.versionId)
    if (version === undefined || typeof version.file_path !== 'string' || !(await isFile(version.file_path))) {
      throw new DomainError('not_found', `stored PDF for paper ${item.paperId} is missing`)
    }
    const filePath = version.file_path
    const info = await pdf.info(filePath)
    const pageCount = Number.isFinite(info.pageCount) && info.pageCount > 0 ? info.pageCount : Number(version.page_count ?? 0)
    if (pageCount <= 0) throw new PdfToolError('PDF has no readable pages', 'failed', { path: filePath })

    api.throwIfCancelled(job)
    const textResult = await pdf.textPages(filePath)
    api.throwIfCancelled(job)
    // One bbox-layout pass serves both figure caption detection and the v0.2
    // paragraph structure; parsing is pure and cheap compared to the command.
    const layoutDocument = await pdf.layoutDocument(filePath)
    const flatPages = flattenLayoutPages(layoutDocument.pages)
    const layoutByPage = new Map(flatPages.map((page) => [page.page, page]))

    /** Per-page reader structure (v0.2), generated from the real layout. */
    const structures = layoutDocument.pages.map((page, index) => ({ ...buildReaderStructure(page), page: index + 1 }))
    const structureByPage = new Map(structures.map((structure, index) => [index + 1, structure]))

    // Assemble one page row per physical page. A missing text layer is a real
    // state (scanned PDF): keep the page with empty text and mark text partial.
    let textChars = 0
    const pages = []
    for (let page = 1; page <= pageCount; page += 1) {
      const layoutPage = layoutByPage.get(page)
      const structure = structureByPage.get(page)
      const text = textResult.pages[page - 1] ?? ''
      textChars += text.trim().length
      pages.push({
        page,
        width: structure?.width ?? layoutPage?.width ?? info.pageWidth ?? null,
        height: structure?.height ?? layoutPage?.height ?? info.pageHeight ?? null,
        text,
        ...(structure === undefined
          ? { layout: null, structureState: 'pending' }
          : {
              layout: structure,
              structureState: 'ready',
              structureVersion: LAYOUT_VERSION,
              blockCount: structure.blocks?.length ?? 0,
              wordCount: structure.words?.length ?? 0,
            }),
      })
      advance(1)
      if (page % 5 === 0) api.heartbeat(job)
    }
    store.replacePages(item.paperId, version.id, pages)
    search.indexPages(item.paperId)

    let structureState = 'ready'
    if (layoutDocument.failed || structures.length === 0) structureState = 'failed'

    // ---- Abstract and outline from real structure -------------------
    let abstractText = null
    let abstractSource = null
    let outline = []
    if (structureState === 'ready') {
      const extracted = extractAbstract(structures)
      abstractText = extracted.text
      abstractSource = extracted.source
      outline = buildOutline(structures)
      const current = store.paperRow(item.paperId)
      const existingAbstract = typeof current?.abstract === 'string' ? current.abstract.trim() : ''
      if (existingAbstract !== '') {
        // Bibliographic metadata wins over heuristic extraction; keep the source
        // label so the UI never presents a heuristic paragraph as publisher text.
        store.setPaperStructure(item.paperId, 'ready', { outline, abstractSource: current?.abstract_source ?? 'metadata' })
      } else if (abstractText !== null) {
        store.setPaperStructure(item.paperId, 'ready', { outline, abstract: abstractText, abstractSource })
      } else {
        store.setPaperStructure(item.paperId, 'ready', { outline, abstractSource: null })
      }
    } else {
      store.setPaperStructure(item.paperId, 'failed', {})
    }

    // ---- Figure candidates and crops --------------------------------
    let figures = []
    let figuresChannel = 'ready'
    if (flatPages.length === 0) {
      figuresChannel = 'partial'
    } else {
      const candidates = detectFigureCandidates(flatPages).slice(0, maxFiguresPerPaper)
      figures = await buildFigures(item, version, filePath, candidates, layoutByPage)
      if (candidates.length === 0) figuresChannel = 'partial'
      else if (figures.some((figure) => figure.status !== 'ready')) figuresChannel = 'partial'
    }
    store.replaceFigures(item.paperId, version.id, figures)
    search.indexFigures(item.paperId)

    api.throwIfCancelled(job)
    search.indexPaper(item.paperId)
    search.indexPages(item.paperId)
    const textChannel = textChars > 0 ? 'ready' : 'partial'
    const ready = textChannel === 'ready' && figuresChannel === 'ready' && structureState === 'ready'
    store.updateProcessing(item.paperId, {
      state: ready ? 'ready' : 'partial',
      channels: {
        text: textChannel,
        figures: figuresChannel,
        index: search.available ? 'ready' : 'partial',
        structure: structureState,
      },
      ...(textChars === 0 ? { note: 'no extractable text layer; OCR is unavailable in this build' } : {}),
      ...(structureState === 'failed' ? { structureNote: 'bbox-layout structure extraction failed; reader shows plain text' } : {}),
    })
    store.db.prepare('UPDATE paper_versions SET page_count = ? WHERE id = ?').run(pageCount, version.id)
  }

  /** Render/crop/hash every detected figure of one paper. */
  /** Drop resized figure caches so a repaired bbox is served immediately. */
  async function clearFigureCaches(figureId) {
    try {
      for (const name of await readdir(layout.figuresCacheDir)) {
        if (name.startsWith(`${figureId}-w`)) await unlink(path.join(layout.figuresCacheDir, name)).catch(() => {})
      }
    } catch {}
  }

  /**
   * Re-crop existing figure ids in place. This is used by the one-time table-crop
   * repair: figure ids stay stable for annotations/notes, only bbox/crop changes.
   */
  async function repairFigureCrops(paperId, version, filePath, flatPages) {
    const layoutByPage = new Map(flatPages.map((page) => [page.page, page]))
    const candidates = detectFigureCandidates(flatPages).slice(0, maxFiguresPerPaper)
    const rows = store.figureRowsForPaper(paperId)
    const byKey = new Map()
    for (const row of rows) byKey.set(`${Number(row.page)}|${String(row.label ?? '')}`, row)
    let updated = 0
    for (const candidate of candidates) {
      const row = byKey.get(`${candidate.page}|${candidate.label}`)
      if (!row || typeof row.file_name !== 'string' || row.file_name === '') continue
      const layoutPage = layoutByPage.get(candidate.page)
      const pageSize = { width: layoutPage?.width ?? candidate.pageWidth, height: layoutPage?.height ?? candidate.pageHeight }
      try {
        const rendered = await pdf.renderCrop({
          filePath,
          page: candidate.page,
          bbox: candidate.bbox,
          pageSize,
          outputPath: path.join(layout.figuresDir, row.file_name),
          dpi: figureDpi,
        })
        if (typeof row.thumb_name === 'string' && row.thumb_name !== '') {
          await pdf.renderCrop({
            filePath,
            page: candidate.page,
            bbox: candidate.bbox,
            pageSize,
            outputPath: path.join(layout.figuresDir, row.thumb_name),
            targetWidth: 320,
          })
        }
        let dhash = null
        try { dhash = await pdf.cropDhash({ filePath, page: candidate.page, bbox: candidate.bbox, pageSize }) } catch {}
        store.updateFigureCrop(row.id, {
          caption: candidate.caption,
          bboxJson: JSON.stringify({ ...candidate.bbox, pageWidth: candidate.pageWidth, pageHeight: candidate.pageHeight }),
          width: rendered.width,
          height: rendered.height,
          dhash,
          status: 'ready',
        })
        await clearFigureCaches(row.id)
        updated += 1
      } catch (error) {
        logger?.warn?.(`pappers-hall: figure repair crop failed for ${row.id}: ${String(error?.message ?? error)}`)
      }
    }
    return updated
  }

  async function buildFigures(item, version, filePath, candidates, layoutByPage) {
    const figures = []
    for (const candidate of candidates) {
      const figureId = `fg-${randomHex(6)}`
      const fileName = `${figureId}.png`
      const thumbName = `${figureId}.thumb.png`
      const outputPath = path.join(layout.figuresDir, fileName)
      const thumbPath = path.join(layout.figuresDir, thumbName)
      const layoutPage = layoutByPage.get(candidate.page)
      const pageSize = { width: layoutPage?.width ?? candidate.pageWidth, height: layoutPage?.height ?? candidate.pageHeight }
      try {
        const rendered = await pdf.renderCrop({
          filePath,
          page: candidate.page,
          bbox: candidate.bbox,
          pageSize,
          outputPath,
          dpi: figureDpi,
        })
        await pdf.renderCrop({
          filePath,
          page: candidate.page,
          bbox: candidate.bbox,
          pageSize,
          outputPath: thumbPath,
          targetWidth: 320,
        })
        let dhash = null
        try {
          dhash = await pdf.cropDhash({ filePath, page: candidate.page, bbox: candidate.bbox, pageSize })
        } catch (error) {
          logger?.debug?.(`pappers-hall: figure dhash failed for ${figureId}: ${String(error?.message ?? error)}`)
        }
        figures.push({
          id: figureId,
          page: candidate.page,
          label: candidate.label,
          caption: candidate.caption,
          bbox: { ...candidate.bbox, pageWidth: candidate.pageWidth, pageHeight: candidate.pageHeight },
          width: rendered.width,
          height: rendered.height,
          fileName,
          thumbName,
          dhash,
          source: 'caption',
          status: 'ready',
        })
      } catch (error) {
        logger?.warn?.(`pappers-hall: figure crop failed on page ${candidate.page} of ${item.paperId}: ${String(error?.message ?? error)}`)
        figures.push({
          id: figureId,
          page: candidate.page,
          label: candidate.label,
          caption: candidate.caption,
          bbox: { ...candidate.bbox, pageWidth: candidate.pageWidth, pageHeight: candidate.pageHeight },
          width: null,
          height: null,
          fileName: null,
          thumbName: null,
          dhash: null,
          source: 'caption',
          status: 'partial',
        })
      }
    }
    return figures
  }

  /** Index-only job for bibliography imports and maintenance retries. */
  async function processIndexJob(job, api) {
    const paperIds = Array.isArray(job.payload?.paperIds) ? job.payload.paperIds : []
    for (const [index, paperId] of paperIds.entries()) {
      api.throwIfCancelled(job)
      const row = store.paperRow(paperId)
      if (row === undefined) continue
      search.indexPaper(paperId)
      search.indexPages(paperId)
      search.indexFigures(paperId)
      const current = JSON.parse(row.processing_json ?? '{}')
      store.updateProcessing(paperId, {
        state: 'ready',
        channels: {
          text: current?.channels?.text ?? 'none',
          figures: current?.channels?.figures ?? 'none',
          index: search.available ? 'ready' : 'partial',
        },
      })
      api.updateProgress(job, index + 1, paperIds.length, 'papers')
    }
    return { indexed: paperIds.length }
  }

  /**
   * Recover figures for imported papers that ended up with zero figures.
   *
   * Figure detection improves over time (caption separators, layout parsing), and
   * re-importing a 30-paper library just for images is wasteful. This job keeps the
   * paper/version/annotation ids and only re-detects + re-crops figures.
   * @param {object} job running job.
   * @param {object} api worker helpers.
   * @returns {Promise<object>} job result.
   */
  async function processFigureRecoveryJob(job, api) {
    const paperIds = Array.isArray(job.payload?.paperIds) ? job.payload.paperIds.map(String) : []
    const results = []
    for (const [index, paperId] of paperIds.entries()) {
      api.throwIfCancelled(job)
      api.heartbeat(job)
      const paper = store.paperRow(paperId)
      if (paper === undefined || paper.state !== 'active') {
        results.push({ paperId, ok: false, reason: 'not_active' })
        api.updateProgress(job, index + 1, paperIds.length, 'papers')
        continue
      }
      const version = store.latestVersion(paperId)
      if (version === undefined || typeof version.file_path !== 'string' || !(await isFile(version.file_path))) {
        results.push({ paperId, ok: false, reason: 'version_file_missing' })
        api.updateProgress(job, index + 1, paperIds.length, 'papers')
        continue
      }
      const force = job.payload?.force === true
      const existing = Number(store.db.prepare('SELECT COUNT(*) AS count FROM figures WHERE paper_id = ?').get(paperId)?.count ?? 0)
      if (existing > 0 && !force) {
        results.push({ paperId, ok: true, skipped: true, figures: existing })
        api.updateProgress(job, index + 1, paperIds.length, 'papers')
        continue
      }
      try {
        const layoutDocument = await pdf.layoutDocument(version.file_path)
        const flatPages = flattenLayoutPages(layoutDocument.pages)
        const layoutByPage = new Map(flatPages.map((page) => [page.page, page]))
        const candidates = detectFigureCandidates(flatPages).slice(0, maxFiguresPerPaper)
        if (force && existing > 0) {
          const updated = await repairFigureCrops(paperId, version, version.file_path, flatPages)
          search.indexFigures(paperId)
          results.push({ paperId, ok: true, repaired: updated, figures: existing })
        } else {
          const figures = candidates.length === 0 ? [] : await buildFigures({ paperId, versionId: version.id }, version, version.file_path, candidates, layoutByPage)
          store.replaceFigures(paperId, version.id, figures)
          search.indexFigures(paperId)
          results.push({ paperId, ok: true, figures: figures.length })
        }
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'cancelled') throw error
        results.push({ paperId, ok: false, reason: String(error?.message ?? error) })
        logger?.warn?.(`pappers-hall: figure recovery failed for ${paperId}: ${String(error?.message ?? error)}`)
      }
      api.updateProgress(job, index + 1, paperIds.length, 'papers')
    }
    if (job.payload?.force === true) {
      try { store.writeSetting('figure-crop:table-side:v17', 'done') } catch {}
    }
    return { results }
  }

  /**
   * One-time repair for the old table-crop heuristic (captions below tables were
   * cropped as if the table body were below the caption). Existing figure ids are
   * kept so annotations and note references stay valid.
   * @returns {string|undefined} job id.
   */
  function scheduleFigureRepair() {
    try {
      if (store.readSetting('figure-crop:table-side:v17') === 'done') return undefined
    } catch {}
    let rows
    try {
      rows = store.db
        .prepare(
          `SELECT p.id AS id FROM papers p
           WHERE p.state = 'active'
             AND EXISTS (SELECT 1 FROM paper_versions v WHERE v.paper_id = p.id)
             AND EXISTS (SELECT 1 FROM figures f WHERE f.paper_id = p.id)
           LIMIT 500`,
        )
        .all()
    } catch (error) {
      logger?.warn?.(`pappers-hall: figure repair scan failed: ${String(error?.message ?? error)}`)
      return undefined
    }
    if (rows.length === 0) {
      try { store.writeSetting('figure-crop:table-side:v17', 'done') } catch {}
      return undefined
    }
    const idempotencyKey = 'figure-repair:table-side:v17'
    const existing = store.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotencyKey)
    if (existing !== undefined) {
      if (['queued', 'running', 'retry_wait', 'paused'].includes(existing.state)) return existing.id
      if (existing.state === 'succeeded') {
        try { store.writeSetting('figure-crop:table-side:v17', 'done') } catch {}
        return undefined
      }
      try {
        queue.retry(existing.id)
        return existing.id
      } catch {
        return undefined
      }
    }
    const job = queue.enqueue({
      kind: 'figure-recovery',
      payload: { paperIds: rows.map((row) => row.id), force: true },
      idempotencyKey,
      total: rows.length,
      unit: 'papers',
      maxAttempts: 2,
    })
    logger?.info?.(`pappers-hall: scheduled table-crop repair for ${rows.length} paper(s)`)
    return job.id
  }

  /**
   * Schedule the one-time figure recovery after a mount (papers with zero figures).
   * @returns {string|undefined} job id.
   */
  function scheduleFigureRecovery() {
    let rows
    try {
      rows = store.db
        .prepare(
          `SELECT p.id AS id FROM papers p
           WHERE p.state = 'active'
             AND EXISTS (SELECT 1 FROM paper_versions v WHERE v.paper_id = p.id)
             AND NOT EXISTS (SELECT 1 FROM figures f WHERE f.paper_id = p.id)
           LIMIT 200`,
        )
        .all()
    } catch (error) {
      logger?.warn?.(`pappers-hall: figure recovery scan failed: ${String(error?.message ?? error)}`)
      return undefined
    }
    if (rows.length === 0) return undefined
    const idempotencyKey = 'figure-recovery:v1'
    const existing = store.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotencyKey)
    if (existing !== undefined) {
      if (['queued', 'running', 'retry_wait', 'paused'].includes(existing.state)) return existing.id
      if (existing.state === 'succeeded') return undefined
      try {
        queue.retry(existing.id)
        return existing.id
      } catch {
        return undefined
      }
    }
    const job = queue.enqueue({
      kind: 'figure-recovery',
      payload: { paperIds: rows.map((row) => row.id) },
      idempotencyKey,
      total: rows.length,
      unit: 'papers',
      maxAttempts: 2,
    })
    logger?.info?.(`pappers-hall: scheduled figure recovery for ${rows.length} paper(s)`)
    return job.id
  }

  /**
   * Lazily ensure the real structure of one legacy (v0.1) paper.
   *
   * Called from `reader.page`/`reader.layer` when the stored page row has no
   * layout. Enqueues an idempotent `structure` job and reports the pending state
   * immediately, so the reader never blocks on poppler.
   * @param {string} paperId paper id.
   * @returns {{state:'ready'|'pending'|'failed', jobId?:string}}
   */
  function ensureStructure(paperId, options = {}) {
    const paper = store.paperRow(paperId)
    if (paper === undefined) throw new DomainError('not_found', `paper ${paperId} does not exist`)
    if (paper.structure_state === 'ready' && options.force !== true) return { state: 'ready' }
    if (!store.hasVersion(paperId)) {
      // Bibliography-only papers have no pages to structure.
      store.setPaperStructure(paperId, 'ready', {})
      return { state: 'ready' }
    }
    // The mount-time v0.2 backfill regenerates every stale paper; piggyback on it
    // instead of queuing duplicate per-paper work.
    const maintenance = store.db
      .prepare("SELECT id FROM jobs WHERE idempotency_key = ? AND state IN ('queued','running','paused','retry_wait') LIMIT 1")
      .get(`structure-maintenance:v${LAYOUT_VERSION}`)
    if (maintenance !== undefined) return { state: 'pending', jobId: maintenance.id }
    const idempotencyKey = `structure:${paperId}`
    const existing = store.db
      .prepare("SELECT id FROM jobs WHERE idempotency_key = ? AND state IN ('queued','running','paused','retry_wait') LIMIT 1")
      .get(idempotencyKey)
    if (existing !== undefined) return { state: 'pending', jobId: existing.id }
    const job = queue.enqueue({
      kind: 'structure',
      payload: { paperIds: [paperId], force: options.force === true },
      idempotencyKey,
      total: 1,
      unit: 'papers',
      maxAttempts: 2,
    })
    store.setPaperStructure(paperId, 'pending', {})
    return { state: 'pending', jobId: job.id }
  }

  /**
   * Recompute abstract/outline for one paper from its already-stored layout
   * (no poppler, no re-import) — used by the v0.2 backfill.
   * @param {string} paperId paper id.
   * @returns {{abstract:boolean, outline:number}} what was filled.
   */
  function refreshDerivedFromStoredLayout(paperId) {
    const pages = store.pageLayouts(paperId)
    if (pages.length === 0) return { abstract: false, outline: 0 }
    const structures = pages.map((row) => ({ page: row.page, blocks: row.layout.blocks ?? [] }))
    const extracted = extractAbstract(structures)
    const outline = buildOutline(structures)
    const current = store.paperRow(paperId)
    const existingAbstract = typeof current?.abstract === 'string' ? current.abstract.trim() : ''
    if (existingAbstract !== '') {
      store.setPaperStructure(paperId, 'ready', { outline: outline.length > 0 ? outline : undefined, abstractSource: current?.abstract_source ?? 'metadata' })
    } else if (extracted.text !== null) {
      store.setPaperStructure(paperId, 'ready', { outline, abstract: extracted.text })
    } else {
      store.setPaperStructure(paperId, 'ready', { outline })
    }
    return { abstract: extracted.text !== null, outline: outline.length }
  }

  /**
   * Schedule the one-time v0.2 backfill after a plugin mount: regenerate stale
   * layouts and fill missing abstracts/outlines for the existing library, in the
   * background (never blocks the mount or a reader request).
   * @returns {string|undefined} maintenance job id.
   */
  function scheduleMaintenance() {
    let rows
    try {
      rows = store.db
        .prepare(
          `SELECT p.id AS id FROM papers p
           WHERE p.state = 'active'
             AND EXISTS (SELECT 1 FROM paper_versions v WHERE v.paper_id = p.id)
             AND (
               p.structure_state <> 'ready'
               OR COALESCE((SELECT MAX(pp.structure_version) FROM paper_pages pp WHERE pp.paper_id = p.id), 0) < ?
               OR p.abstract IS NULL OR p.abstract = ''
             )
           LIMIT 300`,
        )
        .all(LAYOUT_VERSION)
    } catch (error) {
      logger?.warn?.(`pappers-hall: maintenance scan failed: ${String(error?.message ?? error)}`)
      return undefined
    }
    if (rows.length === 0) return undefined
    const idempotencyKey = `structure-maintenance:v${LAYOUT_VERSION}`
    const existing = store.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotencyKey)
    if (existing !== undefined) {
      if (['queued', 'running', 'retry_wait', 'paused'].includes(existing.state)) return existing.id
      if (existing.state === 'succeeded') return undefined
      try {
        queue.retry(existing.id)
        return existing.id
      } catch {
        return undefined
      }
    }
    const job = queue.enqueue({
      kind: 'structure',
      payload: { paperIds: rows.map((row) => row.id), force: true, maintenance: true },
      idempotencyKey,
      total: rows.length,
      unit: 'papers',
      maxAttempts: 2,
    })
    logger?.info?.(`pappers-hall: scheduled v0.2 structure/abstract backfill for ${rows.length} paper(s)`)
    return job.id
  }

  /**
   * Structure job: generate and persist real page layout for legacy papers.
   * @param {object} job running job.
   * @param {object} api worker helpers.
   * @returns {Promise<object>} job result.
   */
  async function processStructureJob(job, api) {
    const paperIds = Array.isArray(job.payload?.paperIds) ? job.payload.paperIds.map(String) : []
    const results = []
    for (const [index, paperId] of paperIds.entries()) {
      api.throwIfCancelled(job)
      api.heartbeat(job)
      const paper = store.paperRow(paperId)
      if (paper === undefined) {
        results.push({ paperId, ok: false, reason: 'not_found' })
        continue
      }
      const force = job.payload?.force === true
      if (paper.structure_state === 'ready' && !force) {
        results.push({ paperId, ok: true, skipped: true })
        api.updateProgress(job, index + 1, paperIds.length, 'papers')
        continue
      }
      if (force && job.payload?.maintenance === true) {
        // Cheap path: reuse stored page layouts; only regenerate when stale.
        const storedPages = store.pageLayouts(paperId)
        const newest = storedPages.reduce((max, row) => Math.max(max, Number(row.layout?.layoutVersion ?? 0)), 0)
        if (storedPages.length > 0 && newest >= LAYOUT_VERSION) {
          const refreshed = refreshDerivedFromStoredLayout(paperId)
          results.push({ paperId, ok: true, refreshed })
          api.updateProgress(job, index + 1, paperIds.length, 'papers')
          continue
        }
      }
      const version = store.latestVersion(paperId)
      if (version === undefined || typeof version.file_path !== 'string' || !(await isFile(version.file_path))) {
        store.setPaperStructure(paperId, 'failed', {})
        results.push({ paperId, ok: false, reason: 'version_file_missing' })
        api.updateProgress(job, index + 1, paperIds.length, 'papers')
        continue
      }
      try {
        const layoutDocument = await pdf.layoutDocument(version.file_path)
        if (layoutDocument.failed || layoutDocument.pages.length === 0) throw new PdfToolError('bbox-layout extraction failed', 'failed', { paperId })
        const structures = layoutDocument.pages.map((page, index) => ({ ...buildReaderStructure(page), page: index + 1 }))
        store.updatePageLayouts(
          paperId,
          structures.map((structure, index) => ({
            page: index + 1,
            blockCount: structure.blocks?.length ?? 0,
            wordCount: structure.words?.length ?? 0,
            layout: { ...structure, page: index + 1 },
          })),
        )
        const extracted = extractAbstract(structures)
        const outline = buildOutline(structures)
        const current = store.paperRow(paperId)
        const existingAbstract = typeof current?.abstract === 'string' ? current.abstract.trim() : ''
        if (existingAbstract !== '') {
          store.setPaperStructure(paperId, 'ready', { outline, abstractSource: current?.abstract_source ?? 'metadata' })
        } else if (extracted.text !== null) {
          store.setPaperStructure(paperId, 'ready', { outline, abstract: extracted.text, abstractSource: extracted.source })
        } else {
          store.setPaperStructure(paperId, 'ready', { outline, abstractSource: null })
        }
        results.push({ paperId, ok: true, pages: structures.length })
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'cancelled') throw error
        store.setPaperStructure(paperId, 'failed', {})
        results.push({ paperId, ok: false, reason: String(error?.message ?? error) })
        logger?.warn?.(`pappers-hall: structure job failed for ${paperId}: ${String(error?.message ?? error)}`)
      }
      api.updateProgress(job, index + 1, paperIds.length, 'papers')
    }
    return { results }
  }

  return {
    registerHandlers,
    importRequest,
    processImportJob,
    processPaper,
    processIndexJob,
    processStructureJob,
    processFigureRecoveryJob,
    ensureStructure,
    scheduleMaintenance,
    scheduleFigureRecovery,
    scheduleFigureRepair,
    refreshDerivedFromStoredLayout,
    /** Exposed for tests and maintenance: compute caption candidates without IO. */
    detectFigureCandidates,
  }
}

/* ------------------------------------------------------------------ */
/* Figure detection                                                     */
/* ------------------------------------------------------------------ */

/** Plain text of one raw layout block. */
function rawBlockText(block) {
  return (block?.lines ?? []).map((line) => line.text ?? '').join(' ').replace(/\s+/g, ' ').trim()
}

/** Does a block look like a table cell/header rather than prose? */
function looksLikeTableBlock(block, pageWidth) {
  if (!block || !block.bbox) return false
  const body = rawBlockText(block)
  if (body === '' || CAPTION_PATTERN.test(body)) return false
  // Section headings ("A", "A.1", "ADDITIONAL RESULTS") can sit directly above
  // a table and must not become the crop's first row.
  if ((block.lines ?? []).length === 1 && (/^[A-Z](?:\.\d+)*$/.test(body) || (/^[A-Z0-9 .:&()\-]+$/.test(body) && /[A-Z]{3,}/.test(body) && /\s/.test(body)))) return false
  const width = Number(block.bbox.w) || 0
  const lineCount = Math.max(1, (block.lines ?? []).length)
  const average = body.length / lineCount
  // Long prose columns are not table cells. Short headers/cells and narrow
  // symbol columns are.
  if (width > pageWidth * 0.30 && average > 28) return false
  return average <= 32 || width <= pageWidth * 0.24
}

/** Horizontal overlap between a block and the caption band. */
function overlapsCaptionColumn(block, captionLine) {
  const b = block?.bbox
  if (!b) return false
  return b.x < captionLine.xMax && b.x + b.w > captionLine.xMin
}

/**
 * Table captions are not always above the table: many two-column papers put
 * the caption below it. Score the short-cell/text blocks above and below the
 * caption, then crop the side that actually contains the grid.
 */
function tableSideCandidates(page, captionLine, pageWidth, pageHeight) {
  const blocks = Array.isArray(page?.blocks) ? page.blocks : []
  if (blocks.length === 0) return { above: { cells: [], gap: Infinity }, below: { cells: [], gap: Infinity }, peerRight: pageWidth }
  // Side-by-side table captions: do not let the left table pull in the right
  // table when their caption lines are merged into one wide text line.
  const peerRight = (page.lines ?? [])
    .filter((line) => line !== captionLine && CAPTION_PATTERN.test(line.text) && Math.abs(line.yMin - captionLine.yMin) < 36 && line.xMin > captionLine.xMin + 20)
    .reduce((right, line) => Math.min(right, line.xMin - 6), pageWidth)
  const within = (block, side) => {
    if (!block?.bbox || !overlapsCaptionColumn(block, captionLine)) return false
    if (peerRight < pageWidth && block.bbox.x + block.bbox.w > peerRight + 2) return false
    if (side === 'above') {
      const bottom = block.bbox.y + block.bbox.h
      return bottom <= captionLine.yMin + 3 && block.bbox.y >= captionLine.yMin - pageHeight * 0.48
    }
    return block.bbox.y >= captionLine.yMax - 3 && block.bbox.y <= captionLine.yMax + pageHeight * 0.55
  }
  const groups = (cells) => {
    const sorted = [...cells].sort((left, right) => left.bbox.y - right.bbox.y)
    const out = []
    for (const cell of sorted) {
      const last = out[out.length - 1]
      if (last === undefined || cell.bbox.y - last.bottom > 30) out.push({ cells: [cell], bottom: cell.bbox.y + cell.bbox.h })
      else { last.cells.push(cell); last.bottom = Math.max(last.bottom, cell.bbox.y + cell.bbox.h) }
    }
    return out
  }
  const score = (side) => {
    const cells = blocks.filter((block) => within(block, side) && looksLikeTableBlock(block, pageWidth))
    const candidates = groups(cells).map((group) => {
      const distinctColumns = new Set(group.cells.map((block) => Math.round(block.bbox.x / 14))).size
      const top = Math.min(...group.cells.map((block) => block.bbox.y))
      const bottom = Math.max(...group.cells.map((block) => block.bbox.y + block.bbox.h))
      const gap = side === 'above' ? captionLine.yMin - bottom : top - captionLine.yMax
      return { cells: group.cells, score: group.cells.length + distinctColumns * 0.35, gap }
    }).filter((group) => group.cells.length >= 2)
    if (candidates.length === 0) return { cells: [], score: 0, gap: Infinity }
    // Above: use the group nearest the caption (last); below: nearest (first).
    return side === 'above' ? candidates[candidates.length - 1] : candidates[0]
  }
  return { above: score('above'), below: score('below'), peerRight }
}

/** Crop the selected table side, trimming section headings above the grid. */
function tableCropFromSides(page, sides, captionLine, pageWidth, pageHeight, preferredSide) {
  const above = sides.above
  const below = sides.below
  const hasAbove = above.cells.length >= 2
  const hasBelow = below.cells.length >= 2
  let chosen = null
  if (preferredSide === 'above' && hasAbove) chosen = above
  else if (preferredSide === 'below' && hasBelow) chosen = below
  else if (hasAbove && hasBelow) chosen = above.gap <= below.gap + 4 ? above : below
  else chosen = hasAbove ? above : hasBelow ? below : null
  if (chosen === null) return null
  // A narrow caption can sit over only the first columns of a wider table.
  // Take every table cell on the selected side whose row band belongs to this
  // grid; this also keeps side-by-side tables apart through `peerRight`.
  const clusterTop = Math.min(...chosen.cells.map((block) => block.bbox.y)) - 4
  const clusterBottom = Math.max(...chosen.cells.map((block) => block.bbox.y + block.bbox.h)) + 4
  const withinSide = chosen === sides.above
  const rowCells = (page.blocks ?? []).filter((block) => {
    if (!block?.bbox || !looksLikeTableBlock(block, pageWidth)) return false
    if (sides.peerRight < pageWidth && block.bbox.x + block.bbox.w > sides.peerRight + 2) return false
    if (block.bbox.y < clusterTop || block.bbox.y > clusterBottom) return false
    if (captionLine.xMin > pageWidth * 0.45 && !overlapsCaptionColumn(block, captionLine)) return false
    if (withinSide) return block.bbox.y + block.bbox.h <= captionLine.yMin + 3
    return block.bbox.y >= captionLine.yMax - 3
  })
  const expanded = rowCells.length >= chosen.cells.length ? rowCells : chosen.cells
  const chosenCells = expanded
  // Drop section headings that happen to sit just above the table: the real
  // table starts at the first row with at least two cells.
  const rowGroups = []
  for (const cell of [...chosenCells].sort((left, right) => left.bbox.y - right.bbox.y)) {
    const row = rowGroups[rowGroups.length - 1]
    if (row === undefined || cell.bbox.y - row.y > 4) rowGroups.push({ y: cell.bbox.y, cells: [cell] })
    else row.cells.push(cell)
  }
  const firstGridRow = rowGroups.find((row) => row.cells.length >= 2) || null
  const cells = firstGridRow === null ? chosenCells : chosenCells.filter((cell) => cell.bbox.y >= firstGridRow.y - 2)
  const left = Math.min(...cells.map((block) => block.bbox.x)) - 4
  const right = Math.max(...cells.map((block) => block.bbox.x + block.bbox.w)) + 4
  const top = Math.min(...cells.map((block) => block.bbox.y)) - 4
  const bottom = chosen === above
    ? captionLine.yMin - 3
    : Math.max(...cells.map((block) => block.bbox.y + block.bbox.h)) + 4
  return {
    x: clampPoint(left, 0, pageWidth),
    y: clampPoint(top, 0, pageHeight),
    w: clampPoint(right - left, 40, pageWidth),
    h: clampPoint(bottom - top, 40, pageHeight),
  }
}

/** Convenience wrapper used by tests and one-off callers. */
function tableCropFromBlocks(page, captionLine, pageWidth, pageHeight) {
  return tableCropFromSides(page, tableSideCandidates(page, captionLine, pageWidth, pageHeight), captionLine, pageWidth, pageHeight)
}

/** Infer whether this page puts table captions above or below their grids. */
function detectTablePageStyle(page, lines, pageWidth, pageHeight) {
  let style = null
  for (const line of lines) {
    if (!CAPTION_PATTERN.test(line.text) || !/^table/i.test(line.text.trim())) continue
    const sides = tableSideCandidates(page, line, pageWidth, pageHeight)
    const hasAbove = sides.above.cells.length >= 2
    const hasBelow = sides.below.cells.length >= 2
    if (hasAbove && !hasBelow) style = 'above'
    else if (hasBelow && !hasAbove) style = 'below'
  }
  return style
}

/** Bounding box of a table printed sideways under a rotated caption. */
function rotatedTableBbox(page, captionLine, pageWidth, pageHeight) {
  const blocks = Array.isArray(page?.blocks) ? page.blocks : []
  const captionBlock = blocks.find((block) => {
    const b = block?.bbox
    return b && captionLine.yMin >= b.y - 2 && captionLine.yMin <= b.y + b.h + 2 && captionLine.xMin >= b.x - 2 && captionLine.xMin <= b.x + b.w + 2 && CAPTION_PATTERN.test(rawBlockText(block))
  })
  if (!captionBlock || !captionBlock.bbox) return null
  const b = captionBlock.bbox
  if (b.h < b.w * 5 || b.h < pageHeight * 0.4 || b.w > pageWidth * 0.1) return null
  const cells = blocks.filter((block) => {
    const box = block?.bbox
    if (!box || block === captionBlock) return false
    if (box.x < b.x - 20 || box.x > pageWidth * 0.7) return false
    if (box.w > pageWidth * 0.28) return false
    if (box.x >= pageWidth * 0.5) return false
    if (box.y < b.y - 20 || box.y + box.h > b.y + b.h + 20) return false
    return rawBlockText(block).length > 0
  })
  if (cells.length === 0) return null
  const left = Math.min(b.x, ...cells.map((cell) => cell.bbox.x)) - 6
  const right = Math.max(...cells.map((cell) => cell.bbox.x + cell.bbox.w)) + 6
  const top = Math.min(b.y, ...cells.map((cell) => cell.bbox.y)) - 6
  const bottom = Math.max(b.y + b.h, ...cells.map((cell) => cell.bbox.y + cell.bbox.h)) + 6
  return {
    x: clampPoint(left, 0, pageWidth),
    y: clampPoint(top, 0, pageHeight),
    w: clampPoint(right - left, 40, pageWidth),
    h: clampPoint(bottom - top, 40, pageHeight),
  }
}

/** Bottom of the nearest body/author text block above a figure caption. */
function figureTopFromBlocks(page, captionLine, pageWidth, pageHeight) {
  const blocks = Array.isArray(page?.blocks) ? page.blocks : []
  let best = null
  for (const block of blocks) {
    if (!block?.bbox) continue
    const body = rawBlockText(block)
    if (body === '' || CAPTION_PATTERN.test(body)) continue
    if (!overlapsCaptionColumn(block, captionLine)) continue
    const bottom = block.bbox.y + block.bbox.h
    if (bottom > captionLine.yMin + 2) continue
    if (captionLine.yMin - bottom <= 24) continue
    const lines = Math.max(1, (block.lines ?? []).length)
    const average = body.length / lines
    const bodyLike = block.bbox.w > pageWidth * 0.35 && average > 35 && (lines >= 2 || block.bbox.y < pageHeight * 0.3)
    if (!bodyLike) continue
    if (best === null || bottom > best) best = bottom
  }
  // A section heading between the body and the figure is part of the page
  // chrome, not the figure: start below it.
  for (const block of blocks) {
    if (!block?.bbox || !overlapsCaptionColumn(block, captionLine)) continue
    const body = rawBlockText(block)
    const heading = body.length < 90 && (block.lines ?? []).length <= 2 && /^(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\s+[A-Z]/.test(body)
    if (!heading) continue
    const bottom = block.bbox.y + block.bbox.h
    if (bottom <= captionLine.yMin + 2 && best !== null && bottom > best) best = bottom
  }
  return best === null ? null : best + 6
}

/** Bounds of the nearest short-label cluster above a figure caption. */
function figureLabelBounds(page, captionLine, pageWidth, pageHeight) {
  const cells = []
  for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
    if (!block?.bbox) continue
    const body = rawBlockText(block)
    if (body === '' || CAPTION_PATTERN.test(body)) continue
    if (!overlapsCaptionColumn(block, captionLine)) continue
    const bottom = block.bbox.y + block.bbox.h
    if (bottom > captionLine.yMin + 2) continue
    if (block.bbox.y < captionLine.yMin - pageHeight * 0.42) continue
    if (block.bbox.w > pageWidth * 0.35 && body.length / Math.max(1, (block.lines ?? []).length) > 30) continue
    cells.push(block)
  }
  if (cells.length === 0) return null
  cells.sort((left, right) => left.bbox.y - right.bbox.y)
  const groups = []
  for (const cell of cells) {
    const last = groups[groups.length - 1]
    if (last === undefined || cell.bbox.y - last.bottom > 20) groups.push({ top: cell.bbox.y, bottom: cell.bbox.y + cell.bbox.h, left: cell.bbox.x, right: cell.bbox.x + cell.bbox.w })
    else {
      last.bottom = Math.max(last.bottom, cell.bbox.y + cell.bbox.h)
      last.left = Math.min(last.left, cell.bbox.x)
      last.right = Math.max(last.right, cell.bbox.x + cell.bbox.w)
    }
  }
  const group = groups[groups.length - 1]
  if (group === undefined || group.bottom - group.top < pageHeight * 0.04) return null
  return group
}

/** Top of a text-only figure block that ends right above its caption. *//** Top of a text-only figure block that ends right above its caption. */
function figureTextTop(page, captionLine, pageWidth, pageHeight) {
  for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
    if (!block?.bbox) continue
    const body = rawBlockText(block)
    if (body === '' || CAPTION_PATTERN.test(body)) continue
    if (!overlapsCaptionColumn(block, captionLine)) continue
    const bottom = block.bbox.y + block.bbox.h
    if (bottom > captionLine.yMin + 2) continue
    if (captionLine.yMin - bottom > 24) continue
    if (block.bbox.h >= pageHeight * 0.35) return block.bbox.y
  }
  return null
}

/** Does the figure span both columns even though its caption is one column? */
function figureSpansPage(page, captionLine, pageWidth, pageHeight) {
  if (captionLine.xMin > pageWidth * 0.4) return false
  const leftCaption = captionLine.xMin < pageWidth * 0.45
  const otherLeft = leftCaption ? pageWidth * 0.5 : 0
  const otherRight = leftCaption ? pageWidth : pageWidth * 0.5
  const bandTop = Math.max(0, captionLine.yMin - pageHeight * 0.7)
  for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
    if (!block?.bbox) continue
    if (block.bbox.y < pageHeight * 0.08) continue
    if (block.bbox.y + block.bbox.h < bandTop || block.bbox.y >= captionLine.yMin - 2) continue
    const right = block.bbox.x + block.bbox.w
    if (block.bbox.x >= otherRight || right <= otherLeft) continue
    const body = rawBlockText(block)
    if (CAPTION_PATTERN.test(body)) continue
    const lineCount = Math.max(1, (block.lines ?? []).length)
    if (block.bbox.w > pageWidth * 0.3 && body.length / lineCount > 30) return false
    if (lineCount >= 4 && block.bbox.w > pageWidth * 0.2) return false
  }
  return true
}

/** Top of the printable content band, below any running header. */
function pageContentTop(page, pageWidth, pageHeight) {
  let bottom = pageHeight * 0.03
  for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
    if (!block?.bbox) continue
    if (block.bbox.y > pageHeight * 0.1) continue
    if (block.bbox.w < pageWidth * 0.08) continue
    bottom = Math.max(bottom, block.bbox.y + block.bbox.h + 4)
  }
  return Math.min(bottom, pageHeight * 0.12)
}

/**
 * Detect figure/table caption candidates in parsed `-bbox-layout` pages.




 *
 * Figures take the region above their caption. Tables choose the grid side by
 * scoring table-like blocks above and below the caption. Coordinates stay in
 * PDF points; the crop render converts them.
 * @param {Array<{page:number,width:number|null,height:number|null,lines:object[]}>} layoutPages parsed pages.
 * @returns {Array<{page:number,kind:string,label:string,caption:string,bbox:object,pageWidth:number,pageHeight:number}>} candidates.
 */
export function detectFigureCandidates(layoutPages) {
  const candidates = []
  for (const page of layoutPages) {
    const pageWidth = page.width ?? 612
    const pageHeight = page.height ?? 792
    if (pageHeight <= 0 || pageWidth <= 0) continue
    const lines = [...(page.lines ?? [])].filter((line) => Number.isFinite(line.yMin) && Number.isFinite(line.yMax)).sort((left, right) => left.yMin - right.yMin)
    let pageFigures = 0
    let tablePageStyle
    const priorCaptions = []
    const priorRegions = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const match = CAPTION_PATTERN.exec(line.text)
      if (match === null) continue
      const kind = match[1].toLowerCase().startsWith('tab') ? 'table' : match[1].toLowerCase().startsWith('alg') ? 'algorithm' : 'figure'
      // "Figure 1 shows ..." is a body reference, not a caption. Require either a
      // number immediately followed by ':'/'.', or a short line ending in ':'.
      const afterNumber = line.text.slice(match[0].length)
      const looksLikeCaption = match[2] !== undefined && /^[A-Z0-9(“"[]/.test(afterNumber.trimStart()) && afterNumber.trim().length > 0
      if (!looksLikeCaption) continue
      if (pageFigures >= 6) break
      const label = `${kind === 'table' ? 'Table' : kind === 'algorithm' ? 'Algorithm' : 'Figure'}${match[2] === undefined ? '' : ` ${match[2]}`}`
      const caption = captionFromBlocks(page, line) || collectCaptionText(lines, index, line, pageWidth)
      let bbox
      if (kind === 'table') {
        // Captions can be below the grid (common in two-column papers) or above
        // it. Pick the block cluster that actually looks like table cells; an
        // unambiguous table elsewhere on the page settles the page style.
        bbox = rotatedTableBbox(page, line, pageWidth, pageHeight)
        if (bbox === null) {
          if (tablePageStyle === undefined) tablePageStyle = detectTablePageStyle(page, lines, pageWidth, pageHeight)
          const sides = tableSideCandidates(page, line, pageWidth, pageHeight)
          bbox = tableCropFromSides(page, sides, line, pageWidth, pageHeight, tablePageStyle)
        }
        if (bbox === null) {
          // Fallback: conventional caption-above-table crop.
          const nextCaptionTop = findNextCaptionTop(lines, index + 1)
          const bottom = Math.min(nextCaptionTop ?? pageHeight - pageHeight * 0.03, line.yMax + pageHeight * 0.5)
          bbox = {
            x: clampPoint(Math.min(line.xMin - 4, pageWidth * 0.04), 0, pageWidth),
            y: clampPoint(line.yMax + 3, 0, pageHeight),
            w: clampPoint(columnWidth(line, pageWidth), 40, pageWidth),
            h: clampPoint(bottom - line.yMax - 3, 40, pageHeight),
          }
        }
      } else {
        const marginTop = pageContentTop(page, pageWidth, pageHeight)
        const minimumHeight = pageHeight * 0.3
        // Use the nearest body/author block above the caption as the top edge;
        // otherwise a page-top title/authors can leak into the figure crop.
        const blockTop = figureTopFromBlocks(page, line, pageWidth, pageHeight)
        const textTop = figureTextTop(page, line, pageWidth, pageHeight)
        const labelBounds = figureLabelBounds(page, line, pageWidth, pageHeight)
        let top = textTop !== null ? textTop : blockTop !== null ? blockTop : Math.max(marginTop, line.yMin - Math.max(minimumHeight, pageHeight * 0.55))
        if (textTop === null && labelBounds !== null) top = Math.max(top, labelBounds.top)
        top = Math.max(top, marginTop)
        // A previous caption in the same horizontal band blocks the crop: a table
        // above this figure must not be pulled into the figure image.
        for (const prior of priorCaptions) {
          if (prior.bottom > line.yMin + 2) continue
          const overlap = Math.min(prior.right, line.xMax) - Math.max(prior.left, line.xMin)
          if (overlap > 12) top = Math.max(top, prior.bottom + 4)
        }
        for (const prior of priorRegions) {
          if (prior.bottom > line.yMin + 2) continue
          const overlap = Math.min(prior.right, line.xMax) - Math.max(prior.left, line.xMin)
          if (overlap > 12) top = Math.max(top, prior.bottom + 4)
        }
        // If the top edge lands inside a caption/body line, start below it.
        for (const block of page.blocks ?? []) {
          if (!block?.bbox) continue
          const body = rawBlockText(block)
          if (!CAPTION_PATTERN.test(body)) continue
          if (block.bbox.y < top && block.bbox.y + block.bbox.h > top) top = Math.max(top, block.bbox.y + block.bbox.h + 4)
        }
        if (line.yMin - top < pageHeight * 0.12 && blockTop === null) top = Math.max(marginTop, line.yMin - minimumHeight)
        // Keep the figure crop inside its caption column unless the other
        // column is empty above the caption (multi-panel full-width figures
        // often have a narrow caption in one column).
        const wide = figureSpansPage(page, line, pageWidth, pageHeight)
        const captionWidth = line.xMax - line.xMin
        const expandColumn = !wide && line.xMin < pageWidth * 0.12 && captionWidth < pageWidth * 0.32
        let x = wide ? pageWidth * 0.04 : expandColumn ? Math.min(Math.max(0, line.xMin - 4), columnLeft(line, pageWidth)) : Math.max(0, line.xMin - 4)
        let width = wide ? pageWidth * 0.92 : expandColumn ? Math.max(40, columnWidth(line, pageWidth)) : Math.max(40, captionWidth + 8)
        bbox = {
          x: clampPoint(x, 0, pageWidth),
          y: clampPoint(top, 0, pageHeight),
          w: clampPoint(width, 40, pageWidth),
          h: clampPoint(line.yMin - top - 2, 40, pageHeight),
        }
      }
      if (bbox.w < 40 || bbox.h < 40) continue
      candidates.push({ page: page.page, kind, label, caption, bbox, pageWidth, pageHeight })
      priorCaptions.push({ left: Math.max(0, line.xMin - 8), right: Math.min(pageWidth, line.xMax + 8), bottom: line.yMax })
      if (kind === 'table') priorRegions.push({ left: bbox.x, right: bbox.x + bbox.w, bottom: bbox.y + bbox.h })
      pageFigures += 1
    }
  }
  return candidates
}

/** Prefer the full caption block (it already contains all wrapped lines). */
function captionFromBlocks(page, captionLine) {
  for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
    const b = block?.bbox
    if (!b) continue
    if (captionLine.yMin < b.y - 2 || captionLine.yMin > b.y + b.h + 2) continue
    if (captionLine.xMin < b.x - 2 || captionLine.xMin > b.x + b.w + 2) continue
    const body = rawBlockText(block)
    if (!CAPTION_PATTERN.test(body)) continue
    return body.slice(0, 1200)
  }
  return ''
}

/** Collect the caption line plus adjacent continuation lines in the same column. */
function collectCaptionText(lines, index, captionLine, pageWidth) {
  const parts = [captionLine.text.trim()]
  const lineHeight = Math.max(4, captionLine.yMax - captionLine.yMin)
  const columnRight = columnLeft(captionLine, pageWidth) + columnWidth(captionLine, pageWidth) + 12
  let previousBottom = captionLine.yMax
  for (let cursor = index + 1; cursor < lines.length && parts.length < 6; cursor += 1) {
    const line = lines[cursor]
    if (CAPTION_PATTERN.test(line.text)) break
    if (line.yMin - previousBottom > lineHeight * 1.2) break
    if (line.xMin < columnLeft(captionLine, pageWidth) - 12 || line.xMax > columnRight) break
    parts.push(line.text.trim())
    previousBottom = line.yMax
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1200)
}

/** Y coordinate of the next caption line below `start`, or undefined. */
function findNextCaptionTop(lines, start) {
  for (let index = start; index < lines.length; index += 1) {
    if (CAPTION_PATTERN.test(lines[index].text)) return lines[index].yMin
  }
  return undefined
}

/** Left edge of the column a caption belongs to. */
function columnLeft(line, pageWidth) {
  const detected = line.xMin
  if (detected > pageWidth * 0.45) return pageWidth * 0.48
  return pageWidth * 0.04
}

/** Width of the column a caption belongs to. */
function columnWidth(line, pageWidth) {
  if (line.xMax - line.xMin > pageWidth * 0.45) return pageWidth * 0.92
  return pageWidth * 0.46
}

/** Clamp one coordinate. */
function clampPoint(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/* ------------------------------------------------------------------ */
/* Bibliography parsing                                                 */
/* ------------------------------------------------------------------ */

/** Read and parse one bibliography file. */
async function parseBibliographyFile(filePath, format) {
  const text = await readFile(filePath, 'utf8')
  if (format === 'bibtex') return parseBibtex(text)
  if (format === 'ris') return parseRis(text)
  return parseCslJson(text)
}

/**
 * Parse BibTeX into normalized records.
 * @param {string} text BibTeX source.
 * @returns {object[]} records.
 */
export function parseBibtex(text) {
  const records = []
  const source = String(text ?? '')
  let cursor = 0
  while (cursor < source.length) {
    const at = source.indexOf('@', cursor)
    if (at < 0) break
    const head = /^@([A-Za-z]+)\s*([{(])/.exec(source.slice(at))
    if (head === null) {
      cursor = at + 1
      continue
    }
    const entryType = head[1].toLowerCase()
    const openIndex = at + head[0].length - 1
    const closeIndex = findBibtexClose(source, openIndex)
    if (closeIndex < 0) break
    const body = source.slice(openIndex + 1, closeIndex)
    cursor = closeIndex + 1
    if (entryType === 'comment' || entryType === 'preamble' || entryType === 'string') continue
    const fields = parseBibtexFields(body)
    if (typeof fields.title !== 'string' || fields.title.trim() === '') continue
    const authors = splitBibtexAuthors(fields.author)
    records.push({
      title: cleanBibtexValue(fields.title),
      authors,
      year: toInteger(cleanBibtexValue(fields.year)),
      venue: cleanBibtexValue(fields.journal ?? fields.booktitle ?? fields.publisher ?? ''),
      containerTitle: cleanBibtexValue(fields.journal ?? fields.booktitle ?? ''),
      volume: cleanBibtexValue(fields.volume ?? ''),
      issue: cleanBibtexValue(fields.number ?? ''),
      pages: cleanBibtexValue(fields.pages ?? ''),
      doi: normalizeDoi(cleanBibtexValue(fields.doi)),
      arxivId: cleanBibtexValue(fields.eprint ?? '') || arxivFromDoi(cleanBibtexValue(fields.doi)),
      url: cleanBibtexValue(fields.url ?? ''),
      abstract: cleanBibtexValue(fields.abstract ?? ''),
      titleZh: null,
      type: entryType,
    })
  }
  return records
}

/** Find the matching close brace/paren of one BibTeX entry. */
function findBibtexClose(source, openIndex) {
  const open = source[openIndex]
  const close = open === '{' ? '}' : ')'
  let depth = 0
  let inQuotes = false
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '"') inQuotes = !inQuotes
    if (inQuotes) continue
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Parse `name = value` pairs out of a BibTeX entry body. */
function parseBibtexFields(body) {
  const fields = {}
  let cursor = 0
  while (cursor < body.length) {
    const nameMatch = /([A-Za-z][A-Za-z0-9_:.+-]*)\s*=/g
    nameMatch.lastIndex = cursor
    const found = nameMatch.exec(body)
    if (found === null) break
    const name = found[1].toLowerCase()
    let valueStart = found.index + found[0].length
    while (valueStart < body.length && /\s/.test(body[valueStart])) valueStart += 1
    let valueEnd = valueStart
    const first = body[valueStart]
    if (first === '{') {
      let depth = 0
      for (; valueEnd < body.length; valueEnd += 1) {
        const char = body[valueEnd]
        if (char === '\\') {
          valueEnd += 1
          continue
        }
        if (char === '{') depth += 1
        else if (char === '}') {
          depth -= 1
          if (depth === 0) {
            valueEnd += 1
            break
          }
        }
      }
    } else if (first === '"') {
      valueEnd += 1
      for (; valueEnd < body.length; valueEnd += 1) {
        if (body[valueEnd] === '\\') valueEnd += 1
        else if (body[valueEnd] === '"') {
          valueEnd += 1
          break
        }
      }
    } else {
      while (valueEnd < body.length && body[valueEnd] !== ',' && body[valueEnd] !== '\n') valueEnd += 1
    }
    if (Object.hasOwn(fields, name) === false) fields[name] = body.slice(valueStart, valueEnd).trim()
    cursor = Math.max(valueEnd, found.index + found[0].length)
  }
  return fields
}

/** Strip outer braces and common TeX escapes from one BibTeX value. */
function cleanBibtexValue(raw) {
  if (typeof raw !== 'string') return ''
  let value = raw.trim()
  if (value.startsWith('{') && value.endsWith('}')) value = value.slice(1, -1)
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  return value
    .replace(/\\['`"^~=.]\{?([A-Za-z])\}?/g, '$1')
    .replace(/\\[a-z]+\{([^{}]*)\}/gi, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split a BibTeX author field into structured author objects. */
function splitBibtexAuthors(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return cleanBibtexValue(value)
    .split(/\s+and\s+/i)
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .map((name) => {
      if (name.includes(',')) {
        const [family, given] = name.split(',').map((part) => part.trim())
        return { ...(given ? { given } : {}), ...(family ? { family } : {}) }
      }
      const parts = name.split(/\s+/)
      if (parts.length === 1) return { literal: name }
      return { given: parts.slice(0, -1).join(' '), family: parts.at(-1) }
    })
}

/** Parse RIS records. */
export function parseRis(text) {
  const records = []
  const blocks = String(text ?? '').split(/^ER\s{2}-.*$/m)
  for (const block of blocks) {
    const fields = {}
    for (const line of block.split('\n')) {
      const match = /^([A-Z][A-Z0-9])\s{2}- (.*)$/.exec(line.trimEnd())
      if (match === null) continue
      if (Object.hasOwn(fields, match[1])) {
        if (Array.isArray(fields[match[1]])) fields[match[1]].push(match[2].trim())
        else fields[match[1]] = [fields[match[1]], match[2].trim()]
      } else fields[match[1]] = match[2].trim()
    }
    const title = firstValue(fields.TI ?? fields.T1)
    if (title === '') continue
    const authors = toArray(fields.AU ?? fields.A1).map((name) => {
      const parts = name.split(',').map((part) => part.trim())
      if (parts.length === 2) return { family: parts[0], given: parts[1] }
      return { literal: name }
    })
    records.push({
      title,
      authors,
      year: toInteger(firstValue(fields.PY ?? fields.Y1)),
      venue: firstValue(fields.JO ?? fields.JF ?? fields.T2 ?? fields.PB),
      containerTitle: firstValue(fields.JO ?? fields.T2),
      volume: firstValue(fields.VL),
      issue: firstValue(fields.IS),
      pages: joinPages(firstValue(fields.SP), firstValue(fields.EP)),
      doi: normalizeDoi(firstValue(fields.DO)),
      arxivId: '',
      url: firstValue(fields.UR),
      abstract: firstValue(fields.AB ?? fields.N2),
      titleZh: null,
      type: firstValue(fields.TY),
    })
  }
  return records
}

/** Parse CSL-JSON (array or `{items:[...]}`). */
export function parseCslJson(text) {
  const parsed = JSON.parse(String(text ?? 'null'))
  const elements = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
  const records = []
  for (const element of elements) {
    if (element === null || typeof element !== 'object') continue
    const title = typeof element.title === 'string' ? element.title : ''
    if (title === '') continue
    const authors = Array.isArray(element.author)
      ? element.author.map((author) => {
          if (author === null || typeof author !== 'object') return null
          if (typeof author.literal === 'string') return { literal: author.literal }
          const family = typeof author.family === 'string' ? author.family : ''
          const given = typeof author.given === 'string' ? author.given : ''
          if (family === '' && given === '') return null
          return { ...(given === '' ? {} : { given }), ...(family === '' ? {} : { family }) }
        }).filter((author) => author !== null)
      : []
    const issued = Array.isArray(element.issued?.['date-parts']) ? element.issued['date-parts'][0] : undefined
    records.push({
      title,
      authors,
      year: Array.isArray(issued) && issued.length > 0 ? toInteger(issued[0]) : undefined,
      venue: typeof element['container-title'] === 'string' ? element['container-title'] : '',
      containerTitle: typeof element['container-title'] === 'string' ? element['container-title'] : '',
      volume: element.volume === undefined ? '' : String(element.volume),
      issue: element.issue === undefined ? '' : String(element.issue),
      pages: element.page === undefined ? '' : String(element.page),
      doi: normalizeDoi(element.DOI),
      arxivId: '',
      url: typeof element.URL === 'string' ? element.URL : '',
      abstract: typeof element.abstract === 'string' ? element.abstract : '',
      titleZh: typeof element['title-zh'] === 'string' ? element['title-zh'] : null,
      type: typeof element.type === 'string' ? element.type : 'article-journal',
    })
  }
  return records
}

/** First string of a possibly-multi-valued RIS field. */
function firstValue(value) {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : ''
  return typeof value === 'string' ? value.trim() : ''
}

/** Normalize one RIS field to an array. */
function toArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  return typeof value === 'string' && value.trim() !== '' ? [value.trim()] : []
}

/** Join start/end page values. */
function joinPages(start, end) {
  if (start === '') return ''
  return end === '' || end === start ? start : `${start}-${end}`
}

/** Normalize a DOI value (strip URL prefixes, lowercase). */
function normalizeDoi(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()
}

/** Derive an arXiv id from one DOI when possible. */
function arxivFromDoi(doi) {
  if (typeof doi !== 'string') return ''
  const match = /10\.48550\/arxiv\.(.+)$/i.exec(doi.trim())
  return match === null ? '' : match[1]
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

/** First non-empty trimmed string. */
function pickText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/** Coerce one value to a year integer. */
function toInteger(value) {
  if (value === null || value === undefined) return null
  const number = Number.parseInt(String(value), 10)
  return Number.isFinite(number) ? number : null
}

/** File size for the version row (best effort; store transactions are synchronous). */
function fileSizeSync(filePath) {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

/**
 * Compare manifest metadata against PDF metadata and record differences without
 * overwriting either source (contract §6).
 * @param {object|undefined} manifestEntry manifest record.
 * @param {object} info pdfinfo facts.
 * @returns {Array<{field:string, manifestValue:any, pdfValue:any, status:string}>}
 */
function buildMetadataDiff(manifestEntry, info) {
  if (manifestEntry === undefined) return []
  const diff = []
  const compare = (field, manifestValue, pdfValue) => {
    const manifestText = typeof manifestValue === 'string' ? manifestValue.trim() : manifestValue
    const pdfText = typeof pdfValue === 'string' ? pdfValue.trim() : pdfValue
    if ((manifestText === null || manifestText === undefined || manifestText === '') && (pdfText === null || pdfText === undefined || pdfText === '')) return
    if (manifestText === null || manifestText === undefined || manifestText === '') {
      diff.push({ field, manifestValue: null, pdfValue: pdfText ?? null, status: 'pdf_only' })
      return
    }
    if (pdfText === null || pdfText === undefined || pdfText === '') {
      diff.push({ field, manifestValue: manifestText, pdfValue: null, status: 'manifest_only' })
      return
    }
    const same = normalizeTitleKey(String(manifestText)) === normalizeTitleKey(String(pdfText))
    diff.push({ field, manifestValue: manifestText, pdfValue: pdfText, status: same ? 'match' : 'different' })
  }
  compare('title', manifestEntry.title, info.title)
  const manifestAuthors = Array.isArray(manifestEntry.authors)
    ? manifestEntry.authors.map((author) => author?.literal ?? [author?.given, author?.family].filter(Boolean).join(' ')).join(', ')
    : ''
  compare('authors', manifestAuthors, info.author)
  return diff
}

/** Atomically write one text artifact (kept small so it can be reused by future exports). */
export async function writeTextArtifact(targetPath, content) {
  await atomicWriteFile(targetPath, content)
}

export { PdfToolError }
