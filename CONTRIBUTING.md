# Contributing

Pappers-Hall is a DSH bundle. Keep the Host and Client halves independently loadable and preserve the plugin lifecycle.

## Development

```sh
npm ci
npm run build
npm run test:host
npm run test:notes
```

`test:host` uses only Node built-ins and a temporary SQLite database. `test:notes` exercises the notes service. Browser acceptance and the fixture-based API suite require a running DSH Desktop profile, poppler, and the local devkit; see `docs/CONTRACT.md` and `reports/`.

## Contract rules

- Register every Host resource inside `ctx.effect`/`ctx.on` and return its cleanup.
- Register Client slots inside `ctx.effect`; never patch DSH's native UI directly.
- Never write tags on behalf of the user.
- Do not import or modify a user's PDF without explicit consent.
- Keep the plugin-owned data directory under `$DSH_HOME/pappers-hall/`.
- Update `CHANGELOG.md` for user-visible changes.

## Pull requests

Run `npm run build`, `npm run test:host`, `npm run test:notes`, and `npm run test:ui` before opening a PR. Include the DSH version, Node version, platform, and any intentionally unverified browser path.
