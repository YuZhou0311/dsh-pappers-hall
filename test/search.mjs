/**
 * Search acceptance suite — the 60 audited paper queries plus the S05/S07
 * regression probes (contract §2.1 `search.query` / `figures.search`, §7).
 *
 * Evaluation rules (from `tests/queries.json` and `tests/test_plan.md`):
 * - run against the test library *without* seed annotations (the annotation
 *   suite runs after this one; a re-run notes pre-existing annotations instead
 *   of deleting them),
 * - record Top1 and Top5 paper recall against `expected_paper_ids`; Top5 is the
 *   pass criterion, Top1 is a recorded metric,
 * - figure queries must additionally be located by `figures.search`: paper id,
 *   1-based physical page and figure label must match `source_anchor`, and the
 *   matched crop must be a real PNG served by the plugin,
 * - `figure_recall_and_understanding` tasks additionally require a real page
 *   image for the model; the model-side answer is not testable over HTTP and is
 *   recorded as `not_run` with the exact manual procedure,
 * - channels must be explicit: the vector/image-embedding channel is degraded
 *   with a stated reason and never claims a similarity.
 *
 * @module pappers-hall/test/search
 */
import {
  CONTRACT_VERSION,
  HARNESS_VERSION,
  check,
  clip,
  isMain,
  normalizeFigureLabel,
  prepareLibrary,
  productionIds,
  queryFigureLabels,
  queryPage,
  runSuiteCli,
  writeJsonFile,
  artifactPath,
} from './lib.mjs'

/** Planned live case counts asserted by the dry run. */
export const PLANNED = Object.freeze({
  paperQueries: 60,
  understandingQueries: 18,
  visualTasks: 3,
  figureQueries: 30,
  totalCases: 90,
})

/** Explicit test read marks used by the S07 probe (documented in verify.md). */
const READ_MARK_FIXTURES = ['R04', 'E06']
/** Read-filter target paper. */
const READ_FILTER_TARGET = 'R04'

/**
 * Search hits whose `paperId` appears in the first N results, ordered by rank
 * and de-duplicated by paper (a figure and the paper row count once).
 * @param {object[]} items search hits.
 * @param {number} n window size.
 * @returns {string[]} production paper ids.
 */
function topPaperIds(items, n) {
  const seen = new Set()
  const ids = []
  for (const item of items.slice(0, n)) {
    const paperId = typeof item?.paperId === 'string' ? item.paperId : null
    if (paperId === null || seen.has(paperId)) continue
    seen.add(paperId)
    ids.push(paperId)
  }
  return ids
}

/**
 * Check whether one query's figure anchor is served by `figures.search`.
 * @param {object[]} items figures.search items.
 * @param {{paperId:string, page:number, labels:string[]}} wanted wanted anchor.
 * @returns {object|null} matching item with extra match facts.
 */
function matchFigureAnchor(items, wanted) {
  for (const item of items) {
    const paperId = item?.paper?.id ?? item?.paperId ?? null
    const page = Number(item?.page ?? item?.figure?.page)
    const label = String(item?.figure?.label ?? '')
    if (paperId !== wanted.paperId) continue
    if (page !== wanted.page) continue
    if (!wanted.labels.some((entry) => normalizeFigureLabel(entry) === normalizeFigureLabel(label))) continue
    return {
      figure_id: item?.figure?.id ?? null,
      page,
      label,
      image_url: item?.figure?.imageUrl ?? null,
      reasons: item?.reasons ?? [],
      score: item?.score ?? null,
    }
  }
  return null
}

/**
 * Look for one expected-paper hit carrying a real explanation.
 * @param {object[]} items search.query hits.
 * @param {string[]} expectedProductionIds expected production ids.
 * @returns {{hit:object|null, reasons:string[]}} first matching hit.
 */
function firstExpectedHit(items, expectedProductionIds) {
  for (const item of items) {
    if (!expectedProductionIds.includes(item?.paperId)) continue
    const reasons = Array.isArray(item?.reasons) ? item.reasons.filter((reason) => typeof reason === 'string' && reason !== '') : []
    return { hit: item, reasons }
  }
  return { hit: null, reasons: [] }
}

/**
 * Detect the honest degraded image channel in a figures.search response.
 * @param {object[]} channels returned channel list.
 * @returns {{honest:boolean, entry:object|null}} detection.
 */
function imageChannelHonesty(channels) {
  const list = Array.isArray(channels) ? channels : []
  const imageChannels = list.filter((channel) => /image|visual/i.test(String(channel?.name ?? '')))
  const honestEntry = imageChannels.find((channel) => channel?.status === 'degraded' && String(channel?.note ?? '').trim() !== '')
  return { honest: honestEntry !== undefined, entry: honestEntry ?? imageChannels[0] ?? null, count: imageChannels.length }
}

/**
 * Run the search suite.
 * @param {object} ctx shared suite context.
 * @returns {Promise<object>} suite result.
 */
export async function run(ctx) {
  const { client, fixtures, recorder, options } = ctx
  const suite = 'search'
  const runStarted = Date.now()

  /* ---------------------------------------------------------------- */
  /* Preconditions                                                    */
  /* ---------------------------------------------------------------- */
  const library = await prepareLibrary(ctx)
  const preconditionCase = recorder.begin({
    suite,
    caseId: 'SEARCH.00.preconditions',
    title: 'Test library holds the 30 fixture papers before retrieval',
    expected: '30/30 fixture papers imported and active; seed annotations absent on a first run',
  })
  const status = ctx.state.status ?? (await client.call('status'))
  recorder.end(preconditionCase, {
    assertions: [
      check('30 fixture papers resolved', library.counts.fixturesMatched === fixtures.papers.length, fixtures.papers.length, library.counts.fixturesMatched),
      check('all fixture papers active', fixtures.papers.every((paper) => library.byFixture.get(paper.id)?.state === 'active'), 'active', fixtures.papers.filter((paper) => library.byFixture.get(paper.id)?.state !== 'active').map((paper) => paper.id)),
    ],
    actual: { counts: library.counts, annotations: status?.counts?.annotations ?? null },
    notes: Number(status?.counts?.annotations ?? 0) > 0
      ? `test library already contains ${status.counts.annotations} annotation(s) from an earlier annotation run; paper recall is computed by paperId and is unaffected, but the first-run rule "no seed annotations" is noted.`
      : 'test library has no annotations: this is the clean first-run ordering required by test_plan.md',
  })
  if (library.counts.fixturesMatched !== fixtures.papers.length) {
    const reason = `search precondition failed: ${library.counts.fixturesMatched}/${fixtures.papers.length} fixture papers imported (run the import suite first)`
    for (const query of fixtures.queryList) {
      recorder.skip({ suite, caseId: `SEARCH.${query.id}`, kind: query.kind, title: `${query.id} paper recall`, input: { q: query.query_zh }, expected: { expected_paper_ids: query.expected_paper_ids } }, reason)
    }
    return { summary: recorder.summary(), searchSummary: null, reason }
  }

  /* ---------------------------------------------------------------- */
  /* The 60 audited queries                                           */
  /* ---------------------------------------------------------------- */
  const paperMap = library.paperMap
  // Audited figure anchor of each manifest paper (first figure query), used to
  // separate "caption was never detected" from "detected caption did not match
  // the Chinese description" when explaining figure-recall failures.
  const anchorByPaper = new Map()
  for (const query of fixtures.queryList) {
    if (query.kind !== 'figure_recall' && query.kind !== 'figure_recall_and_understanding') continue
    const paperId = query.expected_paper_ids?.[0]
    if (typeof paperId === 'string' && !anchorByPaper.has(paperId)) anchorByPaper.set(paperId, query)
  }
  const figuresByPaper = new Map()
  async function figureRowsOf(productionId) {
    if (figuresByPaper.has(productionId)) return figuresByPaper.get(productionId)
    let rows = []
    try {
      rows = await client.call('figures.list', { paperId: productionId })
    } catch {
      rows = []
    }
    figuresByPaper.set(productionId, Array.isArray(rows) ? rows : [])
    return figuresByPaper.get(productionId)
  }
  const metrics = {
    queries: 0,
    top1: 0,
    top5: 0,
    by_kind: {},
    figure_queries: 0,
    figure_matched: 0,
    figure_page_matched: 0,
    figure_label_matched: 0,
    figure_assets_ok: 0,
    figure_anchor_detected: 0,
    figure_fail_no_anchor: 0,
    figure_fail_lexical_mismatch: 0,
    understanding_not_run: 0,
    failures: [],
  }
  const rows = []

  for (const query of fixtures.queryList) {
    const isFigureKind = query.kind === 'figure_recall' || query.kind === 'figure_recall_and_understanding'
    const expectedProductionIds = productionIds(paperMap, query.expected_paper_ids)
    const anchorPage = queryPage(query)
    const anchorLabels = queryFigureLabels(query)
    const handle = recorder.begin({
      suite,
      caseId: `SEARCH.${query.id}`,
      kind: query.kind,
      title: `${query.id} ${isFigureKind ? 'figure recall + location' : 'paper recall'}`,
      input: { q: query.query_zh, limit: 10, scope: 'library' },
      expected: { expected_paper_ids: query.expected_paper_ids, production_ids: expectedProductionIds, pdf_page: anchorPage, figure: query.source_anchor?.figure ?? null },
    })
    try {
      const searchResult = await client.call('search.query', { q: query.query_zh, limit: 10, filters: { trash: false } })
      const items = Array.isArray(searchResult?.items) ? searchResult.items : []
      const channels = Array.isArray(searchResult?.channels) ? searchResult.channels : []
      const top1 = items[0]?.paperId ?? null
      const top5 = topPaperIds(items, 5)
      const top1Hit = top1 !== null && expectedProductionIds.includes(top1)
      const top5Hit = top5.some((paperId) => expectedProductionIds.includes(paperId))
      const expectedHit = firstExpectedHit(items, expectedProductionIds)
      const pageHit = expectedHit.hit !== null && Number(expectedHit.hit?.page) === anchorPage

      metrics.queries += 1
      if (top1Hit) metrics.top1 += 1
      if (top5Hit) metrics.top5 += 1
      const kindKey = query.kind
      metrics.by_kind[kindKey] ??= { total: 0, top1: 0, top5: 0 }
      metrics.by_kind[kindKey].total += 1
      if (top1Hit) metrics.by_kind[kindKey].top1 += 1
      if (top5Hit) metrics.by_kind[kindKey].top5 += 1

      const assertions = [check('Top5 contains an expected paper', top5Hit, query.expected_paper_ids, top5)]
      let figureFacts = null
      let figureMatch = null
      if (isFigureKind) {
        metrics.figure_queries += 1
        // Did the import pipeline detect this audited figure at all?
        const anchorQuery = anchorByPaper.get(query.expected_paper_ids?.[0])
        const anchorPaperId = expectedProductionIds[0] ?? ''
        let anchorDetected = false
        if (anchorQuery !== undefined && anchorPaperId !== '') {
          const anchorFigures = await figureRowsOf(anchorPaperId)
          const wantedPage = queryPage(anchorQuery)
          const wantedLabels = queryFigureLabels(anchorQuery)
          anchorDetected = anchorFigures.some((figure) => {
            const page = Number(figure?.page)
            const label = String(figure?.label ?? '')
            return page === wantedPage && wantedLabels.some((wanted) => normalizeFigureLabel(wanted) === normalizeFigureLabel(label))
          })
        }
        if (anchorDetected) metrics.figure_anchor_detected += 1
        let figureItems = []
        let figureChannels = []
        try {
          const figureResult = await client.call('figures.search', { q: query.query_zh, limit: 20, mode: 'text' })
          figureItems = Array.isArray(figureResult?.items) ? figureResult.items : []
          figureChannels = Array.isArray(figureResult?.channels) ? figureResult.channels : []
        } catch (error) {
          figureFacts = { error: { code: error?.code ?? 'unknown', message: String(error?.message ?? error) } }
        }
        const wanted = { paperId: expectedProductionIds[0] ?? '', page: anchorPage, labels: anchorLabels }
        figureMatch = expectedProductionIds.length > 0 && anchorPage !== null ? matchFigureAnchor(figureItems, wanted) : null
        const pageMatch = figureItems.some((item) => {
          const paperId = item?.paper?.id ?? item?.paperId
          return expectedProductionIds.includes(paperId) && Number(item?.page ?? item?.figure?.page) === anchorPage
        })
        const labelMatch = figureItems.some((item) => {
          const paperId = item?.paper?.id ?? item?.paperId
          return expectedProductionIds.includes(paperId) && anchorLabels.some((label) => normalizeFigureLabel(label) === normalizeFigureLabel(item?.figure?.label))
        })
        if (figureMatch !== null) metrics.figure_matched += 1
        else if (anchorDetected) metrics.figure_fail_lexical_mismatch += 1
        else metrics.figure_fail_no_anchor += 1
        if (pageMatch) metrics.figure_page_matched += 1
        if (labelMatch) metrics.figure_label_matched += 1
        const honesty = imageChannelHonesty(figureChannels)
        let assetFacts = null
        if (figureMatch !== null && typeof figureMatch.image_url === 'string') {
          try {
            const asset = await client.getAsset(figureMatch.image_url)
            assetFacts = { status: asset.httpStatus, contentType: asset.contentType, bytes: asset.bytes, sha256: asset.sha256 }
            if (asset.httpStatus === 200 && asset.contentType.startsWith('image/png') && asset.bytes > 1000) metrics.figure_assets_ok += 1
            assertions.push(check('matched figure crop is a real PNG', asset.httpStatus === 200 && asset.contentType.startsWith('image/png') && asset.bytes > 1000, '200 image/png > 1KB', { status: asset.httpStatus, type: asset.contentType, bytes: asset.bytes }))
          } catch (error) {
            assertions.push(check('matched figure crop is a real PNG', false, '200 image/png', String(error?.message ?? error)))
          }
        } else {
          assertions.push(check('matched figure crop is a real PNG', false, 'figure image URL available', 'no matched figure'))
        }
        assertions.push(
          check('figure located at anchor paper + 1-based page + label', figureMatch !== null, { paper: expectedProductionIds[0] ?? null, page: anchorPage, label: anchorLabels }, figureMatch),
          check('image channel reports degraded with a reason', honesty.honest, 'image/visual channel status=degraded with note', honesty.entry ?? figureChannels),
          check('search hit carries reasons', expectedHit.reasons.length > 0 || figureMatch !== null, 'non-empty reasons on the expected hit', expectedHit.reasons),
        )
        figureFacts = {
          anchor_detected: anchorDetected,
          items: figureItems.length,
          channels: figureChannels,
          match: figureMatch,
          page_match: pageMatch,
          label_match: labelMatch,
          image_channel: honesty.entry,
          asset: assetFacts,
        }
        // The understanding half of this task must be answered by a model that
        // actually received the image; that cannot be proven over HTTP.
        if (query.kind === 'figure_recall_and_understanding') {
          metrics.understanding_not_run += 1
          recorder.skip(
            {
              suite,
              caseId: `SEARCH.UNDERSTANDING.${query.id}`,
              kind: 'figure_understanding',
              title: `${query.id} figure understanding (model must see the real image)`,
              input: { q: query.query_zh, expected_answer_points_zh: query.expected_answer_points_zh ?? null },
              expected: { requires_real_image_in_model_request: true },
            },
            'not testable over HTTP: needs an Agent turn whose provider request demonstrably carries the figure/page image (papers_get_figure / read_image); run manually and attach provider request evidence',
            { figure: figureMatch, paper_id: expectedProductionIds[0] ?? null, anchor_page: anchorPage },
          )
        }
      } else {
        assertions.push(check('expected-paper hit carries reasons', expectedHit.reasons.length > 0, 'non-empty reasons array', expectedHit.reasons))
      }

      rows.push({
        id: query.id,
        kind: query.kind,
        top1_paper: top1,
        top1_hit: top1Hit,
        top5_papers: top5,
        top5_hit: top5Hit,
        expected_production_ids: expectedProductionIds,
        expected_hit: expectedHit.hit === null ? null : { kind: expectedHit.hit.kind, id: expectedHit.hit.id, page: expectedHit.hit.page ?? null, reasons: expectedHit.reasons, snippet: clip(expectedHit.hit.snippet, 200) },
        page_hit: pageHit,
        figure: figureFacts,
        anchor_detected: isFigureKind ? figureFacts?.anchor_detected ?? null : null,
        channels,
        item_count: items.length,
        took_ms: searchResult?.tookMs ?? null,
      })
      const recorded = recorder.end(handle, {
        assertions,
        actual: {
          top1,
          top5,
          top1_hit: top1Hit,
          top5_hit: top5Hit,
          item_count: items.length,
          expected_hit: rows.at(-1).expected_hit,
          page_hit: pageHit,
          figure: figureFacts === null ? null : { match: figureMatch, page_match: figureFacts.page_match, label_match: figureFacts.label_match, image_channel: figureFacts.image_channel, asset: figureFacts.asset },
          took_ms: searchResult?.tookMs ?? null,
        },
        evidence: { channels, top5_titles: items.slice(0, 5).map((item) => `${item.kind}:${clip(item.title, 80)}`) },
      })
      if (recorded.status !== 'pass') metrics.failures.push(query.id)
    } catch (error) {
      recorder.crash(handle, error)
      metrics.failures.push(query.id)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Global channel honesty                                           */
  /* ---------------------------------------------------------------- */
  const channelCase = recorder.begin({
    suite,
    caseId: 'SEARCH.01.channels',
    title: 'search.query states every channel and never fakes an embedding',
    expected: 'channels non-empty; vector/embedding channels degraded with a note',
  })
  try {
    const sample = await client.call('search.query', { q: fixtures.queryList[0].query_zh, limit: 5 })
    const channels = Array.isArray(sample?.channels) ? sample.channels : []
    const vectorChannels = channels.filter((channel) => /vector|embedding/i.test(String(channel?.name ?? '')))
    recorder.end(channelCase, {
      assertions: [
        check('channels non-empty', channels.length > 0, '>= 1 channel', channels.length),
        check('vector/embedding channel explicitly degraded', vectorChannels.length === 0 || vectorChannels.every((channel) => channel.status === 'degraded' && String(channel.note ?? '') !== ''), 'degraded with note', vectorChannels),
        check('channel statuses are ok|degraded', channels.every((channel) => channel.status === 'ok' || channel.status === 'degraded'), 'ok|degraded', channels.map((channel) => channel.status)),
      ],
      actual: channels,
    })
  } catch (error) {
    recorder.crash(channelCase, error)
  }

  /* ---------------------------------------------------------------- */
  /* S05 — nonexistent title / DOI                                    */
  /* ---------------------------------------------------------------- */
  const s05Title = 'Quantum-Crop Diffusion Transformers for Blockchain Yield Prediction: A Nonexistent 2026 Benchmark'
  const s05Doi = '10.9999/ph-acceptance-nonexistent.2026.001'
  const s05TitleCase = recorder.begin({
    suite,
    caseId: 'SEARCH.S05.title',
    title: 'Searching a nonexistent title does not fabricate a library paper',
    expected: 'no hit repeats the fabricated title; any hits are real library records',
    input: { q: s05Title },
  })
  try {
    const result = await client.call('search.query', { q: s05Title, limit: 10 })
    const items = Array.isArray(result?.items) ? result.items : []
    const fabricatedCore = 'blockchain yield prediction'
    const fabricatedHits = items.filter((item) => String(item?.title ?? '').toLowerCase().includes(fabricatedCore))
    const knownPaperIds = new Set([...paperMap.values()])
    const unknownIds = items.map((item) => item?.paperId).filter((paperId) => paperId !== null && !knownPaperIds.has(paperId))
    recorder.end(s05TitleCase, {
      assertions: [
        check('no hit claims the fabricated title', fabricatedHits.length === 0, 0, fabricatedHits.length),
        check('hits only reference library papers', unknownIds.length === 0, 0, unknownIds),
      ],
      actual: { items: items.slice(0, 5).map((item) => ({ kind: item.kind, title: clip(item.title, 120), paperId: item.paperId })), total: items.length },
      notes: 'Lexical search may return loosely related real papers; that is acceptable as long as no nonexistent paper is presented as an in-library result.',
    })
    if (recorder.cases.at(-1).status !== 'pass') metrics.failures.push('S05.title')
  } catch (error) {
    recorder.crash(s05TitleCase, error)
    metrics.failures.push('S05.title')
  }
  const s05DoiCase = recorder.begin({
    suite,
    caseId: 'SEARCH.S05.doi',
    title: 'Searching a nonexistent DOI returns no fabricated paper',
    expected: 'no hit carries the fabricated DOI as an existing record',
    input: { q: s05Doi },
  })
  try {
    const result = await client.call('search.query', { q: s05Doi, limit: 10 })
    const items = Array.isArray(result?.items) ? result.items : []
    const knownPaperIds = new Set([...paperMap.values()])
    const unknownIds = items.map((item) => item?.paperId).filter((paperId) => paperId !== null && !knownPaperIds.has(paperId))
    recorder.end(s05DoiCase, {
      assertions: [
        check('hits only reference library papers', unknownIds.length === 0, 0, unknownIds),
        check('no hit snippet claims the fabricated DOI', items.every((item) => !String(item?.snippet ?? '').includes(s05Doi) && !String(item?.title ?? '').includes(s05Doi)), true, items.map((item) => clip(item.snippet, 80))),
      ],
      actual: { total: items.length, items: items.slice(0, 5).map((item) => ({ kind: item.kind, paperId: item.paperId, snippet: clip(item.snippet, 120) })) },
    })
    if (recorder.cases.at(-1).status !== 'pass') metrics.failures.push('S05.doi')
  } catch (error) {
    recorder.crash(s05DoiCase, error)
    metrics.failures.push('S05.doi')
  }

  /* ---------------------------------------------------------------- */
  /* S07 — only explicit read marks are honoured                      */
  /* ---------------------------------------------------------------- */
  const readIds = []
  // Snapshot which papers were already read before this suite sets its explicit
  // test marks: external/manual reading (e.g. Lead browser verification) must be
  // recorded so the report distinguishes it from harness-created state.
  try {
    const preReadList = await client.call('library.list', { state: 'active', read: true, limit: 200 })
    ctx.state.preExistingReadIds = (Array.isArray(preReadList?.items) ? preReadList.items : []).map((item) => item.id)
  } catch {
    ctx.state.preExistingReadIds = []
  }
  const readSetupCase = recorder.begin({
    suite,
    caseId: 'SEARCH.S07.setup',
    title: 'Explicit test read marks can be set',
    expected: 'library.setRead marks two fixture papers as read (recorded test data)',
    input: { fixtures: READ_MARK_FIXTURES },
  })
  try {
    const ids = READ_MARK_FIXTURES.map((fixtureId) => paperMap.get(fixtureId)).filter((id) => typeof id === 'string')
    const result = await client.call('library.setRead', { ids, read: true, operationId: `ph-acceptance-read-marks-${ids.join('-')}` })
    const ok = Array.isArray(result?.results) && result.results.every((entry) => entry.ok === true)
    readIds.push(...ids)
    ctx.state.readMarks = ids
    recorder.end(readSetupCase, {
      assertions: [
        check('two read marks set', ok && ids.length === READ_MARK_FIXTURES.length, READ_MARK_FIXTURES.length, ids.length),
      ],
      actual: { ids, result: clip(result, 300) },
      notes: `These are explicit test read marks (${READ_MARK_FIXTURES.join(', ')}); they are recorded in reports so they are never mistaken for real user reading history.`,
    })
  } catch (error) {
    recorder.end(readSetupCase, {
      status: 'not_run',
      reason: `no read-mark API available (${error?.code ?? 'error'}: ${String(error?.message ?? error)})`,
      actual: { error: String(error?.message ?? error) },
    })
  }

  const listFilterCase = recorder.begin({
    suite,
    caseId: 'SEARCH.S07.list_filter',
    title: 'library.list read filter returns exactly the marked papers',
    expected: 'read:true items all read; read:false excludes marked ids; counts partition the library',
  })
  if (readIds.length === 0) {
    recorder.end(listFilterCase, { status: 'not_run', reason: 'no explicit read marks were set (library.setRead unavailable)' })
  } else {
    try {
      const readList = await client.call('library.list', { state: 'active', read: true, limit: 200 })
      const unreadList = await client.call('library.list', { state: 'active', read: false, limit: 200 })
      const readItems = Array.isArray(readList?.items) ? readList.items : []
      const unreadItems = Array.isArray(unreadList?.items) ? unreadList.items : []
      recorder.end(listFilterCase, {
        assertions: [
          check('read:true only contains read papers', readItems.every((item) => item.read === true), 'read===true', readItems.map((item) => ({ id: item.id, read: item.read }))),
          check('read marks appear in read list', readIds.every((id) => readItems.some((item) => item.id === id)), readIds, readItems.map((item) => item.id)),
          check('read:false excludes marked papers', readIds.every((id) => !unreadItems.some((item) => item.id === id)), 'marked ids absent', unreadItems.filter((item) => readIds.includes(item.id)).map((item) => item.id)),
          check('unread list only contains unread papers', unreadItems.every((item) => item.read === false), 'read===false', unreadItems.map((item) => item.read)),
          check('both lists partition the active library', Number(readList?.total ?? 0) + Number(unreadList?.total ?? 0) === Number(library.counts.active ?? 0), library.counts.active, Number(readList?.total ?? 0) + Number(unreadList?.total ?? 0)),
        ],
        actual: { read_total: readList?.total, unread_total: unreadList?.total, active: library.counts.active },
      })
    } catch (error) {
      recorder.crash(listFilterCase, error)
    }
  }

  const readerCase = recorder.begin({
    suite,
    caseId: 'SEARCH.S07.reader_open_no_auto_read',
    title: 'Opening a paper does not mark it read',
    expected: 'reader.open leaves the read flag unchanged',
  })
  try {
    const unreadFixture = fixtures.papers.find((paper) => !READ_MARK_FIXTURES.includes(paper.id))
    const unreadId = paperMap.get(unreadFixture.id)
    const beforeDetail = await client.call('library.get', { id: unreadId })
    await client.call('reader.open', { id: unreadId })
    const afterDetail = await client.call('library.get', { id: unreadId })
    recorder.end(readerCase, {
      assertions: [
        check('read flag unchanged by reader.open', beforeDetail?.read === afterDetail?.read, beforeDetail?.read ?? null, afterDetail?.read ?? null),
      ],
      actual: { paper_id: unreadId, fixture_id: unreadFixture.id, before_read: beforeDetail?.read ?? null, after_read: afterDetail?.read ?? null },
      notes: beforeDetail?.read === true
        ? 'this fixture paper was already read before the probe (external/manual state); the check asserts the flag does not change'
        : 'opening the reader must not mark the paper read',
    })
  } catch (error) {
    recorder.crash(readerCase, error)
  }

  const referenceCase = recorder.begin({
    suite,
    caseId: 'SEARCH.S07.reference_no_auto_read',
    title: 'Committing a reference does not mark the paper read',
    expected: 'references.commit succeeds and the read flag stays false',
  })
  try {
    // Pick the last fixture paper that is unread right now (excluding the
    // explicit test read marks); external/manual reading may have already
    // marked other papers, so the pre-state is captured instead of assumed.
    const candidates = fixtures.papers.filter((paper) => !READ_MARK_FIXTURES.includes(paper.id)).reverse()
    let unreadFixture = null
    let unreadId = null
    let beforeRead = null
    for (const candidate of candidates) {
      const productionId = paperMap.get(candidate.id)
      if (productionId === undefined) continue
      const detail = await client.call('library.get', { id: productionId })
      if (detail?.read !== true) {
        unreadFixture = candidate
        unreadId = productionId
        beforeRead = detail?.read === true
        break
      }
    }
    if (unreadId === null) {
      recorder.end(referenceCase, { status: 'not_run', reason: 'no unread fixture paper left to test the "citing does not mark read" rule' })
    } else {
      const commit = await client.call('references.commit', { items: [{ kind: 'paper', id: unreadId }], operationId: `ph-acceptance-ref-${unreadId}` })
      const afterDetail = await client.call('library.get', { id: unreadId })
      recorder.end(referenceCase, {
        assertions: [
          check('references.commit returned a bundle', typeof commit?.bundleId === 'string' && commit.bundleId !== '', 'bundle id', commit?.bundleId ?? null),
          check('read flag unchanged by reference commit', afterDetail?.read === beforeRead, beforeRead, afterDetail?.read),
        ],
        actual: { paper_id: unreadId, fixture_id: unreadFixture.id, bundle_id: commit?.bundleId ?? null, before_read: beforeRead, after_read: afterDetail?.read },
        notes: 'references.commit must not flip the read flag; the assertion compares against the captured pre-state.',
      })
    }
  } catch (error) {
    recorder.end(referenceCase, {
      status: 'not_run',
      reason: `references.commit unavailable or failed (${error?.code ?? 'error'}); verify manually that citing does not mark a paper read`,
      actual: { error: String(error?.message ?? error) },
    })
  }

  const readFilterSearchCase = recorder.begin({
    suite,
    caseId: 'SEARCH.S07.search_filter',
    title: 'search.query read filter only returns explicitly read papers',
    expected: 'every hit paperId belongs to the explicit read set',
  })
  if (readIds.length === 0) {
    recorder.end(readFilterSearchCase, { status: 'not_run', reason: 'no explicit read marks were set (library.setRead unavailable)' })
  } else {
    try {
      const targetQuery = fixtures.queryList.find((query) => query.expected_paper_ids?.[0] === READ_FILTER_TARGET) ?? fixtures.queryList[0]
      const result = await client.call('search.query', { q: targetQuery.query_zh, limit: 10, filters: { read: true } })
      const items = Array.isArray(result?.items) ? result.items : []
      const readSet = new Set(readIds)
      recorder.end(readFilterSearchCase, {
        assertions: [
          check('every hit paper is explicitly read', items.every((item) => item.paperId === null || readSet.has(item.paperId)), [...readSet], items.map((item) => item.paperId)),
          check('read filter finds the marked target', items.some((item) => item.paperId === paperMap.get(READ_FILTER_TARGET)), paperMap.get(READ_FILTER_TARGET), items.map((item) => item.paperId)),
        ],
        actual: { query: targetQuery.id, items: items.slice(0, 5).map((item) => ({ kind: item.kind, paperId: item.paperId, title: clip(item.title, 100) })) },
      })
    } catch (error) {
      recorder.crash(readFilterSearchCase, error)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Visual understanding: image delivery check (model part not_run)  */
  /* ---------------------------------------------------------------- */
  for (const task of fixtures.visualList) {
    const handle = recorder.begin({
      suite: 'search',
      caseId: `SEARCH.VIS.${task.id}`,
      kind: 'figure_understanding',
      title: `${task.id} real image delivery for ${task.paper_id} page ${task.source_anchor?.pdf_page}`,
      input: { query_zh: task.query_zh, expected_answer_points_zh: task.expected_answer_points_zh },
      expected: { paper_id: task.paper_id, page: task.source_anchor?.pdf_page, figure: task.source_anchor?.figure ?? null },
    })
    const productionId = paperMap.get(task.paper_id)
    if (productionId === undefined) {
      recorder.end(handle, { status: 'fail', actual: { missing_paper: task.paper_id } })
      continue
    }
    try {
      const page = Number(task.source_anchor?.pdf_page)
      const figures = await client.call('figures.list', { paperId: productionId })
      const pageAsset = await client.getAsset(`/pappers-hall/page/${productionId}/${page}.png?width=1400`)
      const readerPage = await client.call('reader.page', { id: productionId, page })
      const wantedFigure = task.source_anchor?.figure ?? ''
      const figureHit = Array.isArray(figures)
        ? figures.some((figure) => Number(figure?.page) === page && normalizeFigureLabel(figure?.label) === normalizeFigureLabel(wantedFigure))
        : false
      recorder.end(handle, {
        assertions: [
          check('anchor page renders as real PNG', pageAsset.httpStatus === 200 && pageAsset.contentType.startsWith('image/png') && pageAsset.bytes > 10_000, '200 image/png > 10KB', { status: pageAsset.httpStatus, type: pageAsset.contentType, bytes: pageAsset.bytes }),
          check('reader.page returns text for the anchor page', typeof readerPage?.text === 'string' && readerPage.text.length > 200, '> 200 chars', typeof readerPage?.text === 'string' ? readerPage.text.length : 0),
          check('anchor figure detected on the page', figureHit, { page, figure: wantedFigure }, Array.isArray(figures) ? figures.filter((figure) => Number(figure?.page) === page).map((figure) => figure.label) : []),
        ],
        actual: { paper_id: productionId, page, image_sha256: pageAsset.sha256, image_bytes: pageAsset.bytes, reference_render_sha256: task.image_sha256 ?? null },
        notes: `Image bytes may differ from the audited reference render (${clip(task.image_sha256, 20)}…) because the plugin renders at its own scale; the task requires a real rendered page. The model answer itself is not_run: it needs an Agent turn whose provider request carries this image.`,
      })
      recorder.skip(
        {
          suite: 'search',
          caseId: `SEARCH.VIS.ANSWER.${task.id}`,
          kind: 'figure_understanding',
          title: `${task.id} model reads the image (manual)`,
          input: { query_zh: task.query_zh, expected_answer_points_zh: task.expected_answer_points_zh },
          expected: { answer_points_zh: task.expected_answer_points_zh },
        },
        'not testable over HTTP: send the page image to an image-capable model through an Agent turn, verify the provider request contains the image, then score the answer against expected_answer_points_zh',
        { image_url: `/pappers-hall/page/${productionId}/${page}.png?width=1400` },
      )
    } catch (error) {
      recorder.crash(handle, error, { paper_id: task.paper_id })
    }
  }

  /* ---------------------------------------------------------------- */
  /* Summary                                                          */
  /* ---------------------------------------------------------------- */
  const executed = metrics.queries
  const searchSummary = {
    generated_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    contract_version: CONTRACT_VERSION,
    library: library.counts,
    paper_queries: metrics.queries,
    top1_hits: metrics.top1,
    top5_hits: metrics.top5,
    recall_at_1: executed === 0 ? 0 : Math.round((metrics.top1 / executed) * 1000) / 1000,
    recall_at_5: executed === 0 ? 0 : Math.round((metrics.top5 / executed) * 1000) / 1000,
    by_kind: metrics.by_kind,
    figure_queries: metrics.figure_queries,
    figure_matched: metrics.figure_matched,
    figure_page_matched: metrics.figure_page_matched,
    figure_label_matched: metrics.figure_label_matched,
    figure_assets_ok: metrics.figure_assets_ok,
    figure_recall: metrics.figure_queries === 0 ? 0 : Math.round((metrics.figure_matched / metrics.figure_queries) * 1000) / 1000,
    figure_anchor_detected: metrics.figure_anchor_detected,
    figure_fail_no_anchor: metrics.figure_fail_no_anchor,
    figure_fail_lexical_mismatch: metrics.figure_fail_lexical_mismatch,
    semantic_fuzzy_failures: (metrics.by_kind.semantic_recall?.total - metrics.by_kind.semantic_recall?.top5) + (metrics.by_kind.fuzzy_recall?.total - metrics.by_kind.fuzzy_recall?.top5),
    semantic_fuzzy_passes: (metrics.by_kind.semantic_recall?.top5 ?? 0) + (metrics.by_kind.fuzzy_recall?.top5 ?? 0),
    figure_query_passes: metrics.figure_matched,
    understanding_not_run: metrics.understanding_not_run,
    visual_image_delivery: fixtures.visualList.length,
    read_marks: ctx.state.readMarks ?? [],
    pre_existing_read_ids: ctx.state.preExistingReadIds ?? [],
    failures: metrics.failures,
    rows,
    duration_ms: Date.now() - runStarted,
  }
  ctx.state.searchSummary = searchSummary
  writeJsonFile(artifactPath('search-summary.json'), searchSummary)
  return { summary: recorder.summary(), searchSummary, durationMs: searchSummary.duration_ms }
}

/** CLI entry for `node test/search.mjs`. */
export async function main() {
  return runSuiteCli({ suite: 'search', planned: PLANNED, run })
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`search: ${String(error?.stack ?? error)}`)
      process.exitCode = 1
    })
}
