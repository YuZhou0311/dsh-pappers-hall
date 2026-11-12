#!/usr/bin/env node
/**
 * Static UI control contract.
 *
 * Every interactive control authored by the Client must:
 * - have a handler (onClick/onChange),
 * - expose an accessible name (title/aria-label or visible text),
 * - for Toggle/Check, carry a label prop.
 *
 * The script also writes a complete inventory so browser acceptance can claim
 * which controls were reviewed. It is intentionally dependency-free.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'client', 'src')
const REPORT_DIR = path.join(ROOT, 'reports')
mkdirSync(REPORT_DIR, { recursive: true })

function filesUnder(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else if (entry.name.endsWith('.jsx') || entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

/** Find the matching `}` for a `{` at `open` (quotes/templates handled). */
function matchBrace(text, open) {
  let depth = 0
  let quote = ''
  let template = false
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    const prev = text[i - 1]
    if (quote) {
      if (ch === quote && prev !== '\\') quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (template && ch === '`' && prev !== '\\') { template = false; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

const patterns = [
  { kind: 'Button', re: /h\(Button,\s*\{/g, needs: ['onClick'] },
  { kind: 'IconButton', re: /h\(IconButton,\s*\{/g, needs: ['onClick'] },
  { kind: 'Toggle', re: /h\(Toggle,\s*\{/g, needs: ['onChange', 'label'] },
  { kind: 'Check', re: /h\(Check,\s*\{/g, needs: ['onChange'] },
  { kind: 'raw-button', re: /h\('button',\s*\{/g, needs: ['onClick'] },
  { kind: 'raw-button', re: /React\.createElement\(\s*'button'\s*,\s*\{/g, needs: ['onClick'] },
]
const controls = []
const violations = []
for (const file of filesUnder(SRC)) {
  const text = readFileSync(file, 'utf8')
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0
    for (const match of text.matchAll(pattern.re)) {
      const open = text.indexOf('{', match.index)
      const close = matchBrace(text, open)
      if (close < 0) continue
      const props = text.slice(open + 1, close)
      const after = text.slice(close + 1, close + 420)
      const line = text.slice(0, match.index).split('\n').length
      const title = /(?:title|'aria-label'|"aria-label")\s*:\s*([^,\n}]+)/.exec(props)
      const label = /\blabel\s*:\s*([^,\n}]+)/.exec(props)
      const hasText = /\bt\(|\bprops\.[A-Za-z]|\b[a-zA-Z.]*label\b|['"][^'"]{2,}['"]/.test(after.slice(0, 320))
      const needs = pattern.needs || []
      const missing = needs.filter((key) => !(new RegExp(`\\b${key}\\s*:`).test(props) || new RegExp(`\\b${key}\\s*,`).test(props)))
      if (!title && !label && !hasText && pattern.kind !== 'IconButton' && pattern.kind !== 'Check') missing.push('accessible name')
      if (pattern.kind === 'IconButton' && !title) missing.push('title')
      const entry = {
        file: path.relative(ROOT, file),
        line,
        kind: pattern.kind,
        label: (title?.[1] || label?.[1] || after.match(/t\('([^']+)'/)?.[1] || '').trim().slice(0, 120),
        hasHandler: needs.every((key) => !missing.includes(key)),
        source: props.replace(/\s+/g, ' ').slice(0, 220),
      }
      controls.push(entry)
      if (missing.length > 0) violations.push({ ...entry, missing })
    }
  }
}

const byKind = Object.fromEntries([...new Set(controls.map((entry) => entry.kind))].map((kind) => [kind, controls.filter((entry) => entry.kind === kind).length]))
const report = {
  generatedAt: new Date().toISOString(),
  sourceFiles: filesUnder(SRC).length,
  controls: controls.length,
  byKind,
  violations,
  inventory: controls,
}
writeFileSync(path.join(REPORT_DIR, 'ui-inventory.json'), JSON.stringify(report, null, 2))
const md = [
  '# UI control inventory',
  '',
  `Generated: ${report.generatedAt}`,
  '',
  `Controls: **${controls.length}**`,
  '',
  ...Object.entries(byKind).map(([kind, count]) => `- ${kind}: ${count}`),
  '',
  '## Violations',
  '',
  ...(violations.length === 0 ? ['None.'] : violations.map((entry) => `- ${entry.file}:${entry.line} ${entry.kind} ${entry.label || '(no label)'} — missing ${entry.missing.join(', ')}`)),
  '',
  '## Full inventory',
  '',
  '| File | Line | Kind | Label |',
  '| --- | ---: | --- | --- |',
  ...controls.map((entry) => `| ${entry.file} | ${entry.line} | ${entry.kind} | ${(entry.label || '').replace(/\|/g, '\\|')} |`),
]
writeFileSync(path.join(REPORT_DIR, 'ui-inventory.md'), md.join('\n') + '\n')
console.log(`${violations.length === 0 ? 'PASS' : 'FAIL'} — ${controls.length} interactive controls, ${violations.length} violations`)
for (const entry of violations.slice(0, 30)) console.log(`  ${entry.file}:${entry.line} ${entry.kind} ${entry.label} missing ${entry.missing.join(', ')}`)
process.exit(violations.length === 0 ? 0 : 1)
