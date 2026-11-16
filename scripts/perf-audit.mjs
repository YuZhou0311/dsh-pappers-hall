#!/usr/bin/env node
/**
 * Small, reproducible Pappers-Hall API/render cost audit.
 *
 * Usage:
 *   PAPPERS_BASE=http://127.0.0.1:52321 node scripts/perf-audit.mjs
 *
 * It measures the API endpoints used by the main surfaces; it never mutates
 * data. Report wall-clock p50/p95 and response bytes.
 */
const base = (process.env.PAPPERS_BASE || 'http://127.0.0.1:52321').replace(/\/+$/, '')
const api = base + '/pappers-hall/api'
const methods = [
  ['library.list', { limit: 20 }],
  ['notes.list', { limit: 20 }],
  ['translate.providers', {}],
  ['ai.status', {}],
  ['ai.providers', {}],
]
const rounds = Number(process.env.PAPPERS_ROUNDS || 12)

async function call(method, params) {
  const started = performance.now()
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: params || {} }),
  })
  const text = await response.text()
  const ms = performance.now() - started
  let ok = false
  try { ok = JSON.parse(text).ok === true } catch {}
  return { ms, bytes: Buffer.byteLength(text), ok, status: response.status }
}

function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const at = (q) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  return { p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +Math.max(...values, 0).toFixed(1) }
}

const results = []
for (const [method, params] of methods) {
  await call(method, params) // warm once (provider catalogue/model discovery)
  const runs = []
  for (let i = 0; i < rounds; i += 1) runs.push(await call(method, params))
  const times = runs.map((run) => run.ms)
  results.push({ method, bytes: Math.round(runs.reduce((sum, run) => sum + run.bytes, 0) / runs.length), ok: runs.every((run) => run.ok), ...stats(times) })
}
console.log(JSON.stringify({ base, rounds, results }, null, 2))
