/**
 * Annotation acceptance suite — seed annotations + the 10 annotation queries +
 * the delete-after-test rule (contract §2.1 `annotations.*`, §6, test_plan §4).
 *
 * Rule set from `tests/test_plan.md`:
 * - the 10 synthetic seed notes are imported with `origin:'test_note'`,
 *   page-only (`rect:null`), bound to the exact PDF SHA-256 of the manifest,
 * - each must be found by its audited Chinese query and returned as an
 *   annotation hit marked `test_note`, never as an author sentence,
 * - a deleted annotation must disappear from `annotations.list` and from every
 *   search channel; the paper itself may still match if its body is relevant,
 * - the harness keeps a fixture-id → production-id map in
 *   `test/.artifacts/annotations-map.json`; a re-run verifies existing rows
 *   instead of creating duplicates, recreating only rows deleted by the
 *   previous delete-test.
 *
 * @module pappers-hall/test/annotations
 */
import {
  ARTIFACTS_DIR,
  CONTRACT_VERSION,
  HARNESS_VERSION,
  artifactPath,
  check,
  clip,
  ensureDir,
  isMain,
  prepareLibrary,
  readJsonIfExists,
  runSuiteCli,
  writeJsonFile,
} from './lib.mjs'

/** Planned live case counts asserted by the dry run. */
export const PLANNED = Object.freeze({
  seedAnnotations: 10,
  annotationQueries: 10,
  totalCases: 26,
})

/** Fixture annotation used for the delete-then-recreate probe. */
const DELETE_PROBE_FIXTURE = 'DEV-NOTE-A01'

/** Map file name inside `test/.artifacts/`. */
const MAP_FILE = 'annotations-map.json'

/**
 * Load the persisted fixture → production annotation map.
 * @returns {{entries:Record<string,object>, generated_at?:string, data_dir?:string}} map.
 */
function loadMap() {
  const existing = readJsonIfExists(artifactPath(MAP_FILE))
  if (existing !== null && existing !== undefined && typeof existing === 'object' && typeof existing.entries === 'object') {
    return { entries: existing.entries ?? {}, generated_at: existing.generated_at, data_dir: existing.data_dir }
  }
  return { entries: {} }
}

/**
 * Persist the annotation map after each run.
 * @param {{entries:Record<string,object>}} map map payload.
 * @param {object} environment environment facts.
 * @returns {string} written path.
 */
function saveMap(map, environment) {
  return writeJsonFile(artifactPath(MAP_FILE), {
    generated_at: new Date().toISOString(),
    data_dir: environment?.storage?.dataDir ?? '',
    db_path: environment?.storage?.dbPath ?? '',
    environment: {
      dsh_version: environment?.dsh_version ?? 'unknown',
      plugin_version: environment?.plugin?.version ?? 'unknown',
      node: process.version,
    },
    entries: map.entries,
  })
}

/**
 * Find one annotation by id in `annotations.list` for its paper.
 * @param {object} client API client.
 * @param {string} paperId production paper id.
 * @param {string} annotationId production annotation id.
 * @returns {Promise<object|null>} annotation or null.
 */
async function findAnnotation(client, paperId, annotationId) {
  try {
    const list = await client.call('annotations.list', { paperId })
    const items = Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : []
    return items.find((annotation) => annotation.id === annotationId) ?? null
  } catch {
    return null
  }
}

/**
 * Search with the annotation scope, falling back to the joint library scope.
 * @param {object} client API client.
 * @param {string} queryText query text.
 * @returns {Promise<{items:object[], scope:string, fallback:string|null}>} hits.
 */
async function searchAnnotations(client, queryText) {
  try {
    const result = await client.call('search.query', { q: queryText, scope: 'annotations', limit: 10 })
    return { items: Array.isArray(result?.items) ? result.items : [], scope: 'annotations', fallback: null }
  } catch (error) {
    const result = await client.call('search.query', { q: queryText, scope: 'library', limit: 10 })
    return {
      items: (Array.isArray(result?.items) ? result.items : []).filter((item) => item?.kind === 'annotation'),
      scope: 'library(filtered annotation)',
      fallback: `${error?.code ?? 'error'}: ${String(error?.message ?? error)}`,
    }
  }
}

/**
 * Run the annotation suite.
 * @param {object} ctx shared suite context.
 * @returns {Promise<object>} suite result.
 */
export async function run(ctx) {
  const { client, fixtures, recorder, options } = ctx
  const suite = 'annotations'
  const runStarted = Date.now()
  ensureDir(ARTIFACTS_DIR)
  const library = await prepareLibrary(ctx)
  const map = loadMap()

  /* ---------------------------------------------------------------- */
  /* Preconditions                                                    */
  /* ---------------------------------------------------------------- */
  const preconditionCase = recorder.begin({
    suite,
    caseId: 'ANN.00.preconditions',
    title: 'Test library and seed fixtures are ready',
    expected: '10 seed papers imported; every seed annotation binds the manifest sha256',
  })
  const seedPaperFixtures = fixtures.seedList.map((seed) => seed.paper_id)
  const missingSeedPapers = seedPaperFixtures.filter((paperId) => !library.paperMap.has(paperId))
  recorder.end(preconditionCase, {
    assertions: [
      check('all 10 seed papers imported', missingSeedPapers.length === 0, [], missingSeedPapers),
      check('seed annotations are marked synthetic test data', fixtures.seedList.every((seed) => seed.synthetic === true && seed.not_user_history === true), 'synthetic test data', fixtures.seedList.filter((seed) => seed.synthetic !== true).map((seed) => seed.id)),
    ],
    actual: { seed_papers: seedPaperFixtures.length, missing: missingSeedPapers, existing_map_entries: Object.keys(map.entries).length },
  })

  /* ---------------------------------------------------------------- */
  /* Import / verify the 10 seed annotations                          */
  /* ---------------------------------------------------------------- */
  const seedRows = []
  for (const seed of fixtures.seedList) {
    const productionPaperId = library.paperMap.get(seed.paper_id)
    const handle = recorder.begin({
      suite,
      caseId: `ANN.SEED.${seed.id}`,
      kind: 'annotation',
      title: `${seed.id} page note imported as origin=test_note`,
      input: { fixture_id: seed.id, paper_id: seed.paper_id, page: seed.source_anchor?.pdf_page, origin: 'test_note' },
      expected: { page: seed.source_anchor?.pdf_page, origin: 'test_note', rect: null, document_sha256: seed.source_anchor?.document_sha256 },
    })
    if (productionPaperId === undefined) {
      recorder.end(handle, { status: 'fail', actual: { missing_paper: seed.paper_id } })
      seedRows.push({ fixture_id: seed.id, ok: false })
      continue
    }
    try {
      const detail = await client.call('library.get', { id: productionPaperId })
      const versions = Array.isArray(detail?.versions) ? detail.versions : []
      const versionId = versions[0]?.id ?? null
      const versionSha = String(versions[0]?.sha256 ?? detail?.sha256 ?? '').toLowerCase()
      const expectedSha = String(seed.source_anchor?.document_sha256 ?? '').toLowerCase()
      const readBefore = detail?.read === true

      const existingEntry = map.entries[seed.id]
      let annotation = existingEntry?.annotation_id === undefined ? null : await findAnnotation(client, productionPaperId, existingEntry.annotation_id)
      let action = 'verified-existing'
      if (annotation === null) {
        const created = await client.call('annotations.create', {
          paperId: productionPaperId,
          versionId,
          page: Number(seed.source_anchor?.pdf_page ?? 1),
          quote: null,
          text: seed.body,
          rect: null,
          color: '#ffd400',
          origin: 'test_note',
          operationId: `ph-acceptance-seed-note-${seed.id}${existingEntry === undefined ? '' : `-recreate-${Date.now()}`}`,
        })
        annotation = created?.annotation ?? null
        action = existingEntry === undefined ? 'created' : 'recreated'
        if (annotation !== null) {
          map.entries[seed.id] = {
            fixture_id: seed.id,
            annotation_id: annotation.id,
            paper_id: productionPaperId,
            version_id: annotation.versionId ?? versionId,
            page: annotation.page ?? Number(seed.source_anchor?.pdf_page ?? 1),
            body: seed.body,
            origin: annotation.origin,
            created_at: annotation.createdAt ?? new Date().toISOString(),
            ...(existingEntry?.recreated_from === undefined ? {} : { recreated_from: existingEntry.recreated_from }),
            ...(action === 'recreated' ? { recreated_from: existingEntry?.annotation_id ?? null, deleted_once: true } : {}),
          }
        }
      }
      const current = annotation === null ? null : await findAnnotation(client, productionPaperId, annotation.id)
      const afterDetail = await client.call('library.get', { id: productionPaperId })
      seedRows.push({
        fixture_id: seed.id,
        action,
        annotation_id: annotation?.id ?? null,
        paper_id: productionPaperId,
        page: current?.page ?? annotation?.page ?? null,
        origin: current?.origin ?? annotation?.origin ?? null,
        rect: current?.rect ?? annotation?.rect ?? null,
        version_id: current?.versionId ?? annotation?.versionId ?? versionId,
        ok: current !== null,
      })
      recorder.end(handle, {
        assertions: [
          check('annotation exists in annotations.list', current !== null, 'active annotation', current?.id ?? null),
          check('origin is test_note', (current?.origin ?? annotation?.origin) === 'test_note', 'test_note', current?.origin ?? annotation?.origin ?? null),
          check('page matches fixture anchor', Number(current?.page ?? annotation?.page) === Number(seed.source_anchor?.pdf_page), seed.source_anchor?.pdf_page, current?.page ?? annotation?.page ?? null),
          check('page-only locator (no fabricated rect)', (current?.rect ?? annotation?.rect ?? null) === null, null, current?.rect ?? annotation?.rect ?? null),
          check('annotation bound to the manifest PDF sha256', versionSha === expectedSha, expectedSha, versionSha),
          check('test note did not mark the paper read', afterDetail?.read === readBefore, readBefore, afterDetail?.read),
        ],
        actual: { action, annotation_id: annotation?.id ?? null, page: current?.page ?? null, origin: current?.origin ?? null, rect: current?.rect ?? null, version_id: current?.versionId ?? null },
      })
    } catch (error) {
      recorder.crash(handle, error, { seed: seed.id, paper_id: productionPaperId })
      seedRows.push({ fixture_id: seed.id, ok: false, error: String(error?.message ?? error) })
    }
  }
  saveMap(map, ctx.environment)
  ctx.state.annotationMap = map.entries

  /* ---------------------------------------------------------------- */
  /* The 10 audited annotation queries                                */
  /* ---------------------------------------------------------------- */
  const queryRows = []
  for (const query of fixtures.annotationQueryList) {
    const fixtureAnnotationId = (query.expected_annotation_ids ?? [])[0]
    const seed = fixtures.seedById.get(fixtureAnnotationId)
    const expectedPaperId = library.paperMap.get(seed?.paper_id ?? (query.expected_paper_ids ?? [])[0])
    const expectedAnnotationId = map.entries[fixtureAnnotationId]?.annotation_id ?? null
    const handle = recorder.begin({
      suite,
      caseId: `ANN.QUERY.${query.id}`,
      kind: 'annotation_recall',
      title: `${query.id} finds its development note`,
      input: { q: query.query_zh, scope: 'annotations' },
      expected: { annotation_id: expectedAnnotationId, paper_id: expectedPaperId, origin: 'test_note' },
    })
    try {
      const result = await searchAnnotations(client, query.query_zh)
      const items = result.items
      const mapped = items.find((item) => item?.id === expectedAnnotationId) ?? null
      const paperLevel = items.find((item) => item?.paperId === expectedPaperId) ?? null
      const annotationOrigin = expectedPaperId === undefined || expectedAnnotationId === null ? null : await findAnnotation(client, expectedPaperId, expectedAnnotationId)
      const hitKindOk = mapped !== null && mapped.kind === 'annotation'
      queryRows.push({
        id: query.id,
        fixture_annotation_id: fixtureAnnotationId,
        expected_annotation_id: expectedAnnotationId,
        hit_found: mapped !== null,
        hit_kind: mapped?.kind ?? null,
        paper_hit: paperLevel !== null,
        scope_used: result.scope,
        scope_fallback: result.fallback,
        items: items.slice(0, 5).map((item) => ({ kind: item.kind, id: item.id, paperId: item.paperId, page: item.page ?? null, snippet: clip(item.snippet, 160) })),
        origin: annotationOrigin?.origin ?? null,
      })
      recorder.end(handle, {
        assertions: [
          check('searched annotation scope (or documented fallback)', result.fallback === null, 'scope=annotations', result.scope),
          check('mapped annotation returned', mapped !== null, expectedAnnotationId, items.map((item) => item?.id ?? null)),
          check('hit kind is annotation, not a paper conclusion', hitKindOk, 'kind=annotation', mapped?.kind ?? null),
          check('hit belongs to the expected paper', paperLevel !== null, expectedPaperId, items.map((item) => item?.paperId ?? null)),
          check('returned annotation keeps origin=test_note', (annotationOrigin?.origin ?? null) === 'test_note', 'test_note', annotationOrigin?.origin ?? null),
          check('test note is not described as paper text', mapped !== null && typeof mapped.snippet === 'string', 'annotation snippet present', mapped?.snippet ?? null),
        ],
        actual: {
          scope_used: result.scope,
          hit: mapped === null ? null : { id: mapped.id, kind: mapped.kind, paperId: mapped.paperId, page: mapped.page ?? null, reasons: mapped.reasons ?? null, snippet: clip(mapped.snippet, 200) },
          item_count: items.length,
        },
        evidence: { delete_test: query.delete_test },
      })
    } catch (error) {
      recorder.crash(handle, error)
      queryRows.push({ id: query.id, error: String(error?.message ?? error) })
    }
  }
  ctx.state.annotationQueryRows = queryRows

  /* ---------------------------------------------------------------- */
  /* Delete test: a deleted note disappears from list + search        */
  /* ---------------------------------------------------------------- */
  const probeQuery = fixtures.annotationQueryList.find((query) => (query.expected_annotation_ids ?? [])[0] === DELETE_PROBE_FIXTURE)
  const probeSeed = fixtures.seedById.get(DELETE_PROBE_FIXTURE)
  const probePaperId = library.paperMap.get(probeSeed?.paper_id)
  const probeEntry = map.entries[DELETE_PROBE_FIXTURE]
  const deleteHandle = recorder.begin({
    suite,
    caseId: 'ANN.DELETE.list',
    title: `${DELETE_PROBE_FIXTURE} deleted note leaves annotations.list`,
    expected: 'annotations.delete ok; the id is gone from the list',
    input: { annotation_id: probeEntry?.annotation_id ?? null },
  })
  let deletedId = probeEntry?.annotation_id ?? null
  if (probeEntry === undefined || probePaperId === undefined || deletedId === null) {
    recorder.end(deleteHandle, { status: 'not_run', reason: 'delete probe fixture was not imported successfully' })
  } else {
    try {
      const deleted = await client.call('annotations.delete', { id: deletedId, operationId: `ph-acceptance-ann-delete-${DELETE_PROBE_FIXTURE}-${Date.now()}` })
      const stillListed = await findAnnotation(client, probePaperId, deletedId)
      recorder.end(deleteHandle, {
        assertions: [
          check('annotations.delete returned ok', deleted?.ok === true || deleted?.state === 'trash', 'ok=true', deleted),
          check('deleted annotation gone from annotations.list', stillListed === null, null, stillListed?.id ?? null),
        ],
        actual: { deleted_id: deletedId, response: clip(deleted, 200) },
      })
    } catch (error) {
      recorder.crash(deleteHandle, error)
    }
  }

  const deleteSearchHandle = recorder.begin({
    suite,
    caseId: 'ANN.DELETE.search',
    title: 'Deleted note is not returned by the annotation query',
    expected: 'no annotation hit with the deleted id; a paper hit is acceptable',
    input: { q: probeQuery?.query_zh ?? '' },
  })
  if (probeQuery === undefined || deletedId === null) {
    recorder.end(deleteSearchHandle, { status: 'not_run', reason: 'delete probe fixture unavailable' })
  } else {
    try {
      const result = await searchAnnotations(client, probeQuery.query_zh)
      const items = result.items
      const deletedHits = items.filter((item) => item?.id === deletedId)
      const paperHits = items.filter((item) => item?.kind === 'paper' && item?.paperId === probePaperId)
      recorder.end(deleteSearchHandle, {
        assertions: [
          check('deleted annotation id absent from annotation search', deletedHits.length === 0, 0, deletedHits.length),
          check('deleted annotation not used as a hit reason', items.every((item) => !Array.isArray(item?.reasons) || item.reasons.every((reason) => !String(reason).includes(deletedId))), 'no reason references the deleted id', items.map((item) => item?.reasons ?? null)),
        ],
        actual: { deleted_hits: deletedHits.length, paper_hits: paperHits.length, items: items.slice(0, 5).map((item) => ({ kind: item.kind, id: item.id, paperId: item.paperId })) },
        notes: 'The paper may still match through its own body text; only the deleted annotation must disappear.',
      })
    } catch (error) {
      recorder.crash(deleteSearchHandle, error)
    }
  }

  /* Recreate the probe note so the demo library keeps the full seed set. */
  const recreateHandle = recorder.begin({
    suite,
    caseId: 'ANN.DELETE.recreate',
    title: `${DELETE_PROBE_FIXTURE} recreated with a new id after the delete test`,
    expected: 'new annotation id with origin test_note, page-only locator',
  })
  if (probeQuery === undefined || probeSeed === undefined || probePaperId === undefined) {
    recorder.end(recreateHandle, { status: 'not_run', reason: 'probe fixture unavailable' })
  } else {
    try {
      const detail = await client.call('library.get', { id: probePaperId })
      const versions = Array.isArray(detail?.versions) ? detail.versions : []
      const created = await client.call('annotations.create', {
        paperId: probePaperId,
        versionId: versions[0]?.id ?? null,
        page: Number(probeSeed.source_anchor?.pdf_page ?? 1),
        quote: null,
        text: probeSeed.body,
        rect: null,
        color: '#ffd400',
        origin: 'test_note',
        operationId: `ph-acceptance-ann-recreate-${DELETE_PROBE_FIXTURE}-${Date.now()}`,
      })
      const annotation = created?.annotation ?? null
      if (annotation !== null) {
        map.entries[DELETE_PROBE_FIXTURE] = {
          fixture_id: DELETE_PROBE_FIXTURE,
          annotation_id: annotation.id,
          paper_id: probePaperId,
          version_id: annotation.versionId ?? versions[0]?.id ?? null,
          page: annotation.page ?? Number(probeSeed.source_anchor?.pdf_page ?? 1),
          body: probeSeed.body,
          origin: annotation.origin,
          created_at: annotation.createdAt ?? new Date().toISOString(),
          recreated_from: deletedId,
          deleted_once: true,
        }
        saveMap(map, ctx.environment)
      }
      recorder.end(recreateHandle, {
        assertions: [
          check('recreated annotation returned', annotation !== null, 'annotation object', annotation?.id ?? null),
          check('new id differs from the deleted one', annotation !== null && annotation.id !== deletedId, `!= ${deletedId}`, annotation?.id ?? null),
          check('recreated origin stays test_note', annotation?.origin === 'test_note', 'test_note', annotation?.origin ?? null),
          check('recreated locator is page-only', (annotation?.rect ?? null) === null, null, annotation?.rect ?? null),
        ],
        actual: { annotation_id: annotation?.id ?? null, deleted_id: deletedId, page: annotation?.page ?? null },
      })
      ctx.state.annotationMap = map.entries
    } catch (error) {
      recorder.crash(recreateHandle, error)
    }
  }

  /* Final count sanity: 10 test notes active, all origin test_note. */
  const countHandle = recorder.begin({
    suite,
    caseId: 'ANN.01.counts',
    title: 'Ten development notes remain in the test library',
    expected: 'each seed paper has its test note; status annotation count includes them',
  })
  try {
    const perPaper = []
    for (const seed of fixtures.seedList) {
      const paperId = library.paperMap.get(seed.paper_id)
      const expectedId = map.entries[seed.id]?.annotation_id
      if (paperId === undefined || expectedId === undefined) {
        perPaper.push({ fixture_id: seed.id, present: false })
        continue
      }
      const found = await findAnnotation(client, paperId, expectedId)
      perPaper.push({ fixture_id: seed.id, paper_id: paperId, annotation_id: expectedId, present: found !== null, origin: found?.origin ?? null })
    }
    const status = await client.call('status')
    recorder.end(countHandle, {
      assertions: [
        check('all 10 test notes present', perPaper.every((row) => row.present === true), '10 present', perPaper.filter((row) => row.present !== true).map((row) => row.fixture_id)),
        check('all test notes keep origin test_note', perPaper.every((row) => row.origin === 'test_note'), 'test_note', perPaper.filter((row) => row.origin !== 'test_note').map((row) => row.fixture_id)),
        check('status counts annotations', Number(status?.counts?.annotations ?? 0) >= fixtures.seedList.length, `>= ${fixtures.seedList.length}`, status?.counts?.annotations),
      ],
      actual: { per_paper: perPaper, status_counts: status?.counts ?? null, map_entries: Object.keys(map.entries).length },
    })
  } catch (error) {
    recorder.crash(countHandle, error)
  }

  /* ---------------------------------------------------------------- */
  /* Persist results                                                  */
  /* ---------------------------------------------------------------- */
  const annotationResult = {
    schema: 'pappers-hall/annotations-result@1',
    generated_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    contract_version: CONTRACT_VERSION,
    library: library.counts,
    seeds: seedRows,
    queries: queryRows,
    delete_test: {
      fixture_id: DELETE_PROBE_FIXTURE,
      deleted_id: deletedId,
      recreated: map.entries[DELETE_PROBE_FIXTURE] ?? null,
    },
    map_entries: Object.keys(map.entries).length,
    duration_ms: Date.now() - runStarted,
  }
  writeJsonFile(artifactPath('annotations-result.json'), annotationResult)
  return { summary: recorder.summary(), annotationResult, durationMs: annotationResult.duration_ms }
}

/** CLI entry for `node test/annotations.mjs`. */
export async function main() {
  return runSuiteCli({ suite: 'annotations', planned: PLANNED, run })
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`annotations: ${String(error?.stack ?? error)}`)
      process.exitCode = 1
    })
}
