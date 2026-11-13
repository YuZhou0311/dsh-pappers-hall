# Changelog

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
