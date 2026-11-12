#!/usr/bin/env node
/**
 * Standalone test for the v0.17 notes workbench backend (`host/notes.js`).
 *
 * Runs without DSH: mounts `applyHost` against a throw-away temp data directory
 * with two synthetic paper rows, then exercises the real HTTP-facing API facade
 * (`service.api.call('notes.*')`). The user's live library is never opened.
 *
 * Coverage: schema v8 migration + tables, CRUD, optimistic conflict, revision
 * snapshots/restore, folders (tree/rename/move/delete-up), soft delete/restore/
 * purge, FTS + LIKE search (Chinese/English, folder/paper filters), content_json
 * semantic-text indexing, the independent note_embeddings vector index (driven by
 * a deterministic stub embedder), paper↔note two-way queries, export, undo,
 * operationId idempotency, and legacy `notes.create {text}` compatibility.
 *
 * Run with `node test/notes.mjs`; exits 0 and prints PASS on success.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { applyHost } from '../host/apply.js'
import { closeDatabase, migrate, openDatabase, probeFts5 } from '../host/db.js'
import { buildNoteIndexText, contentJsonPlainText } from '../host/notes.js'

/** Collected assertions. */
const checks = []
/** Captured host warnings (expected degradations). */
const warnings = []

/** Assert one condition. */
function check(name, condition, detail) {
  if (!condition) throw new Error(`FAILED: ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  checks.push(name)
}

/** Capture one expected error (or null when the call unexpectedly succeeded). */
async function expectError(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

/**
 * Minimal fake Cordis context, sufficient for `applyHost`.
 * Mirrors the shape used by host/selftest.mjs without the HTTP asset routes.
 */
function createFakeContext() {
  const state = { topDisposers: [], tools: new Map(), intervals: new Set(), routes: new Map(), fibers: [], promptSections: new Map(), disposed: false }
  const track = (disposer, owned) => {
    owned.push(disposer)
    return disposer
  }
  const makeContext = (services, owned) => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (...args) => warnings.push(args.map((value) => String(value)).join(' ')),
      error: (...args) => warnings.push(args.map((value) => String(value)).join(' ')),
    }
    const context = {
      logger,
      tools: {
        register(definition) {
          if (state.tools.has(definition.name)) throw new Error(`tool ${definition.name} already registered`)
          state.tools.set(definition.name, definition)
          return () => state.tools.delete(definition.name)
        },
      },
      timer: {
        interval(callback, milliseconds) {
          const entry = { callback, milliseconds }
          state.intervals.add(entry)
          return () => state.intervals.delete(entry)
        },
      },
      get(name) {
        return services[name]
      },
      effect(execute) {
        const result = execute()
        if (typeof result === 'function') {
          track(result, owned)
          state.topDisposers.push(result)
          return { then: (resolve) => resolve(result) }
        }
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          const promise = Promise.resolve(result).then((disposer) => {
            track(disposer, owned)
            state.topDisposers.push(disposer)
            return disposer
          })
          return { then: (resolve, reject) => promise.then(resolve, reject) }
        }
        throw new TypeError('fake ctx.effect: body must return a disposer or a promise of one')
      },
      inject(dependencies, callback) {
        const available = dependencies.every((name) => services[name] !== undefined)
        const fiberOwned = []
        const fiber = {
          disposed: false,
          then(onFulfilled) {
            return Promise.resolve(typeof onFulfilled === 'function' ? onFulfilled(fiber) : fiber)
          },
          async dispose() {
            if (fiber.disposed) return
            fiber.disposed = true
            for (const disposer of fiberOwned.reverse()) await disposer()
          },
        }
        state.fibers.push(fiber)
        if (available) {
          const child = makeContext({ ...services }, fiberOwned)
          child.webServer = services.webServer
          callback(child)
        }
        return fiber
      },
    }
    return context
  }
  const systemPrompt = {
    section(section) {
      if (state.promptSections.has(section.name)) throw new Error(`prompt section ${section.name} already registered`)
      state.promptSections.set(section.name, section)
      return () => state.promptSections.delete(section.name)
    },
    getSectionOrder() {
      return 900
    },
  }
  const attachments = {
    async saveImage() {
      return { attachmentId: `sha256:${'0'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
    },
  }
  const webServer = {
    register(route) {
      if (state.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      state.routes.set(route.path, route)
      return () => state.routes.delete(route.path)
    },
  }
  const services = { tools: undefined, timer: undefined, attachments, systemPrompt, webServer }
  const ctx = makeContext(services, [])
  services.tools = ctx.tools
  services.timer = ctx.timer
  ctx.tools = ctx.tools
  ctx.timer = ctx.timer
  async function disposeAll() {
    if (state.disposed) return
    state.disposed = true
    for (const disposer of [...state.topDisposers].reverse()) {
      try {
        await disposer()
      } catch {}
    }
    for (const fiber of state.fibers) {
      try {
        await fiber.dispose()
      } catch {}
    }
  }
  return { ctx, state, disposeAll }
}

/** Deterministic token-hash embedding stub (no model download, no network). */
function createStubEmbedding({ configured = true, available = true, model = 'stub-embedding', dims = 24 } = {}) {
  const encode = (text) => {
    const vector = new Float32Array(dims)
    const tokens = String(text ?? '')
      .toLowerCase()
      .match(/[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]{1,2}/g) ?? []
    for (const token of tokens) {
      let hash = 0
      for (const char of token) hash = (hash * 31 + char.codePointAt(0)) >>> 0
      vector[hash % dims] += 1
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm)
    if (norm > 0) for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
    return Array.from(vector)
  }
  return {
    facts: () => ({ configured, available: configured && available, model, dims, lastError: available ? null : 'stub embedding unavailable' }),
    async embedTexts(texts) {
      if (!configured || !available) throw new Error('stub embedding is not available')
      return { vectors: texts.map((text) => encode(text)), model, dims, latencyMs: 0 }
    },
  }
}

/** POST one JSON API call through the real registered HTTP route handler. */
async function callHttp(handler, { method = 'POST', url = '/pappers-hall/api', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json' }
  const response = { status: 0, headers: {}, chunks: [], writeHead(status, headers) { this.status = status; this.headers = headers }, end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.from(chunk)); this.resolve?.() } }
  const done = new Promise((resolve) => {
    response.resolve = resolve
  })
  await handler(req, response)
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))])
  return { status: response.status, body: JSON.parse(Buffer.concat(response.chunks).toString('utf8')) }
}

/** Main test. */
async function main() {
  const started = Date.now()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pappers-hall-notes-test-'))
  const fake = createFakeContext()
  let service
  try {
    service = await applyHost(fake.ctx, {
      dataDir,
      translationForcedFailures: ['tencent', 'google', 'mymemory', 'libretranslate', 'llm'],
      embeddingPython: '/nonexistent/pappers-hall/embedding/venv/bin/python',
      ocrDir: '/nonexistent/pappers-hall/ocr',
      ocrPython: '/nonexistent/pappers-hall/ocr/venv/bin/python',
    })
    const api = service.api
    const db = service.domain.db

    // ---- schema v8 ---------------------------------------------------
    check('schemaVersion is 8', Number(db.prepare('PRAGMA user_version').get()?.user_version) === 8)
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
    for (const table of ['note_docs', 'note_folders', 'note_paper_links', 'note_revisions', 'note_embeddings', 'note_fts', 'notes']) {
      check(`table ${table} exists`, tables.has(table))
    }
    check('legacy notes_fts kept for paper quick notes', tables.has('notes_fts'))
    check('notes tools registered (6)', ['notes_list', 'notes_get', 'notes_create', 'notes_update', 'notes_search', 'notes_link_papers'].every((name) => fake.state.tools.has(name)))

    // ---- synthetic papers (never the live library) -------------------
    const now = new Date().toISOString()
    for (const [id, title, titleZh, year, venue] of [
      ['ph-aaaaaaaaaaaa', 'Quantum Photosynthesis in Crops', '作物量子光合作用', 2023, 'Nature Plants'],
      ['ph-bbbbbbbbbbbb', 'Reinforcement Learning for Control', '强化学习控制', 2022, 'ICML'],
    ]) {
      db.prepare(
        'INSERT INTO papers(id, title, title_zh, authors_json, year, venue, state, epoch, read, processing_json, metadata_diff_json, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)',
      ).run(id, title, titleZh, '[]', year, venue, 'active', '{"state":"ready"}', '[]', now, now)
    }
    const PAPER_A = 'ph-aaaaaaaaaaaa'
    const PAPER_B = 'ph-bbbbbbbbbbbb'

    // ---- semantic plain-text extraction ------------------------------
    const cardJson = {
      type: 'callout',
      attrs: { icon: 'sparkles', color: 'red' },
      style: { padding: '8px' },
      sections: [
        { id: 's1', type: 'heading', text: '## 核心结论' },
        { id: 's2', type: 'paragraph', text: '**量子产率** 在胁迫下仍保持稳定，详见 [原文](https://example.org)。' },
        { id: 's3', type: 'table', rows: [['指标', '数值'], ['量子产率', '0.85']] },
        { id: 's4', type: 'bullets', items: ['分点一：叶片温度', '分点二：气孔导度'] },
      ],
    }
    const plain = contentJsonPlainText(cardJson)
    check('contentJson plain text keeps headings/cells/bullets', ['核心结论', '量子产率', '0.85', '分点一：叶片温度', '分点二：气孔导度'].every((part) => plain.includes(part)), plain)
    check('contentJson plain text strips UI markers', !plain.includes('callout') && !plain.includes('sparkles') && !plain.includes('##') && !plain.includes('**') && !plain.includes('padding'), plain)
    const indexText = buildNoteIndexText({ title: '卡片笔记', content_md: '## 原始记录\n\n用户原文在这里。', contentJson: cardJson })
    check('index text contains raw content_md', indexText.includes('用户原文在这里。') && indexText.includes('## 原始记录'))
    check('index text contains semantic content_json text', indexText.includes('核心结论') && indexText.includes('0.85'))

    // ---- folders -----------------------------------------------------
    const root = await api.call('notes.folders.create', { name: '论文阅读', color: '#335577', operationId: 'test-folder-root' })
    const child = await api.call('notes.folders.create', { name: '方法章节', parentId: root.folder.id })
    check('folder ids use nf- prefix', root.folder.id.startsWith('nf-') && child.folder.id.startsWith('nf-'))
    const tree = await api.call('notes.folders.tree')
    const treeRoot = tree.folders.find((folder) => folder.id === root.folder.id)
    check('folder tree nests children', treeRoot?.children?.some((folder) => folder.id === child.folder.id) === true, tree.folders)
    const renamed = await api.call('notes.folders.rename', { id: child.folder.id, name: '方法/实验', color: '#884422' })
    check('folder rename updates name and color', renamed.folder.name === '方法/实验' && renamed.folder.color === '#884422')

    // ---- create + read ----------------------------------------------
    const created = await api.call('notes.create', {
      title: '量子光合作用精读',
      content: '## 用户原始笔记\n\n量子产率与气孔导度相关，需要二次核对 [12]。\n\n- 论点一\n- 论点二',
      folderId: child.folder.id,
      paperIds: [PAPER_A],
      operationId: 'test-note-create-1',
    })
    const noteId = created.note.id
    check('notes.create returns note- id', noteId.startsWith('note-'))
    check('notes.create keeps content_md verbatim', created.note.contentMd.includes('用户原始笔记') && created.note.contentMd.includes('[12]'))
    check('notes.create sets draft status and revision 0', created.note.status === 'draft' && created.note.revision === 0)
    check('notes.create returns paper summaries', created.note.paperLinks?.[0]?.paperId === PAPER_A && created.note.paperLinks[0].title === 'Quantum Photosynthesis in Crops')
    check('notes.create returns folder', created.note.folderId === child.folder.id && created.note.folder?.name === '方法/实验')
    const repeatCreate = await api.call('notes.create', {
      title: '重复不应创建',
      content: 'ignored',
      operationId: 'test-note-create-1',
    })
    check('notes.create operationId is idempotent', repeatCreate.note.id === noteId, repeatCreate.note.id)
    const fetched = await api.call('notes.get', { id: noteId })
    check('notes.get returns full content + folder + links + revisions', fetched.note.contentMd === created.note.contentMd && fetched.note.folder?.id === child.folder.id && fetched.note.paperIds.includes(PAPER_A) && Array.isArray(fetched.note.revisions))
    const listInChild = await api.call('notes.list', { folderId: child.folder.id })
    check('notes.list folder filter includes descendants', listInChild.total === 1 && listInChild.items[0].id === noteId, listInChild)
    const listInRoot = await api.call('notes.list', { folderId: root.folder.id })
    check('notes.list parent folder includes child notes', listInRoot.total === 1, listInRoot.total)
    const listByPaperA = await api.call('notes.list', { paperId: PAPER_A })
    check('paper→notes query works', listByPaperA.total === 1 && listByPaperA.items[0].id === noteId)
    const listByPaperB = await api.call('notes.list', { paperId: PAPER_B })
    check('paper→notes query excludes unrelated papers', listByPaperB.total === 0)
    const searchByTitle = await api.call('notes.list', { query: '精读' })
    check('notes.list query filters by title/index text', searchByTitle.total === 1)

    // ---- update + optimistic conflict --------------------------------
    const stale = await expectError(api.call('notes.update', { id: noteId, patch: { title: 'x' }, expectedRevision: 42 }))
    check('notes.update stale expectedRevision → conflict with currentRevision', stale?.code === 'conflict' && stale?.meta?.currentRevision === 0, stale?.code)
    const updated = await api.call('notes.update', {
      id: noteId,
      patch: { title: '量子光合作用精读（修订）', content: '## 用户原文（第二版）\n\n新增：气孔导度下降 20%。' },
      expectedRevision: 0,
    })
    check('notes.update writes content_md and bumps revision', updated.note.contentMd.includes('第二版') && updated.note.revision === 1)
    check('notes.update single field never touches content_json', updated.note.contentJson === null)

    // ---- AI beautify: content_json only ------------------------------
    const beautified = await api.call('notes.update', {
      id: noteId,
      patch: {
        contentJson: cardJson,
        beautifiedRevision: updated.note.revision,
        formatVersion: 1,
      },
      expectedRevision: updated.note.revision,
    })
    check('beautify keeps content_md untouched', beautified.note.contentMd === updated.note.contentMd)
    check('beautify stores content_json structure', beautified.note.contentJson?.sections?.length === 4 && beautified.note.beautifiedRevision === String(updated.note.revision))
    check('beautify bumps revision', beautified.note.revision === 2)
    const clearBeautify = await api.call('notes.update', { id: noteId, patch: { contentJson: null } })
    check('contentJson:null clears beautification without touching content_md', clearBeautify.note.contentJson === null && clearBeautify.note.contentMd === updated.note.contentMd)
    await api.call('notes.update', { id: noteId, patch: { contentJson: cardJson, beautifiedRevision: 2, formatVersion: 1 } })

    // ---- revisions + restoreRevision ---------------------------------
    const revisions = await api.call('notes.revisions', { id: noteId })
    check('revisions keep at least 3 snapshots (create + updates)', revisions.items.length >= 3, revisions.items.map((item) => item.revision))
    check('revision entries expose reason/size metadata', revisions.items.every((item) => typeof item.reason === 'string' && typeof item.contentMdLength === 'number'))
    const restoreTarget = revisions.items[revisions.items.length - 1].revision
    const restored = await api.call('notes.restoreRevision', { id: noteId, revision: restoreTarget })
    check('restoreRevision restores old content_md and increments revision', restored.note.contentMd.includes('用户原始笔记') && restored.note.revision > beautified.note.revision)
    check('restoreRevision result reports the source revision', restored.restoredRevision === restoreTarget)
    // Re-apply the beautified layout after restoring the oldest revision, then
    // churn content to prove the revision ring buffer stays bounded.
    await api.call('notes.update', { id: noteId, patch: { contentJson: cardJson, beautifiedRevision: restored.note.revision, formatVersion: 1 } })
    const revisionLimit = 60
    for (let index = 0; index < revisionLimit; index += 1) {
      await api.call('notes.update', { id: noteId, patch: { content: `第 ${index} 版内容：气孔导度保持稳定` } })
    }
    const bounded = await api.call('notes.revisions', { id: noteId, limit: 50 })
    check('revisions are bounded (≤50)', bounded.items.length <= 50, bounded.items.length)

    // ---- FTS/LIKE search --------------------------------------------
    const cjkSearch = await api.call('notes.search', { q: '气孔导度' })
    check('notes.search finds Chinese substrings (LIKE channel)', cjkSearch.items.some((item) => item.noteId === noteId) && cjkSearch.channels.like > 0, cjkSearch.channels)
    const snippet = cjkSearch.items[0]?.snippet ?? ''
    check('notes.search returns a highlighted snippet', snippet.includes('[气孔导度]') || snippet.includes('气孔导度'), snippet)
    const jsonSearch = await api.call('notes.search', { q: '核心结论' })
    check('notes.search indexes content_json semantic text', jsonSearch.items.some((item) => item.noteId === noteId), jsonSearch.items)
    const folderSearch = await api.call('notes.search', { q: '气孔导度', folderId: root.folder.id })
    check('notes.search folder filter (subtree) works', folderSearch.items.some((item) => item.noteId === noteId))
    const paperSearch = await api.call('notes.search', { q: '气孔导度', paperId: PAPER_A })
    check('notes.search paper filter works', paperSearch.items.every((item) => item.paperIds.includes(PAPER_A)))
    const unrelatedSearch = await api.call('notes.search', { q: '气孔导度', paperId: PAPER_B })
    check('notes.search paper filter excludes other papers', unrelatedSearch.items.length === 0)
    const emptySearch = await api.call('notes.search', { q: '' })
    check('notes.search empty query returns empty channels', emptySearch.items.length === 0 && emptySearch.total === 0)

    // ---- independent vector index (stub embedder) --------------------
    const noEmbeddingSync = await api.call('notes.indexSync')
    check('indexSync honestly reports unavailable without the embedding component', noEmbeddingSync.status === 'unavailable' && typeof noEmbeddingSync.reason === 'string', noEmbeddingSync)
    const stub = createStubEmbedding()
    service.notes.attach({ embedding: stub })
    const secondNote = await api.call('notes.create', {
      title: 'Semantic retrieval note',
      content: 'Quantum yield of photosynthesis reaches 0.85 under stress.\n\nThis is the user original paragraph.',
      paperIds: [PAPER_B],
    })
    const sync = await api.call('notes.indexSync')
    check('notes.indexSync queues when embedding is available', sync.status === 'queued' && sync.queued >= 1, sync)
    const syncDone = await service.notes.syncIndexNow()
    check('note_embeddings are populated by syncIndexNow', syncDone.status === 'ok' && syncDone.changed > 0, syncDone)
    const embeddingRows = db.prepare('SELECT note_id, chunk_index, text, model FROM note_embeddings').all()
    check('note_embeddings stored per note chunk', embeddingRows.length > 0 && embeddingRows.every((row) => row.model === 'stub-embedding'))
    const secondIndexed = embeddingRows.filter((row) => row.note_id === secondNote.note.id)
    check('textual note is chunked into embeddings', secondIndexed.length >= 1 && secondIndexed[0].text.includes('Quantum yield'))
    const indexStatus = await api.call('notes.indexStatus')
    check('notes.indexStatus reports fts + vector facts', indexStatus.fts.available === true && indexStatus.fts.indexedNotes >= 1 && indexStatus.vector.available === true && indexStatus.vector.indexedChunks > 0, indexStatus)
    const semantic = await api.call('notes.search', { q: 'photosynthesis quantum yield' })
    const semanticHit = semantic.items.find((item) => item.noteId === secondNote.note.id)
    check('vector channel participates in notes.search', semantic.channels.vector >= 1 && semanticHit?.channels?.includes('vector') === true, { channels: semantic.channels, hit: semanticHit })
    const notIndexedClean = embeddingRows.every((row) => !row.text.includes('callout') && !row.text.includes('sparkles'))
    check('embedding index text excludes UI layout markers', notIndexedClean)
    // Incremental refresh after an edit.
    await api.call('notes.update', { id: secondNote.note.id, patch: { content: 'Yield response of photosynthesis is nonlinear.' } })
    await service.notes.syncIndexNow()
    const refreshed = db.prepare('SELECT text FROM note_embeddings WHERE note_id = ?').all(secondNote.note.id).map((row) => row.text).join('\n')
    check('incremental sync refreshes changed note embeddings', refreshed.includes('Yield response') && !refreshed.includes('reaches 0.85'), refreshed)

    // ---- paper links -------------------------------------------------
    const linked = await api.call('notes.link', { noteId: noteId, paperIds: [PAPER_B], anchor: { page: 4 } })
    check('notes.link adds paper with anchor', linked.note.paperIds.includes(PAPER_B) && linked.note.paperLinks.find((link) => link.paperId === PAPER_B)?.anchor?.page === 4)
    const unlinkResult = await api.call('notes.unlink', { noteId: noteId, paperIds: [PAPER_B] })
    check('notes.unlink removes only the requested paper', !unlinkResult.note.paperIds.includes(PAPER_B) && unlinkResult.note.paperIds.includes(PAPER_A))
    const notesOfPaperB = await api.call('notes.list', { paperId: PAPER_B })
    check('paper→notes excludes unlinked note', notesOfPaperB.items.every((item) => item.id !== noteId), notesOfPaperB.items.map((item) => item.id))

    // ---- folder assign/unassign --------------------------------------
    const assign = await api.call('notes.folders.assign', { folderId: root.folder.id, noteIds: [noteId] })
    check('notes.folders.assign moves notes', assign.assigned === 1 && (await api.call('notes.get', { id: noteId })).note.folderId === root.folder.id)
    const undoAssign = await api.call('operations.undo', { operationId: assign.operationId })
    check('folder assign is undoable', undoAssign.status === 'undone' && (await api.call('notes.get', { id: noteId })).note.folderId === child.folder.id, undoAssign.status)
    await api.call('notes.folders.assign', { folderId: root.folder.id, noteIds: [noteId] })
    const unassign = await api.call('notes.folders.unassign', { noteIds: [noteId] })
    check('notes.folders.unassign unfiles notes', unassign.unassigned === 1 && (await api.call('notes.get', { id: noteId })).note.folderId === null)
    const undoUnassign = await api.call('operations.undo', { operationId: unassign.operationId })
    check('folder unassign is undoable', undoUnassign.status === 'undone' && (await api.call('notes.get', { id: noteId })).note.folderId === root.folder.id, undoUnassign.status)

    // ---- export ------------------------------------------------------
    const exported = await api.call('notes.export', { ids: [noteId], format: 'both' })
    check('notes.export returns md + json payloads', exported.items?.[0]?.content?.includes('气孔导度保持稳定') === true && exported.items[0].jsonContent.includes('contentMd') && typeof exported.json === 'string', exported.items?.[0]?.filename)
    const exportedJson = JSON.parse(exported.json)
    check('notes.export json carries content_md and content_json', exportedJson.notes[0].contentMd.includes('内容') && exportedJson.notes[0].contentJson !== null)

    // ---- soft delete / restore / purge -------------------------------
    const trashed = await api.call('notes.delete', { ids: [noteId], operationId: 'test-note-trash' })
    check('notes.delete soft-deletes', trashed.deleted.includes(noteId) && trashed.trashed === true)
    const trashList = await api.call('notes.list', {})
    check('notes.list excludes trashed notes', trashList.items.every((item) => item.id !== noteId))
    const trashState = await api.call('notes.list', { includeTrash: true })
    check('notes.list includeTrash shows trashed notes', trashState.items.some((item) => item.id === noteId && item.state === 'trash'))
    const trashGet = await api.call('notes.get', { id: noteId })
    check('notes.get still returns a trashed note for recovery', trashGet.note.state === 'trash' && typeof trashGet.note.deletedAt === 'string')
    const trashSearch = await api.call('notes.search', { q: '气孔导度' })
    check('notes.search excludes trashed notes', trashSearch.items.every((item) => item.noteId !== noteId))
    const restoredTrash = await api.call('notes.restore', { ids: [noteId] })
    check('notes.restore revives the note', restoredTrash.restored.includes(noteId) && (await api.call('notes.get', { id: noteId })).note.state === 'active')
    const purgeActive = await expectError(api.call('notes.purge', { ids: [noteId] }))
    check('notes.purge refuses active notes without force', purgeActive?.code === 'invalid', purgeActive?.code)
    await api.call('notes.delete', { ids: [noteId] })
    const purged = await api.call('notes.purge', { ids: [noteId], operationId: 'test-note-purge' })
    check('notes.purge permanently deletes', purged.purged === 1)
    check('purge removes revisions/links/embeddings/fts rows', db.prepare('SELECT COUNT(*) AS count FROM note_revisions WHERE note_id = ?').get(noteId).count === 0 &&
      db.prepare('SELECT COUNT(*) AS count FROM note_paper_links WHERE note_id = ?').get(noteId).count === 0 &&
      db.prepare('SELECT COUNT(*) AS count FROM note_embeddings WHERE note_id = ?').get(noteId).count === 0 &&
      db.prepare('SELECT COUNT(*) AS count FROM note_fts WHERE note_id = ?').get(noteId).count === 0)
    const purgeUndo = await api.call('operations.undo', { operationId: purged.operationId })
    check('operations.undo refuses to resurrect purged notes', purgeUndo.status === 'not_undoable')
    const gone = await expectError(api.call('notes.get', { id: noteId }))
    check('purged note is not_found', gone?.code === 'not_found')

    // ---- folders delete keeps notes --------------------------------
    const folderNote = await api.call('notes.create', { title: '夹内笔记', content: '文件夹删除测试', folderId: child.folder.id })
    const deletedFolder = await api.call('notes.folders.delete', { id: child.folder.id, operationId: 'test-folder-delete' })
    check('folder delete moves notes up instead of deleting', deletedFolder.movedNotes === 1 && (await api.call('notes.get', { id: folderNote.note.id })).note.folderId === root.folder.id, deletedFolder)
    const folderUndo = await api.call('operations.undo', { operationId: deletedFolder.operationId })
    check('folder delete is undoable', folderUndo.status === 'undone' && (await api.call('notes.get', { id: folderNote.note.id })).note.folderId === child.folder.id, folderUndo.status)

    // ---- operations.undo for content + folders ----------------------
    const undoUpdate = await api.call('notes.update', { id: folderNote.note.id, patch: { title: '改过的标题' } })
    check('content update returns a journal operationId', typeof undoUpdate.operationId === 'string' && undoUpdate.operationId.startsWith('op-'))
    const undone = await api.call('operations.undo', { operationId: undoUpdate.operationId })
    check('undo restores the previous title', undone.status === 'undone' && (await api.call('notes.get', { id: folderNote.note.id })).note.title === '夹内笔记', undone.status)
    const undoCreate = await api.call('notes.create', { title: '可撤销新建', content: 'undo create' })
    const createUndo = await api.call('operations.undo', { operationId: undoCreate.operationId })
    check('creating a note is undoable (moves to trash)', createUndo.status === 'undone' && (await api.call('notes.get', { id: undoCreate.note.id })).note.state === 'trash')
    const undoTrash = await api.call('notes.delete', { ids: [folderNote.note.id] })
    const undoTrashResult = await api.call('operations.undo', { operationId: undoTrash.operationId })
    check('trashing a note is undoable', undoTrashResult.status === 'undone' && (await api.call('notes.get', { id: folderNote.note.id })).note.state === 'active')

    // ---- legacy paper-note compatibility ----------------------------
    const emptyLegacy = await expectError(api.call('notes.create', { text: '' }))
    check('legacy notes.create {text:\'\'} stays invalid', emptyLegacy?.code === 'invalid', emptyLegacy?.code)
    const legacy = await api.call('notes.create', { paperId: PAPER_A, text: 'legacy interleaves thought and action', origin: 'user_note', title: '旧笔记' })
    check('legacy notes.create {text} still creates nt- row', legacy.note.id.startsWith('nt-'), legacy.note.id)
    const workbenchList = await api.call('notes.list', {})
    check('workbench list never shows legacy paper notes', workbenchList.items.every((item) => item.id.startsWith('note-')))
    const legacyDeleted = await api.call('notes.delete', { id: legacy.note.id })
    check('legacy notes.delete {id} still soft-deletes', legacyDeleted.state === 'trash')
    const legacySearch = await api.call('search.query', { q: 'interleaves thought', scope: 'notes' })
    check('legacy search.query notes channel stays functional', Array.isArray(legacySearch.items))

    // ---- status counts ----------------------------------------------
    const status = await api.call('status')
    check('status reports workbench counts separately', typeof status.counts.noteDocs === 'number' && typeof status.counts.noteTrash === 'number' && typeof status.counts.noteFolders === 'number', status.counts)
    check('test data directory is temporary', dataDir.startsWith(tmpdir()) && !service.dbPath.includes('.dsh'), service.dbPath)

    // ---- wire method registration / envelope -------------------------
    const methods = new Set(service.api.methods)
    const expectedNoteMethods = [
      'notes.list',
      'notes.get',
      'notes.create',
      'notes.update',
      'notes.delete',
      'notes.restore',
      'notes.purge',
      'notes.revisions',
      'notes.restoreRevision',
      'notes.folders.tree',
      'notes.folders.create',
      'notes.folders.rename',
      'notes.folders.delete',
      'notes.folders.assign',
      'notes.folders.unassign',
      'notes.link',
      'notes.unlink',
      'notes.search',
      'notes.export',
      'notes.indexSync',
      'notes.indexStatus',
    ]
    check('all 21 notes.* wire methods are registered', expectedNoteMethods.every((method) => methods.has(method)), expectedNoteMethods.filter((method) => !methods.has(method)))
    const listEnvelope = await service.api.envelope('notes.list', {})
    check('notes.list returns the ok envelope', listEnvelope.ok === true && Array.isArray(listEnvelope.data.items), listEnvelope.ok)
    const unknownEnvelope = await service.api.envelope('notes.doesNotExist', {})
    check('unknown notes method returns an invalid envelope', unknownEnvelope.ok === false && unknownEnvelope.error.code === 'invalid', unknownEnvelope.error)
    check('HTTP route /pappers-hall is registered', fake.state.routes.has('/pappers-hall'))
    const httpList = await callHttp(fake.state.routes.get('/pappers-hall').handler, { body: JSON.stringify({ method: 'notes.list', params: {} }) })
    check('notes.list is reachable over the real HTTP route', httpList.status === 200 && httpList.body.ok === true && Array.isArray(httpList.body.data.items), { status: httpList.status, ok: httpList.body.ok })
    const httpConflict = await callHttp(fake.state.routes.get('/pappers-hall').handler, {
      body: JSON.stringify({ method: 'notes.create', params: { title: 'HTTP note', content: 'http channel' } }),
    })
    check('notes.create over HTTP returns ok envelope', httpConflict.status === 200 && httpConflict.body.ok === true && httpConflict.body.data.note.id.startsWith('note-'), httpConflict.body.error)

    // ---- v7 → v8 upgrade keeps legacy data (backward compatibility) ----
    // Simulate an existing v0.16 library: build a v8 database, keep a legacy
    // paper + `nt-` quick note, drop the workbench tables and reset
    // `PRAGMA user_version` to 7. The upgrade must add the new tables without
    // touching or rewriting legacy rows.
    const legacyDir = await mkdtemp(path.join(tmpdir(), 'pappers-hall-notes-migrate-'))
    try {
      const legacyPath = path.join(legacyDir, 'pappers-hall.db')
      let legacyDb = openDatabase(legacyPath)
      const legacyFts = probeFts5(legacyDb)
      const firstMigration = migrate(legacyDb, { fts5: legacyFts })
      check('fresh database migrates to v8', firstMigration.version === 8 && Number(legacyDb.prepare('PRAGMA user_version').get()?.user_version) === 8)
      const stamp = new Date().toISOString()
      legacyDb
        .prepare(
          'INSERT INTO papers(id, title, authors_json, state, epoch, read, processing_json, metadata_diff_json, added_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)',
        )
        .run('ph-cccccccccccc', 'Legacy Paper', '[]', 'active', '{"state":"ready"}', '[]', stamp, stamp)
      legacyDb
        .prepare(
          'INSERT INTO notes(id, paper_id, title, text, origin, source_refs_json, state, epoch, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)',
        )
        .run('nt-cccccccccccc', 'ph-cccccccccccc', 'Legacy note', 'legacy text survives', 'user_note', '[]', 'active', stamp, stamp)
      for (const table of ['note_fts', 'note_embeddings', 'note_revisions', 'note_paper_links', 'note_folders', 'note_docs']) {
        legacyDb.exec(`DROP TABLE IF EXISTS ${table}`)
      }
      legacyDb.exec('PRAGMA user_version = 7')
      closeDatabase(legacyDb)
      legacyDb = openDatabase(legacyPath)
      const upgraded = migrate(legacyDb, { fts5: legacyFts })
      const upgradedTables = new Set(legacyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
      check('v7 → v8 migration rewrote user_version=8', upgraded.version === 8 && Number(legacyDb.prepare('PRAGMA user_version').get()?.user_version) === 8)
      check('v7 → v8 migration recreates the workbench tables', ['note_docs', 'note_folders', 'note_paper_links', 'note_revisions', 'note_embeddings', 'note_fts'].every((table) => upgradedTables.has(table)), [...upgradedTables].filter((name) => name.startsWith('note')))
      check('v7 → v8 migration keeps legacy rows untouched', legacyDb.prepare('SELECT COUNT(*) AS count FROM notes WHERE id = ?').get('nt-cccccccccccc').count === 1 &&
        legacyDb.prepare('SELECT text FROM notes WHERE id = ?').get('nt-cccccccccccc').text === 'legacy text survives' &&
        legacyDb.prepare('SELECT COUNT(*) AS count FROM papers WHERE id = ?').get('ph-cccccccccccc').count === 1)
      check('v7 → v8 migration starts with empty workbench', legacyDb.prepare('SELECT COUNT(*) AS count FROM note_docs').get().count === 0)
      closeDatabase(legacyDb)
    } finally {
      await rm(legacyDir, { recursive: true, force: true }).catch(() => {})
    }

    // ---- dispose -----------------------------------------------------
    await service.dispose()
    check('dispose stops the notes index timer', fake.state.intervals.size === 0)
    check('dispose clears tool registrations', fake.state.tools.size === 0)
    check('dispose clears the notes HTTP route', fake.state.routes.size === 0)
    await fake.disposeAll()

    if (warnings.length > 0) checks.push(`note: captured ${warnings.length} expected degradation warning(s)`)
    const elapsed = Date.now() - started
    console.log(`\nPASS — ${checks.filter((entry) => !entry.startsWith('note:')).length} checks, ${elapsed}ms\n`)
    for (const entry of checks) console.log(`  ✓ ${entry}`)
  } finally {
    if (service !== undefined && service.active) await service.dispose().catch(() => {})
    await fake.disposeAll().catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\nFAIL —', error?.message ?? error)
  if (error?.stack !== undefined) console.error(error.stack)
  process.exitCode = 1
})
