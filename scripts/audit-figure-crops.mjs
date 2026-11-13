#!/usr/bin/env node
/**
 * Audit figure crops against the paper's own text layout.
 *
 * Re-runs the production detection path (pdftotext -bbox-layout → flatten →
 * detectFigureCandidates) for every imported paper and reports three classes of
 * defect against the stored crop:
 *
 *  - changed      the detector now returns a different bbox than the stored row
 *                 (the library predates the current heuristic; the one-time
 *                 figure-crop repair applies it);
 *  - sliced       the crop edge lands inside a text block that continues past
 *                 it, i.e. the image cuts a column or a line in half;
 *  - foreign      a caption of another figure/table sits fully inside the crop,
 *                 i.e. the crop swallowed a neighbouring panel.
 *
 * Findings are candidates for review, not verdicts: pdftotext merges blocks that
 * hold several stacked tables, so a legitimate crop can appear to slice one.
 * Confirm with the rendered image before re-cropping.
 *
 * Usage:
 *   node scripts/audit-figure-crops.mjs [--paper ph-…] [--out reports/figure-crops.json] [--quiet]
 *
 * Reads the paper center's SQLite file directly and never writes to it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPdfTools } from '../host/pdf.js'
import { detectFigureCandidates } from '../host/ingest.js'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const DB_PATH = process.env.PAPPERS_DB ?? path.join(process.env.HOME ?? '', '.dsh', 'pappers-hall', 'pappers-hall.sqlite')
const OUT = arg('--out', path.join(process.cwd(), 'reports', 'figure-crops.json'))
const ONLY_PAPER = arg('--paper', null)
const QUIET = args.includes('--quiet')

const CAPTION = /^\s*(?:fig(?:ure)?|tab(?:le)?|algorithm)\.?\s*\d/i


/** Run one poppler command without a shell; mirrors the host's runner contract. */
async function run(argv, { timeoutMs = 120_000 } = {}) {
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 })
    return { exitCode: 0, stdout, stderr: '' }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exitCode: 127, stdout: Buffer.alloc(0), stderr: '', missing: true }
    return { exitCode: error?.status ?? 1, stdout: error?.stdout ?? Buffer.alloc(0), stderr: String(error?.stderr ?? '') }
  }
}

const blockText = (block) => (block?.lines ?? []).map((line) => line.text ?? '').join(' ').replace(/\s+/g, ' ').trim()

/** A crop edge that lands inside a text block which continues past it. */
function slicedEdges(page, bbox) {
  const right = bbox.x + bbox.w
  const bottom = bbox.y + bbox.h
  const hits = []
  for (const block of page.blocks ?? []) {
    const b = block?.bbox
    const text = blockText(block)
    if (!b || text === '') continue
    // Another panel's caption is not this figure's content.
    if (captionKey(text) !== null) continue
    const verticalOverlap = Math.min(bottom, b.y + b.h) - Math.max(bbox.y, b.y)
    const horizontalOverlap = Math.min(right, b.x + b.w) - Math.max(bbox.x, b.x)
    if (verticalOverlap <= Math.min(30, (b.h || 0) * 0.3)) continue
    // pdftotext merges stacked tables and the body text after them into one
    // block that spans the whole crop. A crop sitting inside such a block is not
    // evidence of a slice, so only edges that start or end inside count.
    const merged = b.x <= bbox.x + 2 && b.x + b.w >= right - 2 && b.w > bbox.w * 1.15
    if (!merged) {
      if (b.x > bbox.x + 2 && b.x < right - 4 && b.x + b.w > right + 30) hits.push({ edge: 'right', text: blockText(block).slice(0, 80) })
      if (b.x < bbox.x - 30 && b.x + b.w > bbox.x - 4 && b.x + b.w < right - 4) hits.push({ edge: 'left', text: blockText(block).slice(0, 80) })
    }
    if (merged || horizontalOverlap <= 6) continue
    if (b.y > bbox.y + 2 && b.y < bottom - 4 && b.y + b.h > bottom + 30) hits.push({ edge: 'bottom', text: text.slice(0, 80) })
  }
  return hits
}

/** Normalised "Table 2" / "Figure 3" key so a caption can be recognised as its own. */
function captionKey(text) {
  const match = /^\s*(fig(?:ure)?|tab(?:le)?|algorithm)\.?\s*(\d+)/i.exec(text ?? '')
  if (match === null) return null
  const kind = match[1].toLowerCase().startsWith('tab') ? 'table' : match[1].toLowerCase().startsWith('fig') ? 'figure' : 'algorithm'
  return `${kind} ${Number(match[2])}`
}

/** A caption of another figure/table swallowed by the crop. */
function foreignCaptions(page, bbox, label) {
  const right = bbox.x + bbox.w
  const bottom = bbox.y + bbox.h
  const ownKey = captionKey(label)
  const out = []
  for (const block of page.blocks ?? []) {
    const b = block?.bbox
    if (!b) continue
    const text = blockText(block)
    const key = captionKey(text)
    if (key === null) continue
    // Algorithm boxes are figure content; the crop must contain them.
    if (key.startsWith('algorithm ')) continue
    if (key === ownKey) continue
    if (b.x >= bbox.x && b.y >= bbox.y && b.x + b.w <= right && b.y + b.h <= bottom) out.push(text.slice(0, 80))
  }
  return out
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const pdf = createPdfTools({ run })
  const papers = ONLY_PAPER
    ? [{ id: ONLY_PAPER }]
    : db.prepare('SELECT DISTINCT paper_id AS id FROM figures ORDER BY paper_id').all()
  const report = { db: DB_PATH, papers: [], summary: { figures: 0, changed: 0, sliced: 0, foreign: 0 } }
  for (const paper of papers) {
    const version = db.prepare('SELECT file_path FROM paper_versions WHERE paper_id = ? ORDER BY created_at DESC LIMIT 1').get(paper.id)
    if (typeof version?.file_path !== 'string') continue
    const rows = db.prepare('SELECT id, page, label, bbox_json FROM figures WHERE paper_id = ? ORDER BY page, label').all(paper.id)
    if (rows.length === 0) continue
    const pages = await pdf.layoutPages(version.file_path)
    const candidates = detectFigureCandidates(pages)
    const pageByNumber = new Map(pages.map((page) => [page.page, page]))
    const entry = { paperId: paper.id, figures: [] }
    for (const row of rows) {
      const stored = JSON.parse(row.bbox_json)
      const candidate = candidates.find((c) => c.label === row.label && c.page === row.page)
      const detected = candidate ? candidate.bbox : null
      const delta = detected === null ? null : Math.abs(detected.x - stored.x) + Math.abs(detected.y - stored.y) + Math.abs(detected.w - stored.w) + Math.abs(detected.h - stored.h)
      const box = detected ?? stored
      const page = pageByNumber.get(row.page)
      const sliced = page ? slicedEdges(page, box) : []
      const foreign = page ? foreignCaptions(page, box, row.label) : []
      const item = { id: row.id, label: row.label, page: row.page, stored, detected, delta, sliced, foreign }
      entry.figures.push(item)
      report.summary.figures += 1
      if (delta !== null && delta > 0.5) report.summary.changed += 1
      if (sliced.length > 0) report.summary.sliced += 1
      if (foreign.length > 0) report.summary.foreign += 1
      const bad = (delta !== null && delta > 0.5) || sliced.length > 0 || foreign.length > 0
      if (!QUIET && bad) {
        const flags = [delta !== null && delta > 0.5 ? `delta ${delta.toFixed(0)}pt` : '', sliced.length ? `sliced ${sliced.map((hit) => hit.edge).join('/')}` : '', foreign.length ? 'foreign caption' : ''].filter(Boolean).join(' · ')
        console.log(`${row.id} ${paper.id} p${row.page} ${row.label} — ${flags}`)
      }
    }
    report.papers.push(entry)
  }
  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  const { figures, changed, sliced, foreign } = report.summary
  console.log(`audited ${figures} figures in ${report.papers.length} papers: changed=${changed} sliced=${sliced} foreign=${foreign}`)
  console.log(`report: ${OUT}`)
}

main().catch((error) => {
  console.error('figure crop audit failed:', error?.stack ?? error)
  process.exitCode = 1
})
