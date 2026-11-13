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

## Repository presentation

- Keep the About description bilingual and identify Pappers-Hall as a **research workbench** and a **pre-release community plugin**.
- Keep `dsh-plugin` and `deepseek-harness` in Topics. Add relevant paper, PDF, note-taking and research topics within GitHub's 20-topic limit.
- Use the [Releases list](https://github.com/YuZhou0311/dsh-pappers-hall/releases) as the download entry point; `/releases/latest` does not reliably lead visitors to preview builds.
- Use [the GitHub social-preview upload image](assets/social/github-social-preview.jpg), an opaque 2:1 JPEG under 1 MB. The generated PNG master stays in the [press kit](press-kit/README.md).
- Repository discovery and public social sharing require a public repository. Review the contents, commit history, Actions logs and release assets before changing visibility; publishing a pre-release does not itself make a private repository public.
- Use Issues for reproducible problems and feature requests, and Discussions for questions and workflows. Bilingual forms are in `.github/ISSUE_TEMPLATE/`.
- `CITATION.cff` supplies the **Cite this repository** entry. Users should specify the version they actually used.
- `.github/release.yml` groups generated release notes by `enhancement`, `bug` and `documentation`, then includes other changes. It formats notes; it does not publish builds automatically.

## Preview release procedure

1. Confirm `engines.dsh` matches the tested host. The declared range is `>=0.2.2-rc.2 <0.3.0`; the verified host is `0.2.2-rc.2`.
2. Update `version`, the lockfile and `CHANGELOG.md` together. Run the preflight above and the relevant browser acceptance checks against a disposable data directory.
3. Build and inspect the package, then generate its checksum:

   ```sh
   release_version="$(node -p "require('./package.json').version")"
   npm pack
   tar -tzf "dsh-pappers-hall-${release_version}.tgz" | sort
   shasum -a 256 "dsh-pappers-hall-${release_version}.tgz" > "dsh-pappers-hall-${release_version}.tgz.sha256"
   ```

4. Install that exact tarball in a disposable profile and verify startup, the library, reader, notes, references and uninstall cleanup:

   ```sh
   dsh plugin --profile pappers-smoke add "./dsh-pappers-hall-${release_version}.tgz"
   dsh --profile pappers-smoke --dump-config
   ```

5. Commit the release changes, tag that tested commit, and push the commit and tag. Never move an existing release tag to different code.
6. Draft a GitHub release for that tag, attach the `.tgz` and `.sha256`, and include both Chinese and English notes: a short product introduction, actual changes in this build, the install command, host requirements and known limitations. Generated PR summaries can help, but direct commits also need a manual summary.
7. Select **Pre-release** throughout the preview period. Check that attachment names, version numbers and checksums match before publishing. Keep a stable-release label separate from development previews.
8. Update README installation examples only to packages that are actually available. Campaign screenshots may follow the development branch; say so when they show features newer than the downloadable package.

GitHub tarball distribution does not publish to npm. If npm distribution is introduced later, use an explicit preview dist-tag such as `next`, and announce the new installation channel separately.

GitHub references: [social preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview), [topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics), [release-note categories](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes).

## Do not claim

- Official DeepSeek endorsement.
- Full support for DSH versions outside the declared engine range.
- That OCR/embedding/translation works when the optional services are absent.
- That every browser button was exercised if the signed-cookie browser harness was unavailable; report the limitation instead.
