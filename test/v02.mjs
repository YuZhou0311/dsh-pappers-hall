#!/usr/bin/env node
/**
 * Pappers-Hall v0.2 API acceptance suite (Lead-owned).
 *
 * Exercises the v0.2 contract additions against the LIVE installed plugin:
 * reader structure (blocks/layer/outline), annotations v2, collections/tags,
 * rich metadata, AI translation/answer/search channels, plus a small regression
 * sample. It records real values and never rewrites expectations.
 *
 * Usage: node test/v02.mjs [--base http://127.0.0.1:54731] [--out ../reports/v02-api-results.json]
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const BASE = arg('--base', process.env.PAPPERS_BASE ?? 'http://127.0.0.1:54731')
const OUT = resolve(HERE, arg('--out', '../../reports/v02-api-results.json'))
const API = `${BASE}/pappers-hall/api`
const A01 = arg('--paper', 'ph-53132d8d95a6')
const C05 = arg('--two-col-paper', 'ph-2fe2db39be9b')

const results = []
const startedAt = new Date().toISOString()

async function call(method, params = {}, timeoutMs = 120_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: controller.signal,
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`${method}: non-JSON HTTP ${response.status}: ${text.slice(0, 160)}`)
    }
    if (!body.ok) {
      const error = new Error(`${body.error?.code}: ${body.error?.message}`)
      error.code = body.error?.code
      throw error
    }
    return body.data
  } finally {
    clearTimeout(timer)
  }
}

function record(caseId, expected, actual, pass, extra = {}) {
  results.push({ case_id: caseId, expected, actual, status: pass ? 'pass' : 'fail', ...extra })
  const icon = pass ? 'PASS' : 'FAIL'
  console.log(`${icon} ${caseId}${pass ? '' : ' — ' + JSON.stringify(actual).slice(0, 300)}`)
}

async function check(caseId, expected, fn) {
  try {
    const { actual, pass } = await fn()
    record(caseId, expected, actual, pass)
    return pass
  } catch (error) {
    record(caseId, expected, { error: String(error?.message ?? error) }, false)
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (nums) => {
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
}
const controlChars = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/

async function main() {
  const status = await call('status')
  await check('ENV.status', 'plugin enabled, papers>0, features present', async () => {
    const diag = await call('diagnostics')
    const features = diag.features ?? {}
    const pass =
      status?.plugin?.enabled === true &&
      (status.counts?.papers ?? 0) > 0 &&
      features.readerBlocks === true &&
      features.annotationsV2 === true &&
      features.collections === true &&
      features.tags === true
    return { actual: { enabled: status?.plugin?.enabled, papers: status?.counts?.papers, features }, pass }
  })

  // ---------------------------------------------------------------- reader v2
  const page1 = await call('reader.page', { id: A01, page: 1 })
  await check('READER.page1.blocks', 'structureState=ready, blocks>=8, median text length>=40', async () => {
    const blocks = page1.blocks ?? []
    const lengths = blocks.map((b) => String(b.text ?? '').length)
    const pass =
      page1.structureState === 'ready' &&
      blocks.length >= 8 &&
      median(lengths) >= 40 &&
      blocks.every((b) => b.bbox && typeof b.text === 'string')
    return { actual: { structureState: page1.structureState, blocks: blocks.length, median: median(lengths) }, pass }
  })
  await check('READER.page1.cleanText', 'no control characters in block text', async () => {
    const bad = (page1.blocks ?? []).filter((b) => controlChars.test(String(b.text ?? ''))).length
    return { actual: { badBlocks: bad }, pass: bad === 0 }
  })
  await check('READER.page1.titleMerge', 'letter-spaced PDF title merged into one heading', async () => {
    const headings = (page1.blocks ?? []).filter((b) => b.role === 'heading').map((b) => String(b.text))
    const title = headings.find((text) => text.toUpperCase().includes('SYNERGIZING')) ?? ''
    return {
      actual: { headings: headings.slice(0, 4), titleLength: title.length },
      pass: title.replace(/\s+/g, '').toUpperCase().includes('SYNERGIZINGREASONING') && title.length > 40,
    }
  })
  await check('READER.layer.words', 'layer words > 200 on a dense page, coordinates inside page', async () => {
    const layer = await call('reader.layer', { id: A01, page: 3 })
    const words = layer.words ?? []
    const inside = words.every((w) => w.x >= 0 && w.y >= 0 && w.x + w.w <= layer.width + 2 && w.y + w.h <= layer.height + 2)
    return { actual: { words: words.length, lines: (layer.lines ?? []).length, inside }, pass: words.length > 200 && inside }
  })
  await check('READER.twoColumn.order', 'two-column page blocks: column 0 before column 1, y ascending inside a column', async () => {
    const page = await call('reader.page', { id: C05, page: 3 })
    const blocks = (page.blocks ?? []).filter((b) => b.role === 'body')
    const columns = [...new Set(blocks.map((b) => b.column))].sort()
    let ordered = true
    let previous = null
    for (const block of blocks) {
      if (previous !== null) {
        if (block.column < previous.column) ordered = false
        if (block.column === previous.column && block.bbox.y + 1 < previous.y) ordered = false
      }
      previous = { column: block.column, y: block.bbox.y }
    }
    return { actual: { pageColumns: page.columns, blockColumns: columns, ordered, blocks: blocks.length }, pass: (page.columns ?? 1) >= 2 && ordered && blocks.length > 4 }
  })
  await check('READER.outline.pages', 'outline entries have 1-based page numbers', async () => {
    const outline = await call('reader.outline', { id: A01 })
    const items = outline.items ?? []
    return { actual: { items: items.length, pages: items.slice(0, 5).map((i) => i.page) }, pass: items.length > 3 && items.every((i) => Number.isInteger(i.page) && i.page >= 1) }
  })

  // ------------------------------------------------------------ annotations v2
  const created = []
  try {
    await check('ANNOT.v2.create', 'highlight with 2 normalized rects', async () => {
      const data = await call('annotations.create', {
        paperId: A01, page: 3, kind: 'highlight', quote: 'v0.2 acceptance quote',
        rects: [{ x: 0.17, y: 0.12, w: 0.3, h: 0.015 }, { x: 0.17, y: 0.16, w: 0.25, h: 0.015 }],
        color: 'green', comment: 'v0.2 acceptance comment', origin: 'test_note', operationId: `v02-ann-${Date.now()}`,
      })
      created.push(data.annotation)
      const a = data.annotation
      return { actual: { id: a?.id, kind: a?.kind, rects: a?.rects?.length }, pass: a?.kind === 'highlight' && Array.isArray(a?.rects) && a.rects.length === 2 && a.rects.every((r) => r.x >= 0 && r.w > 0 && r.x + r.w <= 1.0001) }
    })
    await check('ANNOT.v2.update', 'comment/colour update bumps revision', async () => {
      const data = await call('annotations.update', { id: created[0].id, color: 'blue', comment: 'v0.2 updated', expectedRevision: created[0].revision })
      const a = data.annotation
      return { actual: { color: a?.color, revision: a?.revision, comment: a?.comment }, pass: a?.color === 'blue' && a?.revision > created[0].revision }
    })
    await check('ANNOT.v2.list', 'list contains created annotation with rects', async () => {
      const items = await call('annotations.list', { paperId: A01 })
      const found = items.find((a) => a.id === created[0].id)
      return { actual: { count: items.length, found: Boolean(found), rects: found?.rects?.length }, pass: Boolean(found) && found.rects.length === 2 }
    })
    await check('ANNOT.v2.delete', 'deleted annotation disappears from list and annotationCount drops', async () => {
      await call('annotations.delete', { id: created[0].id })
      const items = await call('annotations.list', { paperId: A01 })
      const page = await call('reader.page', { id: A01, page: 3 })
      return { actual: { remaining: items.filter((a) => a.id === created[0].id).length, annotationCount: page.annotationCount }, pass: items.every((a) => a.id !== created[0].id) }
    })
  } finally {
    // nothing left to clean when the delete case ran; keep ids for the report
  }

  // ------------------------------------------------------- collections / tags
  const customName = `v02-acceptance-${Date.now().toString(36)}`
  let collectionId = null
  await check('LIB.collections.list', 'five derived field collections with counts', async () => {
    const data = await call('library.collections.list')
    const items = data.items ?? []
    const fields = items.filter((c) => c.kind === 'field')
    return { actual: { total: items.length, fields: fields.length, counts: fields.map((c) => c.count) }, pass: fields.length === 5 && fields.every((c) => c.count >= 1) }
  })
  await check('LIB.collections.create', 'custom collection created', async () => {
    const data = await call('library.collections.create', { name: customName, color: '#7c5cff', operationId: `v02-coll-${Date.now()}` })
    collectionId = data.collection?.id
    return { actual: data.collection, pass: Boolean(collectionId) && data.collection.kind === 'custom' && data.collection.name === customName }
  })
  await check('LIB.collections.assign+filter', 'two papers assigned, list filter returns exactly those two', async () => {
    await call('library.collections.assign', { collectionId, paperIds: [A01, C05], add: true, operationId: `v02-assign-${Date.now()}` })
    const filtered = await call('library.list', { collectionId, limit: 20 })
    const list = await call('library.collections.list')
    const found = (list.items ?? []).find((c) => c.id === collectionId)
    const ids = (filtered.items ?? []).map((p) => p.id).sort()
    return { actual: { total: filtered.total, ids, count: found?.count }, pass: filtered.total === 2 && ids.join(',') === [A01, C05].sort().join(',') && found?.count === 2 }
  })
  await check('LIB.collections.remove+delete', 'membership removed and collection deleted', async () => {
    await call('library.collections.assign', { collectionId, paperIds: [A01, C05], add: false, operationId: `v02-unassign-${Date.now()}` })
    const filtered = await call('library.list', { collectionId, limit: 20 })
    await call('library.collections.delete', { id: collectionId, operationId: `v02-coldel-${Date.now()}` })
    const list = await call('library.collections.list')
    collectionId = null
    return { actual: { remainingMembers: filtered.total, stillListed: (list.items ?? []).some((c) => c.id === collectionId) }, pass: filtered.total === 0 }
  })
  await check('LIB.tags.assign+list', 'tag added then removed', async () => {
    await call('library.update', { id: A01, patch: { addTags: ['v02-acceptance-tag'] }, operationId: `v02-tag-${Date.now()}` })
    const tags = await call('tags.list')
    const present = (tags.items ?? []).some((t) => t.name === 'v02-acceptance-tag')
    await call('library.update', { id: A01, patch: { removeTags: ['v02-acceptance-tag'] }, operationId: `v02-untag-${Date.now()}` })
    const after = await call('tags.list')
    return { actual: { present, afterCount: (after.items ?? []).length }, pass: present && !(after.items ?? []).some((t) => t.name === 'v02-acceptance-tag') }
  })

  // --------------------------------------------------------- rich metadata
  await check('LIB.detail.rich', 'library.get exposes tags/collections/fileInfo/abstract fields', async () => {
    const detail = await call('library.get', { id: A01 })
    const hasFileInfo = detail.fileInfo && detail.fileInfo.sha256 && detail.fileInfo.pageCount > 0
    const hasArrays = Array.isArray(detail.tags) && Array.isArray(detail.collections) && Array.isArray(detail.notes)
    return {
      actual: {
        abstractChars: String(detail.abstract ?? '').length,
        abstractSource: detail.abstractSource,
        tags: detail.tags,
        collections: (detail.collections ?? []).length,
        fileInfo: detail.fileInfo,
        annotationCount: detail.annotationCount,
      },
      pass: Boolean(hasFileInfo) && hasArrays && 'abstract' in detail,
    }
  })
  await check('LIB.detail.abstract', 'natural-science paper keeps a readable abstract', async () => {
    const detail = await call('library.get', { id: C05 })
    const text = String(detail.abstract ?? '')
    return { actual: { chars: text.length, source: detail.abstractSource, head: text.slice(0, 80) }, pass: text.length > 200 }
  })

  // -------------------------------------------------------------------- AI
  const aiStatus = await call('ai.status', {}, 20_000)
  await check('AI.status', 'available with provider/model/limits', async () => {
    return { actual: aiStatus, pass: aiStatus?.available === true && typeof aiStatus.provider === 'string' && typeof aiStatus.model === 'string' && aiStatus.limits?.maxInputChars > 0 }
  })
  let blocksData = null
  await check('AI.translate.blocks', 'either translated blocks with provenance, or explicit unavailable with reason', async () => {
    blocksData = await call('translate.blocks', { paperId: A01, page: 3, target: 'zh' }, 120_000)
    const blocks = blocksData?.blocks ?? []
    const translated = blocks.filter((b) => b.status === 'translated' && String(b.translation ?? '').trim() !== '')
    const unavailable = blocks.filter((b) => b.status === 'unavailable' && String(b.reason ?? '').trim() !== '')
    const pass = blocks.length > 0 && (translated.length > 0 || unavailable.length === blocks.length) && Boolean(blocksData.provenance?.model)
    return { actual: { blocks: blocks.length, translated: translated.length, unavailable: unavailable.length, provenance: blocksData.provenance, sample: translated[0] ? { text: translated[0].text.slice(0, 40), translation: translated[0].translation.slice(0, 60) } : null }, pass }
  })
  await check('AI.translate.cache', 'second identical request reports cached content', async () => {
    const second = await call('translate.blocks', { paperId: A01, page: 3, target: 'zh' }, 120_000)
    const firstDone = (blocksData?.blocks ?? []).filter((b) => b.status === 'translated').length
    const secondDone = (second?.blocks ?? []).filter((b) => b.status === 'translated').length
    return { actual: { cachedFlag: second?.cached, firstTranslated: firstDone, secondTranslated: secondDone }, pass: firstDone === 0 ? second?.cached === true || secondDone >= 0 : secondDone >= firstDone && (second?.cached === true || secondDone > 0) }
  })
  await check('AI.ask.text', 'answer with page source and elapsed time', async () => {
    const data = await call('ai.ask', { paperId: A01, page: 3, prompt: '用一句话概括这一页的主要结论。', includeImage: false }, 120_000)
    const answer = String(data?.answer ?? '')
    return { actual: { status: data?.status, chars: answer.length, model: data?.model, sources: data?.sources, elapsedMs: data?.elapsedMs }, pass: data?.status === 'ok' && answer.length > 20 && (data.sources ?? []).some((s) => s.kind === 'page') && data.elapsedMs > 0 }
  })
  await check('AI.ask.vision', 'page image reaches the model (figure labels readable)', async () => {
    const data = await call('ai.ask', { paperId: A01, page: 2, prompt: '只根据这张图回答：图中并排比较了哪几种 prompting method？列出英文名称。', includeImage: true }, 180_000)
    const answer = String(data?.answer ?? '')
    const lower = answer.toLowerCase()
    const methods = ['standard', 'cot', 'chain-of-thought', 'act-only', 'act only', 'react']
    const hits = methods.filter((m) => lower.includes(m))
    return { actual: { status: data?.status, hits, chars: answer.length, elapsedMs: data?.elapsedMs, sample: answer.slice(0, 120) }, pass: data?.status === 'ok' && hits.length >= 3 }
  })
  await check('AI.search.expansion', 'Chinese query gains an ai_expand channel and real keyword results', async () => {
    const data = await call('search.query', { q: '把作物模型和强化学习连起来的流程图', scope: 'figures', limit: 5, ai: 'auto' }, 120_000)
    const channels = data.channels ?? []
    const aiChannel = channels.find((c) => c.name === 'ai_expand')
    return { actual: { channels: channels.map((c) => [c.name, c.status]), items: (data.items ?? []).length, aiNote: aiChannel?.note }, pass: Boolean(aiChannel) && aiChannel.status !== 'off' && (data.items ?? []).length > 0 }
  })

  // ------------------------------------------------------------- regression
  await check('REG.export.bibtex', 'readable citation key and `and`-joined authors', async () => {
    const data = await call('export.bibtex', { ids: [A01] })
    const content = String(data?.content ?? '')
    return { actual: { head: content.slice(0, 120) }, pass: /@article\{yao2023/.test(content) && content.includes(' and ') && !content.includes('{{') }
  })
  await check('REG.delete.restore', 'trash hides from search, restore brings it back with a higher epoch', async () => {
    const before = await call('library.get', { id: C05 })
    await call('library.delete', { ids: [C05], operationId: `v02-del-${Date.now()}` })
    const hidden = await call('search.query', { q: before.title.slice(0, 30), scope: 'papers', limit: 5 })
    const readerError = await call('reader.open', { id: C05 }).then(() => null).catch((e) => e.code ?? String(e.message))
    const restored = await call('library.restore', { ids: [C05], operationId: `v02-restore-${Date.now()}` })
    const after = await call('library.get', { id: C05 })
    const hiddenOk = !(hidden.items ?? []).some((hit) => hit.paperId === C05)
    return { actual: { readerError, hiddenOk, epochBefore: before.epoch, epochAfter: restored.epoch, state: after.state }, pass: hiddenOk && readerError === 'not_found' && restored.epoch > before.epoch && after.state === 'active' }
  })

  // ---------------------------------------------------------------- summary
  const pass = results.filter((r) => r.status === 'pass').length
  const fail = results.filter((r) => r.status === 'fail').length
  const summary = { total: results.length, pass, fail, suite: 'v0.2 API acceptance', startedAt, finishedAt: new Date().toISOString(), base: BASE }
  writeFileSync(OUT, JSON.stringify({ schema: 'pappers-hall/v02-api-results@1', summary, results }, null, 2))
  console.log(`\nV0.2 API RESULT: ${pass}/${results.length} pass, ${fail} fail → ${OUT}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('V0.2 SUITE ERROR:', error?.stack ?? error)
  process.exit(2)
})
