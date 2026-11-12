/**
 * Lifecycle acceptance suite — delete → immediate exclusion → restore with a
 * fresh epoch → idempotent replay (contract §2.1 `library.delete|restore`,
 * §4 lifecycle rules, test_plan §5 L01/L05).
 *
 * Checks:
 * - a deleted paper leaves the active list immediately, disappears from paper,
 *   figure and body search, and its page/figure/PDF asset routes answer 404,
 * - a reader/tool read of the trashed paper must be refused (§4: "回收站不可被
 *   检索/工具读取"); the HTTP reader check is asserted, the Agent-tool probe is
 *   recorded `not_run` with the exact manual procedure because tools can only
 *   be invoked from an Agent session,
 * - restoring returns a strictly new lifecycle epoch and makes the paper visible
 *   again (list, search, figure search, assets),
 * - repeating the same `operationId` returns the identical cached result for
 *   both delete and restore,
 * - a second delete/restore cycle increments the epoch again.
 *
 * The target paper defaults to C05 (small, no seed annotation) and is restored
 * to `active` before the suite returns.
 *
 * @module pappers-hall/test/lifecycle
 */
import {
  CONTRACT_VERSION,
  HARNESS_VERSION,
  artifactPath,
  check,
  clip,
  deepEqual,
  isMain,
  normalizeFigureLabel,
  prepareLibrary,
  queryFigureLabels,
  queryPage,
  runSuiteCli,
  writeJsonFile,
} from './lib.mjs'

/** Planned live case count asserted by the dry run. */
export const PLANNED = Object.freeze({ totalCases: 18 })

/** Default lifecycle target (overridable with `--lifecycle-paper`). */
const DEFAULT_TARGET = 'C05'

/**
 * First audited query for one paper with a given kind predicate.
 * @param {object} fixtures loaded fixtures.
 * @param {string} paperId fixture paper id.
 * @param {(kind:string)=>boolean} predicate kind filter.
 * @returns {object|null} query or null.
 */
function firstQueryFor(fixtures, paperId, predicate) {
  for (const query of fixtures.queryList) {
    if (query.expected_paper_ids?.[0] !== paperId) continue
    if (predicate(query.kind)) return query
  }
  return null
}

/**
 * Whether one list response contains one paper id.
 * @param {object} result `library.list` payload.
 * @param {string} paperId production id.
 * @returns {boolean} present.
 */
function listContains(result, paperId) {
  return Array.isArray(result?.items) && result.items.some((item) => item.id === paperId)
}

/**
 * Run the lifecycle suite.
 * @param {object} ctx shared suite context.
 * @returns {Promise<object>} suite result.
 */
export async function run(ctx) {
  const { client, fixtures, recorder, options } = ctx
  const suite = 'lifecycle'
  const runStarted = Date.now()
  const library = await prepareLibrary(ctx)
  const targetFixture = options.lifecyclePaper ?? DEFAULT_TARGET
  const targetItem = library.byFixture.get(targetFixture)
  const targetPaper = fixtures.manifestById.get(targetFixture)
  const semanticQuery = firstQueryFor(fixtures, targetFixture, (kind) => kind === 'semantic_recall' || kind === 'fuzzy_recall')
  const figureQuery = firstQueryFor(fixtures, targetFixture, (kind) => kind === 'figure_recall' || kind === 'figure_recall_and_understanding')

  const preconditionCase = recorder.begin({
    suite,
    caseId: 'LIFE.00.preconditions',
    title: `Lifecycle target ${targetFixture} is imported and active`,
    expected: `${targetFixture} present, active; audited semantic + figure queries available`,
    input: { target: targetFixture },
  })
  if (targetItem === undefined || targetPaper === undefined) {
    recorder.end(preconditionCase, {
      status: 'fail',
      actual: { missing: targetFixture, library_counts: library.counts },
    })
    return { summary: recorder.summary(), lifecycleSummary: null, reason: `lifecycle target ${targetFixture} is not imported` }
  }
  const targetId = targetItem.id
  let recovered = null
  if (targetItem.state !== 'active') {
    const restored = await client.call('library.restore', { ids: [targetId], operationId: `ph-acceptance-life-init-${Date.now()}` })
    recovered = restored
  }
  const startList = await client.call('library.list', { state: 'active', limit: 200 })
  recorder.end(preconditionCase, {
    assertions: [
      check('target imported', targetItem !== undefined, targetFixture, targetId),
      check('semantic query available', semanticQuery !== null, 'semantic/fuzzy query', semanticQuery?.id ?? null),
      check('figure query available', figureQuery !== null, 'figure query', figureQuery?.id ?? null),
      check('target active', listContains(startList, targetId), 'active', targetItem.state),
    ],
    actual: { paper_id: targetId, fixture_id: targetFixture, title: targetPaper.title, recovered, library: library.counts },
  })

  const semanticQueryText = semanticQuery?.query_zh ?? targetPaper.title
  const figureQueryText = figureQuery?.query_zh ?? targetPaper.title
  const figurePage = queryPage(figureQuery)
  const figureLabels = queryFigureLabels(figureQuery)
  const titleQueryText = targetPaper.title

  /**
   * Search helper: return the paper ids observed for one query text.
   * @param {string} queryText query.
   * @returns {Promise<{paperIds:string[], itemCount:number, channels:object[]}>} observed hits.
   */
  async function observedPaperIds(queryText) {
    const result = await client.call('search.query', { q: queryText, limit: 10 })
    const items = Array.isArray(result?.items) ? result.items : []
    return {
      paperIds: items.map((item) => item?.paperId).filter((paperId) => typeof paperId === 'string'),
      itemCount: items.length,
      channels: Array.isArray(result?.channels) ? result.channels : [],
    }
  }

  /**
   * Figure-search helper for the target anchor.
   * @returns {Promise<{match:object|null, itemCount:number, itemPaperIds:string[]}>} observed figure hits.
   */
  async function observedFigures() {
    const result = await client.call('figures.search', { q: figureQueryText, limit: 20, mode: 'text' })
    const items = Array.isArray(result?.items) ? result.items : []
    const match =
      items.find((item) => {
        const paperId = item?.paper?.id ?? item?.paperId
        const page = Number(item?.page ?? item?.figure?.page)
        const label = String(item?.figure?.label ?? '')
        return paperId === targetId && page === figurePage && figureLabels.some((wanted) => normalizeFigureLabel(wanted) === normalizeFigureLabel(label))
      }) ?? null
    return { match, itemCount: items.length, itemPaperIds: items.map((item) => item?.paper?.id ?? item?.paperId ?? null) }
  }

  /**
   * Fetch the three asset routes for the target paper.
   * @returns {Promise<object>} asset statuses.
   */
  async function assets() {
    const page = await client.getAsset(`/pappers-hall/page/${targetId}/1.png?width=600`)
    const thumb = await client.getAsset(`/pappers-hall/thumb/${targetId}.png`)
    const pdf = await client.getAsset(`/pappers-hall/pdf/${targetId}`)
    let figure = null
    try {
      const figures = await client.call('figures.list', { paperId: targetId })
      if (Array.isArray(figures) && figures.length > 0) figure = await client.getAsset(figures[0].imageUrl)
    } catch {
      figure = null
    }
    return { page, thumb, pdf, figure }
  }

  /* ---------------------------------------------------------------- */
  /* L01 — delete and immediate exclusion                             */
  /* ---------------------------------------------------------------- */
  const deleteOperationId = `ph-acceptance-life-delete-1-${Date.now()}`
  const deleteCase = recorder.begin({
    suite,
    caseId: 'LIFE.01.delete',
    title: `library.delete moves ${targetFixture} to the recycle bin`,
    expected: 'results[0].ok, state trash, trashCount includes the paper, active list excludes it',
    input: { ids: [targetId], operationId: deleteOperationId },
  })
  let deleteResponse = null
  try {
    const beforeDelete = await client.call('status')
    deleteResponse = await client.call('library.delete', { ids: [targetId], operationId: deleteOperationId })
    const afterDelete = await client.call('status')
    const activeList = await client.call('library.list', { state: 'active', limit: 200 })
    const trashList = await client.call('library.list', { state: 'trash', limit: 200 })
    ctx.state.deleteResponse = deleteResponse
    ctx.state.deleteOperationId = deleteOperationId
    ctx.state.trashCountBefore = beforeDelete?.counts?.trash ?? null
    ctx.state.trashCountAfter = afterDelete?.counts?.trash ?? null
    recorder.end(deleteCase, {
      assertions: [
        check('delete returned ok', deleteResponse?.results?.[0]?.ok === true, true, deleteResponse?.results?.[0] ?? null),
        check('result state is trash', deleteResponse?.results?.[0]?.state === 'trash', 'trash', deleteResponse?.results?.[0]?.state ?? null),
        check('paper left the active list', !listContains(activeList, targetId), 'absent', listContains(activeList, targetId)),
        check('paper appears in the trash list', listContains(trashList, targetId), 'present', listContains(trashList, targetId)),
        check('trashCount increased by one', Number(afterDelete?.counts?.trash) === Number(beforeDelete?.counts?.trash) + 1, Number(beforeDelete?.counts?.trash) + 1, afterDelete?.counts?.trash),
      ],
      actual: { response: clip(deleteResponse, 400), counts_before: beforeDelete?.counts ?? null, counts_after: afterDelete?.counts ?? null },
    })
  } catch (error) {
    recorder.crash(deleteCase, error)
  }

  const searchExclusionCase = recorder.begin({
    suite,
    caseId: 'LIFE.02.search_excluded',
    title: 'A trashed paper is not returned by any new search',
    expected: 'search.query returns no hit for the target on semantic, title and figure searches',
  })
  try {
    const semanticHits = await observedPaperIds(semanticQueryText)
    const titleHits = await observedPaperIds(titleQueryText)
    const figureHits = await observedFigures()
    recorder.end(searchExclusionCase, {
      assertions: [
        check('semantic query excludes trashed paper', !semanticHits.paperIds.includes(targetId), 'absent', semanticHits.paperIds),
        check('title query excludes trashed paper', !titleHits.paperIds.includes(targetId), 'absent', titleHits.paperIds),
        check('figure search excludes trashed paper', figureHits.match === null && !figureHits.itemPaperIds.includes(targetId), 'absent', figureHits.itemPaperIds),
      ],
      actual: { semantic: { item_count: semanticHits.itemCount }, title: { item_count: titleHits.itemCount }, figures: { item_count: figureHits.itemCount } },
    })
  } catch (error) {
    recorder.crash(searchExclusionCase, error)
  }

  const assetExclusionCase = recorder.begin({
    suite,
    caseId: 'LIFE.03.assets_404',
    title: 'Trashed paper assets are not served',
    expected: 'page, thumbnail, PDF and figure routes answer 404',
  })
  try {
    const observed = await assets()
    recorder.end(assetExclusionCase, {
      assertions: [
        check('page route 404', observed.page.httpStatus === 404, 404, observed.page.httpStatus),
        check('thumbnail route 404', observed.thumb.httpStatus === 404, 404, observed.thumb.httpStatus),
        check('PDF route 404', observed.pdf.httpStatus === 404, 404, observed.pdf.httpStatus),
        check('figure route 404', observed.figure === null || observed.figure.httpStatus === 404, '404 or no figure rows', observed.figure?.httpStatus ?? null),
      ],
      actual: { page: observed.page.httpStatus, thumb: observed.thumb.httpStatus, pdf: observed.pdf.httpStatus, figure: observed.figure?.httpStatus ?? null },
    })
  } catch (error) {
    recorder.crash(assetExclusionCase, error)
  }

  const readerRejectionCase = recorder.begin({
    suite,
    caseId: 'LIFE.04.reader_open_rejected',
    title: 'reader.open refuses a trashed paper (contract §4 recycle-bin read rule)',
    expected: 'ApiError not_found for reader.open / reader.page of the trashed paper',
  })
  try {
    const openResult = await client.tryCall('reader.open', { id: targetId })
    const pageResult = await client.tryCall('reader.page', { id: targetId, page: 1 })
    recorder.end(readerRejectionCase, {
      assertions: [
        check('reader.open rejected', openResult.ok === false && ['not_found', 'unavailable', 'degraded'].includes(openResult.error?.code), 'not_found', openResult.ok ? 'opened trashed paper' : openResult.error?.code),
        check('reader.page rejected after delete', pageResult.ok === false, 'rejected', pageResult.ok ? 'page served for trashed paper' : pageResult.error?.code),
      ],
      actual: {
        open: openResult.ok ? clip(openResult.data, 300) : { code: openResult.error?.code, message: openResult.error?.message },
        page: pageResult.ok ? clip(pageResult.data, 300) : { code: pageResult.error?.code, message: pageResult.error?.message },
      },
      notes: 'CONTRACT §4 says the recycle bin must not be readable. If the host intentionally serves reader.open for a trash preview, Lead must amend CONTRACT.md; the test follows the written contract.',
    })
  } catch (error) {
    recorder.crash(readerRejectionCase, error)
  }

  recorder.skip(
    {
      suite,
      caseId: 'LIFE.05.tool_read_rejected',
      kind: 'agent-tool',
      title: 'Agent tools refuse the trashed paper (papers_get_passage / papers_get_figure)',
      input: { paper_id: targetId },
      expected: 'both tools return {status:"unavailable"} / unavailable error, never the text or image',
    },
    'not callable over HTTP: tools are mounted in the Agent; run one Agent turn with papers_get_passage {paper_id:"' + targetId + '"} and papers_get_figure {paper_id:"' + targetId + '",page:1} while the paper is trashed and attach the tool results as evidence',
    { paper_id: targetId, fixture_id: targetFixture },
  )

  const deleteIdempotentCase = recorder.begin({
    suite,
    caseId: 'LIFE.06.delete_idempotent',
    title: 'Repeating the delete operationId returns the identical cached result',
    expected: 'second call returns the same payload; paper stays in trash',
  })
  try {
    const replay = await client.call('library.delete', { ids: [targetId], operationId: deleteOperationId })
    const trashList = await client.call('library.list', { state: 'trash', limit: 200 })
    recorder.end(deleteIdempotentCase, {
      assertions: [
        check('replay equals first delete response', deepEqual(replay, deleteResponse), clip(deleteResponse, 400), clip(replay, 400)),
        check('paper still in trash', listContains(trashList, targetId), 'present', listContains(trashList, targetId)),
      ],
      actual: { replay: clip(replay, 400) },
    })
  } catch (error) {
    recorder.crash(deleteIdempotentCase, error)
  }

  /* ---------------------------------------------------------------- */
  /* L05 — restore with a fresh epoch and full visibility             */
  /* ---------------------------------------------------------------- */
  const restoreOperationId = `ph-acceptance-life-restore-1-${Date.now()}`
  const restoreCase = recorder.begin({
    suite,
    caseId: 'LIFE.07.restore',
    title: `library.restore returns ${targetFixture} to the active library`,
    expected: 'results[0].ok, state active, new epoch reported, active list includes it',
    input: { ids: [targetId], operationId: restoreOperationId },
  })
  let restoreResponse = null
  try {
    restoreResponse = await client.call('library.restore', { ids: [targetId], operationId: restoreOperationId })
    ctx.state.restoreResponse = restoreResponse
    ctx.state.restoreOperationId = restoreOperationId
    const activeList = await client.call('library.list', { state: 'active', limit: 200 })
    const trashList = await client.call('library.list', { state: 'trash', limit: 200 })
    recorder.end(restoreCase, {
      assertions: [
        check('restore returned ok', restoreResponse?.results?.[0]?.ok === true, true, restoreResponse?.results?.[0] ?? null),
        check('result state is active', restoreResponse?.results?.[0]?.state === 'active', 'active', restoreResponse?.results?.[0]?.state ?? null),
        check('paper returned to the active list', listContains(activeList, targetId), 'present', listContains(activeList, targetId)),
        check('paper left the trash list', !listContains(trashList, targetId), 'absent', listContains(trashList, targetId)),
      ],
      actual: { response: clip(restoreResponse, 400) },
    })
  } catch (error) {
    recorder.crash(restoreCase, error)
  }

  const epochCase = recorder.begin({
    suite,
    caseId: 'LIFE.08.new_epoch',
    title: 'Restore reports a new lifecycle epoch',
    expected: 'numeric epoch > 0, echoed in results[0].epoch',
  })
  const epoch1 = Number(restoreResponse?.epoch ?? restoreResponse?.results?.[0]?.epoch ?? NaN)
  const epoch1Result = Number(restoreResponse?.results?.[0]?.epoch ?? NaN)
  recorder.end(epochCase, {
    assertions: [
      check('response epoch is a positive integer', Number.isInteger(epoch1) && epoch1 > 0, 'positive integer', restoreResponse?.epoch ?? null),
      check('result epoch matches response epoch', Number.isInteger(epoch1Result) && epoch1Result === epoch1, epoch1, epoch1Result),
    ],
    actual: { epoch: restoreResponse?.epoch ?? null, result_epoch: restoreResponse?.results?.[0]?.epoch ?? null },
    notes: 'A second delete/restore cycle below must return a strictly greater epoch.',
  })

  const visibilityCase = recorder.begin({
    suite,
    caseId: 'LIFE.09.visible_again',
    title: 'Restored paper is visible in list, search, figure search and assets',
    expected: 'active list, title search, figure search and page/PDF routes all see the paper again',
  })
  try {
    const activeList = await client.call('library.list', { state: 'active', limit: 200 })
    const titleHits = await observedPaperIds(titleQueryText)
    const figureHits = await observedFigures()
    const observed = await assets()
    recorder.end(visibilityCase, {
      assertions: [
        check('active list includes restored paper', listContains(activeList, targetId), 'present', listContains(activeList, targetId)),
        check('title search finds restored paper', titleHits.paperIds.includes(targetId), targetId, titleHits.paperIds),
        check('figure search finds the audited figure again', figureHits.match !== null, { paper: targetId, page: figurePage, labels: figureLabels }, figureHits.itemPaperIds),
        check('page route serves 200 image/png', observed.page.httpStatus === 200 && observed.page.contentType.startsWith('image/png'), '200 image/png', { status: observed.page.httpStatus, type: observed.page.contentType }),
        check('PDF route serves 200 application/pdf', observed.pdf.httpStatus === 200 && observed.pdf.contentType.startsWith('application/pdf'), '200 application/pdf', { status: observed.pdf.httpStatus, type: observed.pdf.contentType }),
        check('PDF byte size matches the bundled original', observed.pdf.bytes === Number(targetPaper.size_bytes), targetPaper.size_bytes, observed.pdf.bytes),
      ],
      actual: {
        title_items: titleHits.itemCount,
        figure_match: figureHits.match,
        page: { status: observed.page.httpStatus, bytes: observed.page.bytes },
        pdf: { status: observed.pdf.httpStatus, bytes: observed.pdf.bytes },
      },
    })
  } catch (error) {
    recorder.crash(visibilityCase, error)
  }

  const restoreIdempotentCase = recorder.begin({
    suite,
    caseId: 'LIFE.10.restore_idempotent',
    title: 'Repeating the restore operationId returns the identical cached epoch',
    expected: 'same payload and epoch; paper stays active',
  })
  try {
    const replay = await client.call('library.restore', { ids: [targetId], operationId: restoreOperationId })
    const activeList = await client.call('library.list', { state: 'active', limit: 200 })
    recorder.end(restoreIdempotentCase, {
      assertions: [
        check('replay equals first restore response', deepEqual(replay, restoreResponse), clip(restoreResponse, 400), clip(replay, 400)),
        check('paper still active', listContains(activeList, targetId), 'present', listContains(activeList, targetId)),
      ],
      actual: { replay: clip(replay, 400) },
    })
  } catch (error) {
    recorder.crash(restoreIdempotentCase, error)
  }

  /* ---------------------------------------------------------------- */
  /* Second cycle: epoch must strictly increase                       */
  /* ---------------------------------------------------------------- */
  const secondCycleCase = recorder.begin({
    suite,
    caseId: 'LIFE.11.second_cycle_epoch',
    title: 'A second delete/restore cycle increments the epoch again',
    expected: 'epoch2 > epoch1',
  })
  try {
    await client.call('library.delete', { ids: [targetId], operationId: `ph-acceptance-life-delete-2-${Date.now()}` })
    const restore2 = await client.call('library.restore', { ids: [targetId], operationId: `ph-acceptance-life-restore-2-${Date.now()}` })
    const epoch2 = Number(restore2?.epoch ?? restore2?.results?.[0]?.epoch ?? NaN)
    recorder.end(secondCycleCase, {
      assertions: [
        check('second epoch is numeric', Number.isInteger(epoch2), 'integer', epoch2),
        check('second epoch is strictly greater', Number.isInteger(epoch2) && Number.isInteger(epoch1) && epoch2 > epoch1, `> ${epoch1}`, epoch2),
        check('second restore result reports active', restore2?.results?.[0]?.state === 'active', 'active', restore2?.results?.[0]?.state ?? null),
      ],
      actual: { epoch1, epoch2, restore2: clip(restore2, 300) },
    })
  } catch (error) {
    recorder.crash(secondCycleCase, error)
  }

  /* ---------------------------------------------------------------- */
  /* End state must be active and searchable                          */
  /* ---------------------------------------------------------------- */
  const endCase = recorder.begin({
    suite,
    caseId: 'LIFE.12.end_state',
    title: `Suite leaves ${targetFixture} active and searchable`,
    expected: 'active list, title search, figure search and page asset all available',
  })
  try {
    const activeList = await client.call('library.list', { state: 'active', limit: 200 })
    const titleHits = await observedPaperIds(titleQueryText)
    const figureHits = await observedFigures()
    const page = await client.getAsset(`/pappers-hall/page/${targetId}/1.png?width=600`)
    recorder.end(endCase, {
      assertions: [
        check('paper active at the end of the suite', listContains(activeList, targetId), 'present', listContains(activeList, targetId)),
        check('title search finds the paper', titleHits.paperIds.includes(targetId), targetId, titleHits.paperIds),
        check('figure search finds the audited figure', figureHits.match !== null, 'figure match', figureHits.itemPaperIds),
        check('page asset available', page.httpStatus === 200, 200, page.httpStatus),
      ],
      actual: { paper_id: targetId, fixture_id: targetFixture },
      notes: 'The suite never purges fixture papers; only the test-created read marks/annotations are test data.',
    })
  } catch (error) {
    recorder.crash(endCase, error)
  }

  /* ---------------------------------------------------------------- */
  /* Persist results                                                  */
  /* ---------------------------------------------------------------- */
  const lifecycleSummary = {
    schema: 'pappers-hall/lifecycle-result@1',
    generated_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    contract_version: CONTRACT_VERSION,
    target: { fixture_id: targetFixture, paper_id: targetId, title: targetPaper.title },
    delete_operation_id: ctx.state.deleteOperationId ?? null,
    restore_operation_id: ctx.state.restoreOperationId ?? null,
    epochs: { first_restore: Number.isFinite(epoch1) ? epoch1 : null, second_restore: null },
    duration_ms: Date.now() - runStarted,
  }
  writeJsonFile(artifactPath('lifecycle-result.json'), lifecycleSummary)
  return { summary: recorder.summary(), lifecycleSummary, durationMs: lifecycleSummary.duration_ms }
}

/** CLI entry for `node test/lifecycle.mjs`. */
export async function main() {
  return runSuiteCli({ suite: 'lifecycle', planned: PLANNED, run })
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`lifecycle: ${String(error?.stack ?? error)}`)
      process.exitCode = 1
    })
}
