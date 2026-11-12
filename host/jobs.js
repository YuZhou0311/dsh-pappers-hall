/**
 * Persistent background job queue for the Pappers-Hall Host half.
 *
 * Jobs are rows in SQLite, not in-memory promises: the worker claims one job at
 * a time under a lease, records checkpoints in `job_steps`, retries with
 * exponential backoff, and can be paused, resumed, cancelled or retried from the
 * API. On mount every `running` job whose lease expired is requeued, so a crash
 * during import loses at most the current checkpoint (contract §4).
 *
 * The worker is driven by `ctx.timer.interval` (1s) in DSH; the selftest injects
 * a fake timer and calls `tick()`/`drain()` directly.
 *
 * @module pappers-hall/host/jobs
 */
import { readSetting, writeSetting } from './db.js'
import { futureIso, nowIso, randomHex } from './paths.js'
import { notFound } from './store.js'

/** Job states that a scheduler may pick up. */
const RUNNABLE_STATES = "('queued','retry_wait')"

/**
 * Map one `jobs` row the same way the API does. Kept local to avoid a circular
 * import with the store module.
 * @param {object} row raw row.
 * @returns {object} Job object.
 */
function mapJob(row) {
  const job = {
    id: row.id,
    kind: row.kind,
    state: row.state,
    attempts: Number(row.attempts ?? 0),
    progress: {
      done: Number(row.progress_done ?? 0),
      total: Number(row.progress_total ?? 0),
      unit: row.progress_unit ?? 'items',
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    idempotencyKey: row.idempotency_key ?? null,
  }
  if (typeof row.error_message === 'string' && row.error_message !== '') job.error = row.error_message
  if (typeof row.lease_until === 'string') job.leaseUntil = row.lease_until
  if (typeof row.next_run_at === 'string') job.nextRunAt = row.next_run_at
  if (row.cancel_requested === 1) job.cancelRequested = true
  return job
}

/** Stable summary counts used by `status` and `jobs.list`. */
export function jobSummary(db) {
  const summary = { queued: 0, running: 0, paused: 0, retry_wait: 0, failed: 0, succeeded: 0, cancelled: 0, globalPaused: false }
  for (const row of db.prepare('SELECT state, COUNT(*) AS count FROM jobs GROUP BY state').all()) {
    if (Object.hasOwn(summary, row.state)) summary[row.state] = Number(row.count ?? 0)
  }
  summary.globalPaused = readSetting(db, 'jobs.globalPaused') === true
  return summary
}

/**
 * Create the persistent job queue bound to one database.
 * @param {object} options queue options.
 * @param {import('node:sqlite').DatabaseSync} options.db open database.
 * @param {object} [options.logger] logger.
 * @param {object} [options.timer] service exposing `interval(callback, ms) => dispose`.
 * @param {number} [options.pollMs] polling interval (default 1000).
 * @param {number} [options.leaseMs] lease duration (default 60s).
 * @returns {object} queue.
 */
export function createJobQueue({ db, logger, timer, pollMs = 1000, leaseMs = 60_000 }) {
  /** Registered kind → handler map. */
  const handlers = new Map()
  /** Abort controllers of currently running handlers. */
  const inflight = new Map()
  /** True while one worker pass is executing (re-entrancy guard). */
  let working = false
  /** Set by {@link stop}; a stopped queue never claims another job. */
  let stopped = false
  /** Disposer of the polling timer. */
  let disposeTimer = null
  /** Fallback interval when no timer service is available (selftest/minimal). */
  let fallbackInterval = null

  /** Read one raw job row. */
  function rowOf(jobId) {
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)
  }

  /** Patch one job row and refresh `updated_at`. */
  function update(jobId, assignments, params) {
    const now = nowIso()
    db.prepare(`UPDATE jobs SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, now, jobId)
    return rowOf(jobId)
  }

  /** Counters exposed to handlers and the API. */
  const api = {
    /** @param {object} job parsed job. */
    updateProgress(job, done, total, unit) {
      const current = rowOf(job.id)
      if (current === undefined) return
      db.prepare('UPDATE jobs SET progress_done = ?, progress_total = ?, progress_unit = COALESCE(?, progress_unit), updated_at = ? WHERE id = ?').run(
        Math.max(0, Math.trunc(done)),
        Math.max(0, Math.trunc(total ?? current.progress_total ?? 0)),
        unit ?? null,
        nowIso(),
        job.id,
      )
    },
    /** Extend the lease of one running job. */
    heartbeat(job) {
      db.prepare('UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ?').run(futureIso(leaseMs / 1000), nowIso(), job.id)
    },
    /** Record one idempotent checkpoint step. */
    checkpoint(job, step, status, detail) {
      db.prepare('INSERT OR REPLACE INTO job_steps(job_id, step, status, detail, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        job.id,
        String(step),
        String(status),
        detail === undefined ? null : JSON.stringify(detail),
        nowIso(),
      )
    },
    /** Read one checkpoint step status. */
    getCheckpoint(job, step) {
      const row = db.prepare('SELECT * FROM job_steps WHERE job_id = ? AND step = ?').get(job.id, String(step))
      if (row === undefined) return undefined
      return { step: row.step, status: row.status, detail: row.detail === null ? undefined : safeParse(row.detail) }
    },
    /** Whether cancellation was requested for one job. */
    isCancelled(job) {
      if (job.signal?.aborted) return true
      const row = rowOf(job.id)
      return row?.cancel_requested === 1 || row?.state === 'cancelled'
    },
    /** Throw the canonical cancellation error when the job was cancelled. */
    throwIfCancelled(job) {
      if (api.isCancelled(job)) throw cancelledError()
    },
    logger,
  }

  /** Canonical cancellation failure recognised by the worker. */
  function cancelledError() {
    const error = new Error('job cancelled')
    error.name = 'AbortError'
    error.code = 'cancelled'
    return error
  }

  /** JSON-parse a checkpoint detail without throwing. */
  function safeParse(value) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  /** Register the handler for one job kind. */
  function register(kind, handler) {
    if (typeof handler !== 'function') throw new Error(`job handler for ${kind} must be a function`)
    handlers.set(kind, handler)
  }

  /**
   * Enqueue one job, or return the existing job when the idempotency key is known.
   * @param {object} request job request.
   * @returns {object} Job.
   */
  function enqueue({ kind, payload = {}, idempotencyKey, maxAttempts = 3, total = 0, unit = 'items' }) {
    if (typeof kind !== 'string' || kind === '') throw new Error('job kind is required')
    if (typeof idempotencyKey === 'string' && idempotencyKey !== '') {
      const existing = db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotencyKey)
      if (existing !== undefined) return mapJob(existing)
    }
    const id = `jb-${randomHex(6)}`
    const now = nowIso()
    db.prepare(
      `INSERT INTO jobs(id, kind, state, payload_json, result_json, attempts, max_attempts, progress_done, progress_total, progress_unit,
                        error_message, idempotency_key, lease_until, next_run_at, cancel_requested, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, NULL, 0, ?, 0, ?, ?, NULL, ?, NULL, NULL, 0, ?, ?)`,
    ).run(
      id,
      kind,
      JSON.stringify(payload ?? {}),
      Math.max(1, Math.trunc(maxAttempts)),
      Math.max(0, Math.trunc(total)),
      unit,
      typeof idempotencyKey === 'string' && idempotencyKey !== '' ? idempotencyKey : null,
      now,
      now,
    )
    const row = rowOf(id)
    logger?.debug?.(`pappers-hall: enqueued ${kind} job ${id}`)
    return mapJob(row)
  }

  /** Claim the oldest runnable job and mark it running under a lease. */
  function claimNext() {
    const now = nowIso()
    const row = db
      .prepare(
        `SELECT * FROM jobs
         WHERE state IN ${RUNNABLE_STATES}
           AND (next_run_at IS NULL OR next_run_at <= ?)
           AND (lease_until IS NULL OR lease_until <= ?)
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(now, now)
    if (row === undefined) return undefined
    const result = db
      .prepare(
        "UPDATE jobs SET state = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = ? AND state IN ('queued','retry_wait')",
      )
      .run(futureIso(leaseMs / 1000), now, row.id)
    if (Number(result.changes ?? 0) !== 1) return undefined
    return rowOf(row.id)
  }

  /** Run one claimed job to a settled state. */
  async function runJob(row) {
    const handler = handlers.get(row.kind)
    const job = {
      id: row.id,
      kind: row.kind,
      attempt: Number(row.attempts ?? 1),
      payload: safeParse(row.payload_json ?? '{}'),
      signal: undefined,
    }
    if (handler === undefined) {
      update(row.id, ["state = 'failed'", 'error_message = ?', 'lease_until = NULL'], [`no handler is registered for job kind ${row.kind}`])
      logger?.warn?.(`pappers-hall: job ${row.id} failed: no handler for ${row.kind}`)
      return
    }
    const controller = new AbortController()
    job.signal = controller.signal
    inflight.set(row.id, controller)
    try {
      const result = await handler(job, api)
      const fresh = rowOf(row.id)
      if (fresh?.cancel_requested === 1 || controller.signal.aborted) {
        update(row.id, ["state = 'cancelled'", 'lease_until = NULL', 'error_message = ?'], ['cancelled by request'])
        return
      }
      update(
        row.id,
        ["state = 'succeeded'", 'result_json = ?', 'lease_until = NULL', 'error_message = NULL', 'progress_done = CASE WHEN progress_total > 0 THEN progress_total ELSE progress_done END'],
        [result === undefined ? null : JSON.stringify(result)],
      )
      logger?.debug?.(`pappers-hall: job ${row.id} (${row.kind}) succeeded`)
    } catch (error) {
      const fresh = rowOf(row.id)
      const cancelled = fresh?.cancel_requested === 1 || controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'cancelled'
      if (cancelled) {
        update(row.id, ["state = 'cancelled'", 'lease_until = NULL', 'error_message = ?'], ['cancelled by request'])
        return
      }
      const message = String(error?.message ?? error).slice(0, 2000)
      const attempts = Number(fresh?.attempts ?? row.attempts ?? 1)
      const maxAttempts = Number(fresh?.max_attempts ?? row.max_attempts ?? 3)
      if (attempts >= maxAttempts || error?.fatal === true) {
        update(row.id, ["state = 'failed'", 'error_message = ?', 'lease_until = NULL'], [message])
        logger?.warn?.(`pappers-hall: job ${row.id} (${row.kind}) failed after ${attempts} attempt(s): ${message}`)
      } else {
        const delaySeconds = Math.min(60, 2 ** attempts)
        update(row.id, ["state = 'retry_wait'", 'error_message = ?', 'lease_until = NULL', 'next_run_at = ?'], [message, futureIso(delaySeconds)])
        logger?.debug?.(`pappers-hall: job ${row.id} (${row.kind}) retrying in ${delaySeconds}s: ${message}`)
      }
    } finally {
      inflight.delete(row.id)
    }
  }

  /**
   * One worker pass: claim and run until no runnable job remains.
   * @returns {Promise<number>} number of jobs processed.
   */
  async function tick() {
    if (stopped || working) return 0
    if (readSetting(db, 'jobs.globalPaused') === true) return 0
    working = true
    let processed = 0
    try {
      for (;;) {
        if (stopped) break
        const row = claimNext()
        if (row === undefined) break
        processed += 1
        await runJob(row)
        if (processed > 1000) break // defensive bound for one pass
      }
    } finally {
      working = false
    }
    return processed
  }

  /**
   * Run passes until the queue is idle (tests and one-shot maintenance).
   * Waits out a pass another timer tick already started so callers never observe
   * an idle-looking queue while a job is still running.
   * @param {number} [timeoutMs] safety deadline.
   * @returns {Promise<number>} number of jobs processed.
   */
  async function drain(timeoutMs = 600_000) {
    let total = 0
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (working) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        continue
      }
      const processed = await tick()
      total += processed
      if (processed === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (!working) return total
      }
    }
    throw new Error('pappers-hall: job queue drain timed out')
  }

  /** Requeue jobs whose lease expired while the process was away. */
  function recoverStale() {
    const now = nowIso()
    const result = db
      .prepare("UPDATE jobs SET state = 'queued', lease_until = NULL, updated_at = ? WHERE state = 'running' AND (lease_until IS NULL OR lease_until <= ?)")
      .run(now, now)
    if (Number(result.changes ?? 0) > 0) logger?.warn?.(`pappers-hall: recovered ${result.changes} interrupted job(s)`)
    return Number(result.changes ?? 0)
  }

  /** Start the polling worker, if not already running. */
  function start() {
    if (stopped) return
    recoverStale()
    if (disposeTimer !== null || fallbackInterval !== null) return
    const run = () => {
      void tick().catch((error) => logger?.warn?.(`pappers-hall: job worker tick failed: ${String(error?.message ?? error)}`))
    }
    if (timer !== undefined && typeof timer.interval === 'function') {
      disposeTimer = timer.interval(run, pollMs)
    } else {
      fallbackInterval = setInterval(run, pollMs)
      if (typeof fallbackInterval.unref === 'function') fallbackInterval.unref()
    }
  }

  /** Stop the worker, abort the current job and release the timer. */
  function stop() {
    stopped = true
    for (const controller of inflight.values()) {
      try {
        controller.abort(new Error('job queue stopped'))
      } catch {}
    }
    inflight.clear()
    if (disposeTimer !== null) {
      try {
        disposeTimer()
      } catch {}
      disposeTimer = null
    }
    if (fallbackInterval !== null) {
      clearInterval(fallbackInterval)
      fallbackInterval = null
    }
  }

  /** `jobs.pause` — one job by id, or the whole queue when no id is given. */
  function pause(jobId) {
    if (jobId === undefined || jobId === null || String(jobId) === '') {
      writeSetting(db, 'jobs.globalPaused', true)
      return { globalPaused: true, summary: jobSummary(db) }
    }
    const row = rowOf(String(jobId))
    if (row === undefined) throw notFound(`job ${jobId} does not exist`, { id: jobId })
    if (row.state === 'queued' || row.state === 'retry_wait') {
      return mapJob(update(row.id, ["state = 'paused'", 'lease_until = NULL'], []))
    }
    return mapJob(row)
  }

  /** `jobs.resume` — one paused job by id, or the whole queue when no id is given. */
  function resume(jobId) {
    if (jobId === undefined || jobId === null || String(jobId) === '') {
      writeSetting(db, 'jobs.globalPaused', false)
      return { globalPaused: false, summary: jobSummary(db) }
    }
    const row = rowOf(String(jobId))
    if (row === undefined) throw notFound(`job ${jobId} does not exist`, { id: jobId })
    if (row.state === 'paused') return mapJob(update(row.id, ["state = 'queued'", 'next_run_at = NULL', 'lease_until = NULL'], []))
    return mapJob(row)
  }

  /** `jobs.retry` — reset one failed/cancelled job and run it again. */
  function retry(jobId) {
    const row = rowOf(String(jobId ?? ''))
    if (row === undefined) throw notFound(`job ${jobId} does not exist`, { id: jobId })
    if (!['failed', 'cancelled', 'succeeded'].includes(row.state)) return mapJob(row)
    return mapJob(
      update(row.id, ["state = 'queued'", 'attempts = 0', 'error_message = NULL', 'lease_until = NULL', 'next_run_at = NULL', 'cancel_requested = 0'], []),
    )
  }

  /** `jobs.cancel` — request cancellation; running jobs are aborted now. */
  function cancel(jobId) {
    const row = rowOf(String(jobId ?? ''))
    if (row === undefined) throw notFound(`job ${jobId} does not exist`, { id: jobId })
    if (['succeeded', 'failed', 'cancelled'].includes(row.state)) return mapJob(row)
    const controller = inflight.get(row.id)
    if (controller !== undefined) {
      try {
        controller.abort(new Error('cancelled by request'))
      } catch {}
      return mapJob(update(row.id, ['cancel_requested = 1'], []))
    }
    return mapJob(update(row.id, ["state = 'cancelled'", 'cancel_requested = 1', 'lease_until = NULL', 'error_message = ?'], ['cancelled by request']))
  }

  /** `jobs.list` read helper. */
  function list() {
    return { items: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').all().map(mapJob), summary: jobSummary(db) }
  }

  /** Read one job by id. */
  function get(jobId) {
    const row = rowOf(String(jobId ?? ''))
    return row === undefined ? undefined : mapJob(row)
  }

  return {
    register,
    enqueue,
    tick,
    drain,
    start,
    stop,
    pause,
    resume,
    retry,
    cancel,
    list,
    get,
    summary: () => jobSummary(db),
    recoverStale,
    /** Expose the handler-facing helpers for tests and maintenance. */
    api,
    get running() {
      return working
    },
  }
}
