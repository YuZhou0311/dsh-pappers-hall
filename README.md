# Pappers-Hall

Pappers-Hall is a native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for research papers and notes. It adds a paper library, a PDF reader, annotations, a notes workbench, figure/table lookup, and one-click material references inside research conversations.

The plugin is a normal DSH bundle: enabling it adds Host services/tools and Client slots; disabling or uninstalling it removes them again. It does not modify DSH's native prompts or UI.

## Features

- **Paper center** — import local PDFs/BibTeX/RIS/CSL-JSON, folders, tags (human-managed), search, batch actions, trash/restore.
- **Reader** — original PDF pages, text layer and selection, highlights/area notes, translation, page outline, figure list, citation export.
- **Side-by-side notes** — write a note while reading an imported paper or a local PDF; auto-beautify uses the configured model and never overwrites the original Markdown.
- **Notes library** — notes tree in the paper-library sidebar, folders, paper↔note links, full-text search.
- **Note Agent** — a lightweight DSH Agent restricted to five note tools lays out a note and executes inline directives such as `{{figure: ...}}`, `{{table: ...}}` and `{{web-image: ...}}`, or natural-language requests such as “这里加一张论文图” while writing.
- **Conversation references** — cite papers, figures, annotations or notes into the draft; a source-aware bundle token lets the Agent read the exact material.
- **Local PDF reading** — inspect, batch-read, OCR (when enabled), and view figure/table pages without importing first.
- **Agent tools** — 14 consolidated research tools, plus a separate isolated note Agent used only while editing notes.
- **Richer note blocks** — Markdown, cards, bar/line/donut charts, image galleries, tabs, disclosures, task checklists, status/progress, alerts, quotes, action links, timelines and architecture/flow/mind-map diagrams.
- **Diagram directives** — `{{architecture: ...}}`, `{{mindmap: ...}}`, `{{chart: ...}}` and similar natural-language requests are rendered as validated SVG blocks, never ASCII art.
- **Dynamic blocks** — bound forms (text/select/slider/date/stepper), computed aggregates, sortable data tables, comparison tables, grids, multi-series charts, persisted checklists/tab state, gallery lightbox, action callbacks, and safe avatar/calendar cards. Interactive state lives in `contentJson.data` and is saved with a debounce.

## Inline directives and the note Agent

Open a saved note in the notes workbench (or the reader's notes tab) and either press **Directives** (指令) in the editor toolbar, or type a directive directly in the Markdown:

```text
{{figure: Figure 3}}       find a real figure from a linked paper
{{table: 指标 | 数值}}      build a table from the content or web sources
{{web-image: ENSO satellite}}  search and cache a licensed web image
{{web: ENSO latest}}       add a citeable web source
{{stats: ...}}             key-number cards
{{callout: ...}}           emphasized conclusion
{{timeline: ...}}          chronology
{{compare: ...}}           side-by-side comparison
{{steps: ...}}             numbered actions
{{architecture: ...}}      architecture/flow diagram
{{mindmap: ...}}           mind map
{{chart: ...}}             bar/line/donut chart
{{cards: ...}}             key-point cards
{{gallery: ...}}           image gallery
{{tasks: ...}}             reading/experiment checklist
{{quotes: ...}}             quotes with attributions
```

Natural-language requests such as “这里加一张论文图” or “加一个统计表” also work when written in the note. The **Directives** menu runs the note Agent over all markers; the normal **AI beautify** action uses the same Agent for layout.

The note Agent is a separate, short-lived DSH Agent session. It is restricted to five note-only tools (`read`, `set section`, `insert action`, `web search`, `finish`); every global tool is hidden. It can read the current note, use only real linked-paper figures, download attributed web images into the plugin data directory, and call `note_finish`. It cannot edit `content_md`, other notes, the library, tags, files or the general Agent surface. If the Agent is unavailable, the old client-side formatter is **not** used; the UI reports the reason.

## Requirements

- DSH Desktop/Web with `webServer`, `tools` and `timer` services.
- Node.js **>= 24**.
- `pdfinfo`, `pdftotext`, and `pdftoppm` from [poppler](https://poppler.freedesktop.org/) on `PATH` (macOS: `brew install poppler`).
- Optional: the paper-center OCR/embedding components installed from **Settings → Capabilities**, and a configured translation model.
- Supported DSH range: `>=0.2.2-rc.2 <0.3.0` (declared by `engines.dsh`). DSH is a developer preview; breaking changes can occur between releases.

No npm runtime dependencies are required. `esbuild` is a build-time dependency used to rebuild `client.js`.

## Install

### From a local checkout (development)

```sh
npm ci
npm run build
dsh plugin --profile desktop add link:/absolute/path/to/pappers-hall-plugin
```

Or use **Plugins → Add plugin** and select this directory. Restart the page/DSH if the plugin was already loaded and a new Client generation is required.

### From npm (after publishing)

```sh
dsh plugin --profile desktop add dsh-pappers-hall
```

### From a tarball

```sh
npm pack
dsh plugin --profile desktop add ./dsh-pappers-hall-0.24.9.tgz
```

The package is a bundle: `package.json` declares `dsh.bundle.patch`, `dsh.client`, display metadata and exported resources. The patch inserts the `pappers-hall` Host row; the Client half is loaded from the exported `./client` subpath.

## Configuration

Optional values can be set on the bundle row:

```yaml
- id: pappers-hall
  name: dsh-pappers-hall
  config:
    dataDir: /Users/you/.dsh/pappers-hall
    fixtureDir: /absolute/path/to/fixtures
    pdfTools:
      pdfinfo: /opt/homebrew/bin/pdfinfo
      pdftotext: /opt/homebrew/bin/pdftotext
      pdftoppm: /opt/homebrew/bin/pdftoppm
```

The default data directory is `$DSH_HOME/pappers-hall/`; it contains a SQLite database, stored PDFs, figures, OCR/embedding data, and bounded PDF preview thumbnails.

## Data and privacy

- Papers, notes, annotations and indexes stay in the plugin-owned directory.
- Nothing is uploaded by the plugin itself. AI answers/translations use only the services configured in the DSH profile and are invoked by the user.
- The Agent cannot add or remove tags.
- Importing a PDF requires explicit user consent; previewing/reading a local PDF never writes it to the library.
- PDF preview thumbnails are capped (500 files / 256 MB / 7 days) and can be cleared in **Settings → Index & data → Clear PDF preview cache**.
- Disabling the plugin stops its Host routes, tools, prompt sections, timers and Client slots.

## Agent tools

The public Agent surface is intentionally small and action-oriented:

`papers_search`, `papers_get`, `papers_list`, `papers_get_passage`, `papers_get_figure`, `papers_manage`, `papers_annotations`, `papers_overview`, `papers_changes`, `papers_pdf`, `papers_translate`, `notes_search`, `notes_get`, `notes_edit`.

For an unimported PDF, `papers_pdf` supports `inspect`, `read`, `view` (caption-cropped figure/table), `ocr` and consent-gated `import`. The reader/tool path is based on poppler; image-only PDFs return a `no_text_layer` fallback with OCR availability and next steps.

## Development and verification

```sh
npm run build
npm run test:host
npm run test:notes
npm run test:ui
npm run test:bridge
npm run test:api
npm run test:i18n
npm run test:agent
npm run test:rich
npm run test:figures
npm run verify
```

- `test:host` is a dependency-free Host self-test using a temporary SQLite database.
- `test:notes` exercises the notes service.
- `test:ui` checks the UI control inventory and accessibility contract.
- `test:api` checks that every Client JSON API method has a Host handler.
- `test:i18n` checks literal UI translation keys against both dictionaries (reader fallback keys excluded).
- `test:agent` checks note-Agent section hashing, directive parsing and basic block normalization.
- `test:rich` checks the P0/P1 block schema, diagram validation and diagram directives.
- `test:figures` checks table side selection, crop grouping and full caption extraction.
- `test:bridge` checks the shared note-context bridge used by reader annotation/figure actions.
- Browser acceptance and the fixture-based API suite need a running DSH profile, poppler and the external devkit; see the repository's internal notes and `reports/`.
- An authenticated Web UI can be exercised with `PAPPERS_BASE=http://127.0.0.1:<port> PAPPERS_TOKEN=<printed-token> node scripts/browser-shot.mjs --steps library,reader,drawer,dock,notes,figures,settings`. Use a disposable data directory for destructive checks.

## Known limitations

- This is a developer-preview plugin; DSH APIs may change.
- OCR and semantic embeddings are optional and degrade explicitly when unavailable.
- Unimported figure/table views are caption-guided crops; pass `crop:false` to read the full page.
- The Agent may update paper metadata and folders but never tags.
- Automatic figure crops from ingest can be imperfect for unusual layouts.

## License and community

MIT — see [LICENSE](LICENSE). Changelog: [CHANGELOG.md](CHANGELOG.md). Contributing and security: [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md).

For GitHub discovery, add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to the public repository. There is no official plugin store review process; publishing means a normal npm/GitHub-tarball bundle installation. DeepSeek Harness is a developer preview; pin a tested DSH version when deploying.

Claiming to be an official DeepSeek plugin is not permitted; this is a community plugin.
