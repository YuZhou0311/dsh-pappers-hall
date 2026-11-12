/**
 * Import acceptance suite (`library.import` → async queue → verified library).
 *
 * What it proves, in contract terms (§2.1 `library.import`, §7.2):
 * 1. the request accepts the 30 bundled PDFs and returns a durable job id,
 * 2. the background queue finishes the import job (poll `jobs.list`),
 * 3. the library ends up with exactly the 30 manifest papers, all 5 fields with
 *    6 papers each, and every paper matches the manifest SHA-256 and page count,
 * 4. all pages/figures are processed without `failed`, and figure crops exist,
 * 5. a second import of the same files only reports duplicates (no new papers),
 * 6. the binary asset routes serve real page/figure/thumbnail/PDF bytes,
 * 7. the index/diagnostics report honestly (no fake vector channel).
 *
 * Writes `reports/import-result.json` (allowed by task-4) and stores the
 * fixture-id → production-id map in `test/.artifacts/library-map.json` so the
 * search/annotation/lifecycle suites do not have to re-import.
 *
 * @module pappers-hall/test/import
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  ARTIFACTS_DIR,
  CONTRACT_VERSION,
  HARNESS_VERSION,
  WORKSPACE,
  artifactPath,
  check,
  clip,
  collectEnvironment,
  ensureDir,
  fmtDuration,
  flagInt,
  flagString,
  isMain,
  loadFixtures,
  paperVersion,
  parseArgs,
  pollUntil,
  readJsonIfExists,
  reportPath,
  resolveLibrary,
  runSuiteCli,
  writeJsonFile,
  PappersClient,
  Recorder,
  DEFAULT_API_BASE,
  DEFAULT_IMPORT_TIMEOUT_MS,
  DEFAULT_PROFILE,
} from './lib.mjs'

/** Planned live case counts asserted by the dry run. */
export const PLANNED = Object.freeze({
  manifestPapers: 30,
  perPaperCases: 30,
  totalCases: 46,
})

/** Preferred paper ids for the binary-asset smoke checks; the suite falls back
 * to the first papers that actually produced a figure crop when a fixture paper
 * legitimately has no detected figures (figure channel `partial`). */
const ASSET_SAMPLE_PREFERRED = ['A01', 'V06', 'A02']

/**
 * Collapse whitespace so manifest and stored titles compare semantically.
 * @param {unknown} value candidate text.
 * @returns {string} normalized text.
 */
function squash(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Absolute paths of the 30 bundled PDFs in manifest order.
 * @param {object} fixtures loaded fixtures.
 * @returns {string[]} absolute PDF paths.
 */
function manifestPdfPaths(fixtures) {
  return fixtures.papers.map((paper) => path.join(WORKSPACE, 'pappers_hall_devkit_lite', String(paper.local_path)))
}

/**
 * First figure-recall query of each manifest paper, used for anchor checks.
 * @param {object} fixtures loaded fixtures.
 * @returns {Map<string, object>} fixture paper id -> query.
 */
function anchorFigureQueryByPaper(fixtures) {
  const result = new Map()
  for (const query of fixtures.queryList) {
    if (query.kind !== 'figure_recall' && query.kind !== 'figure_recall_and_understanding') continue
    const paperId = (query.expected_paper_ids ?? [])[0]
    if (typeof paperId === 'string' && !result.has(paperId)) result.set(paperId, query)
  }
  return result
}

/**
 * Run the import suite.
 * @param {object} ctx shared suite context from `lib.runSuiteCli` / `run-tests`.
 * @returns {Promise<object>} suite result with summary + artifact payload.
 */
export async function run(ctx) {
  const { client, fixtures, recorder, options } = ctx
  const suite = 'import'
  const runStarted = Date.now()
  ensureDir(ARTIFACTS_DIR)

  /* ---------------------------------------------------------------- */
  /* Status and isolation                                             */
  /* ---------------------------------------------------------------- */
  const status = await client.call('status')
  ctx.state.status = status
  const statusCase = recorder.begin({
    suite,
    caseId: 'IMPORT.00.status',
    title: 'Plugin status, host version and honest degraded channels',
    expected: 'plugin dsh-pappers-hall enabled, version + host version present, degraded list explicit',
  })
  recorder.end(statusCase, {
    assertions: [
      check('plugin id', status?.plugin?.id === 'dsh-pappers-hall', 'dsh-pappers-hall', status?.plugin?.id),
      check('plugin enabled', status?.plugin?.enabled === true, true, status?.plugin?.enabled),
      check('plugin version', typeof status?.plugin?.version === 'string' && status.plugin.version !== '', 'semver string', status?.plugin?.version),
      check('host version', typeof status?.plugin?.hostVersion === 'string' && status.plugin.hostVersion !== 'unknown', 'DSH version', status?.plugin?.hostVersion),
      check('degraded is an array', Array.isArray(status?.degraded), 'array', status?.degraded),
    ],
    actual: { plugin: status?.plugin, storage: status?.storage, index: status?.index, degraded: status?.degraded, jobs: status?.jobs },
  })

  const isolationCase = recorder.begin({
    suite,
    caseId: 'IMPORT.01.isolation',
    title: 'Data directory is plugin-owned and outside the workspace',
    expected: 'dataDir under DSH_HOME (default ~/.dsh/pappers-hall), not inside the source workspace',
  })
  const dataDir = String(status?.storage?.dataDir ?? '')
  const dbPath = String(status?.storage?.dbPath ?? '')
  const workspacePrefix = `${WORKSPACE}${path.sep}`
  const inWorkspace = dataDir.startsWith(workspacePrefix)
  recorder.end(isolationCase, {
    assertions: [
      check('dataDir present', dataDir !== '', 'absolute path', dataDir),
      check('dbPath present', dbPath !== '', 'absolute path', dbPath),
      check('dataDir outside workspace', !inWorkspace, `not under ${WORKSPACE}`, dataDir),
      check('database file exists', existsSync(dbPath), 'existing SQLite file', dbPath),
    ],
    actual: { data_dir: dataDir, db_path: dbPath, db_bytes: status?.storage?.dbBytes ?? null },
    notes: 'Test data is created inside this plugin data directory only; every production id created here is recorded in reports/import-result.json for cleanup.',
  })

  /* ---------------------------------------------------------------- */
  /* Import request + job                                             */
  /* ---------------------------------------------------------------- */
  const pdfPaths = manifestPdfPaths(fixtures)
  const missingFiles = pdfPaths.filter((filePath) => !existsSync(filePath))
  const before = await resolveLibrary(client, fixtures)
  const preStateCase = recorder.begin({
    suite,
    caseId: 'IMPORT.02.pre_state',
    title: 'Library inventory before import',
    expected: 'library.list paginates over all papers; fixture papers counted by SHA-256',
  })
  recorder.end(preStateCase, {
    assertions: [
      check('library.list reachable', Array.isArray(before.items), 'array', Array.isArray(before.items)),
      check('fixture pdf files present locally', missingFiles.length === 0, '30 files', missingFiles),
      check('no duplicate sha256 in library', before.duplicatesBySha.size === 0, 0, before.duplicatesBySha.size),
    ],
    actual: {
      library: before.counts,
      pre_existing: {
        papers: before.items.map((item) => ({ id: item.id, title: clip(item.title, 80), state: item.state, sha256: clip(item.sha256, 16) })),
        fixture_matched: before.counts.fixturesMatched,
        note: 'Any paper/annotation present before this run is recorded here so the report can separate Lead smoke data from test-created data.',
      },
    },
    notes: before.counts.fixturesMatched > 0
      ? `library already held ${before.counts.fixturesMatched}/${fixtures.papers.length} fixture paper(s) plus possibly hand-imported smoke data; this run imports incrementally and records the duplicates instead of failing`
      : undefined,
  })

  const alreadyImported = before.counts.fixturesMatched
  const firstRun = alreadyImported < fixtures.papers.length
  const importOperationId = firstRun
    ? `ph-acceptance-import-${alreadyImported === 0 ? 'v1' : `repair-${Date.now()}`}`
    : `ph-acceptance-import-dedupe-${Date.now()}`
  const importCase = recorder.begin({
    suite,
    caseId: 'IMPORT.10.import_request',
    title: 'library.import accepts the 30 bundled PDFs',
    expected: 'jobId returned; accepted + duplicates + errors == 30; errors == 0',
    input: { paths: pdfPaths.length, operationId: importOperationId, first_run: firstRun },
  })
  let importResponse
  try {
    importResponse = await client.call('library.import', { paths: pdfPaths, operationId: importOperationId }, { timeoutMs: 180_000 })
  } catch (error) {
    recorder.crash(importCase, error)
    throw error
  }
  const accepted = Number(importResponse?.accepted ?? 0)
  const duplicates = Array.isArray(importResponse?.duplicates) ? importResponse.duplicates : []
  const importErrors = Array.isArray(importResponse?.errors) ? importResponse.errors : []
  recorder.end(importCase, {
    assertions: [
      check('jobId returned', typeof importResponse?.jobId === 'string' && importResponse.jobId !== '', 'non-empty job id', importResponse?.jobId),
      check('accepted + duplicates + errors == 30', accepted + duplicates.length + importErrors.length === fixtures.papers.length, fixtures.papers.length, accepted + duplicates.length + importErrors.length),
      check('import errors empty', importErrors.length === 0, 0, importErrors.length),
      // Incremental import: a library that already holds some fixture papers
      // must report them as duplicates and only accept the remainder. This is
      // exactly the I02 rule (duplicate import never creates a second original).
      ...(alreadyImported === fixtures.papers.length
        ? [check('re-import accepted 0', accepted === 0, 0, accepted)]
        : [check('incremental import accepted the missing papers', accepted === fixtures.papers.length - alreadyImported, fixtures.papers.length - alreadyImported, accepted)]),
      ...(alreadyImported > 0
        ? [check('already-present fixture papers reported as duplicates', duplicates.length === alreadyImported, alreadyImported, duplicates.length)]
        : []),
    ],
    actual: {
      jobId: importResponse?.jobId,
      accepted,
      acceptedItems: clip(importResponse?.acceptedItems, 600),
      duplicates: clip(duplicates, 400),
      errors: clip(importErrors, 400),
    },
  })
  ctx.state.importOperationId = importOperationId

  const acceptedPaperIds = (Array.isArray(importResponse?.acceptedItems) ? importResponse.acceptedItems : [])
    .map((item) => item?.paperId)
    .filter((id) => typeof id === 'string')

  const jobCase = recorder.begin({
    suite,
    caseId: 'IMPORT.11.job_completed',
    title: 'Import job reaches a terminal succeeded state',
    expected: 'job state succeeded, progress done == total, no error',
    input: { jobId: importResponse?.jobId, timeout_ms: options.importTimeoutMs },
  })
  let jobSnapshot = null
  if (acceptedPaperIds.length > 0) {
    try {
      jobSnapshot = await waitForImportJob(client, importResponse?.jobId, options.importTimeoutMs)
      const job = jobSnapshot.job
      recorder.end(jobCase, {
        assertions: [
          check('job found in jobs.list', job !== null && job !== undefined, 'one job', job?.id ?? null),
          check('job succeeded', job?.state === 'succeeded', 'succeeded', job?.state),
          check('job not timed out', jobSnapshot.timedOut !== true, false, jobSnapshot.timedOut),
          check('job error empty', job?.error === undefined || job?.error === null, null, job?.error ?? null),
          check('progress complete', job?.progress === undefined || Number(job.progress.done) >= Number(job.progress.total ?? 0), 'done >= total', job?.progress),
        ],
        actual: { job, ticks: jobSnapshot.timeline.length, duration_ms: jobSnapshot.durationMs },
        evidence: { timeline_tail: jobSnapshot.timeline.slice(-3) },
        notes: jobSnapshot.timedOut ? 'queue did not settle before the import budget elapsed' : undefined,
      })
    } catch (error) {
      recorder.crash(jobCase, error)
    }
  } else {
    recorder.end(jobCase, {
      assertions: [check('no import work required', true, 'no accepted papers on a re-run', acceptedPaperIds.length)],
      actual: { skipped: 'library already complete; job had zero papers' },
      notes: 'Re-run against an already imported library: nothing to wait for.',
    })
  }

  /* ---------------------------------------------------------------- */
  /* Wait for processing + verify the library                         */
  /* ---------------------------------------------------------------- */
  const processingBudget = Math.max(60_000, options.importTimeoutMs - (Date.now() - runStarted))
  if (acceptedPaperIds.length > 0) {
    try {
      await waitForProcessing(client, acceptedPaperIds, Math.min(processingBudget, options.importTimeoutMs))
    } catch (error) {
      if (error?.code === 'timeout') console.warn(`import: processing wait ended early: ${error.message}`)
    }
  }
  const after = await resolveLibrary(client, fixtures)
  ctx.state.library = after

  const countsCase = recorder.begin({
    suite,
    caseId: 'IMPORT.12.library_counts',
    title: 'Library contains exactly the 30 manifest papers',
    expected: 'fixturesMatched 30, missing 0, duplicate sha256 0, no fixture in trash',
  })
  recorder.end(countsCase, {
    assertions: [
      check('30 fixture papers matched by sha256', after.counts.fixturesMatched === fixtures.papers.length, fixtures.papers.length, after.counts.fixturesMatched),
      check('no missing fixture paper', after.missing.length === 0, [], after.missing),
      check('no duplicate sha256', after.duplicatesBySha.size === 0, 0, after.duplicatesBySha.size),
      check('no fixture paper in trash', after.trash.filter((item) => new Set([...after.byFixture.values()].map((fixtureItem) => fixtureItem.id)).has(item.id)).length === 0, 0, after.trash.filter((item) => new Set([...after.byFixture.values()].map((fixtureItem) => fixtureItem.id)).has(item.id)).map((item) => item.id)),
    ],
    actual: { before: before.counts, after: after.counts },
  })

  const fieldsCase = recorder.begin({
    suite,
    caseId: 'IMPORT.13.fields',
    title: '5 fields with 6 papers each',
    expected: '5 distinct field ids, 6 papers per field',
  })
  const fieldCounts = {}
  for (const paper of fixtures.papers) {
    const item = after.byFixture.get(paper.id)
    const fieldId = item?.fieldId ?? item?.field ?? 'unknown'
    fieldCounts[fieldId] = (fieldCounts[fieldId] ?? 0) + 1
  }
  const fieldIds = Object.keys(fieldCounts)
  recorder.end(fieldsCase, {
    assertions: [
      check('5 distinct fields', fieldIds.length === fixtures.manifest.fields.length, fixtures.manifest.fields.length, fieldIds.length),
      check('6 papers per field', fieldIds.every((fieldId) => fieldCounts[fieldId] === 6), '6 each', fieldCounts),
      check('field ids match manifest', fieldIds.every((fieldId) => fixtures.manifest.fields.some((field) => field.id === fieldId)), fixtures.manifest.fields.map((field) => field.id), fieldIds),
    ],
    actual: fieldCounts,
  })

  /* Per-paper: sha256 / page_count / title / year / license / state. */
  const perPaper = []
  for (const paper of fixtures.papers) {
    const item = after.byFixture.get(paper.id)
    const handle = recorder.begin({
      suite,
      caseId: `IMPORT.14.${paper.id}`,
      kind: 'paper',
      title: `${paper.id} matches manifest sha256 + page_count`,
      expected: { sha256: paper.sha256, page_count: paper.page_count, title: paper.title },
    })
    if (item === undefined) {
      recorder.end(handle, {
        status: 'fail',
        actual: { missing: true, paperId: null },
        evidence: { manifest_id: paper.id },
      })
      perPaper.push({ fixture_id: paper.id, paper_id: null, ok: false })
      continue
    }
    let detail = null
    try {
      detail = await client.call('library.get', { id: item.id })
    } catch (error) {
      recorder.crash(handle, error)
      perPaper.push({ fixture_id: paper.id, paper_id: item.id, ok: false, error: String(error?.message ?? error) })
      continue
    }
    const versions = Array.isArray(detail?.versions) ? detail.versions : []
    const currentVersion = versions[0] ?? null
    const titleOk = squash(detail?.title) === squash(paper.title)
    const titleZhOk = typeof paper.title_zh !== 'string' || paper.title_zh === '' || detail?.titleZh === paper.title_zh
    const pageCountActual = currentVersion?.pageCount ?? detail?.pageCount ?? null
    const shaActual = String(currentVersion?.sha256 ?? detail?.sha256 ?? '').toLowerCase()
    const rows = {
      fixture_id: paper.id,
      paper_id: item.id,
      version_id: currentVersion?.id ?? null,
      sha256_actual: shaActual,
      sha256_ok: shaActual === String(paper.sha256 ?? '').toLowerCase(),
      page_count_actual: pageCountActual,
      page_count_ok: Number(pageCountActual) === Number(paper.page_count),
      title_actual: detail?.title,
      title_ok: titleOk,
      title_zh_ok: titleZhOk,
      processing: item.processing?.state ?? 'unknown',
      field_id: item.fieldId ?? item.field ?? null,
      state: item.state,
      license: detail?.license ?? null,
      year: detail?.year ?? null,
    }
    perPaper.push(rows)
    recorder.end(handle, {
      assertions: [
        check('sha256 matches manifest', rows.sha256_ok, String(paper.sha256 ?? '').toLowerCase(), shaActual),
        check('page_count matches manifest', rows.page_count_ok, paper.page_count, pageCountActual),
        check('title matches manifest', titleOk, squash(paper.title), squash(detail?.title)),
        check('title_zh merged from manifest', titleZhOk, paper.title_zh ?? null, detail?.titleZh ?? null),
        check('state active', item.state === 'active', 'active', item.state),
        check('processing not failed', item.processing?.state !== 'failed', 'ready|partial|pending', item.processing?.state ?? null),
      ],
      actual: {
        paper_id: item.id,
        version_id: currentVersion?.id ?? null,
        processing: item.processing,
        year: detail?.year ?? null,
        license: detail?.license ?? null,
      },
    })
  }

  const processingCase = recorder.begin({
    suite,
    caseId: 'IMPORT.15.processing',
    title: 'Every paper finished processing (ready or explicit partial)',
    expected: 'no pending / failed papers; partial only with a stated reason',
  })
  const processingStates = {}
  for (const paper of fixtures.papers) {
    const item = after.byFixture.get(paper.id)
    const state = item?.processing?.state ?? 'missing'
    processingStates[state] = (processingStates[state] ?? 0) + 1
  }
  recorder.end(processingCase, {
    assertions: [
      check('no pending papers', (processingStates.pending ?? 0) === 0, 0, processingStates.pending ?? 0),
      check('no failed papers', (processingStates.failed ?? 0) === 0, 0, processingStates.failed ?? 0),
      check('all 30 accounted for', fixtures.papers.every((paper) => after.byFixture.has(paper.id)), 30, Object.values(processingStates).reduce((sum, count) => sum + count, 0)),
    ],
    actual: processingStates,
    evidence: {
      status_processing: status?.processing ?? null,
      partial_ids: fixtures.papers.filter((paper) => after.byFixture.get(paper.id)?.processing?.state === 'partial').map((paper) => paper.id),
    },
  })

  /* Figures: count crops and check the audited figure anchors exist. */
  const anchorQueries = anchorFigureQueryByPaper(fixtures)
  const figureRows = []
  const anchorHits = []
  for (const paper of fixtures.papers) {
    const item = after.byFixture.get(paper.id)
    if (item === undefined) continue
    let figures = []
    try {
      figures = await client.call('figures.list', { paperId: item.id })
    } catch {
      figures = []
    }
    const anchor = anchorQueries.get(paper.id)
    let anchorHit = false
    if (anchor !== undefined && Array.isArray(figures)) {
      anchorHit = figures.some((figure) => {
        const page = Number(figure?.page)
        const label = String(figure?.label ?? '')
        const wantedLabels = String(anchor.source_anchor?.figure ?? '')
          .split(/\s*(?:,|、|and|&)\s*/i)
          .map((entry) => entry.trim())
          .filter(Boolean)
        return page === Number(anchor.source_anchor?.pdf_page) && wantedLabels.some((wanted) => normalizeLabel(label) === normalizeLabel(wanted))
      })
    }
    anchorHits.push({ paper_id: paper.id, anchor_hit: anchorHit, figures: Array.isArray(figures) ? figures.length : 0 })
    figureRows.push({
      fixture_id: paper.id,
      paper_id: item.id,
      figure_count: Array.isArray(figures) ? figures.length : 0,
      processing_figures: item.processing?.channels?.figures ?? null,
      first_figure: Array.isArray(figures) && figures.length > 0 ? { id: figures[0].id, page: figures[0].page, label: figures[0].label } : null,
    })
  }
  const totalFigures = figureRows.reduce((sum, row) => sum + row.figure_count, 0)
  const anchorHitCount = anchorHits.filter((row) => row.anchor_hit).length
  const figureCase = recorder.begin({
    suite,
    caseId: 'IMPORT.16.figures',
    title: 'Figure crops were generated and audited anchors resolve',
    expected: 'total figure crops > 0; first audited figure anchor of each paper matched where present',
  })
  recorder.end(figureCase, {
    assertions: [
      check('figure crops generated', totalFigures > 0, '> 0', totalFigures),
      check('papers with at least one crop', figureRows.filter((row) => row.figure_count > 0).length >= 20, '>= 20', figureRows.filter((row) => row.figure_count > 0).length),
      check('audited anchor figure found at least once', anchorHitCount > 0, '> 0', anchorHitCount),
      check('no paper failed the figure channel', figureRows.every((row) => row.processing_figures !== 'failed'), 'no failed', figureRows.filter((row) => row.processing_figures === 'failed').map((row) => row.fixture_id)),
    ],
    actual: { total_figures: totalFigures, anchor_hits: anchorHitCount, anchor_expected: anchorQueries.size, per_paper: figureRows },
    notes: 'Anchor matching is also measured per query in the search suite; this case only checks the import pipeline produced the crops.',
  })

  const partialFigureCase = recorder.begin({
    suite,
    caseId: 'IMPORT.16b.partial_figures',
    title: 'Papers without figure crops report the figure channel as degraded, not ready',
    expected: 'figure_count 0 => processing.channels.figures partial/none; never "ready" (no silent fabrication)',
  })
  const figureless = figureRows.filter((row) => row.figure_count === 0)
  recorder.end(partialFigureCase, {
    assertions: [
      check('figureless papers do not claim figures ready', figureless.every((row) => row.processing_figures !== 'ready'), 'partial|none', figureless.map((row) => ({ fixture_id: row.fixture_id, figures: row.processing_figures }))),
      check('figureless papers are marked partial when crops were expected', figureless.every((row) => row.processing_figures === 'partial' || row.processing_figures === 'none'), 'partial|none', figureless.map((row) => row.processing_figures)),
    ],
    actual: { figureless_papers: figureless.map((row) => row.fixture_id), per_paper: figureRows.filter((row) => row.figure_count === 0) },
    notes: 'CONTRACT §5 allows `partial` when captions cannot be located; the assertion only forbids claiming a ready figure channel with zero crops. The recalled figure queries for these papers are measured by the search suite.',
  })

  /* ---------------------------------------------------------------- */
  /* Duplicate import (I02) and no-new-papers invariant                */
  /* ---------------------------------------------------------------- */
  const dedupeCase = recorder.begin({
    suite,
    caseId: 'IMPORT.17.reimport_duplicates',
    title: 'Re-importing the same 30 PDFs only reports duplicates',
    expected: 'accepted 0, duplicates 30, errors 0',
  })
  try {
    const dedupeResponse = await client.call('library.import', { paths: pdfPaths, operationId: `ph-acceptance-import-dedupe-${Date.now()}` }, { timeoutMs: 120_000 })
    const dedupeDuplicates = Array.isArray(dedupeResponse?.duplicates) ? dedupeResponse.duplicates : []
    const dedupeErrors = Array.isArray(dedupeResponse?.errors) ? dedupeResponse.errors : []
    const fixturePaperIds = new Set([...after.byFixture.values()].map((item) => item.id))
    recorder.end(dedupeCase, {
      assertions: [
        check('accepted 0', Number(dedupeResponse?.accepted) === 0, 0, dedupeResponse?.accepted),
        check('duplicates 30', dedupeDuplicates.length === fixtures.papers.length, fixtures.papers.length, dedupeDuplicates.length),
        check('duplicates point at existing papers', dedupeDuplicates.every((entry) => fixturePaperIds.has(entry?.paperId)), 'every duplicate paperId already in library', dedupeDuplicates.filter((entry) => !fixturePaperIds.has(entry?.paperId)).length),
        check('errors 0', dedupeErrors.length === 0, 0, dedupeErrors.length),
      ],
      actual: { accepted: dedupeResponse?.accepted, duplicates: clip(dedupeDuplicates, 400), errors: clip(dedupeErrors, 300) },
    })
  } catch (error) {
    recorder.crash(dedupeCase, error)
  }

  const noNewCase = recorder.begin({
    suite,
    caseId: 'IMPORT.18.no_new_papers',
    title: 'Import did not create extra papers',
    expected: 'after.total == before.total + first_import_accepted',
  })
  const afterTotal = after.counts.total
  const expectedTotal = before.counts.total + Math.max(0, accepted)
  recorder.end(noNewCase, {
    assertions: [
      check('library total grew only by accepted papers', afterTotal === expectedTotal, expectedTotal, afterTotal),
      check('fixture id set unchanged', after.counts.fixturesMatched === fixtures.papers.length, fixtures.papers.length, after.counts.fixturesMatched),
    ],
    actual: { before_total: before.counts.total, after_total: afterTotal, first_import_accepted: accepted },
  })

  /* ---------------------------------------------------------------- */
  /* Binary assets (page / thumb / figure / pdf)                      */
  /* ---------------------------------------------------------------- */
  const assetRows = []
  const assetAssertions = []
  const assetSampleIds = (() => {
    const withFigures = figureRows.filter((row) => row.figure_count > 0).map((row) => row.fixture_id)
    const picked = []
    for (const fixtureId of ASSET_SAMPLE_PREFERRED) if (withFigures.includes(fixtureId) && !picked.includes(fixtureId)) picked.push(fixtureId)
    for (const fixtureId of withFigures) {
      if (picked.length >= 3) break
      if (!picked.includes(fixtureId)) picked.push(fixtureId)
    }
    return picked.slice(0, 3)
  })()
  for (const fixtureId of assetSampleIds) {
    const item = after.byFixture.get(fixtureId)
    if (item === undefined) {
      assetAssertions.push(check(`${fixtureId}: paper present`, false, 'present', 'missing'))
      continue
    }
    let figures = []
    try {
      figures = await client.call('figures.list', { paperId: item.id })
    } catch {
      figures = []
    }
    const page1 = await client.getAsset(`/pappers-hall/page/${item.id}/1.png?width=800`)
    const thumb = await client.getAsset(`/pappers-hall/thumb/${item.id}.png`)
    const pdf = await client.getAsset(`/pappers-hall/pdf/${item.id}`)
    const figureAsset = Array.isArray(figures) && figures.length > 0 ? await client.getAsset(figures[0].imageUrl) : { httpStatus: 0, contentType: '', bytes: 0, sha256: '' }
    assetRows.push({
      fixture_id: fixtureId,
      paper_id: item.id,
      page1: clip({ status: page1.httpStatus, contentType: page1.contentType, bytes: page1.bytes, sha256: page1.sha256 }, 200),
      thumb: clip({ status: thumb.httpStatus, contentType: thumb.contentType, bytes: thumb.bytes }, 160),
      pdf: clip({ status: pdf.httpStatus, contentType: pdf.contentType, bytes: pdf.bytes, expected_bytes: fixtures.manifestById.get(fixtureId)?.size_bytes }, 200),
      figure: clip({ status: figureAsset.httpStatus, contentType: figureAsset.contentType, bytes: figureAsset.bytes, sha256: figureAsset.sha256 }, 200),
    })
    assetAssertions.push(
      check(`${fixtureId}: page render 200 image/png`, page1.httpStatus === 200 && page1.contentType.startsWith('image/png') && page1.bytes > 1000, '200 image/png > 1KB', { status: page1.httpStatus, type: page1.contentType, bytes: page1.bytes }),
      check(`${fixtureId}: thumbnail 200 image/png`, thumb.httpStatus === 200 && thumb.contentType.startsWith('image/png') && thumb.bytes > 500, '200 image/png > 500B', { status: thumb.httpStatus, type: thumb.contentType, bytes: thumb.bytes }),
      check(`${fixtureId}: PDF 200 application/pdf with original byte size`, pdf.httpStatus === 200 && pdf.contentType.startsWith('application/pdf') && pdf.bytes === Number(fixtures.manifestById.get(fixtureId)?.size_bytes), `200 application/pdf ${fixtures.manifestById.get(fixtureId)?.size_bytes} bytes`, { status: pdf.httpStatus, type: pdf.contentType, bytes: pdf.bytes }),
      check(`${fixtureId}: figure crop 200 image/png`, figureAsset.httpStatus === 200 && figureAsset.contentType.startsWith('image/png') && figureAsset.bytes > 500, '200 image/png > 500B', { status: figureAsset.httpStatus, type: figureAsset.contentType, bytes: figureAsset.bytes }),
    )
  }
  const assetCase = recorder.begin({
    suite,
    caseId: 'IMPORT.19.assets',
    title: 'Page/figure/thumbnail/PDF asset routes serve real bytes',
    expected: 'sampled papers return 200 with correct content types and the original PDF size',
    input: { papers: assetSampleIds, preferred: ASSET_SAMPLE_PREFERRED },
  })
  recorder.end(assetCase, { assertions: assetAssertions, actual: assetRows })

  /* ---------------------------------------------------------------- */
  /* Index / diagnostics honesty                                      */
  /* ---------------------------------------------------------------- */
  const finalStatus = await client.call('status')
  const diagnostics = await client.call('diagnostics')
  ctx.state.finalStatus = finalStatus
  const indexCase = recorder.begin({
    suite,
    caseId: 'IMPORT.20.index_diagnostics',
    title: 'Index and diagnostics report ready/degraded channels honestly',
    expected: 'index.paperCount covers active papers; vector channel unavailable; pdf capabilities ready',
  })
  const capabilities = diagnostics?.capabilities ?? {}
  recorder.end(indexCase, {
    assertions: [
      check('index.paperCount >= 30', Number(finalStatus?.index?.paperCount ?? 0) >= fixtures.papers.length, `>= ${fixtures.papers.length}`, finalStatus?.index?.paperCount),
      check('fts channel ready or degraded with note', ['ready', 'degraded'].includes(finalStatus?.index?.channels?.fts), 'ready|degraded', finalStatus?.index?.channels?.fts),
      check('vector channel unavailable (no fake embedding)', finalStatus?.index?.channels?.vector === 'unavailable', 'unavailable', finalStatus?.index?.channels?.vector),
      check('pdfText capability ready', capabilities.pdfText === 'ready', 'ready', capabilities.pdfText),
      check('pageRender capability ready', capabilities.pageRender === 'ready', 'ready', capabilities.pageRender),
      check('figureCrop capability ready', capabilities.figureCrop === 'ready', 'ready', capabilities.figureCrop),
      check('schemaVersion present', Number(diagnostics?.schemaVersion ?? 0) > 0, '> 0', diagnostics?.schemaVersion),
      check('dataDir stable', String(diagnostics?.dataDir ?? '') === dataDir, dataDir, diagnostics?.dataDir),
    ],
    actual: { index: finalStatus?.index, degraded: finalStatus?.degraded, capabilities, diagnostics: { host: diagnostics?.host, dataDir: diagnostics?.dataDir, schemaVersion: diagnostics?.schemaVersion, versions: diagnostics?.versions } },
  })

  /* ---------------------------------------------------------------- */
  /* Bibliography import (I02 second half) stays opt-in               */
  /* ---------------------------------------------------------------- */
  const bibliographyCase = recorder.begin({
    suite,
    caseId: 'IMPORT.21.bibliography_import',
    title: 'BibTeX/RIS/CSL-JSON import links to existing papers without duplicates',
    expected: 'accepted 0, duplicates 30, no metadata-only clones',
  })
  if (options.bibliography !== true) {
    recorder.end(bibliographyCase, {
      status: 'not_run',
      reason: 'opt-in: run with --bibliography to send library.bib/library.ris/library.csl.json; kept off by default so the demo library stays clean',
      actual: { files: ['papers/library.bib', 'papers/library.ris', 'papers/library.csl.json'] },
    })
  } else {
    try {
      const bibliographyFiles = ['library.bib', 'library.ris', 'library.csl.json'].map((name) => path.join(WORKSPACE, 'pappers_hall_devkit_lite', 'papers', name))
      const bibliographyResponse = await client.call('library.import', {
        paths: bibliographyFiles,
        operationId: `ph-acceptance-bibliography-${Date.now()}`,
      }, { timeoutMs: 120_000 })
      const bibliographyDuplicates = Array.isArray(bibliographyResponse?.duplicates) ? bibliographyResponse.duplicates : []
      const acceptedItems = Array.isArray(bibliographyResponse?.acceptedItems) ? bibliographyResponse.acceptedItems : []
      const createdIds = acceptedItems.map((item) => item?.paperId).filter((id) => typeof id === 'string')
      let cleanup = { removed: [], failed: [] }
      if (createdIds.length > 0) {
        cleanup = await cleanupCreatedPapers(client, createdIds)
      }
      recorder.end(bibliographyCase, {
        assertions: [
          check('accepted == 0', Number(bibliographyResponse?.accepted) === 0, 0, bibliographyResponse?.accepted),
          check('no new metadata-only papers remained', cleanup.removed.length === createdIds.length, createdIds.length, cleanup.removed.length),
        ],
        actual: {
          accepted: bibliographyResponse?.accepted,
          duplicates: bibliographyDuplicates.length,
          errors: clip(bibliographyResponse?.errors, 300),
          created_and_cleaned: createdIds,
          cleanup,
        },
      })
    } catch (error) {
      recorder.crash(bibliographyCase, error)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Persist artifacts                                                */
  /* ---------------------------------------------------------------- */
  const mapping = {}
  for (const paper of fixtures.papers) {
    const item = after.byFixture.get(paper.id)
    const row = perPaper.find((entry) => entry.fixture_id === paper.id)
    if (item === undefined) {
      mapping[paper.id] = null
      continue
    }
    mapping[paper.id] = {
      fixture_id: paper.id,
      paper_id: item.id,
      version_id: row?.version_id ?? null,
      sha256: paper.sha256,
      page_count: paper.page_count,
      title: paper.title,
      field_id: paper.field_id,
      state: item.state,
      processing: item.processing?.state ?? null,
    }
  }
  const importResult = {
    schema: 'pappers-hall/import-result@1',
    generated_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    contract_version: CONTRACT_VERSION,
    environment: {
      dsh_version: status?.plugin?.hostVersion ?? 'unknown',
      plugin_version: status?.plugin?.version ?? 'unknown',
      profile: options.profile,
      api_base: options.apiBase,
      data_dir: dataDir,
      db_path: dbPath,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    first_run_evidence: readJsonIfExists(artifactPath('import-first-run.json')) ?? null,
    request: {
      operation_id: importOperationId,
      first_run: firstRun,
      paths: pdfPaths,
      response: {
        jobId: importResponse?.jobId ?? null,
        accepted,
        // Full arrays (not clipped) so reports can compute counts and cite paths.
        duplicates,
        errors: importErrors,
      },
    },
    job: jobSnapshot === null ? null : { job: jobSnapshot.job, ticks: jobSnapshot.timeline.length, duration_ms: jobSnapshot.durationMs },
    library: {
      before: before.counts,
      after: after.counts,
      pre_existing: before.items.map((item) => ({
        paper_id: item.id,
        title: clip(item.title, 120),
        state: item.state,
        annotation_count: item.annotationCount ?? null,
        sha256_prefix: typeof item.sha256 === 'string' ? item.sha256.slice(0, 16) : null,
      })),
    },
    fields: fieldCounts,
    mapping,
    per_paper: perPaper,
    figures: { total: totalFigures, anchor_hits: anchorHitCount, anchor_expected: anchorQueries.size, per_paper: figureRows },
    assets: assetRows,
    summary: {
      cases: recorder.cases.length,
      pass: recorder.cases.filter((testCase) => testCase.status === 'pass').length,
      fail: recorder.cases.filter((testCase) => testCase.status === 'fail').length,
      not_run: recorder.cases.filter((testCase) => testCase.status === 'not_run').length,
      duration_ms: Date.now() - runStarted,
    },
  }
  writeJsonFile(reportPath('import-result.json'), importResult)
  writeJsonFile(artifactPath('library-map.json'), {
    generated_at: new Date().toISOString(),
    data_dir: dataDir,
    db_path: dbPath,
    environment: importResult.environment,
    mapping,
  })
  for (const testCase of recorder.cases.filter((entry) => entry.suite === suite)) {
    if (testCase.status !== 'pass') console.log(`  import: ${testCase.status} ${testCase.case_id}`)
  }
  ctx.state.importResult = importResult
  return { summary: recorder.summary(), importResult, mapping, after: after.counts, durationMs: importResult.summary.duration_ms }
}

/**
 * Wait for one import job, collecting a compact timeline.
 * @param {PappersClient} client API client.
 * @param {string} jobId job id from `library.import`.
 * @param {number} timeoutMs budget.
 * @returns {Promise<{job:object|null, timeline:object[], timedOut:boolean, durationMs:number}>} snapshot.
 */
async function waitForImportJob(client, jobId, timeoutMs) {
  const startedAt = Date.now()
  const timeline = []
  let timedOut = false
  let lastJob = null
  try {
    const job = await pollUntil(
      async () => {
        const result = await client.call('jobs.list')
        const items = Array.isArray(result?.items) ? result.items : []
        const current = items.find((entry) => entry.id === jobId) ?? null
        lastJob = current
        timeline.push({
          at: new Date().toISOString(),
          state: current?.state ?? 'unknown',
          progress: current?.progress ?? null,
          attempts: current?.attempts ?? null,
          summary: result?.summary ?? null,
        })
        return { done: current !== null && ['succeeded', 'failed', 'cancelled'].includes(current.state), value: current }
      },
      { timeoutMs, intervalMs: 1000, label: `import job ${jobId}` },
    )
    return { job, timeline, timedOut, durationMs: Date.now() - startedAt }
  } catch (error) {
    if (error?.name === 'TimeoutError') timedOut = true
    else throw error
    return { job: lastJob, timeline, timedOut, durationMs: Date.now() - startedAt }
  }
}

/**
 * Normalize a figure label for anchor comparison (`Fig. 1` == `Figure 1`).
 * @param {string} label raw label.
 * @returns {string} normalized.
 */
function normalizeLabel(label) {
  const text = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  const numbered = /^(?:fig(?:ure)?)(\d+)$/.exec(text)
  return numbered === null ? text : `figure${numbered[1]}`
}

/**
 * Purge papers created by the opt-in bibliography import (test-created only).
 * @param {PappersClient} client API client.
 * @param {string[]} ids creation ids from `acceptedItems`.
 * @returns {Promise<{removed:string[], failed:object[]}>} cleanup result.
 */
async function cleanupCreatedPapers(client, ids) {
  const removed = []
  const failed = []
  for (const id of ids) {
    try {
      const deleted = await client.call('library.delete', { ids: [id], operationId: `ph-biblio-clean-del-${id}-${Date.now()}` })
      if (deleted?.results?.[0]?.ok !== true) {
        failed.push({ id, step: 'delete', result: deleted })
        continue
      }
      const purged = await client.call('library.purge', { ids: [id], operationId: `ph-biblio-clean-purge-${id}-${Date.now()}` })
      if (purged?.results?.[0]?.ok === true) removed.push(id)
      else failed.push({ id, step: 'purge', result: purged })
    } catch (error) {
      failed.push({ id, step: 'error', message: String(error?.message ?? error) })
    }
  }
  return { removed, failed }
}

/** CLI entry for `node test/import.mjs`. */
export async function main() {
  return runSuiteCli({ suite: 'import', planned: PLANNED, run })
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`import: ${String(error?.stack ?? error)}`)
      process.exitCode = 1
    })
}
