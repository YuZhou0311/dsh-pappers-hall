/**
 * Stable ids and constants shared by every Pappers-Hall client surface.
 */

/** Locale namespace owned by this plugin. */
export const NS = 'pappers-hall'
/** Sidebar entry id; also the `main` panel key. */
export const PANEL_ID = 'pappers-hall'
/** Right-sidebar tab implementation id; also the body registration key. */
export const DRAWER_ID = 'dsh-pappers-hall/drawer'
/** Right-sidebar page type opened by `ctx.sidebarRight.openTab(...)`. */
export const DRAWER_KIND = 'pappers-hall'
/** Composer dock list entry id. */
export const DOCK_ID = 'pappers-hall-dock'
/** Session header utilities list entry id. */
export const HEADER_ID = 'pappers-hall-drawer-button'
/** Same-origin Host API endpoint (contract §2). */
export const API_PATH = '/pappers-hall/api'
/** Private drag-and-drop MIME type; only this plugin produces and accepts it. */
export const MATERIAL_MIME = 'application/x-pappers-hall'
/** Default preferred page raster width. */
export const PAGE_IMAGE_WIDTH = 1400
/** Default preferred figure crop width. */
export const FIGURE_IMAGE_WIDTH = 900
/** Status strip poll interval while the paper center is visible. */
export const STATUS_POLL_MS = 6000
/** Page size of one library list request. */
export const LIBRARY_PAGE_SIZE = 200
/** localStorage key holding only UI preferences (widths, toggles, sort). */
export const UI_PREF_KEY = 'pappers-hall.ui.v2'
/** Annotation palette shared by the reader and the drawer. */
export const ANNOTATION_COLORS = ['yellow', 'green', 'blue', 'red', 'purple']
/** Collection colours offered by the new-collection editor. */
export const COLLECTION_COLORS = ['blue', 'green', 'amber', 'red', 'violet', 'slate']
/** Known Pappers-Hall wire tool names whose results get a source card. */
export const TOOL_NAMES = [
  'papers_search',
  'papers_get',
  'papers_list',
  'papers_get_passage',
  'papers_get_figure',
  'papers_manage',
  'papers_annotations',
  'papers_overview',
  'papers_changes',
  'papers_pdf',
  'papers_translate',
  'notes_search',
  'notes_get',
  'notes_edit',
]
