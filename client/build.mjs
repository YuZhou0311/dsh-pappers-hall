#!/usr/bin/env node
/**
 * Build the Pappers-Hall Web Client half.
 *
 * Produces the single lazy-CJS browser artifact the DSH module loader expects:
 * `client.js` registers one factory under `window.__ModuleLoader__`. Sources live
 * in `client/src/**` (JSX) and are bundled here; the plugin ships only the built
 * artifact, so the DSH runtime needs no bundler and no npm dependency.
 *
 * The React runtime and its automatic JSX runtime come from the Host's frozen
 * module table (`require('react')` / `require('react/jsx-runtime')`), exactly
 * like the shipped DSH client bundles. Any other external import fails the build.
 *
 * Usage: node client/build.mjs [--watch]
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const root = new URL('./', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('../package.json', root), 'utf8'))
const allowed = new Set(['react', 'react/jsx-runtime'])
const outfile = '../client.js'


/**
 * Keep the injected stylesheet in sync with the canonical `styles.css`.
 *
 * `styles.js` embeds the CSS as a template literal so the client bundle needs no
 * separate CSS asset. Designers should only edit `styles.css`; this step
 * regenerates the embedded string before every build (idempotent, preserves the
 * rest of the module). Without this step it is easy to edit CSS and see no
 * change because the runtime only reads `styles.js`.
 */
async function syncStyles() {
  const css = await readFile(new URL('./src/core/styles.css', root), 'utf8')
  const jsPath = new URL('./src/core/styles.js', root)
  const js = await readFile(jsPath, 'utf8')
  const escaped = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  const next = js.replace(/const STYLES = `[\s\S]*?`\n/, 'const STYLES = `' + escaped + '`\n')
  if (next === js) return
  await writeFile(jsPath, next, 'utf8')
  console.log('synced src/core/styles.js ← src/core/styles.css')
}

await syncStyles()
await mkdir(new URL('./dist/', root), { recursive: true })

/** Bundle one artifact from the current sources. */
async function runBuild(watch = false) {
  const options = {
    absWorkingDir: fileURLToPath(root),
    entryPoints: ['src/index.jsx'],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    external: [...allowed],
    banner: {
      js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
    },
    footer: { js: 'return module.exports;}});' },
    metafile: true,
  }
  if (watch) {
    const ctx = await context(options)
    await ctx.watch()
    console.log(`watching ${options.entryPoints[0]} → ${outfile}`)
    return
  }
  const result = await build(options)
  for (const output of Object.values(result.metafile.outputs)) {
    for (const edge of output.imports) {
      if (!edge.external || !allowed.has(edge.path)) throw new Error(`Unexpected client dependency: ${edge.path}`)
    }
  }
  const bytes = (await stat(new URL(outfile, root))).size
  console.log(`built ${manifest.name}/client → ${outfile} (${bytes} bytes)`)
}

await runBuild(process.argv.includes('--watch'))
