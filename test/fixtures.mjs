/**
 * Fixture validator for the Pappers-Hall acceptance suite (`--dry-run`).
 *
 * The dry run never calls the plugin API. It proves the inputs are internally
 * consistent *before* a single live request is made:
 * - the five devkit JSON fixtures parse and keep their audited case counts
 *   (60 paper queries / 10 seed annotations / 10 annotation queries / 3 visual
 *   understanding tasks),
 * - every expected paper id and document SHA-256 resolves against
 *   `papers/manifest.json`,
 * - the 30 bundled PDFs exist, start with `%PDF-`, and match the manifest
 *   SHA-256 and byte size,
 * - the planned live case counts of each suite agree with those fixtures.
 *
 * Running it: `node test/fixtures.mjs` (or `node test/run-tests.mjs --dry-run`).
 *
 * @module pappers-hall/test/fixtures
 */
import path from 'node:path'
import {
  DEVKIT,
  EXPECTED_COUNTS,
  FIXTURES_DIR,
  HARNESS_VERSION,
  MANIFEST_FILE,
  PAPERS_DIR,
  PDF_DIR,
  artifactPath,
  fileSize,
  fmtDuration,
  isMain,
  listFiles,
  loadFixtures,
  parseArgs,
  flagBool,
  readJsonFile,
  sha256File,
  writeJsonFile,
} from './lib.mjs'

/** Figure label shape the fixtures use (single or `Figure 2 and Figure 3`). */
const FIGURE_LABEL_PATTERN = /^(?:Fig(?:ure)?\.?\s*\d+)(?:\s+(?:and|&)\s+(?:Fig(?:ure)?\.?\s*\d+))?$/i
/** SHA-256 hex digest shape. */
const SHA256_PATTERN = /^[a-f0-9]{64}$/
/** Devkit-relative paths used by visual tasks. */
const VISUAL_IMAGE_PREFIX = 'tests/visual_fixtures/'

/**
 * Accumulate one check result.
 * @param {object[]} checks accumulator.
 * @param {string} id stable check id.
 * @param {boolean} ok whether the check passed.
 * @param {unknown} [expected] expected value.
 * @param {unknown} [actual] actual value.
 * @param {string} [detail] diagnostic.
 * @returns {boolean} `ok` for chaining.
 */
function addCheck(checks, id, ok, expected, actual, detail) {
  checks.push({
    id,
    ok: ok === true,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    ...(detail === undefined ? {} : { detail }),
  })
  return ok === true
}

/**
 * Count array entries by one key, returning a plain object.
 * @param {object[]} rows source rows.
 * @param {(row:object)=>string} keyOf key selector.
 * @returns {Record<string,number>} counts.
 */
function countBy(rows, keyOf) {
  const counts = {}
  for (const row of rows) {
    const key = String(keyOf(row))
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * Validate every fixture and the bundled PDFs.
 * @param {{hashPdfs?:boolean, verbose?:boolean}} [options] options.
 * @returns {Promise<object>} dry-run result.
 */
export async function validateFixtures(options = {}) {
  const startedAt = Date.now()
  const hashPdfs = options.hashPdfs !== false
  const checks = []
  const warnings = []
  /** @type {object} */
  let fixtures
  try {
    fixtures = loadFixtures()
  } catch (error) {
    return {
      ok: false,
      generated_at: new Date().toISOString(),
      harness_version: HARNESS_VERSION,
      duration_ms: Date.now() - startedAt,
      checks: [],
      errors: [{ id: 'fixtures.load', message: String(error?.message ?? error) }],
      warnings: [],
      stats: {},
    }
  }
  const { manifest, papers, manifestById, manifestBySha, queryList, seedList, annotationQueryList, visualList, metadataCases } = fixtures

  /* ---------------------------------------------------------------- */
  /* 1. Fixture case counts and audited kinds                          */
  /* ---------------------------------------------------------------- */
  addCheck(checks, 'fixtures.queries.count', queryList.length === EXPECTED_COUNTS.paperQueries, EXPECTED_COUNTS.paperQueries, queryList.length)
  addCheck(checks, 'fixtures.seed_annotations.count', seedList.length === EXPECTED_COUNTS.seedAnnotations, EXPECTED_COUNTS.seedAnnotations, seedList.length)
  addCheck(checks, 'fixtures.annotation_queries.count', annotationQueryList.length === EXPECTED_COUNTS.annotationQueries, EXPECTED_COUNTS.annotationQueries, annotationQueryList.length)
  addCheck(checks, 'fixtures.visual_understanding.count', visualList.length === EXPECTED_COUNTS.visualUnderstanding, EXPECTED_COUNTS.visualUnderstanding, visualList.length)

  const queryKinds = countBy(queryList, (query) => query.kind)
  const expectedKindCounts = {
    figure_recall: 12,
    semantic_recall: 24,
    figure_recall_and_understanding: 18,
    fuzzy_recall: 6,
  }
  addCheck(checks, 'fixtures.queries.kinds', JSON.stringify(queryKinds) === JSON.stringify(expectedKindCounts), expectedKindCounts, queryKinds)

  for (const [label, rows, idOf] of [
    ['queries', queryList, (row) => row.id],
    ['seed_annotations', seedList, (row) => row.id],
    ['annotation_queries', annotationQueryList, (row) => row.id],
    ['visual_understanding', visualList, (row) => row.id],
  ]) {
    const ids = rows.map(idOf)
    const unique = new Set(ids)
    addCheck(checks, `fixtures.${label}.unique_ids`, unique.size === ids.length, `${ids.length} unique ids`, `${unique.size} unique ids`)
    const missingIds = ids.filter((id) => typeof id !== 'string' || id.trim() === '')
    addCheck(checks, `fixtures.${label}.ids_present`, missingIds.length === 0, 'every row has a non-empty id', missingIds.length)
  }

  /* ---------------------------------------------------------------- */
  /* 2. Manifest structure and paper identity                          */
  /* ---------------------------------------------------------------- */
  addCheck(checks, 'manifest.schema_version', manifest.schema_version === '1.0', '1.0', manifest.schema_version)
  addCheck(checks, 'manifest.papers.count', papers.length === EXPECTED_COUNTS.manifestPapers, EXPECTED_COUNTS.manifestPapers, papers.length)
  addCheck(checks, 'manifest.fields.count', Array.isArray(manifest.fields) && manifest.fields.length === EXPECTED_COUNTS.manifestFields, EXPECTED_COUNTS.manifestFields, manifest.fields?.length)
  const idCounts = countBy(papers, (paper) => paper.id)
  addCheck(checks, 'manifest.papers.unique_ids', Object.keys(idCounts).length === papers.length, `${papers.length} unique ids`, `${Object.keys(idCounts).length} unique ids`)
  const fieldCounts = countBy(papers, (paper) => paper.field_id)
  const perFieldCorrect = Object.keys(fieldCounts).length === EXPECTED_COUNTS.manifestFields && Object.values(fieldCounts).every((count) => count === EXPECTED_COUNTS.papersPerField)
  addCheck(checks, 'manifest.papers.fields_5x6', perFieldCorrect, '5 fields x 6 papers', fieldCounts)

  const badHashes = papers.filter((paper) => typeof paper.sha256 !== 'string' || !SHA256_PATTERN.test(paper.sha256))
  addCheck(checks, 'manifest.papers.sha256_shape', badHashes.length === 0, '30 x 64-hex sha256', badHashes.map((paper) => paper.id))
  const uniqueSha = new Set(papers.map((paper) => String(paper.sha256 ?? '').toLowerCase()))
  addCheck(checks, 'manifest.papers.sha256_unique', uniqueSha.size === papers.length, `${papers.length} unique sha256`, `${uniqueSha.size} unique sha256`)
  const badPages = papers.filter((paper) => !Number.isInteger(paper.page_count) || paper.page_count < 1)
  addCheck(checks, 'manifest.papers.page_count', badPages.length === 0, 'positive integer page_count per paper', badPages.map((paper) => paper.id))
  addCheck(checks, 'manifest.counts.papers', Number(manifest.counts?.papers) === EXPECTED_COUNTS.manifestPapers, EXPECTED_COUNTS.manifestPapers, manifest.counts?.papers)
  addCheck(checks, 'manifest.counts.paper_queries', Number(manifest.counts?.paper_queries) === EXPECTED_COUNTS.paperQueries, EXPECTED_COUNTS.paperQueries, manifest.counts?.paper_queries)
  addCheck(checks, 'manifest.counts.per_field', Number(manifest.counts?.per_field) === EXPECTED_COUNTS.papersPerField, EXPECTED_COUNTS.papersPerField, manifest.counts?.per_field)

  /* ---------------------------------------------------------------- */
  /* 3. Bundled PDFs exist and match the manifest oracle               */
  /* ---------------------------------------------------------------- */
  const allPdfDirFiles = listFiles(PDF_DIR)
  const pdfFiles = allPdfDirFiles.filter((name) => name.toLowerCase().endsWith('.pdf'))
  const nonPdfFiles = allPdfDirFiles.filter((name) => !name.toLowerCase().endsWith('.pdf'))
  if (nonPdfFiles.length > 0) warnings.push({ id: 'pdf.dir.non_pdf_files', message: `non-PDF files in papers/pdf are ignored (${nonPdfFiles.join(', ')})` })
  const expectedLocalNames = papers.map((paper) => path.basename(String(paper.local_path ?? '')))
  const unexpected = pdfFiles.filter((name) => !expectedLocalNames.includes(name))
  const missingPdfs = expectedLocalNames.filter((name) => !pdfFiles.includes(name))
  addCheck(checks, 'pdf.dir.count', pdfFiles.length === EXPECTED_COUNTS.manifestPapers && unexpected.length === 0, EXPECTED_COUNTS.manifestPapers, pdfFiles.length, unexpected.length > 0 ? `unexpected PDFs: ${unexpected.join(', ')}` : undefined)
  addCheck(checks, 'pdf.dir.manifest_names', missingPdfs.length === 0, 'every manifest local_path exists', missingPdfs)
  const pdfChecks = []
  if (hashPdfs) {
    for (const paper of papers) {
      const filePath = path.join(DEVKIT, String(paper.local_path ?? ''))
      const actualSize = fileSize(filePath)
      const actualSha = actualSize === null ? null : await sha256File(filePath)
      const expectedSha = String(paper.sha256 ?? '').toLowerCase()
      const sizeOk = actualSize === Number(paper.size_bytes)
      const shaOk = actualSha === expectedSha
      pdfChecks.push({ id: paper.id, size_expected: paper.size_bytes, size_actual: actualSize, sha256_expected: expectedSha, sha256_actual: actualSha, size_ok: sizeOk, sha256_ok: shaOk })
    }
    const shaMismatch = pdfChecks.filter((row) => row.sha256_ok !== true)
    const sizeMismatch = pdfChecks.filter((row) => row.size_ok !== true)
    addCheck(checks, 'pdf.manifest.sha256_match', shaMismatch.length === 0, 'all 30 PDF sha256 match manifest', shaMismatch.map((row) => row.id))
    addCheck(checks, 'pdf.manifest.size_match', sizeMismatch.length === 0, 'all 30 PDF byte sizes match manifest', sizeMismatch.map((row) => row.id))
  } else {
    warnings.push({ id: 'pdf.manifest.hash_skipped', message: 'PDF SHA-256 verification skipped (--no-hash)' })
  }
  const magicChecks = []
  for (const paper of papers) {
    const filePath = path.join(DEVKIT, String(paper.local_path ?? ''))
    try {
      const { readFileSync } = await import('node:fs')
      const head = readFileSync(filePath, { encoding: 'latin1', flag: 'r' }).slice(0, 5)
      magicChecks.push({ id: paper.id, magic_ok: head === '%PDF-' })
    } catch (error) {
      magicChecks.push({ id: paper.id, magic_ok: false, error: String(error?.message ?? error) })
    }
  }
  const badMagic = magicChecks.filter((row) => row.magic_ok !== true)
  addCheck(checks, 'pdf.dir.pdf_magic', badMagic.length === 0, 'every PDF starts with %PDF-', badMagic.map((row) => row.id))

  /* ---------------------------------------------------------------- */
  /* 4. Query fixtures resolve to manifest identity                    */
  /* ---------------------------------------------------------------- */
  const queryExpectationIssues = []
  const queryShaIssues = []
  const queryAnchorIssues = []
  for (const query of queryList) {
    if (typeof query.query_zh !== 'string' || query.query_zh.trim() === '') queryExpectationIssues.push(`${query.id}: empty query_zh`)
    const expectedIds = Array.isArray(query.expected_paper_ids) ? query.expected_paper_ids : []
    if (expectedIds.length === 0) queryExpectationIssues.push(`${query.id}: no expected_paper_ids`)
    for (const expectedId of expectedIds) {
      if (!manifestById.has(expectedId)) queryExpectationIssues.push(`${query.id}: unknown paper ${expectedId}`)
    }
    const anchor = query.source_anchor ?? {}
    if (!Number.isInteger(anchor.pdf_page) || anchor.pdf_page < 1) queryAnchorIssues.push(`${query.id}: invalid pdf_page ${anchor.pdf_page}`)
    if (expectedIds.length === 1) {
      const expectedPaper = manifestById.get(expectedIds[0])
      const anchorSha = String(anchor.document_sha256 ?? '').toLowerCase()
      if (expectedPaper === undefined || anchorSha !== String(expectedPaper.sha256 ?? '').toLowerCase()) {
        queryShaIssues.push(`${query.id}: document_sha256 does not match manifest sha256 of ${expectedIds[0]}`)
      }
    }
    if (query.kind === 'figure_recall' || query.kind === 'figure_recall_and_understanding') {
      const figure = anchor.figure
      if (typeof figure !== 'string' || !FIGURE_LABEL_PATTERN.test(figure.trim())) queryAnchorIssues.push(`${query.id}: invalid figure label ${figure}`)
      if (anchor.pdf_page === undefined) queryAnchorIssues.push(`${query.id}: figure query without pdf_page`)
    }
  }
  addCheck(checks, 'queries.expected_paper_ids', queryExpectationIssues.length === 0, 'all expected ids exist in manifest', queryExpectationIssues.slice(0, 30))
  addCheck(checks, 'queries.document_sha256', queryShaIssues.length === 0, 'all query anchors bind the manifest document sha256', queryShaIssues.slice(0, 30))
  addCheck(checks, 'queries.figure_anchors', queryAnchorIssues.length === 0, 'all figure queries carry a valid label + 1-based page', queryAnchorIssues.slice(0, 30))
  const paperQueriesPerPaper = countBy(queryList, (query) => (query.expected_paper_ids ?? [])[0])
  const missingPaperQuery = papers.map((paper) => paper.id).filter((id) => (paperQueriesPerPaper[id] ?? 0) !== 2)
  addCheck(checks, 'queries.two_per_paper', missingPaperQuery.length === 0, '2 queries per manifest paper', missingPaperQuery)

  /* ---------------------------------------------------------------- */
  /* 5. Seed annotations and annotation queries                       */
  /* ---------------------------------------------------------------- */
  const seedIssues = []
  const seedShaIssues = []
  const seedById = new Map(seedList.map((annotation) => [annotation.id, annotation]))
  for (const annotation of seedList) {
    const anchor = annotation.source_anchor ?? {}
    const paper = manifestById.get(annotation.paper_id)
    if (paper === undefined) seedIssues.push(`${annotation.id}: unknown paper ${annotation.paper_id}`)
    if (typeof annotation.body !== 'string' || annotation.body.trim() === '') seedIssues.push(`${annotation.id}: empty body`)
    if (annotation.synthetic !== true) seedIssues.push(`${annotation.id}: synthetic flag missing`)
    if (annotation.not_user_history !== true) seedIssues.push(`${annotation.id}: not_user_history flag missing`)
    if (annotation.locator_precision !== 'page_only') seedIssues.push(`${annotation.id}: locator_precision must be page_only`)
    if (!Number.isInteger(anchor.pdf_page) || anchor.pdf_page < 1) seedIssues.push(`${annotation.id}: invalid pdf_page`)
    const anchorSha = String(anchor.document_sha256 ?? '').toLowerCase()
    if (paper !== undefined && anchorSha !== String(paper.sha256 ?? '').toLowerCase()) seedShaIssues.push(`${annotation.id}: document_sha256 mismatch for ${annotation.paper_id}`)
  }
  addCheck(checks, 'seed_annotations.structure', seedIssues.length === 0, '10 page-only synthetic test annotations', seedIssues)
  addCheck(checks, 'seed_annotations.document_sha256', seedShaIssues.length === 0, 'seed anchors bind the manifest document sha256', seedShaIssues)

  const annotationQueryIssues = []
  const annotationBindingIssues = []
  for (const query of annotationQueryList) {
    if (typeof query.query_zh !== 'string' || query.query_zh.trim() === '') annotationQueryIssues.push(`${query.id}: empty query_zh`)
    const expectedAnnotations = Array.isArray(query.expected_annotation_ids) ? query.expected_annotation_ids : []
    if (expectedAnnotations.length === 0) annotationQueryIssues.push(`${query.id}: no expected_annotation_ids`)
    for (const annotationId of expectedAnnotations) {
      const seed = seedById.get(annotationId)
      if (seed === undefined) {
        annotationQueryIssues.push(`${query.id}: unknown seed annotation ${annotationId}`)
        continue
      }
      const expectedPapers = Array.isArray(query.expected_paper_ids) ? query.expected_paper_ids : []
      if (!expectedPapers.includes(seed.paper_id)) annotationBindingIssues.push(`${query.id}: seed ${annotationId} belongs to ${seed.paper_id}, expected ${expectedPapers.join(',')}`)
      const anchorSha = String(query.source_anchor?.document_sha256 ?? '').toLowerCase()
      const paper = manifestById.get(seed.paper_id)
      if (paper !== undefined && anchorSha !== String(paper.sha256 ?? '').toLowerCase()) annotationBindingIssues.push(`${query.id}: document_sha256 mismatch for ${seed.paper_id}`)
    }
    if (typeof query.delete_test !== 'string' || query.delete_test.trim() === '') annotationQueryIssues.push(`${query.id}: delete_test expectation missing`)
  }
  addCheck(checks, 'annotation_queries.structure', annotationQueryIssues.length === 0, '10 annotation queries with targets + delete expectation', annotationQueryIssues)
  addCheck(checks, 'annotation_queries.seed_binding', annotationBindingIssues.length === 0, 'query <-> seed <-> manifest binding consistent', annotationBindingIssues)

  /* ---------------------------------------------------------------- */
  /* 6. Visual understanding fixtures                                 */
  /* ---------------------------------------------------------------- */
  const visualIssues = []
  const visualWarnings = []
  for (const task of visualList) {
    const anchor = task.source_anchor ?? {}
    const paper = manifestById.get(task.paper_id)
    if (paper === undefined) visualIssues.push(`${task.id}: unknown paper ${task.paper_id}`)
    if (typeof task.query_zh !== 'string' || task.query_zh.trim() === '') visualIssues.push(`${task.id}: empty query_zh`)
    if (!Array.isArray(task.expected_answer_points_zh) || task.expected_answer_points_zh.length === 0) visualIssues.push(`${task.id}: expected_answer_points_zh missing`)
    if (typeof task.input_image !== 'string' || !task.input_image.startsWith(VISUAL_IMAGE_PREFIX)) visualIssues.push(`${task.id}: input_image must live under ${VISUAL_IMAGE_PREFIX}`)
    if (task.scoring === undefined) visualIssues.push(`${task.id}: scoring missing`)
    if (!Number.isInteger(anchor.pdf_page) || anchor.pdf_page < 1) visualIssues.push(`${task.id}: invalid pdf_page`)
    if (paper !== undefined && String(anchor.document_sha256 ?? '').toLowerCase() !== String(paper.sha256 ?? '').toLowerCase()) {
      visualIssues.push(`${task.id}: document_sha256 mismatch for ${task.paper_id}`)
    }
    const imagePath = path.join(DEVKIT, task.input_image)
    const size = fileSize(imagePath)
    if (size === null) {
      visualWarnings.push({ id: task.id, message: `visual fixture PNG not generated yet (${task.input_image}); the live run renders the page through the plugin instead` })
    } else if (size === 0) {
      visualIssues.push(`${task.id}: generated visual fixture is empty (${task.input_image})`)
    }
  }
  addCheck(checks, 'visual_understanding.structure', visualIssues.length === 0, '3 visual tasks bind manifest papers and pages', visualIssues)
  warnings.push(...visualWarnings)

  /* ---------------------------------------------------------------- */
  /* 7. Metadata cases                                                 */
  /* ---------------------------------------------------------------- */
  const realConflicts = Array.isArray(metadataCases.real_source_conflicts) ? metadataCases.real_source_conflicts : []
  const additionalCases = Array.isArray(metadataCases.additional_cases) ? metadataCases.additional_cases : []
  const simulatedCases = Array.isArray(metadataCases.simulated_service_cases) ? metadataCases.simulated_service_cases : []
  addCheck(checks, 'metadata.real_conflicts.count', realConflicts.length === 10, 10, realConflicts.length)
  addCheck(checks, 'metadata.additional_cases.count', additionalCases.length === 5, 5, additionalCases.length)
  addCheck(checks, 'metadata.simulated_service_cases.count', simulatedCases.length === 4, 4, simulatedCases.length)
  const metadataIssues = []
  for (const conflict of realConflicts) {
    if (!manifestById.has(conflict.paper_id)) metadataIssues.push(`${conflict.id}: unknown paper ${conflict.paper_id}`)
    if (typeof conflict.expected_behavior !== 'string' || conflict.expected_behavior.trim() === '') metadataIssues.push(`${conflict.id}: expected_behavior missing`)
  }
  for (const extra of additionalCases) {
    for (const paperId of extra.paper_ids ?? []) {
      if (!manifestById.has(paperId)) metadataIssues.push(`${extra.id}: unknown paper ${paperId}`)
    }
  }
  addCheck(checks, 'metadata.paper_binding', metadataIssues.length === 0, 'metadata cases bind manifest papers', metadataIssues)

  /* ---------------------------------------------------------------- */
  /* 8. Planned live cases agree with the fixture counts              */
  /* ---------------------------------------------------------------- */
  const planned = {}
  try {
    const [{ PLANNED: importPlan }, { PLANNED: searchPlan }, { PLANNED: annotationPlan }, { PLANNED: lifecyclePlan }, { PLANNED: togglePlan }] = await Promise.all([
      import('./import.mjs'),
      import('./search.mjs'),
      import('./annotations.mjs'),
      import('./lifecycle.mjs'),
      import('./toggle.mjs'),
    ])
    planned.import = importPlan
    planned.search = searchPlan
    planned.annotations = annotationPlan
    planned.lifecycle = lifecyclePlan
    planned.toggle = togglePlan
    addCheck(checks, 'plan.search.paper_queries', searchPlan.paperQueries === queryList.length, queryList.length, searchPlan.paperQueries)
    addCheck(checks, 'plan.search.understanding_queries', searchPlan.understandingQueries === queryKinds.figure_recall_and_understanding, queryKinds.figure_recall_and_understanding, searchPlan.understandingQueries)
    addCheck(checks, 'plan.search.visual_tasks', searchPlan.visualTasks === visualList.length, visualList.length, searchPlan.visualTasks)
    addCheck(checks, 'plan.annotations.seed', annotationPlan.seedAnnotations === seedList.length, seedList.length, annotationPlan.seedAnnotations)
    addCheck(checks, 'plan.annotations.queries', annotationPlan.annotationQueries === annotationQueryList.length, annotationQueryList.length, annotationPlan.annotationQueries)
    addCheck(checks, 'plan.import.papers', importPlan.manifestPapers === papers.length, papers.length, importPlan.manifestPapers)
    addCheck(checks, 'plan.toggle.phases', Array.isArray(togglePlan.phases) && togglePlan.phases.length === 2, 2, togglePlan.phases?.length)
    addCheck(checks, 'plan.lifecycle.cases', Number.isInteger(lifecyclePlan.totalCases) && lifecyclePlan.totalCases > 0, 'positive planned case count', lifecyclePlan.totalCases)
  } catch (error) {
    addCheck(checks, 'plan.modules', false, 'suite modules export PLANNED', String(error?.message ?? error))
  }

  /* ---------------------------------------------------------------- */
  /* Summary                                                           */
  /* ---------------------------------------------------------------- */
  const errors = checks.filter((row) => row.ok !== true).map((row) => ({ id: row.id, expected: row.expected, actual: row.actual, detail: row.detail }))
  const result = {
    ok: errors.length === 0,
    generated_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    mode: 'dry-run',
    duration_ms: Date.now() - startedAt,
    checks,
    errors,
    warnings,
    stats: {
      fixtures: { queries: queryList.length, query_kinds: queryKinds, seed_annotations: seedList.length, annotation_queries: annotationQueryList.length, visual_tasks: visualList.length },
      manifest: { papers: papers.length, fields: (manifest.fields ?? []).length, per_field: fieldCounts, sha256_verified: hashPdfs },
      pdfs: { files_in_dir: pdfFiles.length, hashed: pdfChecks.length, sha256_ok: pdfChecks.filter((row) => row.sha256_ok).length, size_ok: pdfChecks.filter((row) => row.size_ok).length },
      planned,
      fixtures_dir: FIXTURES_DIR,
      pdf_dir: PDF_DIR,
      manifest_file: MANIFEST_FILE,
      devkit: DEVKIT,
    },
  }
  return result
}

/**
 * Print a dry-run report to stdout.
 * @param {object} result dry-run result.
 * @returns {void}
 */
export function printDryRun(result) {
  console.log('')
  console.log('Pappers-Hall acceptance fixtures — dry run')
  console.log(`  harness: ${result.harness_version}   duration: ${fmtDuration(result.duration_ms)}   fixtures: ${path.relative(process.cwd(), DEVKIT)}`)
  const stats = result.stats
  if (stats.fixtures !== undefined) {
    const kinds = stats.fixtures.query_kinds
    console.log(`  fixtures: ${stats.fixtures.queries} queries (${Object.entries(kinds).map(([kind, count]) => `${kind}=${count}`).join(', ')}), ` +
      `${stats.fixtures.seed_annotations} seed annotations, ${stats.fixtures.annotation_queries} annotation queries, ${stats.fixtures.visual_tasks} visual tasks`)
    console.log(`  manifest: ${stats.manifest.papers} papers / ${stats.manifest.fields} fields; PDF sha256 verified ${stats.pdfs.sha256_ok}/${stats.pdfs.hashed}, size ok ${stats.pdfs.size_ok}/${stats.pdfs.hashed}`)
  }
  const failed = result.checks.filter((row) => row.ok !== true)
  console.log(`  checks: ${result.checks.length - failed.length}/${result.checks.length} passed, ${failed.length} failed, ${result.warnings.length} warning(s)`)
  for (const row of failed.slice(0, 40)) {
    console.log(`    [FAIL] ${row.id}: expected ${JSON.stringify(row.expected)} got ${JSON.stringify(row.actual)}${row.detail === undefined ? '' : ` — ${JSON.stringify(row.detail)}`}`)
  }
  if (failed.length > 40) console.log(`    … ${failed.length - 40} more failure(s) in dry-run.json`)
  for (const warning of result.warnings.slice(0, 10)) console.log(`    [WARN] ${warning.id}: ${warning.message}`)
  console.log(`  result: ${result.ok ? 'OK (fixtures are consistent; live API was not called)' : 'FAILED (fix the fixtures before a live run)'}`)
  console.log('')
}

/**
 * CLI entry: validate fixtures, write the dry-run artifact, and exit non-zero
 * when anything is inconsistent.
 * @returns {Promise<number>} exit code.
 */
export async function main() {
  const { flags } = parseArgs()
  const hashPdfs = !flagBool(flags, 'no-hash')
  const result = await validateFixtures({ hashPdfs })
  const out = artifactPath(flagStringOutput(flags, 'out', 'dry-run.json'))
  writeJsonFile(out, result)
  printDryRun(result)
  console.log(`  artifact: ${out}`)
  return result.ok ? 0 : 1
}

/**
 * Read one string flag with an artifact-name default.
 * @param {Record<string,string|boolean>} flags parsed flags.
 * @param {string} name flag name.
 * @param {string} fallback default.
 * @returns {string} value.
 */
function flagStringOutput(flags, name, fallback) {
  const value = flags[name]
  return typeof value === 'string' && value !== '' ? value : fallback
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`fixtures: ${String(error?.stack ?? error)}`)
      process.exitCode = 1
    })
}

export { addCheck, countBy }
