/**
 * PP-DocLayout-S region detection (optional, via the Python bridge).
 *
 * The model labels every region of a page (`doc_title`, `paragraph_title`,
 * `text`, `abstract`, `figure_title`, `table`, `header`, `footer`, …). The reader
 * structure uses those labels to correct the heuristic roles it derives from
 * geometry alone; when the model is not installed nothing changes.
 *
 * @module pappers-hall/host/doc-layout
 */
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'

/** DocLayout label → reader role. */
const ROLE_BY_LABEL = {
  doc_title: 'heading',
  paragraph_title: 'heading',
  figure_title: 'caption',
  table_title: 'caption',
  chart_title: 'caption',
  table: 'table',
  header: 'header',
  footer: 'footer',
  header_image: 'header',
  footer_image: 'footer',
  text: 'body',
  content: 'body',
  abstract: 'body',
  reference: 'body',
  aside_text: 'body',
  footnote: 'body',
  image: 'body',
  chart: 'body',
  formula: 'body',
  formula_number: 'body',
  number: 'body',
  algorithm: 'body',
  seal: 'body',
}

/**
 * Create the region service.
 * @param {object} options service options.
 * @param {object} options.python Python bridge.
 * @param {object} [options.logger] logger.
 * @returns {object} region service.
 */
export function createDocLayout({ python, logger } = {}) {
  /** Whether the layout model is usable right now. */
  function available() {
    return Boolean(python && python.installed() && python.capabilities.layout)
  }

  /**
   * Detect regions on one page.
   * @param {object} request request.
   * @param {string} request.filePath absolute PDF path.
   * @param {number} request.page 1-based page.
   * @param {number} [request.dpi] render resolution for detection (default 180).
   * @returns {Promise<Array<{label:string,score:number,box:number[]}>|null>} regions in PDF points.
   */
  async function pageRegions({ filePath, page, dpi = 180 }) {
    if (!available()) return null
    try {
      const result = await python.invoke('regions', { path: filePath, page, dpi }, { timeoutMs: 60_000 })
      const regions = Array.isArray(result.regions) ? result.regions : []
      return regions.filter((region) => ROLE_BY_LABEL[region.label] !== undefined)
    } catch (error) {
      logger?.debug?.(`pappers-hall: region detection failed for page ${page}: ${String(error?.message ?? error)}`)
      return null
    }
  }

  /**
   * Mark the reader role of each block from the detected regions.
   *
   * A block keeps its heuristic role unless a labelled region contains its
   * centre; specific labels (titles, captions, tables, running heads) win over
   * the generic `text`/`body` ones.
   * @param {Array<object>} blocks reader candidates.
   * @param {Array<object>} regions detected regions (PDF points).
   * @returns {Array<object>} the same blocks with corrected roles.
   */
  function applyRoles(blocks, regions) {
    if (!Array.isArray(regions) || regions.length === 0) return blocks
    const specific = regions.filter((region) => ROLE_BY_LABEL[region.label] !== 'body')
    for (const block of blocks) {
      const cx = block.bbox.x + block.bbox.w / 2
      const cy = block.bbox.y + block.bbox.h / 2
      const hit = specific.find((region) => {
        const [x0, y0, x1, y1] = region.box
        return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1
      })
      if (hit !== undefined) block.role = ROLE_BY_LABEL[hit.label]
    }
    return blocks
  }

  /**
   * Convert model labels into the reader's role vocabulary.
   * @param {Array<object>} regions detected regions.
   * @returns {Array<{role:string,box:number[]}>} role regions.
   */
  function toRoleRegions(regions) {
    if (!Array.isArray(regions)) return []
    return regions
      .map((region) => ({ role: ROLE_BY_LABEL[region.label] ?? null, box: region.box }))
      .filter((region) => region.role !== null && Array.isArray(region.box))
  }

  return { available, pageRegions, applyRoles, toRoleRegions, ROLE_BY_LABEL }
}
