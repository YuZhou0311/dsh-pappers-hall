#!/usr/bin/env node
/**
 * Lead smoke test for the running Pappers-Hall plugin.
 *
 * Exercises the same HTTP API the browser client uses, in order, and prints
 * PASS/FAIL per step. It is intentionally small: the full acceptance suite
 * lives in ../test/run-tests.mjs. This script answers "is the installed plugin
 * alive and does the core paper loop work right now?".
 *
 * Usage:
 *   node scripts/lead-smoke.mjs                 # uses http://127.0.0.1:54731
 *   PAPPERS_BASE=http://127.0.0.1:1234 node scripts/lead-smoke.mjs
 *   node scripts/lead-smoke.mjs --pdf /abs/A01_react.pdf --skip-write
 */
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const BASE = process.env.PAPPERS_BASE ?? 'http://127.0.0.1:54731'
const API = `${BASE}/pappers-hall/api`
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const skipWrite = args.includes('--skip-write')
const pdfPath = resolve(
  arg('--pdf', '/Users/zhouyu/Project/Pappers-Hall/pappers_hall_devkit_lite/papers/pdf/A01_react.pdf'),
)

let failures = 0
const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function call(method, params = {}) {
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${method}: non-JSON response HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  if (!body.ok) throw new Error(`${method}: ${body.error?.code ?? 'error'} ${body.error?.message ?? ''}`)
  return body.data
}

async function waitJobs(timeoutMs = 180_000) {
  const started = Date.now()
  let last
  for (;;) {
    last = await call('jobs.list')
    const active = last.items.filter((job) =>
      ['queued', 'running', 'retry_wait', 'paused'].includes(job.state))
    if (active.length === 0) return last
    if (Date.now() - started > timeoutMs) throw new Error(`jobs still active after ${timeoutMs}ms: ${JSON.stringify(active.map((j) => [j.id, j.state, j.progress]))}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function main() {
  const status = await call('status')
  check('status', status && typeof status.plugin === 'object', `version=${status?.plugin?.version} papers=${status?.counts?.papers} channels=${JSON.stringify(status?.index?.channels)}`)
  check('storage is plugin-owned', typeof status?.storage?.dataDir === 'string' && status.storage.dataDir.includes('pappers-hall'), status?.storage?.dataDir)

  await call('jobs.resume').catch(() => {})
  if (!skipWrite) {
    const bytes = await readFile(pdfPath)
    const imported = await call('library.import', {
      uploads: [{ name: basename(pdfPath), base64: bytes.toString('base64') }],
      operationId: `lead-smoke-${Date.now()}`,
      testMode: true,
    })
    check('library.import accepted', Boolean(imported?.jobId || imported?.accepted), JSON.stringify(imported?.accepted ?? imported?.jobId))
    const jobs = await waitJobs()
    check('import job finished', jobs.items.every((job) => !['queued', 'running', 'retry_wait'].includes(job.state)), `jobs=${jobs.items.length}`)
  }

  const library = await call('library.list', { limit: 100 })
  check('library.list has papers', library.total >= 1, `total=${library.total}`)
  const paper = library.items[0]
  if (!paper) throw new Error('no paper to continue with')

  const detail = await call('library.get', { id: paper.id })
  check('library.get returns versions', Array.isArray(detail.versions) && detail.versions.length >= 1, `versions=${detail.versions?.length}`)

  const reader = await call('reader.open', { id: paper.id })
  check('reader.open pages', Array.isArray(reader.pages) && reader.pages.length >= 1, `pages=${reader.pages?.length} figures=${reader.figures?.length}`)
  const page = await call('reader.page', { id: paper.id, page: reader.currentPage ?? 1 })
  check('reader.page has text', typeof page.text === 'string' && page.text.length > 50, `chars=${page.text?.length}`)
  const img = await fetch(`${BASE}${page.imageUrl}`)
  check('page PNG served', img.ok && (img.headers.get('content-type') ?? '').includes('image/'), `${page.imageUrl} -> ${img.status} ${img.headers.get('content-type')}`)

  const search = await call('search.query', { q: paper.title.split(/\s+/).slice(0, 3).join(' '), scope: 'papers', limit: 5 })
  check('search.query finds paper', search.items.some((hit) => hit.paperId === paper.id || hit.id === paper.id), `hits=${search.items?.length} channels=${JSON.stringify(search.channels?.map((c) => [c.name, c.status]))}`)

  const figures = reader.figures ?? []
  if (figures.length > 0) {
    const figImg = await fetch(`${BASE}${figures[0].imageUrl}`)
    check('figure PNG served', figImg.ok, `${figures[0].imageUrl} -> ${figImg.status}`)
    const figSearch = await call('figures.search', { q: figures[0].caption?.slice(0, 40) ?? paper.title, mode: 'text', limit: 5 })
    check('figures.search runs', Array.isArray(figSearch.items), `hits=${figSearch.items?.length} channels=${JSON.stringify(figSearch.channels)}`)
  } else {
    check('figures extracted (partial allowed)', true, 'no figure rows; import may still be running or PDF has no caption')
  }

  const annotation = await call('annotations.create', {
    paperId: paper.id,
    versionId: detail.currentVersionId ?? detail.versions[0].id,
    page: 1,
    quote: 'smoke quote',
    text: 'Pappers-Hall smoke annotation',
    origin: 'test_note',
    operationId: `lead-smoke-ann-${Date.now()}`,
  })
  check('annotations.create', Boolean(annotation?.annotation?.id), annotation?.annotation?.id)

  const exportBib = await call('export.bibtex', { ids: [paper.id] })
  check('export.bibtex', typeof exportBib.content === 'string' && exportBib.content.includes('@'), `${exportBib.filename} ${exportBib.content?.length}B`)

  if (!skipWrite) {
    await call('library.delete', { ids: [paper.id], operationId: `lead-smoke-del-${Date.now()}` })
    const hidden = await call('library.list', { query: paper.title, state: 'active' })
    check('deleted paper excluded from active list', !hidden.items.some((item) => item.id === paper.id), `active=${hidden.items.length}`)
    await call('library.restore', { ids: [paper.id], operationId: `lead-smoke-restore-${Date.now()}` })
    const back = await call('library.get', { id: paper.id })
    check('restored paper visible', back.state === 'active', `epoch=${back.epoch ?? 'n/a'}`)
  }

  const tools = await call('diagnostics')
  check('diagnostics capabilities', Boolean(tools?.capabilities), JSON.stringify(tools?.capabilities))
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures})`} — ${results.length} checks`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error(`\nSMOKE ERROR: ${error?.stack ?? error}`)
    process.exit(2)
  })
