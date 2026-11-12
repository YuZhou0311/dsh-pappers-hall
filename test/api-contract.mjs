#!/usr/bin/env node
/** Verify every Client JSON API method has a Host handler. */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'client', 'src')
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.js') || full.endsWith('.jsx')) out.push(full)
  }
  return out
}
const used = new Set()
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\b(?:defaultApi|api)\(['"]([a-z][a-z0-9_.]+)['"]/g)) used.add(match[1])
}
const api = readFileSync(path.join(ROOT, 'host', 'api.js'), 'utf8')
const declared = new Set([...api.matchAll(/\['([a-z][a-z0-9_.]+)',\s*\(/g)].map((match) => match[1]))
const missing = [...used].filter((method) => !declared.has(method)).sort()
const unused = [...declared].filter((method) => !used.has(method)).sort()
const report = {
  generatedAt: new Date().toISOString(),
  clientMethods: [...used].sort(),
  hostHandlers: [...declared].sort(),
  missingHostHandlers: missing,
  hostHandlersWithoutDirectClientCall: unused,
}
mkdirSync(path.join(ROOT, 'reports'), { recursive: true })
writeFileSync(path.join(ROOT, 'reports', 'api-contract.json'), JSON.stringify(report, null, 2))
writeFileSync(path.join(ROOT, 'reports', 'api-contract.md'), [
  '# Client/API contract', '', `Client methods: **${report.clientMethods.length}**`, `Host handlers: **${report.hostHandlers.length}**`, '',
  '## Missing Host handlers', '', ...(missing.length ? missing.map((m) => `- ${m}`) : ['None.']), '',
  '## Host handlers without a direct Client call', '', ...(unused.length ? unused.map((m) => `- ${m}`) : ['None.']),
].join('\n') + '\n')
console.log(`PASS — ${used.size} client methods, ${declared.size} host handlers, ${missing.length} missing`)
if (missing.length) { for (const method of missing) console.log('  missing', method); process.exit(1) }
