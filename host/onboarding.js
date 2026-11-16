/**
 * First-run onboarding for the paper centre.
 *
 * The guide walks a new user through the four things this plugin actually does:
 * read a paper, annotate it, write a note and cite material into the
 * conversation. It ships with one small sample PDF (and a rasterised page) so the
 * walkthrough can be real instead of a slideshow, and it offers the optional
 * Python component (PyMuPDF + PP-OCRv6 + PP-DocLayout-S) right in the flow — the
 * settings card stays as the fallback entry point.
 *
 * The state is a single JSON row in `settings`, so the guide resumes across
 * reloads and can be reopened from the library toolbar or the settings panel.
 *
 * @module pappers-hall/host/onboarding
 */
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readSetting, writeSetting } from './db.js'
import { nowIso } from './paths.js'

/** Version of the onboarding script; bump to re-show the guide after a redesign. */
export const ONBOARDING_VERSION = 1

/** Settings key holding the onboarding state. */
export const ONBOARDING_KEY = 'onboarding.state'

/** Steps in display order. Kept small on purpose: each one is a real action. */
export const ONBOARDING_STEPS = ['welcome', 'component', 'sample', 'tour', 'done']

/** Sample PDF shipped inside the package. */
export const SAMPLE_PDF_PATH = fileURLToPath(new URL('../assets/sample/sample-paper.pdf', import.meta.url))

/** Default state for a fresh install. */
function defaultState() {
  return { version: ONBOARDING_VERSION, completedSteps: [], dismissedAt: null, sampleImported: false, samplePaperId: null, updatedAt: null }
}

/**
 * Normalise a stored/patched state so a hand-edited row cannot break the guide.
 * @param {object} value raw value.
 * @returns {object} normalised state.
 */
function normalizeState(value) {
  const base = defaultState()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return base
  const completed = Array.isArray(value.completedSteps)
    ? value.completedSteps.filter((step) => ONBOARDING_STEPS.includes(String(step)))
    : []
  return {
    version: Number.isFinite(Number(value.version)) ? Number(value.version) : ONBOARDING_VERSION,
    completedSteps: [...new Set(completed.map(String))],
    dismissedAt: typeof value.dismissedAt === 'string' && value.dismissedAt !== '' ? value.dismissedAt : null,
    sampleImported: value.sampleImported === true,
    samplePaperId: typeof value.samplePaperId === 'string' && value.samplePaperId !== '' ? value.samplePaperId : null,
    updatedAt: typeof value.updatedAt === 'string' && value.updatedAt !== '' ? value.updatedAt : null,
  }
}

/**
 * Create the onboarding service.
 * @param {object} options dependencies.
 * @param {import('node:sqlite').DatabaseSync} options.db database.
 * @param {object} [options.logger] logger.
 * @returns {object} onboarding service.
 */
export function createOnboarding({ db, logger } = {}) {
  /** Current state (normalised). */
  function state() {
    const stored = readSetting(db, ONBOARDING_KEY)
    return normalizeState(stored === undefined ? null : stored)
  }

  /** Whether the guide should open by itself on the next visit. */
  function shouldAutoOpen() {
    const current = state()
    if (current.dismissedAt !== null) return false
    if (current.version < ONBOARDING_VERSION) return current.dismissedAt === null
    return current.completedSteps.length === 0
  }

  /** Persist one state patch. */
  function update(patch = {}) {
    const current = state()
    const next = normalizeState({ ...current, ...patch, updatedAt: nowIso() })
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
    return { path: SAMPLE_PDF_PATH, available, bytes, title: 'Pappers-Hall 示例论文' }
  }

  /** `onboarding.status` payload. */
  function status() {
    const current = state()
    return {
      state: current,
      steps: ONBOARDING_STEPS,
      version: ONBOARDING_VERSION,
      shouldAutoOpen: shouldAutoOpen(),
      sample: sample(),
    }
  }

  /** Mark one step as done (idempotent). */
  function completeStep(step) {
    const name = String(step ?? '')
    if (!ONBOARDING_STEPS.includes(name)) return { status: 'invalid', reason: `unknown onboarding step ${name || '(empty)'}`, state: state() }
    const current = state()
    if (current.completedSteps.includes(name)) return { status: 'ok', state: current }
    const next = update({ completedSteps: [...current.completedSteps, name] })
    logger?.debug?.(`pappers-hall: onboarding step ${name} completed`)
    return { status: 'ok', state: next }
  }

  return { state, status, update, completeStep, sample, shouldAutoOpen }
}
