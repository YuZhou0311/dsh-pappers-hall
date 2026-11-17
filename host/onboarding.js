/**
 * First-run onboarding as a task list, not a slideshow.
 *
 * Every step is a real action in the product, and its state is derived from the
 * database — not from a client claim:
 *
 *   component  the optional Python component is installed (PyMuPDF/OCR/layout)
 *   sample     the bundled sample paper exists in the library
 *   read       that paper has actually been opened
 *   annotate   at least one highlight was created on it
 *   note       a note links back to it
 *   cite       a reference bundle contains it
 *
 * The guide therefore finishes only when the user has really used the features,
 * and it survives reloads because the evidence lives in the library itself.
 *
 * @module pappers-hall/host/onboarding
 */
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readSetting, writeSetting } from './db.js'
import { nowIso } from './paths.js'

/** Version of the onboarding script; bump to re-show the guide after a redesign. */
export const ONBOARDING_VERSION = 2

/** Settings key holding the onboarding state. */
export const ONBOARDING_KEY = 'onboarding.state'

/** Tasks in display order. */
export const ONBOARDING_TASKS = ['component', 'vector', 'sample', 'read', 'annotate', 'note', 'cite']

/** Title marker of the bundled sample paper, used when the id was lost. */
const SAMPLE_TITLE = 'Pappers-Hall 示例论文'

/** Sample PDF shipped inside the package. */
export const SAMPLE_PDF_PATH = fileURLToPath(new URL('../assets/sample/sample-paper.pdf', import.meta.url))

/** Default state for a fresh install. */
function defaultState() {
  return { version: ONBOARDING_VERSION, samplePaperId: null, dismissedAt: null, completedAt: null, expanded: true, updatedAt: null }
}

/** Normalise a stored/patched state so a hand-edited row cannot break the guide. */
function normalizeState(value) {
  const base = defaultState()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return base
  return {
    version: Number.isFinite(Number(value.version)) ? Number(value.version) : ONBOARDING_VERSION,
    samplePaperId: typeof value.samplePaperId === 'string' && value.samplePaperId !== '' ? value.samplePaperId : null,
    dismissedAt: typeof value.dismissedAt === 'string' && value.dismissedAt !== '' ? value.dismissedAt : null,
    completedAt: typeof value.completedAt === 'string' && value.completedAt !== '' ? value.completedAt : null,
    expanded: value.expanded !== false,
    updatedAt: typeof value.updatedAt === 'string' && value.updatedAt !== '' ? value.updatedAt : null,
  }
}

/**
 * Create the onboarding service.
 * @param {object} options dependencies.
 * @param {import('node:sqlite').DatabaseSync} options.db database.
 * @param {object} [options.python] Python bridge (component facts).
 * @param {object} [options.logger] logger.
 * @returns {object} onboarding service.
 */
export function createOnboarding({ db, python = null, embedding = null, logger } = {}) {
  /** Current stored state. */
  function state() {
    const stored = readSetting(db, ONBOARDING_KEY)
    return normalizeState(stored === undefined ? null : stored)
  }

  /** Persist one state patch. */
  function update(patch = {}) {
    const current = state()
    const next = normalizeState({ ...current, ...patch, version: ONBOARDING_VERSION, updatedAt: nowIso() })
    writeSetting(db, ONBOARDING_KEY, next)
    return next
  }

  /** Sample PDF facts (path + availability), never throws on a missing asset. */
  function sample() {
    let bytes = 0
    let available = false
    try {
      available = existsSync(SAMPLE_PDF_PATH)
      if (available) bytes = statSync(SAMPLE_PDF_PATH).size
    } catch {
      available = false
    }
    return { path: SAMPLE_PDF_PATH, available, bytes, title: SAMPLE_TITLE }
  }

  /** Component installed = the bridge is on disk and reports PyMuPDF. */
  function componentInstalled() {
    try {
      if (python === null || python === undefined) return false
      if (typeof python.installed === 'function' && python.installed() !== true) return false
      return python.capabilities?.pdf === true
    } catch {
      return false
    }
  }

  /** Resolve the sample paper row: stored id first, then the title marker. */
  function samplePaper() {
    const current = state()
    const select = 'SELECT id, title, last_read_at, structure_state FROM papers WHERE state = \'active\''
    if (current.samplePaperId !== null) {
      const row = db.prepare(`${select} AND id = ?`).get(current.samplePaperId)
      if (row !== undefined) return row
    }
    return db.prepare(`${select} AND title = ? ORDER BY rowid DESC LIMIT 1`).get(SAMPLE_TITLE)
  }

  /** Count rows with a bounded query; missing tables just mean "not done". */
  function count(sql, ...params) {
    try {
      return Number(db.prepare(sql).get(...params)?.count ?? 0)
    } catch {
      return 0
    }
  }

  /** Embedding component facts (never throws; a missing service reads as unavailable). */
  function vectorFacts() {
    try {
      if (embedding === null || embedding === undefined || typeof embedding.facts !== 'function') {
        return { installed: false, available: false, indexReady: false, chunks: 0, model: null, reason: 'embedding service is not initialized' }
      }
      const facts = embedding.facts()
      return {
        installed: facts.configured === true,
        available: facts.available === true,
        indexReady: facts.indexReady === true,
        chunks: Number(facts.counts?.chunks ?? 0),
        model: facts.model ?? null,
        reason: facts.configured !== true ? (facts.lastError ?? 'embedding component is not installed') : facts.available !== true ? (facts.lastError ?? 'embedding worker is unavailable') : facts.indexReady !== true ? 'embedding index is empty; run embedding.index' : '',
      }
    } catch (error) {
      return { installed: false, available: false, indexReady: false, chunks: 0, model: null, reason: String(error?.message ?? error) }
    }
  }

  /** Derived task progress from the library itself. */
  function progress() {
    const paper = samplePaper()
    const paperId = paper === undefined ? null : paper.id
    const annotate = paperId === null ? 0 : count("SELECT COUNT(*) AS count FROM annotations WHERE paper_id = ? AND state = 'active'", paperId)
    const note = paperId === null ? 0 : count('SELECT COUNT(*) AS count FROM note_paper_links WHERE paper_id = ?', paperId)
    const quickNote = paperId === null ? 0 : count("SELECT COUNT(*) AS count FROM notes WHERE paper_id = ? AND state = 'active'", paperId)
    const cite = paperId === null ? 0 : count("SELECT COUNT(*) AS count FROM bundle_items WHERE ref_id = ? AND kind = 'paper'", paperId)
    const vector = vectorFacts()
    const done = {
      component: componentInstalled(),
      vector: vector.installed && vector.indexReady,
      sample: paperId !== null,
      read: paperId !== null && typeof paper.last_read_at === 'string' && paper.last_read_at !== '',
      annotate: annotate > 0,
      note: note + quickNote > 0,
      cite: cite > 0,
    }
    const tasks = ONBOARDING_TASKS.map((id) => ({ id, done: done[id] === true }))
    const doneCount = tasks.filter((task) => task.done).length
    const next = tasks.find((task) => task.done !== true) ?? null
    return {
      tasks,
      doneCount,
      total: ONBOARDING_TASKS.length,
      allDone: doneCount === ONBOARDING_TASKS.length,
      next: next === null ? null : next.id,
      counts: { annotate, note: note + quickNote, cite, vectorChunks: vector.chunks },
      sample: {
        paperId,
        title: paper === undefined ? null : paper.title,
        opened: paper !== undefined && typeof paper.last_read_at === 'string' && paper.last_read_at !== '',
      },
      vector,
    }
  }

  /** `onboarding.status` payload. */
  function status() {
    const current = state()
    const derived = progress()
    return {
      state: current,
      version: ONBOARDING_VERSION,
      tasks: derived.tasks,
      doneCount: derived.doneCount,
      total: derived.total,
      allDone: derived.allDone,
      next: derived.next,
      counts: derived.counts,
      vector: derived.vector,
      sample: { ...sample(), paperId: derived.sample.paperId, title: derived.sample.title, opened: derived.sample.opened },
      // The checklist shows itself on a fresh install and stays docked until the
      // user finishes or dismisses it.
      // Stay visible once all tasks are done so the user sees the finished state and
      // can close it deliberately.
      visible: current.dismissedAt === null,
    }
  }

  /** Record the sample paper id right after the client imports it. */
  function noteSampleImported(paperId) {
    if (typeof paperId !== 'string' || paperId === '') return state()
    return update({ samplePaperId: paperId })
  }

  /** Reset the guide (replay) without touching the library. */
  function reset() {
    return update({ dismissedAt: null, completedAt: null, expanded: true })
  }

  /** Mark the guide finished: the checklist hides for good. */
  function finish() {
    return update({ completedAt: nowIso(), dismissedAt: nowIso() })
  }

  return { state, update, status, progress, sample, noteSampleImported, reset, finish, samplePaper, componentInstalled }
}
