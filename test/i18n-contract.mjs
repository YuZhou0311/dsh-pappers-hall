#!/usr/bin/env node
/** Verify literal translation keys used by the Client exist in both locales. */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'client', 'src')
function walk(dir) { const out=[]; for (const e of readdirSync(dir,{withFileTypes:true})) { const f=path.join(dir,e.name); if(e.isDirectory()) out.push(...walk(f)); else if(/\.(jsx?|mjs)$/.test(e.name)) out.push(f) } return out }
const keys=new Set()
for(const file of walk(SRC)){ const text=readFileSync(file,'utf8'); for(const m of text.matchAll(/\b(?:t|rt)\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g)) { const key=m[1]; if (key.endsWith('.')) continue; keys.add(key) } }
const locales={}
for(const lang of ['en','zh']){ const text=readFileSync(path.join(SRC,'i18n',lang+'.js'),'utf8'); locales[lang]=Object.fromEntries([...text.matchAll(/^\s*"([^"]+)"\s*:/gm)].map(m=>[m[1],true])) }
const missing={}
for(const lang of ['en','zh']) missing[lang]=[...keys].filter(k=>!(k in locales[lang]) && !k.startsWith('reader.')).sort()
mkdirSync(path.join(ROOT,'reports'),{recursive:true})
writeFileSync(path.join(ROOT,'reports','i18n-contract.json'),JSON.stringify({keys:[...keys].sort(),missing},null,2))
console.log(`keys=${keys.size} en_missing=${missing.en.length} zh_missing=${missing.zh.length}`)
for(const lang of ['en','zh']) for(const k of missing[lang].slice(0,40)) console.log(`  ${lang} missing ${k}`)
process.exit(missing.en.length || missing.zh.length ? 1 : 0)
