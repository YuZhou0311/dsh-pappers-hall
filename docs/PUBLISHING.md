# Publishing Pappers-Hall

This is a community DSH bundle, not an official DeepSeek plugin. DSH has no official plugin store with editorial review; distribution is a normal npm package or GitHub/tarball install, and discovery uses the GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin).

## Official requirements checked

- A **bundle** is an npm package whose `package.json` declares `dsh.bundle.patch`; the patch inserts plugin rows.
- `engines.dsh` declares the supported DSH SemVer range. DSH is a developer preview and may introduce breaking changes.
- A Client plugin declares `dsh.client`; its bundle exports `./client` and runtime locale/icon resources.
- Display metadata comes from `locale/{en,zh}.json` `meta.title` / `meta.description`; the optional detail document uses one image and is declared by `meta.detail`.
- `files` must include every runtime file, patch, locale, icon, detail document and image.
- Publish a prebuilt bundle (or provide a `prepare` script for git installs). Our `prepack` rebuilds `client.js`.
- GitHub: add the `dsh-plugin` topic, a README, LICENSE, security/contribution notes, and a reproducible install smoke test.

Primary sources:

- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/package-manifest/README.md>
- <https://github.com/topics/dsh-plugin>

## Preflight

```sh
npm ci
npm run build
npm run test:ui
npm run test:api
npm run test:host
npm run test:notes
npm run verify
```

`npm run verify` validates the public manifest, locale metadata, icon size, detail files, patch contents, built Client bundle and the exact `npm pack` file list. It writes `reports/release-check.{json,md}`.

## Before the first publish

1. Create the public GitHub repository `YuZhou0311/dsh-pappers-hall` and push `main` plus tag `v0.24.2`. `repository`, `homepage`, and `bugs` are already set.
2. Confirm `dsh.engines` still matches the tested DSH release. Current tested range: `>=0.2.2-rc.2 <0.3.0`.
3. Bump `version` and `CHANGELOG.md`; keep the package version and lockfile in sync.
4. Run the browser acceptance checklist in `reports/` against a disposable data directory. Do not test destructive actions against a real library.
5. Pack and inspect the tarball:
   ```sh
   npm pack
   tar -tzf dsh-pappers-hall-0.24.2.tgz | sort
   ```
6. Install the tarball into a disposable profile:
   ```sh
   dsh plugin --profile pappers-smoke add ./dsh-pappers-hall-0.24.2.tgz
   dsh --profile pappers-smoke --dump-config
   ```
   Verify the bundle row, title/description/icon/detail, a new conversation, the paper center, and uninstall cleanup.
7. Push and publish:
   ```sh
   git push -u origin main
   git push origin v0.24.2
   npm publish --access public
   ```
8. Create a GitHub release with the tarball, add the `dsh-plugin` topic, and link the DSH compatibility range in the release notes.

## Do not claim

- Official DeepSeek endorsement.
- Full support for DSH versions outside the declared engine range.
- That OCR/embedding/translation works when the optional services are absent.
- That every browser button was exercised if the signed-cookie browser harness was unavailable; report the limitation instead.
