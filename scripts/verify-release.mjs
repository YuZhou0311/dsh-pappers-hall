#!/usr/bin/env node
/**
 * Release preflight for the dsh-pappers-hall bundle.
 *
 * Checks the public manifest, display resources, bundle patch, build artifacts,
 * and the exact npm pack file list against the official DSH bundle rules.
 * It does not publish, tag, push, or modify the profile.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPORT = path.join(ROOT, 'reports')
mkdirSync(REPORT, { recursive: true })
const failures = []
const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) failures.push({ name, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function readJson(file) { return JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) }
function exists(file) { return existsSync(path.join(ROOT, file)) }

const pkg = readJson('package.json')
check('package name', pkg.name === 'dsh-pappers-hall', pkg.name)
check('public version', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(pkg.version)), pkg.version)
check('not private', pkg.private !== true, String(pkg.private))
check('MIT license declared', pkg.license === 'MIT', pkg.license)
check('ES module entry', pkg.type === 'module' && exists(pkg.main ?? ''), pkg.main)
check('dsh bundle patch declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh client manifest declared', pkg.dsh?.client?.platform === 'web')
check('dsh manifest version', Number(pkg.dsh?.manifestVersion) === 1, String(pkg.dsh?.manifestVersion))
check('DSH engine range declared', typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.length > 0, pkg.engines?.dsh)
check('Node engine declared', typeof pkg.engines?.node === 'string', pkg.engines?.node)
check('publish access public', pkg.publishConfig?.access === 'public', pkg.publishConfig?.access)
check('files list present', Array.isArray(pkg.files) && pkg.files.length > 0, String(pkg.files?.length ?? 0))
check('bundle patch exists', exists('cordis.patch.yml'))
check('Host entry exists', exists('index.js'))
check('Client bundle exists', exists('client.js'))
const patch = exists('cordis.patch.yml') ? readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8') : ''
check('patch inserts pappers-hall row', /pappers-hall/.test(patch) && /dsh-pappers-hall/.test(patch))
const client = exists('client.js') ? readFileSync(path.join(ROOT, 'client.js'), 'utf8') : ''
check('client bundle is a DSH module', client.includes('__ModuleLoader__') && client.length > 100000, `${Math.round(client.length / 1024)} KiB`)
for (const locale of ['locale/en.json', 'locale/zh.json']) {
  const data = exists(locale) ? readJson(locale) : {}
  check(`${locale} title`, typeof data.meta?.title === 'string' && data.meta.title.length > 0)
  check(`${locale} description`, typeof data.meta?.description === 'string' && data.meta.description.length > 20)
  check(`${locale} detail declared`, typeof data.meta?.detail === 'string' && data.meta.detail.endsWith('.md'), data.meta?.detail)
  if (typeof data.meta?.detail === 'string') check(`${locale} detail exists`, exists(data.meta.detail))
}
check('detail preview exists', exists('docs/preview.svg'))
const iconStat = exists('icon.svg') ? statSync(path.join(ROOT, 'icon.svg')) : null
check('icon under 256 KiB', iconStat !== null && iconStat.size <= 256 * 1024, iconStat ? `${iconStat.size} bytes` : 'missing')

let packed = []
try {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  const parsed = JSON.parse(raw)
  packed = Array.isArray(parsed) ? parsed[0]?.files?.map((entry) => entry.path) ?? [] : []
} catch (error) {
  check('npm pack dry-run', false, String(error?.message ?? error))
}

if (packed.length > 0) {
  check('npm pack includes Host entry', packed.includes('index.js'))
  check('npm pack includes client bundle', packed.includes('client.js'))
  check('npm pack includes patch', packed.includes('cordis.patch.yml'))
  check('npm pack includes locale', packed.includes('locale/en.json') && packed.includes('locale/zh.json'))
  check('npm pack includes icon', packed.includes('icon.svg'))
  check('npm pack includes README/LICENSE', packed.includes('README.md') && packed.includes('LICENSE'))
  check('npm pack includes detail docs', packed.includes('docs/DETAIL.md') && packed.includes('docs/preview.svg'))
  check('npm pack excludes source/tests/reports', !packed.some((file) => /^(src\/|test\/|reports\/|node_modules\/)/.test(file)), packed.filter((file) => /^(src\/|test\/|reports\/)/.test(file)).join(', '))
}

const result = { generatedAt: new Date().toISOString(), package: `${pkg.name}@${pkg.version}`, checks, failures, packedCount: packed.length }
writeFileSync(path.join(REPORT, 'release-check.json'), JSON.stringify(result, null, 2))
writeFileSync(path.join(REPORT, 'release-check.md'), ['# Release preflight', '', `Package: ${result.package}`, `Generated: ${result.generatedAt}`, '', ...checks.map((entry) => `- ${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`), '', failures.length === 0 ? '**READY for pack/npm publish after the GitHub remote and tarball smoke test are verified.**' : `**BLOCKED: ${failures.length} failure(s).**`].join('\n') + '\n')
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${checks.length} release checks, ${packed.length} packed files`)
process.exit(failures.length === 0 ? 0 : 1)
