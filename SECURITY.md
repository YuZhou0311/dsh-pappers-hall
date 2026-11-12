# Security

Pappers-Hall stores its own SQLite database and paper files under `$DSH_HOME/pappers-hall/`. It does not upload papers or notes by itself. AI answers and translations are sent only through the translation/AI services configured in the DSH profile, and only when the user invokes them.

## Reporting

Do not open a public issue containing private papers, notes, tokens, or local paths. Report suspected vulnerabilities privately to the maintainers of the repository where you obtained this plugin.

## Local PDF preview cache

Rendered page previews live under `$DSH_HOME/pappers-hall/tmp/pdf-previews/`; they are capped, age-limited, and removable in Settings → Index & data.
