# Changelog

## 0.24.25

- The reading sidebar no longer auto-opens in a normal browser (screenshot/web use); automatic opening is limited to the desktop Electron shell and once per session.

## 0.24.27

- A figure that spans both page columns is no longer cropped to its (narrower) caption: the crop grows across the panels the caption already reaches, so diagram-plus-pseudocode figures stop losing their outer edges.
- Added `scripts/audit-figure-crops.mjs`, which re-runs the production detection path over the stored library and reports crops that changed, slice a text column or swallow a neighbouring caption (report in `reports/figure-crops.json`).
- Figure-crop regression tests now cover the four repaired mechanisms: prose-like columns, single-block tables, numbered section headings and two-column figures.
- The one-time table-crop repair marker moved to v19 so libraries repaired under v18 pick up the wider figure crops.

## 0.24.26

- Table crops no longer slice a column whose cells hold long text (citation lists, prompt templates): the grid now extends across any block it already reaches instead of stopping at the last column that looked like a cell.
- A table that arrives as one prose-looking block (prompt templates, wide reference tables) is cropped to that block instead of the caption column, so it is no longer cut in half.
- Numbered section headings (“6. Conclusion”) are no longer counted as table cells, which used to stretch a left-column table into the neighbouring column.
- The one-time table-crop repair marker moved to v18, so existing libraries are re-cropped in place on the next mount (figure ids, annotations and note references stay valid).

## 0.24.25

- Figures on the reader page are now drag sources: drag a figure box straight into the conversation (session row or composer) or into an open note, with the real figure as the drag ghost.
- Removed the conversation sidebar's 图片 tab and its figure wall; figures are picked from the paper itself (page boxes or the reader's 图表 panel).
- The reader's figure highlight and the page drag boxes now share one bbox normaliser, so PDF-point and 0–1 boxes land on the same rectangle.
- Conversations no longer open the paper drawer by themselves: the drawer appears only from its header button or an explicit “打开论文抽屉” action, not on plugin startup or header mount.
- Fixed the conversation being clipped under the drawer: the plugin stopped reporting `layout.openRightbar(false, …)`. That report reserves no grid track, so the frame hung the panel over the centre; `ui-sidebar-right` now keeps its normal track and the centre makes room.

## 0.24.24

- Conversation-sidebar figures, annotations/passages and notes are draggable into the chat composer; material drops insert a Pappers-Hall reference bundle.
- The note preview itself is draggable as a note reference.

## 0.24.23

- Removed the 原文/对照/仅译文 mode switch from the reader toolbar; the translation assistant and side translation tools remain.
- Moved 引用到对话 and 打开 PDF into the tool row’s former mode-switch position.

## 0.24.22

- Linking a paper from the note side panel refreshes the open note live (no reopen needed).
- The link-paper dialog can filter All / Linked / Unlinked papers.
- Removed the duplicate top-toolbar Notes button from the reader; the side Notes tab remains.

## 0.24.21

- Persist the open paper/page inside the note-writing side panel as well as the inline note editor.

## 0.24.20

- Persist the inline note opened inside the paper library, so switching to a conversation and back restores the note editor instead of the library home.
- Auto-open the paper sidebar from plugin startup, not only from a conversation header.

## 0.24.19

- Moved “关联到当前笔记” into the note-writing paper panel bar (the embedded reader beside the note); removed it from the generic reader toolbar.

## 0.24.18

- “关联到此笔记” now appears only while a note is actively open beside a paper; it is hidden in the standalone reader where it had no valid target.
- The conversation drawer retries opening until the host right sidebar is ready, and restores the last paper/page as its initial preview.
- Added a live page hand-off from the reader to the Paper Center route so switching to a conversation and back keeps the page.

## 0.24.17

- Persist the last paper-center route and reader page across panel remounts; returning from a conversation resumes the paper/page instead of the library home.
- The conversation drawer opens automatically when a conversation header mounts, so the reading sidebar is visible by default.

## 0.24.16

- Conversation-sidebar paper cards now open the paper reader inline: translation, annotations, AI and figure tools stay in the right sidebar.
- Clicking a note in the sidebar opens a clean read-only note preview; previews have an explicit jump to the paper center.
- The conversation drawer auto-opens once per browser session so the reading sidebar is not silently hidden on a fresh conversation.

## 0.24.10

- Made “关联到此笔记” a primary, always-visible reader action; its label no longer collapses when the toolbar switches to icon-only mode.
- Clicking it without an open note now explains what to do instead of silently doing nothing.

## 0.24.9

- Audited all 95 figure/table crops across 7 papers.
- Added page-level table caption-side inference, side-by-side table bounds and narrow-caption table expansion.
- Figure crops now skip running headers/section headings, bound against preceding tables, include full-width Nature panels, and keep text-only appendix figures.
- Added a complete (sideways) crop for the rotated GGCM Table 2; auto-rotation remains unsupported.

## 0.24.7

- Reader annotations can be quoted straight into the open note as quote cards.
- Added a reader Figures tab; figures/tables are draggable into notes and render as figure cards.
- Added “关联到此笔记” in the reader toolbar to link the current paper to the open note.
- Shared note-context bridge keeps the active note available across reader/notes navigation.

## 0.24.4

- Fixed table crops when the caption is below the grid (nearest-cluster side detection).
- Fixed figure crops leaking page titles/authors; figure top now follows the nearest body block.
- Fixed truncated captions by reading the full caption block.
- Added one-time in-place figure repair preserving figure ids and dHash-versioned image URLs.

## 0.24.3

- Added a note-canvas budget to the note Agent: diagrams are limited to fit a card (9 architecture/flow nodes, 12 mind-map nodes, 5 levels), with explicit split/summarize guidance.
- Host tools now reject oversized diagram payloads with a corrective tool error instead of letting them exceed the note boundaries.
- Agent-verified 14 modules: split into 5-node + 9-node diagrams instead of one oversized graph.

## 0.24.2

- Large diagrams now render as a readable card preview with a top-right “展开” dialog that uses natural SVG width and scrolling.
- Diagram cards cap their viewport and scroll instead of shrinking text or clipping the graph.
- Large paper figures cap at 68vh with object-fit contain; gallery images keep thumbnails + lightbox.

## 0.24.1

- Added Avatar and Calendar event blocks to complete the safe P2 note vocabulary.
- Verified form auto-binding, persisted data, multi-series charts, sortable tables, comparison tables and the gallery lightbox in the Web UI.

## 0.24.0

- Added `contentJson.data` bindings and debounced persistence for interactive note blocks.
- Form block with text, textarea, select, multiselect, slider, date, stepper and checkbox controls; fields auto-bind when the Agent omits a path.
- Computed aggregate block (`sum`/`avg`/`count`/`min`/`max`) over bound data paths; no eval.
- Tabs, checklists and data-table rows can bind to persisted note data.
- Sortable DataTable, ComparisonTable, 1–4 column Grid, CardList hero/compact variants.
- Multi-series and stacked bar/line charts.
- Gallery lightbox with figure/reader and source attribution; action callbacks for figures, links and copy.
- Video/audio media block with bounded URL validation.
- Added dynamic-block tests and browser verification for form persistence, charts, tables and lightbox.

## 0.22.0

- Added a dedicated note beautification Agent built on the DSH Agent runtime.
- The Agent is restricted to five note-only tools: read, set section, insert action block, web search, finish.
- Every layout, figure, table, web image and source is created through an Agent tool call; `content_md` is never changed.
- Added inline action directives: `{{figure: ...}}`, `{{table: ...}}`, `{{web-image: ...}}`, `{{web: ...}}`, `{{stats: ...}}`, `{{callout: ...}}`, `{{timeline: ...}}`, `{{compare: ...}}`, `{{steps: ...}}`.
- Added a directive toolbar with templates and an execute-directives action.
- Added richer note blocks: web image with attribution, source list, timeline (vertical/horizontal), comparison and numbered steps.
- Added P0/P1 expression blocks: Markdown, card grids, bar/line/donut charts, image galleries, tabs, disclosures, checklists, status badges, progress bars, alerts, empty states, quotes, action links and table captions/alignment.
- Added validated architecture/flow/mind-map SVG diagrams with `{{architecture: ...}}`, `{{flowchart: ...}}`, `{{mindmap: ...}}` directives and natural-language diagram requests.
- Web image search uses Openverse with license/creator attribution and a local bounded asset cache.


## 0.21.0

- Standardized as a public DSH bundle with `engines.dsh` and `dsh.manifestVersion`.
- Consolidated the Agent surface to 14 action-oriented tools.
- Added `papers_pdf` for unimported PDFs: inspect, batch read, caption-cropped figure/table view, OCR fallback, and consent-gated import.
- Added proactive visual-reading guidance and figure/table metadata (`visuals`).
- Added a bounded, manually clearable local PDF preview cache.
- Made tool cards collapsed by default with action-specific titles and image badges.
- Tags are human-only for the Agent.
- Fixed note references in conversation bundles (`note_docs` resolution).
- Fixed new-conversation citation insertion and added a composer entry.
- Added local note-folder actions to `notes_edit`.

## 0.20.x

- Notes workbench, inline note editor, paper panel, region translation, and conversation drawer improvements.
