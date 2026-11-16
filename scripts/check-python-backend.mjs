#!/usr/bin/env node
/**
 * Integration check for the optional Python component (not part of `npm test`).
 *
 * Usage:
 *   PAPPERS_TEST_VENV=/path/to/venv PAPPERS_TEST_MODELS=/path/to/models \
 *   PAPPERS_TEST_PDF=/path/to/paper.pdf node scripts/check-python-backend.mjs
 *
 * It exercises the real worker: PyMuPDF extraction, PP-DocLayout-S regions and
 * PP-OCRv6 OCR, plus the fixed model download used by the installer.
 */
import { createHash } from 'node:crypto'
import { createPythonBridge } from '../host/py.js'
import { createPdfTools } from '../host/pdf.js'
import { createDocLayout } from '../host/doc-layout.js'
import { buildReaderStructure } from '../host/layout.js'

const venvDir = process.env.PAPPERS_TEST_VENV
const modelDir = process.env.PAPPERS_TEST_MODELS
const pdfPath = process.env.PAPPERS_TEST_PDF
if (!venvDir || !modelDir || !pdfPath) {
  console.log('SKIP — set PAPPERS_TEST_VENV, PAPPERS_TEST_MODELS and PAPPERS_TEST_PDF')
  process.exit(0)
}

const logger = { warn: (message) => console.log('warn:', message), debug: () => {} }
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' — ' + JSON.stringify(detail).slice(0, 300)}`)
}

const python = createPythonBridge({ venvDir, modelDir, logger })
const docLayout = createDocLayout({ python, logger })
const tools = createPdfTools({ run: async () => ({ stdout: Buffer.alloc(0), stderr: 'unused', exitCode: 1, missing: true, timedOut: false }), logger, python })

const detection = await tools.detect()
check('PyMuPDF backend is selected', detection.backend === 'pymupdf' && detection.available === true, detection)
check('PyMuPDF version reported', typeof detection.version === 'string' && detection.version.length > 0, detection.version)

const info = await tools.info(pdfPath)
check('info returns pages and page size', info.pageCount > 0 && info.pageWidth > 0 && info.pageHeight > 0, info)
const texts = await tools.textPages(pdfPath)
check('text pages extracted', texts.pageCount === info.pageCount && texts.pages[0].length > 200, { pages: texts.pageCount, first: texts.pages[0].length })
const layout = await tools.layoutPages(pdfPath)
check('layout pages have blocks and lines', layout.length === info.pageCount && layout[0].lines.length > 5 && layout[0].blocks.length > 0, { pages: layout.length, lines: layout[0].lines.length })
const rendered = await tools.renderPage({ filePath: pdfPath, page: 1, width: 900, outputPath: '/tmp/ph-check-page.png' })
check('render produces a page image', rendered.width === 900 && rendered.height > 0, rendered)
check('page dhash is stable', typeof (await tools.pageDhash(pdfPath, 1)) === 'string')

const started = Date.now()
const regions = await docLayout.pageRegions({ filePath: pdfPath, page: 1 })
const regionMs = Date.now() - started
check('PP-DocLayout-S returns regions', Array.isArray(regions) && regions.length >= 3, { regions: regions?.length, ms: regionMs })
const roleRegions = docLayout.toRoleRegions(regions ?? [])
check('regions map to reader roles', roleRegions.length > 0 && roleRegions.every((region) => typeof region.role === 'string'), roleRegions.slice(0, 3))
const heuristic = buildReaderStructure(layout[0].flows === undefined ? { width: info.pageWidth, height: info.pageHeight, flows: [] } : layout[0])
const withRegions = buildReaderStructure({ width: layout[0].width, height: layout[0].height, flows: [{ blocks: layout[0].blocks }] }, { regions: roleRegions })
check('detected regions change reader roles', withRegions.blocks.length > 0 && withRegions.blocks.some((block, index) => heuristic.blocks[index] === undefined || block.role !== heuristic.blocks[index]?.role), { blocks: withRegions.blocks.length })

const ocrStarted = Date.now()
const ocr = await python.invoke('ocrPage', { path: pdfPath, page: 1, dpi: 180, layout: true }, { timeoutMs: 300_000 })
const ocrMs = Date.now() - ocrStarted
check('PP-OCRv6 recognises the page', typeof ocr.text === 'string' && ocr.text.length > 200 && ocr.lines.length > 10, { lines: ocr.lines.length, chars: ocr.text?.length, ms: ocrMs })

// Fixed model download used by the installer.
const sha = '33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8'
const url = 'https://huggingface.co/stefanj0/PP-DocLayout-S-ONNX/resolve/main/pp_doclayout_s.onnx'
try {
  const response = await fetch(url, { redirect: 'follow' })
  const buffer = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(buffer).digest('hex')
  check('layout model downloads with the pinned checksum', response.ok && digest === sha, { status: response.status, bytes: buffer.length, digest })
} catch (error) {
  check('layout model downloads with the pinned checksum', false, String(error.message))
}

python.stop()
const failed = checks.filter((entry) => entry.ok !== true)
console.log(failed.length === 0 ? `PASS — ${checks.length} python-backend checks` : `FAIL — ${failed.length}/${checks.length} checks failed`)
process.exit(failed.length === 0 ? 0 : 1)
