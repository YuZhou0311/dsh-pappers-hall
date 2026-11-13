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
check('table crop spans a column whose cells read as prose', () => {
  // A "Key literature"-style column: long citation lines fail the cell test, so
  // only its short header is accepted; the grid must still reach the column.
  const lines = [caption('Table 1. Models.', 55, 300)]
  const blocks = [
    captionBlock('Table 1. Models.', 55, 300, 236, 20),
    ...tableGrid(340),
    block('Key literature', 300, 340, 60, 10),
    block('de Wit and van Diepen (2008)\nDrewniak et al. (2013)\nEPIC v0810 - Izaurralde et al. (2006)\nGEPIC v0810 - Liu et al. (2007)', 300, 352, 200, 60),
  ]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.ok(candidate.bbox.x + candidate.bbox.w >= 500, JSON.stringify(candidate.bbox))
})
check('table that arrives as one prose-looking block is cropped to that block', () => {
  // Prompt templates: one block, every line too long to look like a table cell.
  const lines = [caption('Table 2. A prompt on the ALFWorld clean task.', 90, 300)]
  const blocks = [
    captionBlock('Table 2. A prompt on the ALFWorld clean task.', 90, 300, 220, 20),
    block('You are in the middle of a room. Looking quickly around you, you see a cabinet 13, a cabinet 12.\n> think: To solve the task, I need to find and take a lettuce, then clean it.\n> go to fridge 1\nThe fridge 1 is closed.', 114, 330, 350, 220),
  ]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.ok(candidate.bbox.x <= 112, JSON.stringify(candidate.bbox))
  assert.ok(candidate.bbox.x + candidate.bbox.w >= 462, JSON.stringify(candidate.bbox))
})
check('numbered section heading in the next column is not a table cell', () => {
  // A heading right of the grid used to stretch a left-column table across the
  // page gutter and swallow the neighbouring column.
  const lines = [caption('Table 4. Pass@1 accuracy.', 55, 300)]
  const blocks = [
    ...tableGrid(100),
    captionBlock('Table 4. Pass@1 accuracy.', 55, 300, 236, 20),
    block('6. Conclusion', 320, 120, 90, 10),
  ]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.ok(candidate.bbox.x + candidate.bbox.w <= 300, JSON.stringify(candidate.bbox))
})
check('figure crop spans both panels when the caption is narrower', () => {
  // Diagram on the left, pseudocode panel on the right, caption below both.
  const lines = [caption('Figure 2. (a) Diagram of the method. (b) The algorithm.', 150, 500, 300)]
  const blocks = [
    block('External feedback', 124, 200, 60, 10),
    block('Actor (LM)', 229, 300, 40, 10),
    block('Algorithm 1 Reinforcement via self-reflection', 314, 200, 180, 20),
    block('Initialize Actor, Evaluator, Self-Reflection\nfor each trial do\n  generate trajectory', 324, 230, 180, 180),
    captionBlock('Figure 2. (a) Diagram of the method. (b) The algorithm.', 150, 500, 300, 20),
  ]
  const [candidate] = detectFigureCandidates([page(lines, blocks)])
  assert.ok(candidate.bbox.x <= 125, JSON.stringify(candidate.bbox))
  assert.ok(candidate.bbox.x + candidate.bbox.w >= 503, JSON.stringify(candidate.bbox))
})
console.log(`${process.exitCode ? 'FAIL' : 'PASS'} — ${pass} figure-crop checks`)
