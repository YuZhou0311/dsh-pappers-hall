/**
 * Plugin toggle (enable/disable) acceptance harness — contract §7.5.
 *
 * The verifier cannot change the DSH profile: the `plugin_manager` tool is only
 * callable from an Agent session and profile edits are Lead-owned. This script
 * therefore splits the evidence collection into phases the Lead runs around the
 * real toggle:
 *
 *   node test/toggle.mjs --phase after-enable    --note "baseline"
 *   # Lead: plugin_manager set_plugin target=pappers-hall enabled:false
 *   node test/toggle.mjs --phase after-disable
 *   # Lead: re-enable (optionally restart the app first to prove persistence)
 *   node test/toggle.mjs --phase after-enable --note "re-enabled"
 *
 * Every phase independently probes the HTTP surface:
 * - `GET  /pappers-hall/`      — plugin prefix handler marker (mounted or not),
 * - `POST /pappers-hall/api`   — JSON envelope vs SPA fallback (405/404),
 * - `GET  /plugins/...client.js` — native DSH static asset (GUI stays healthy),
 * - `GET  /`                   — native Host route still enforces the cookie.
 *
 * Optional evidence from the Lead (`--evidence <json>` / `--host-tools-json`):
 * ```
 * { "phase": "after-disable", "actor": "lead", "at": "...",
 *   "actions": [{"tool":"plugin_manager","args":{...},"result":"applied"}],
 *   "restarted": true,
 *   "hostTools": ["papers_search", "..."] }
 * ```
 * Tool registration can only be observed from the Agent side, so it is
 * `not_run` unless that evidence is supplied. Browser UI screenshots are always
 * recorded as manual evidence, never as an automated pass.
 *
 * The accumulated state lives in `test/.artifacts/toggle-state.json`; the
 * `run-tests` entry point reads it (`run()` below) and folds the phase results
 * into `reports/test-results.json`.
 *
 * @module pappers-hall/test/toggle
 */
import { existsSync } from 'node:fs'
import {
  CONTRACT_VERSION,
  DEFAULT_API_BASE,
  DEFAULT_PROFILE,
  DEFAULT_TIMEOUT_MS,
  HERE,
  HARNESS_VERSION,
  artifactPath,
  check,
  clip,
  deepEqual,
  isMain,
  parseArgs,
  readJsonIfExists,
  runSuiteCli,
  writeJsonFile,
  PappersClient,
  Recorder,
  collectEnvironment,
  flagBool,
  flagInt,
  flagString,
} from './lib.mjs'

/** Planned phases asserted by the dry run. */
export const PLANNED = Object.freeze({
  phases: ['after-enable', 'after-disable'],
  totalCases: 8,
})

/** The 8 Agent tools from contract §3. */
export const EXPECTED_TOOLS = Object.freeze([
  'papers_search',
  'papers_get_passage',
  'papers_get_figure',
  'papers_translate',
  'papers_propose_changes',
  'papers_apply_changes',
  'papers_cite',
  'papers_index_status',
])

/** Toggle phase state file. */
const STATE_FILE = 'toggle-state.json'

/**
 * Load the accumulated toggle state.
 * @returns {{updated_at:string|null, phases:object[], snapshots:object}} state.
 */
function loadState() {
  const existing = readJsonIfExists(artifactPath(STATE_FILE))
  if (existing !== null && existing !== undefined && typeof existing === 'object') {
    return {
      updated_at: existing.updated_at ?? null,
      phases: Array.isArray(existing.phases) ? existing.phases : [],
      snapshots: typeof existing.snapshots === 'object' && existing.snapshots !== null ? existing.snapshots : {},
    }
  }
  return { updated_at: null, phases: [], snapshots: {} }
}

/**
 * Persist the accumulated toggle state.
 * @param {object} state state payload.
 * @returns {string} written path.
 */
function saveState(state) {
  return writeJsonFile(artifactPath(STATE_FILE), { ...state, updated_at: new Date().toISOString() })
}

/**
 * Extract host tool names from Lead-supplied evidence in a few accepted shapes.
 * @param {unknown} evidence parsed evidence.
 * @returns {string[]} tool names (may be empty).
 */
function extractToolNames(evidence) {
  if (evidence === null || evidence === undefined) return []
  const found = new Set()
  const visit = (value, depth) => {
    if (depth > 4 || value === null || value === undefined) return
    if (Array.isArray(value)) {
      if (value.every((entry) => typeof entry === 'string')) {
        for (const entry of value) if (entry.startsWith('papers_')) found.add(entry)
        return
      }
      for (const entry of value) visit(entry, depth + 1)
      return
    }
    if (typeof value === 'object') {
      // Tool inventories may be arrays of objects with a `name` field
      // (cordis_inspect_query Tool.listTools output) or plain strings.
      if (typeof value.name === 'string' && value.name.startsWith('papers_')) found.add(value.name)
      for (const key of ['tools', 'toolNames', 'tool_names', 'hostTools', 'host_tools', 'after', 'before']) {
        if (Object.hasOwn(value, key)) visit(value[key], depth + 1)
      }
    }
  }
  visit(evidence, 0)
  // Also accept a flat phase-scoped `hostTools:{before:[],after:[]}` payload.
  if (evidence?.hostTools !== null && typeof evidence?.hostTools === 'object' && !Array.isArray(evidence.hostTools)) {
    for (const key of ['before', 'after']) visit(evidence.hostTools[key], 1)
  }
  return [...found].sort()
}

/**
 * Verify the Lead's toggle action log has the shape the report cites.
 * @param {unknown} evidence parsed evidence.
 * @returns {{valid:boolean, actions:object[]}} action log.
 */
function validateActionLog(evidence) {
  const actions = Array.isArray(evidence?.actions) ? evidence.actions : []
  const valid = actions.every((action) => action !== null && typeof action === 'object' && typeof action.tool === 'string' && action.tool !== '')
  return { valid: valid && actions.length > 0, actions }
}

/**
 * One probe phase: observe the toggle surface and record cases.
 * @param {object} options options.
 * @param {string} options.phase `after-enable` or `after-disable`.
 * @param {string} options.apiBase Web GUI base URL.
 * @param {string} options.profile profile name.
 * @param {object|null} options.evidence Lead evidence payload.
 * @param {string[]} options.evidencePaths evidence file paths for the record.
 * @param {string} options.note phase note.
 * @param {boolean} [options.baseline] treat this enabled observation as the reference snapshot.
 * @param {boolean} [options.reset] clear previously accumulated phases/snapshots first.
 * @returns {Promise<object>} phase result.
 */
export async function runPhase(options) {
  const phase = options.phase
  const client = new PappersClient({ baseUrl: options.apiBase ?? DEFAULT_API_BASE, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  const recorder = new Recorder({ runId: `toggle-${phase}-${Date.now()}` })
  const environment = await collectEnvironment(client, { profile: options.profile ?? DEFAULT_PROFILE })
  let state = loadState()
  if (options.reset === true) state = { updated_at: null, phases: [], snapshots: {} }
  const evidence = options.evidence ?? null
  const toolNames = extractToolNames(evidence)
  const actionLog = validateActionLog(evidence)
  const surface = await client.pluginSurface()
  const rootProbe = await client.probeStatic('/', { timeoutMs: 10_000 })
  const enabled = surface.route.plugin_marker === true && surface.api_post.json_envelope === true && surface.api_post.httpStatus === 200

  /* Common evidence case. */
  const surfaceCase = recorder.begin({
    suite: 'toggle',
    caseId: `TOGGLE.${phase}.surface`,
    title: `${phase}: observed HTTP surface`,
    expected: 'plugin route + JSON API state matches the phase',
    input: { phase, api_base: client.baseUrl, evidence_files: options.evidencePaths ?? [] },
  })
  recorder.end(surfaceCase, {
    assertions: [],
    actual: surface,
    evidence: { environment: { dsh_version: environment.dsh_version, plugin: environment.plugin, storage: environment.storage }, root_probe: rootProbe, evidence: clip(evidence, 1200), action_log: clip(actionLog.actions, 800) },
    status: 'pass',
    notes: 'Observations only; the phase-specific assertions below decide pass/fail.',
  })

  if (phase === 'after-enable') {
    const enableCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-enable.mounted',
      title: 'Enabled: plugin route mounted and JSON API answers',
      expected: 'GET /pappers-hall/ plugin marker 200; POST /pappers-hall/api status => ok:true, plugin.enabled true',
    })
    recorder.end(enableCase, {
      assertions: [
        check('plugin route marker registered', surface.route.plugin_marker === true, true, surface.route),
        check('JSON API answers the envelope', surface.api_post.json_envelope === true, true, surface.api_post),
        check('API status ok', surface.api_post.httpStatus === 200, 200, surface.api_post.httpStatus),
      ],
      actual: surface,
    })

    const statusProbe = await client.status()
    const statusCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-enable.status',
      title: 'Enabled: status reports dsh-pappers-hall enabled',
      expected: 'plugin.id=dsh-pappers-hall, enabled=true; library counts readable',
    })
    recorder.end(statusCase, {
      assertions: [
        check('status reachable', statusProbe.ok === true, true, statusProbe.ok ? 'ok' : statusProbe.error?.code),
        check('plugin id', statusProbe.data?.plugin?.id === 'dsh-pappers-hall', 'dsh-pappers-hall', statusProbe.data?.plugin?.id ?? null),
        check('plugin enabled', statusProbe.data?.plugin?.enabled === true, true, statusProbe.data?.plugin?.enabled ?? null),
        check('counts readable', typeof statusProbe.data?.counts === 'object' && statusProbe.data?.counts !== null, 'counts object', statusProbe.data?.counts ?? null),
      ],
      actual: { plugin: statusProbe.data?.plugin ?? null, counts: statusProbe.data?.counts ?? null, storage: statusProbe.data?.storage ?? null },
    })

    const toolsCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-enable.tools',
      title: 'Enabled: the 8 papers_* Agent tools are registered exactly once',
      expected: EXPECTED_TOOLS.join(', '),
    })
    if (toolNames.length === 0) {
      recorder.end(toolsCase, {
        status: 'not_run',
        reason: 'host tool registration is only visible from the Agent side; rerun with --host-tools-json <lead evidence> or record the tool list from a session',
        actual: { expected: EXPECTED_TOOLS, evidence_files: options.evidencePaths ?? [] },
      })
    } else {
      const missing = EXPECTED_TOOLS.filter((name) => !toolNames.includes(name))
      const duplicates = toolNames.filter((name, index) => toolNames.indexOf(name) !== index)
      recorder.end(toolsCase, {
        assertions: [
          check('all 8 papers_* tools present', missing.length === 0, EXPECTED_TOOLS, missing),
          check('no duplicate tool registration', duplicates.length === 0, 0, duplicates),
        ],
        actual: { observed_tools: toolNames },
      })
    }

    const libraryProbe = await client.tryCall('library.list', { state: 'all', limit: 200 })
    const items = libraryProbe.ok ? libraryProbe.data?.items ?? [] : []
    const ids = items.map((item) => item.id)
    const uniqueIds = new Set(ids)
    // A baseline observation establishes the reference snapshot for later
    // toggle/restart comparisons; it must not be compared with older data from
    // a different library state (e.g. before the 30-PDF import).
    const previous = options.baseline === true ? null : state.snapshots.last_enabled ?? null
    const persistenceCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-enable.persistence',
      title: 'Enabled: data survives the toggle and registration is not duplicated',
      expected: 'library ids unique; when a previous enabled snapshot exists, counts and id set are unchanged',
    })
    const comparison = previous === null
      ? null
      : {
          counts_equal: deepEqual(previous.counts ?? null, libraryProbe.ok ? { papers: libraryProbe.data?.total ?? ids.length } : null) ? true : Number(previous.counts?.papers) === Number(libraryProbe.data?.total),
          id_set_equal: Array.isArray(previous.ids) && deepEqual([...uniqueIds].sort(), [...previous.ids].sort()),
        }
    recorder.end(persistenceCase, {
      assertions: [
        check('library.list reachable', libraryProbe.ok === true, true, libraryProbe.ok ? 'ok' : libraryProbe.error?.code),
        check('no duplicate library rows', uniqueIds.size === ids.length, ids.length, uniqueIds.size),
        ...(previous === null
          ? []
          : [
              check('paper count preserved across toggle/restart', comparison.counts_equal, previous.counts, libraryProbe.ok ? { papers: libraryProbe.data?.total } : null),
              check('library id set preserved across toggle/restart', comparison.id_set_equal === true, 'same ids', comparison.id_set_equal),
            ]),
      ],
      actual: { total: libraryProbe.ok ? libraryProbe.data?.total : null, previous_snapshot: previous?.captured_at ?? null, comparison },
      notes: previous === null ? 'First enabled observation: this becomes the reference snapshot for the next toggle.' : undefined,
    })

    const guiCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-enable.gui',
      title: 'Enabled: Web GUI shell is served and plugin-side checks do not replace a human visual check',
      expected: 'native static asset 200; sidebar/panel screenshot is a manual check',
    })
    recorder.end(guiCase, {
      assertions: [
        check('native GUI static asset serves 200', surface.gui_static.httpStatus === 200, 200, surface.gui_static.httpStatus),
      ],
      actual: { gui_static: surface.gui_static },
      evidence: { browser_screenshot: evidence?.browserScreenshot ?? null },
      notes: 'Sidebar entry "论文中心", empty state and reader visuals are human-reviewed; screenshots are evidence, not an automated pass.',
    })

    // New enabled snapshot (library ids + counts) for the next phase comparison.
    state.snapshots.last_enabled = {
      captured_at: new Date().toISOString(),
      counts: { papers: libraryProbe.ok ? libraryProbe.data?.total ?? ids.length : null },
      ids: [...uniqueIds].sort(),
      plugin_version: statusProbe.data?.plugin?.version ?? null,
      dsh_version: statusProbe.data?.plugin?.hostVersion ?? null,
    }
  } else if (phase === 'after-disable') {
    const disabledCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-disable.unmounted',
      title: 'Disabled: plugin route and JSON API are gone',
      expected: 'GET /pappers-hall/ is not the plugin marker; POST /pappers-hall/api is not a plugin JSON envelope (404 contract; the SPA fallback may answer 405)',
    })
    recorder.end(disabledCase, {
      assertions: [
        check('plugin route marker absent', surface.route.plugin_marker === false, false, surface.route),
        check('JSON API envelope absent', surface.api_post.json_envelope === false, false, surface.api_post),
        check('API POST does not answer 200 plugin JSON', !(surface.api_post.httpStatus === 200 && surface.api_post.json_envelope === true), 'not a plugin 200 envelope', surface),
      ],
      actual: surface,
      notes: 'CONTRACT §2 says an unloaded plugin returns 404 on /pappers-hall/*. The SPA fallback may instead answer 404 for GET and 405 for POST; both count as "plugin surface gone" as long as no plugin JSON envelope is answered.',
    })

    const residueCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-disable.residue',
      title: 'Disabled: no plugin asset routes or job timers remain',
      expected: 'page/figure/thumb/pdf routes answer non-200; no plugin JSON error envelope',
    })
    try {
      const probes = {
        page: await client.probeStatic('/pappers-hall/page/ph-000000000000/1.png?width=200'),
        figure: await client.probeStatic('/pappers-hall/figure/fg-000000000000.png'),
        thumb: await client.probeStatic('/pappers-hall/thumb/ph-000000000000.png'),
        pdf: await client.probeStatic('/pappers-hall/pdf/ph-000000000000'),
      }
      const residual = Object.entries(probes).filter(([, probe]) => probe.httpStatus === 200)
      recorder.end(residueCase, {
        assertions: [
          check('no plugin asset route answers 200', residual.length === 0, 0, residual.map(([kind]) => kind)),
        ],
        actual: probes,
      })
    } catch (error) {
      recorder.crash(residueCase, error)
    }

    const toolsCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-disable.tools',
      title: 'Disabled: no papers_* Agent tools remain',
      expected: 'host tool list has no papers_* entries',
    })
    const registryEvidence = evidence?.observed?.toolRegistryContainsPapersTools
    if (toolNames.length === 0 && registryEvidence !== false) {
      recorder.end(toolsCase, {
        status: 'not_run',
        reason: 'host tool registration is only visible from the Agent side; supply --host-tools-json evidence or a Tool.listTools observation in the evidence file',
        actual: { expected_absent: EXPECTED_TOOLS },
      })
    } else if (toolNames.length === 0 && registryEvidence === false) {
      recorder.end(toolsCase, {
        assertions: [check('no papers_* tools registered (lead Tool.listTools evidence)', registryEvidence === false, false, registryEvidence)],
        actual: { evidence_source: 'evidence.observed.toolRegistryContainsPapersTools', evidence_file: options.evidencePaths ?? [], tool_registry_note: clip(evidence?.observed?.toolRegistryNote, 300) },
        notes: 'The tool registry cannot be listed over HTTP; this assertion uses the Lead-captured cordis_inspect_query Tool.listTools observation in the evidence file.',
      })
    } else {
      const remaining = toolNames.filter((name) => EXPECTED_TOOLS.includes(name))
      recorder.end(toolsCase, {
        assertions: [check('no papers_* tools registered', remaining.length === 0, 0, remaining)],
        actual: { observed_tools: toolNames },
      })
    }

    const guiCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-disable.native_gui',
      title: 'Disabled: native DSH GUI stays healthy and does not error',
      expected: 'native static asset 200; index route still enforces auth as before',
    })
    recorder.end(guiCase, {
      assertions: [
        check('GUI static asset serves 200 while plugin is off', surface.gui_static.httpStatus === 200, 200, surface.gui_static.httpStatus),
      ],
      actual: { gui_static: surface.gui_static, index_without_cookie: rootProbe.httpStatus },
      notes: 'The untokened / probe is expected to be 401 (native cookie auth). It must not be 5xx.',
    })

    const restartCase = recorder.begin({
      suite: 'toggle',
      caseId: 'TOGGLE.after-disable.restart_persistence',
      title: 'Disabled: disablement persists across a DSH restart',
      expected: 'evidence.restarted === true and the plugin surface is still absent afterwards',
    })
    const persistenceEvidence = evidence?.persistenceEvidence ?? null
    if (evidence === null || evidence?.restarted !== true) {
      recorder.end(restartCase, {
        status: 'not_run',
        reason: 'a real DSH process restart was not performed (it would terminate the live validation session); restart persistence is NOT verified. A persisted disable row / profile patch is recorded as supporting evidence only.',
        actual: {
          restarted: evidence?.restarted ?? null,
          persistence_evidence: clip(persistenceEvidence, 800),
          profile_patch_disabled: evidence?.observed?.profilePatchDisabled ?? null,
          boot_graph_contains_plugin: evidence?.observed?.bootGraphContainsPlugin ?? null,
          evidence_files: options.evidencePaths ?? [],
        },
        notes: 'Do not read this as a passed restart check: an actual process restart remains a manual/not_run item. The profile patch (disabled:true) is re-read by the Loader on startup, which is why the contract expects persistence, but only a real restart can verify it.',
      })
    } else {
      recorder.end(restartCase, {
        assertions: [
          check('restart recorded in evidence', evidence.restarted === true, true, evidence.restarted),
          check('plugin still absent after restart', surface.route.plugin_marker === false && surface.api_post.json_envelope === false, 'absent', surface),
          check('action log present', actionLog.valid === true, 'actions[] with tool + args', actionLog.actions.length),
        ],
        actual: { restarted: evidence.restarted, actions: clip(actionLog.actions, 800), evidence_files: options.evidencePaths ?? [] },
      })
    }
  } else {
    throw new Error(`unknown toggle phase "${phase}" (expected after-enable or after-disable)`)
  }

  const summary = recorder.summary()
  const phaseRecord = {
    phase,
    note: options.note ?? '',
    at: new Date().toISOString(),
    environment: {
      dsh_version: environment.dsh_version,
      plugin: environment.plugin,
      storage: environment.storage,
      api_base: client.baseUrl,
      node: process.version,
    },
    evidence: evidence === null ? null : { payload: clip(evidence, 4000), files: options.evidencePaths ?? [], tool_names: toolNames, actions: clip(actionLog.actions, 1200), restarted: evidence?.restarted === true },
    surface,
    root_probe: rootProbe,
    summary,
    cases: recorder.cases,
  }
  state.phases.push(phaseRecord)
  // Keep the file bounded across many manual iterations.
  if (state.phases.length > 20) state.phases = state.phases.slice(-20)
  saveState(state)
  ctxRef.last = phaseRecord
  return phaseRecord
}

/** Last phase record, for `main()` printing. */
const ctxRef = { last: null }

/**
 * Fold the accumulated toggle phases into one suite summary (used by run-tests).
 *
 * This does not probe anything and does not toggle: it reports whether the
 * collected phase evidence exists and passed, and keeps manual checks not_run.
 * @param {object} ctx shared suite context.
 * @returns {Promise<object>} suite result.
 */
export async function run(ctx) {
  const { recorder } = ctx
  const state = loadState()
  const phases = state.phases
  const found = new Set(phases.map((phase) => phase.phase))
  const caseSpec = (caseId, title, expected) => ({ suite: 'toggle', caseId, kind: 'toggle', title, expected })

  if (phases.length === 0) {
    const handle = recorder.begin(caseSpec('TOGGLE.summary', 'Plugin toggle evidence', 'after-enable + after-disable phases recorded by the Lead around plugin_manager operations'))
    recorder.end(handle, {
      status: 'not_run',
      reason: 'no toggle phases recorded: run `node test/toggle.mjs --phase after-enable`, toggle the plugin via plugin_manager, then `--phase after-disable` (and a final after-enable)',
      evidence: { state_file: artifactPath(STATE_FILE) },
    })
    return { summary: recorder.summary(), toggleResult: { phases: [], state_file: artifactPath(STATE_FILE) } }
  }

  for (const phase of phases) {
    const handle = recorder.begin(caseSpec(
      `TOGGLE.RESULT.${phase.phase}`,
      `${phase.phase} recorded ${phase.at}`,
      'phase ran with no failed assertion',
    ))
    recorder.end(handle, {
      assertions: [
        check('phase has cases', Array.isArray(phase.cases) && phase.cases.length > 0, '> 0 cases', phase.cases?.length ?? 0),
        check('phase recorded no failure', Number(phase.summary?.fail ?? 0) === 0, 0, phase.summary?.fail ?? 0),
      ],
      actual: { summary: phase.summary, note: phase.note, environment: phase.environment, evidence: phase.evidence === null ? null : { files: phase.evidence?.files, tool_names: phase.evidence?.tool_names, restarted: phase.evidence?.restarted } },
    })
  }

  const handle = recorder.begin(caseSpec('TOGGLE.summary', 'Complete toggle evidence (enable → disable → enable)', 'both phases present; final state enabled'))
  const lastPhase = phases.at(-1)?.phase ?? null
  const enabledAgain = phases.filter((phase) => phase.phase === 'after-enable').length >= 2
  const assertion = [
    check('after-enable phase recorded', found.has('after-enable'), true, found.has('after-enable')),
    check('after-disable phase recorded', found.has('after-disable'), true, found.has('after-disable')),
    check('final recorded state is enabled', lastPhase === 'after-enable', 'after-enable', lastPhase),
  ]
  if (!enabledAgain) {
    recorder.end(handle, {
      assertions: assertion,
      status: 'not_run',
      reason: 'toggle round-trip incomplete: re-enable the plugin and record a final `--phase after-enable` (with the DSH restart evidence for §7.5 persistence)',
      actual: { phases: phases.map((phase) => phase.phase), last_phase: lastPhase },
    })
  } else {
    recorder.end(handle, {
      assertions: [...assertion, check('round-trip completed (2 enabled observations)', enabledAgain, '>= 2 after-enable phases', phases.filter((phase) => phase.phase === 'after-enable').length)],
      actual: { phases: phases.map((phase) => phase.phase), last_phase: lastPhase, state_file: artifactPath(STATE_FILE) },
    })
  }

  // Manual, non-automated UI checks stay not_run and are listed in verify.md.
  recorder.skip(
    caseSpec('TOGGLE.manual.sidebar', 'Manual: sidebar entry / paper center panel appears after enable and disappears after disable', 'human screenshot check of the Web GUI sidebar + main panel'),
    'browser UI is a human check; attach screenshots to the report (state file records no automated claim)',
    { state_file: artifactPath(STATE_FILE) },
  )
  recorder.skip(
    caseSpec('TOGGLE.manual.tools_in_session', 'Manual: papers_* tools visible in an Agent session and gone after disable', 'tool list observed in a normal conversation before/after the toggle'),
    'tool registration is only observable from an Agent session; the phase evidence may carry the observed list via --host-tools-json',
  )

  const toggleResult = {
    generated_at: new Date().toISOString(),
    state_file: artifactPath(STATE_FILE),
    phases: phases.map((phase) => ({ phase: phase.phase, note: phase.note, at: phase.at, summary: phase.summary, evidence: phase.evidence === null ? null : { files: phase.evidence.files, tool_names: phase.evidence.tool_names, restarted: phase.evidence.restarted } })),
    snapshots: state.snapshots,
  }
  return { summary: recorder.summary(), toggleResult }
}

/**
 * CLI entry: run one phase (or `--dry-run` to validate the fixtures instead).
 * @returns {Promise<number>} exit code.
 */
export async function main() {
  const { flags } = parseArgs()
  if (flagBool(flags, 'dry-run')) {
    return runSuiteCli({ suite: 'toggle', planned: PLANNED, run: async () => ({ summary: { total: 0, pass: 0, fail: 0, not_run: 0 } }) })
  }
  const phase = flagString(flags, 'phase', '')
  if (phase === '') {
    console.error('usage: node test/toggle.mjs --phase after-enable|after-disable [--note "..."] [--baseline] [--reset] [--evidence evidence.json] [--host-tools-json tools.json] [--api-base URL]')
    return 2
  }
  const evidencePaths = []
  const evidence = {}
  for (const [flagName, evidenceKey] of [
    ['evidence', null],
    ['host-tools-json', 'hostTools'],
  ]) {
    const filePath = flagString(flags, flagName, '')
    if (filePath === '') continue
    if (!existsSync(filePath)) {
      console.error(`toggle: evidence file not found: ${filePath}`)
      return 2
    }
    evidencePaths.push(filePath)
    const payload = readJsonIfExists(filePath)
    if (evidenceKey === null) Object.assign(evidence, payload ?? {})
    else evidence[evidenceKey] = Array.isArray(payload) ? payload : payload?.tools ?? payload
  }
  const phaseRecord = await runPhase({
    phase,
    apiBase: flagString(flags, 'api-base', DEFAULT_API_BASE),
    profile: flagString(flags, 'profile', DEFAULT_PROFILE),
    timeoutMs: flagInt(flags, 'timeout-ms', DEFAULT_TIMEOUT_MS),
    note: flagString(flags, 'note', ''),
    baseline: flagBool(flags, 'baseline'),
    reset: flagBool(flags, 'reset'),
    evidence: Object.keys(evidence).length === 0 ? null : evidence,
    evidencePaths,
  })
  for (const testCase of phaseRecord.cases) console.log(`[${testCase.status.toUpperCase().padEnd(7)}] ${testCase.case_id} — ${testCase.title}`)
  const summary = phaseRecord.summary
  console.log('')
  console.log(`toggle ${phase}: ${summary.pass} pass, ${summary.fail} fail, ${summary.not_run} not_run`)
  console.log(`state: ${artifactPath(STATE_FILE)}`)
  if (phase === 'after-disable') {
    console.log('next: re-enable with plugin_manager, then run `node test/toggle.mjs --phase after-enable --note "re-enabled"` (add --evidence after a restart)')
  }
  return summary.fail > 0 ? 1 : 0
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`toggle: ${String(error?.stack ?? error)}`)
      process.exitCode = 1
    })
}
