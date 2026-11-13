#!/usr/bin/env node
/** Regression checks for figure/table crop side, grouping and caption text. */
import assert from 'node:assert/strict'
import { detectFigureCandidates } from '../host/ingest.js'

let pass = 0
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name) } catch (error) { console.error('  ✗ ' + name + ': ' + (error?.stack ?? error)); process.exitCode = 1 }
}
const line = (text, x, y, w = 200) => ({ text, xMin: x, yMin: y, xMax: x + w, yMax: y + 10 })
const block = (text, x, y, w, h) => ({ bbox: { x, y, w, h }, lines: String(text).split('\n').map((part) => ({ text: part, bbox: { x, y, w, h } })) })
const page = (lines, blocks) => ({ page: 1, width: 612, height: 792, lines, blocks })
const tableGrid = (y) => [
  block('Prompt Method', 80, y, 100, 10),
  block('Score', 220, y, 50, 10),
  block('CoT 0.32', 80, y + 14, 120, 40),
  block('LATS 0.62', 220, y + 14, 80, 40),
]
const caption = (text, x, y, w = 236) => line(text, x, y, w)
const captionBlock = (text, x, y, w, h) => block(text, x, y, w, h)

check('table caption below the grid crops the grid above it', () => {
  const lines = [caption('Table 1. Comparison of methods.', 55, 300)]
  const blocks = [...tableGrid(100), captionBlock('Table 1. Comparison of methods.', 55, 300, 236, 20), block('Body text below the table that is a long prose paragraph and must not be cropped.', 55, 340, 236, 60)]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.equal(candidate.kind, 'table')
  assert.ok(candidate.bbox.y < 300)
  assert.ok(candidate.bbox.y + candidate.bbox.h <= 300)
  assert.ok(candidate.bbox.h > 40)
})
check('table caption above the grid crops the grid below it', () => {
  const lines = [caption('Table 2. Results.', 55, 300)]
  const blocks = [captionBlock('Table 2. Results.', 55, 300, 236, 20), ...tableGrid(340), block('Long prose body before the caption that is not the table.', 55, 220, 236, 50)]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.ok(candidate.bbox.y >= 300)
  assert.ok(candidate.bbox.h > 40)
})
check('table uses the nearest grid when another table sits above', () => {
  const lines = [caption('Table 3. Costs.', 55, 300)]
  const blocks = [...tableGrid(70), captionBlock('Table 2. Previous.', 55, 160, 236, 20), ...tableGrid(220), captionBlock('Table 3. Costs.', 55, 300, 236, 20)]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.ok(candidate.bbox.y >= 190, JSON.stringify(candidate.bbox))
  assert.ok(candidate.bbox.y + candidate.bbox.h <= 300)
})
check('figure crop starts below a preceding body/author block, not at the page top', () => {
  const lines = [caption('Figure 1. Overview of the method.', 300, 400)]
  const blocks = [
    block('A title or author line that spans the page and must not leak into the figure crop.', 80, 100, 400, 30),
    captionBlock('Figure 1. Overview of the method.', 300, 400, 236, 20),
  ]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.ok(candidate.bbox.y >= 130, JSON.stringify(candidate.bbox))
  assert.ok(candidate.bbox.x >= 290)
})
check('caption block keeps all wrapped caption lines', () => {
  const text = 'Figure 2. A complete caption that wraps over three lines and should not be truncated after the first line.'
  const lines = [caption('Figure 2. A complete caption', 300, 400)]
  const blocks = [captionBlock(text, 300, 400, 236, 40)]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.match(candidate.caption, /three lines/)
})
check('table caption block keeps all wrapped caption lines', () => {
  const text = 'Table 4. A complete table caption that wraps and must keep its explanation for the reader.'
  const lines = [caption('Table 4. A complete table caption', 55, 300)]
  const blocks = [...tableGrid(100), captionBlock(text, 55, 300, 236, 30)]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.match(candidate.caption, /keep its explanation/)
})
console.log(`${process.exitCode ? 'FAIL' : 'PASS'} — ${pass} figure-crop checks`)
