# Changelog

## 0.22.0

- Added a dedicated note beautification Agent built on the DSH Agent runtime.
- The Agent is restricted to five note-only tools: read, set section, insert action block, web search, finish.
- Every layout, figure, table, web image and source is created through an Agent tool call; `content_md` is never changed.
- Added inline action directives: `{{figure: ...}}`, `{{table: ...}}`, `{{web-image: ...}}`, `{{web: ...}}`, `{{stats: ...}}`, `{{callout: ...}}`, `{{timeline: ...}}`, `{{compare: ...}}`, `{{steps: ...}}`.
- Added a directive toolbar with templates and an execute-directives action.
- Added richer note blocks: web image with attribution, source list, timeline, comparison and numbered steps.
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
