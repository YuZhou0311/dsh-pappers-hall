/**
 * Paper-library controller for the Zotero-style three-pane surface.
 *
 * One plain observable store owns the filters, selection, details pane and the
 * fetched data; React surfaces subscribe through `useSyncExternalStore`. Data
 * writes go through the Host API and refresh only what they touched.
 *
 * v0.2 APIs (`library.collections.*`, `tags.list`) are called optimistically and
 * degrade to derived values when the connected Host is still v0.1.
 */
import { LIBRARY_PAGE_SIZE, UI_PREF_KEY } from './constants.js'
import { undo } from './undo.js'

/** Smart views shown above the collections list. */
export const SMART_VIEWS = ['all', 'recentAdded', 'recentRead', 'unread', 'read', 'annotated', 'trash']

const DEFAULT_UI = { leftWidth: 232, rightWidth: 340, leftCollapsed: false, rightCollapsed: false }
const EMPTY_DETAILS = { paperId: null, status: 'idle', data: null, error: null, tab: 'info', annotations: [], figures: [], notes: [] }

function readPrefs() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(UI_PREF_KEY) : null
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePrefs(prefs) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(UI_PREF_KEY, JSON.stringify(prefs))
  } catch {
    /* preferences are best-effort only */
  }
}

function opId(prefix) {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  return (prefix ? prefix + '-' : '') + random
}

/** Sort param the Host understands for each sort option. */
const SORT_PARAMS = { recent: 'recent', added: 'added', title: 'title', year: 'year', authors: 'authors', citations: 'citations', impactFactor: 'impactFactor' }

/** Smart views mapped onto the Host `reading` filter. */
const READING_VIEWS = { toRead: 'to-read', reading: 'reading', read: 'read' }

/** Default sort implied by a smart view. */
function sortForView(view, current) {
  if (view === 'recentAdded') return 'added'
  if (view === 'recentRead') return 'recent'
  return current || 'recent'
}

/** Toggle one id inside a selection array. */
function toggleId(selection, id) {
  return selection.indexOf(id) >= 0 ? selection.filter((value) => value !== id) : selection.concat([id])
}

/** Read an array field safely. */
function listOf(value) {
  return Array.isArray(value) ? value : []
}

export function createLibraryController({ api }) {
  const prefs = readPrefs()
  let state = {
    status: 'idle',
    error: null,
    offline: false,
    filters: { view: 'all', collectionId: null, collectionKind: null, field: null, folderId: null, favorite: false, tags: [], query: '', sort: prefs.sort || 'recent', reading: null, mode: prefs.searchMode === 'semantic' ? 'semantic' : 'hybrid' },
    items: [],
    total: 0,
    semantic: { mode: 'hybrid', available: null, reason: '', model: null, tookMs: 0, pending: false },
    selection: [],
    anchorIndex: -1,
    details: EMPTY_DETAILS,
    viewMode: prefs.viewMode === 'grid' ? 'grid' : 'table',
    ui: {
      leftWidth: Number(prefs.leftWidth) || DEFAULT_UI.leftWidth,
      rightWidth: Number(prefs.rightWidth) || DEFAULT_UI.rightWidth,
      leftCollapsed: prefs.leftCollapsed === true,
      rightCollapsed: prefs.rightCollapsed === true,
    },
    mobileLeftOpen: false,
    collections: [],
    collectionsAvailable: true,
    tags: [],
    tagsAvailable: true,
    counts: {},
    statusData: null,
    loadingMore: false,
    contextMenu: null,
    duplicates: { status: 'idle', groups: [], error: null },
    folders: { status: 'idle', items: [], total: 0, error: null },
    revision: 0,
  }
  const listeners = new Set()
  let listSeq = 0
  let lastSideRetryAt = 0
  let detailSeq = 0

  function publish(patch) {
    state = Object.assign({}, state, patch, { revision: state.revision + 1 })
    listeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        console.error('[pappers-hall] library listener failed', error)
      }
    })
  }

  function persistUi() {
    writePrefs({
      leftWidth: state.ui.leftWidth,
      rightWidth: state.ui.rightWidth,
      leftCollapsed: state.ui.leftCollapsed,
      rightCollapsed: state.ui.rightCollapsed,
      viewMode: state.viewMode,
      sort: state.filters.sort,
      searchMode: state.filters.mode,
    })
  }

  /** Params for one `library.list` request derived from the filters. */
  function listParams(filters, offset) {
    const params = {
      state: filters.view === 'trash' ? 'trash' : 'active',
      sort: SORT_PARAMS[filters.sort] || 'recent',
      offset: offset || 0,
      limit: LIBRARY_PAGE_SIZE,
    }
    if (filters.query) params.query = filters.query
    if (filters.reading) params.reading = filters.reading
    if (filters.view === 'continueReading') { params.read = true; params.sort = 'recent' }
    if (filters.view === 'recentAnnotations') params.annotated = true
    if (filters.view === 'annotated') params.annotated = true
    if (filters.view === 'annotated') params.annotated = true
    if (filters.collectionId) params.collectionId = filters.collectionId
    if (filters.field) params.field = filters.field
    if (filters.folderId) params.folderId = filters.folderId
    if (filters.favorite) params.favorite = true
    if (filters.tags.length > 0) { if (filters.tags.length > 1) params.tags = filters.tags.slice(); else params.tag = filters.tags[0] }
    return params
  }

  /** Apply extra tag filters (AND) client-side so multi-select works on any Host. */
  function applyTagFilter(items, tags) {
    if (tags.length <= 1) return items
    return items.filter((paper) => {
      const own = listOf(paper.tags)
      return tags.every((tag) => own.indexOf(tag) >= 0)
    })
  }

  /** Derive field collections from loaded papers when the Host has no collections API. */
  function derivedCollections(items) {
    const buckets = new Map()
    items.forEach((paper) => {
      const field = paper.field || paper.fieldId
      if (!field) return
      buckets.set(field, (buckets.get(field) || 0) + 1)
    })
    return Array.from(buckets.entries()).map(([name, count]) => ({ id: 'field:' + name, name: name, color: 'slate', kind: 'field', count: count }))
  }

  /** Derive the tag list from loaded papers when the Host has no tags API. */
  function derivedTags(items) {
    const counts = new Map()
    items.forEach((paper) => {
      listOf(paper.tags).forEach((tag) => {
        counts.set(tag, (counts.get(tag) || 0) + 1)
      })
    })
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name: name, count: count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
  }

  function collectionsFrom(result, items) {
    if (result.status === 'fulfilled' && result.value && Array.isArray(result.value.items)) {
      return { collections: result.value.items, available: true }
    }
    return { collections: derivedCollections(items), available: false }
  }

  function tagsFrom(result, items) {
    if (result.status === 'fulfilled' && result.value && Array.isArray(result.value.items)) {
      return { tags: result.value.items, available: true }
    }
    return { tags: derivedTags(items), available: false }
  }

  /** Normalise `library.folders.tree` (v0.5) with a collections fallback. */
  function foldersFrom(result, collectionsResult, items) {
    if (result.status === 'fulfilled' && result.value && Array.isArray(result.value.items)) {
      return { status: 'ready', items: result.value.items, total: Number(result.value.total) || result.value.items.length, error: null }
    }
    const fallback = (collectionsResult.collections || []).filter((collection) => collection.kind !== 'field' || true).map((collection) => ({ id: collection.id, name: collection.name, color: collection.color, kind: collection.kind === 'field' ? 'field' : 'folder', count: collection.count || 0, children: [] }))
    return { status: fallback.length > 0 ? 'degraded' : 'error', items: fallback, total: fallback.length, error: result.reason || null }
  }

  async function refreshFolders() {
    try {
      const value = await api('library.folders.tree', {})
      publish({ folders: { status: 'ready', items: listOf(value && value.items), total: Number(value && value.total) || 0, error: null } })
    } catch (error) {
      const fallback = listOf(state.collections).map((collection) => ({ id: collection.id, name: collection.name, color: collection.color, kind: collection.kind === 'field' ? 'field' : 'folder', count: collection.count || 0, children: [] }))
      publish({ folders: { status: 'degraded', items: fallback, total: fallback.length, error: error } })
    }
  }

  async function createFolder(parentId, name, color) {
    const result = await api('library.collections.create', { ...(parentId ? { parentId: String(parentId) } : {}), name: String(name || '').trim(), color: color || 'blue', operationId: opId('folder') })
    undo.push({ label: '新建文件夹' })
    await refreshFolders()
    return result && result.folder ? result.folder : result
  }
  async function updateFolder(id, patch) {
    const result = await api('library.collections.update', Object.assign({ id: String(id), operationId: opId('folder') }, patch))
    undo.push({ label: '文件夹变更' })
    await refreshFolders()
    return result
  }
  async function deleteFolder(id) {
    const result = await api('library.collections.delete', { id: String(id), operationId: opId('folder') })
    undo.push({ label: '删除文件夹' })
    const filters = state.filters.folderId === id ? Object.assign({}, state.filters, { folderId: null }) : state.filters
    publish({ filters: filters })
    await refreshFolders()
    return result
  }
  async function assignFolder(folderId, paperIds, add) {
    const ids = listOf(paperIds).map(String).filter(Boolean)
    if (ids.length === 0) throw new Error('no papers')
    const result = await api('library.collections.assign', { collectionId: folderId ? String(folderId) : null, paperIds: ids, add: add !== false, operationId: opId('folder') })
    undo.push({ label: add === false ? '移出文件夹' : '加入文件夹' })
    await refreshFolders()
    if (state.details.paperId && ids.indexOf(String(state.details.paperId)) >= 0) await selectPaper(state.details.paperId, { tab: state.details.tab })
    return result
  }
  async function setFavorite(ids, favorite) {
    const list = listOf(ids).map(String).filter(Boolean)
    if (list.length === 0) return { results: [] }
    const result = await api('library.setFavorite', { ids: list, favorite: favorite !== false, operationId: opId('favorite') })
    undo.push({ label: favorite === false ? '取消收藏' : '收藏' })
    publish({ items: state.items.map((paper) => (list.indexOf(paper.id) >= 0 ? Object.assign({}, paper, { favorite: favorite !== false }) : paper)) })
    if (state.details.paperId && list.indexOf(String(state.details.paperId)) >= 0 && state.details.data) publish({ details: Object.assign({}, state.details, { data: Object.assign({}, state.details.data, { favorite: favorite !== false }) }) })
    if (state.filters.view === 'favorite' || state.filters.favorite) refresh()
    return result
  }
  function setFolderFilter(folderId) {
    const filters = Object.assign({}, state.filters, { folderId: folderId || null, view: folderId ? 'all' : state.filters.view, favorite: folderId ? false : state.filters.favorite })
    publish({ filters: filters, selection: [], details: EMPTY_DETAILS })
    refresh()
  }
  function setFavoriteFilter(favorite) {
    const filters = Object.assign({}, state.filters, { favorite: Boolean(favorite), folderId: favorite ? null : state.filters.folderId, view: favorite ? 'favorite' : 'all' })
    publish({ filters: filters, selection: [] })
    refresh()
  }

  /** Refresh the list, status, collections and tags together. */
  async function refresh() {
    const seq = ++listSeq
    if (state.status !== 'ready' || state.items.length === 0) publish({ status: 'loading', error: null })
    const params = listParams(state.filters, 0)
    const query = state.filters.query
    const semanticFilters = {}
    if (state.filters.folderId) semanticFilters.folderId = state.filters.folderId
    if (state.filters.tags && state.filters.tags.length > 0) semanticFilters.tags = state.filters.tags.slice()
    if (state.filters.favorite) semanticFilters.favorite = true
    if (state.filters.field) semanticFilters.field = state.filters.field
    const semanticMode = state.filters.mode === 'semantic'
    // Hybrid mode keeps keyword rows and appends strongly related neighbours;
    // semantic mode replaces the list with the embedding ranking (cosine scores).
    const semanticCall = !query || semanticMode
      ? Promise.resolve(null)
      : api('search.query', { q: query, scope: 'papers', limit: Math.max(LIBRARY_PAGE_SIZE, 30), ai: 'off', filters: semanticFilters }).then((value) => ({ kind: 'hybrid', value: value })).catch((error) => ({ kind: 'hybrid', error: error }))
    const semanticOnlyCall = query && semanticMode
      ? api('search.semantic', { q: query, limit: Math.max(LIBRARY_PAGE_SIZE, 30), filters: semanticFilters }).then((value) => ({ kind: 'semantic', value: value })).catch((error) => ({ kind: 'semantic', error: error }))
      : Promise.resolve(null)
    if (semanticMode && query) publish({ semantic: Object.assign({}, state.semantic, { mode: 'semantic', query, pending: true }) })
    const [listResult, statusResult, collectionsResult, tagsResult, semanticResult, semanticOnlyResult] = await Promise.allSettled([
      api('library.list', params),
      api('status', {}),
      api('library.folders.tree', {}),
      api('tags.list', {}),
      semanticCall,
      semanticOnlyCall,
    ])
    if (seq !== listSeq) return
    if (listResult.status === 'rejected') {
      const error = listResult.reason
      publish({ status: 'error', error: error, offline: Boolean(error && error.code === 'not_running') })
      return
    }
    let data = listResult.value || {}
    let items = applyTagFilter(listOf(data.items), state.filters.tags)
    // v0.5: a non-empty query is also answered by `search.query` (FTS + LIKE +
    // AI expansion + real vector channel). Merge its paper-level hits into the
    // table and hydrate full rows via library.tiles; keyword rows stay first.
    const hybridSettled = semanticResult.status === 'fulfilled' ? semanticResult.value : null
    const hybridPayload = hybridSettled !== null && hybridSettled !== undefined && hybridSettled.kind === 'hybrid' ? hybridSettled.value : null
    if (query && hybridPayload !== null && Array.isArray(hybridPayload.items)) {
      const semanticItems = hybridPayload.items
      const seen = new Set(items.map((paper) => paper.id))
      // v0.15: the vector channel legitimately returns up to 30 neighbours for
      // any query, but a table-wide semantic dump makes keyword search look
      // broken. Keep only strongly-related extras (or the semantic top hits when
      // keyword search found nothing), then hydrate those ids.
      const candidates = semanticItems
        .map((hit) => ({ id: hit.paperId || (hit.kind === 'paper' ? hit.id : null), hit: hit }))
        .filter((entry) => entry.id && !seen.has(entry.id))
      const topVector = candidates.reduce((max, entry) => Math.max(max, Number(entry.hit.vectorScore) || 0), 0)
      const strong = candidates.filter((entry) => {
        const vector = Number(entry.hit.vectorScore) || 0
        const reasons = Array.isArray(entry.hit.reasons) ? entry.hit.reasons : []
        const keywordHit = reasons.some((reason) => /phrase_match|or abstract match|title_match/.test(String(reason)))
        return keywordHit || vector >= 0.35 || (topVector > 0 && vector >= topVector * 0.8)
      })
      const fallback = items.length === 0 ? candidates.slice(0, 5) : []
      const order = (strong.length > 0 ? strong : fallback).slice(0, 8).map((entry) => entry.id)
      if (order.length > 0) {
        try {
          const tiles = await api('library.tiles', { ids: order })
          const hydrated = listOf(tiles && tiles.items).filter((paper) => paper && paper.id)
          const semanticPapers = hydrated.length > 0
            ? hydrated
            : order.map((id) => {
                const hit = semanticItems.find((entry) => (entry.paperId || entry.id) === id) || {}
                return { id: id, title: hit.title || id, titleZh: hit.titleZh || null, authors: [], tags: [], read: false, annotationCount: 0, figureCount: 0, readingProgress: 0 }
              })
          items = items.concat(applyTagFilter(semanticPapers, state.filters.tags))
          data = Object.assign({}, data, { total: Math.max(Number(data.total) || 0, items.length) })
        } catch {
          /* hydrate failure is non-fatal: keyword rows remain usable */
        }
      }
    }
    let semanticState = Object.assign({}, state.semantic, {
      mode: semanticMode ? 'semantic' : 'hybrid',
      query,
    })
    if (query && semanticMode) {
      const settled = semanticOnlyResult.status === 'fulfilled' ? semanticOnlyResult.value : null
      const payload = settled && settled.kind === 'semantic' ? settled.value : null
      const failure = settled && settled.error ? settled.error : null
      if (payload === null || payload === undefined) {
        semanticState = Object.assign(semanticState, {
          available: false,
          reason: failure && failure.message ? failure.message : 'semantic search request failed',
          tookMs: 0,
        })
      } else {
        semanticState = Object.assign(semanticState, {
          available: payload.available === true,
          reason: payload.reason || '',
          model: payload.model || null,
          tookMs: Number(payload.tookMs) || 0,
        })
        const hits = listOf(payload.items)
        if (payload.available === true && hits.length > 0) {
          const order = hits.map((hit) => hit.paperId || hit.id)
          let hydrated = []
          try {
            const tiles = await api('library.tiles', { ids: order })
            hydrated = listOf(tiles && tiles.items)
          } catch { hydrated = [] }
          const byId = new Map(hydrated.map((paper) => [paper.id, paper]))
          items = order.map((id) => {
            const paper = byId.get(id)
            if (paper === undefined) return null
            const hit = hits.find((entry) => (entry.paperId || entry.id) === id) || {}
            return Object.assign({}, paper, { similarity: Number(hit.similarity) || 0, snippet: hit.snippet || paper.snippet || '' })
          }).filter(Boolean)
          data = Object.assign({}, data, { total: Number(payload.total) || items.length })
        } else if (payload.available === true) {
          items = []
          data = Object.assign({}, data, { total: 0 })
        } else {
          items = []
          data = Object.assign({}, data, { total: 0 })
        }
      }
    }
    const collections = collectionsFrom(collectionsResult, items)
    const folders = foldersFrom(collectionsResult, collections, items)
    const tags = tagsFrom(tagsResult, items)
    const status = statusResult.status === 'fulfilled' ? statusResult.value : state.statusData
    publish({
      status: 'ready',
      error: null,
      offline: false,
      items: items,
      total: Number(data.total) || items.length,
      collections: collections.collections,
      collectionsAvailable: collections.available,
      folders: folders,
      tags: tags.tags,
      tagsAvailable: tags.available,
      statusData: status || null,
      counts: (status && status.counts) || state.counts,
      semantic: Object.assign({}, semanticState, { pending: false }),
    })
  }

  /** Refresh only the status strip (counts/jobs/channels), healing degraded side lists. */
  async function refreshStatus() {
    try {
      const status = await api('status', {})
      if (!status) return
      publish({ statusData: status, counts: status.counts || state.counts })
    } catch (error) {
      if (error && error.code === 'not_running') publish({ offline: true })
    }
    // Host-side collection/tag services may arrive or recover after the first
    // paint; retry at most every 20 s instead of hammering the API.
    if (!state.collectionsAvailable || !state.tagsAvailable) {
      const now = Date.now()
      if (now - lastSideRetryAt > 20000) {
        lastSideRetryAt = now
        if (!state.collectionsAvailable) refreshCollections()
        if (!state.tagsAvailable) refreshTagList()
      }
    }
  }

  /** Load more rows for the active filters. */
  async function loadMore() {
    if (state.loadingMore || state.items.length >= state.total) return
    publish({ loadingMore: true })
    try {
      const data = await api('library.list', listParams(state.filters, state.items.length))
      const more = applyTagFilter(listOf(data && data.items), state.filters.tags)
      const seen = new Set(state.items.map((paper) => paper.id))
      publish({
        items: state.items.concat(more.filter((paper) => !seen.has(paper.id))),
        total: Number(data && data.total) || state.total,
        loadingMore: false,
      })
    } catch (error) {
      publish({ loadingMore: false })
      throw error
    }
  }

  function setFilters(patch, options) {
    const opts = options || {}
    const filters = Object.assign({}, state.filters, patch)
    if (patch.mode === 'semantic' || patch.mode === 'hybrid') prefs.searchMode = patch.mode
    if (opts.resetSelection !== false) publish({ filters: filters, selection: [], anchorIndex: -1, details: EMPTY_DETAILS })
    else publish({ filters: filters })
    persistUi()
    return refresh()
  }

  function setView(view) {
    const allowed = ['all', 'favorite', 'continueReading', 'recentAdded', 'recentRead', 'recentAnnotations', 'toRead', 'reading', 'read', 'annotated', 'trash', 'duplicates']
    const next = allowed.indexOf(view) >= 0 ? view : 'all'
    if (next === 'duplicates') {
      const filters = { view: next, collectionId: null, collectionKind: null, field: null, tags: [], query: '', sort: state.filters.sort, reading: null, mode: state.filters.mode }
      publish({ filters: filters, selection: [], anchorIndex: -1, details: EMPTY_DETAILS })
      loadDuplicates()
      return
    }
    const filters = { view: next, collectionId: null, collectionKind: null, field: null, folderId: null, favorite: next === 'favorite', tags: [], query: state.filters.query, sort: sortForView(next, state.filters.sort), reading: READING_VIEWS[next] || null, mode: state.filters.mode }
    publish({ filters: filters, selection: [], anchorIndex: -1, details: EMPTY_DETAILS })
    refresh()
  }

  function setQuery(query) {
    if (query === state.filters.query) return Promise.resolve()
    return setFilters({ query: query })
  }

  /** Switch between keyword ("hybrid") and embedding ("semantic") library search. */
  function setSearchMode(mode) {
    const next = mode === 'semantic' ? 'semantic' : 'hybrid'
    if (state.filters.mode === next) return Promise.resolve()
    return setFilters({ mode: next })
  }

  function setSort(sort) {
    if (sort === state.filters.sort) return Promise.resolve()
    return setFilters({ sort: sort }, { resetSelection: false })
  }

  function toggleTag(tag) {
    const tags = state.filters.tags.indexOf(tag) >= 0 ? state.filters.tags.filter((value) => value !== tag) : state.filters.tags.concat([tag])
    return setFilters({ tags: tags })
  }

  function clearTags() {
    if (state.filters.tags.length === 0) return Promise.resolve()
    return setFilters({ tags: [] })
  }

  function selectCollection(collection) {
    if (!collection) return setView('all')
    const patch = { collectionId: null, collectionKind: collection.kind || 'custom', field: null, view: 'all' }
    if (collection.kind === 'field') patch.field = collection.name
    else patch.collectionId = collection.id
    return setFilters(patch)
  }

  function setViewMode(mode) {
    publish({ viewMode: mode === 'grid' ? 'grid' : 'table' })
    persistUi()
  }

  function setSelection(selection) {
    publish({ selection: Array.isArray(selection) ? selection : [] })
  }

  function toggleSelect(id, index, event) {
    const modifiers = event && typeof event === 'object' ? event : {}
    let selection = state.selection.slice()
    if (modifiers.shiftKey && state.anchorIndex >= 0 && typeof index === 'number' && index >= 0) {
      const from = Math.min(state.anchorIndex, index)
      const to = Math.max(state.anchorIndex, index)
      for (let cursor = from; cursor <= to; cursor += 1) {
        const paper = state.items[cursor]
        if (paper && selection.indexOf(paper.id) < 0) selection.push(paper.id)
      }
    } else if (modifiers.metaKey || modifiers.ctrlKey) {
      selection = toggleId(selection, id)
    } else {
      selection = selection.length === 1 && selection[0] === id ? [] : [id]
    }
    publish({ selection: selection, anchorIndex: typeof index === 'number' ? index : state.anchorIndex })
  }

  function selectAll() {
    publish({ selection: state.items.map((paper) => paper.id) })
  }

  function clearSelection() {
    publish({ selection: [], anchorIndex: -1 })
  }

  function selectedPapers() {
    const wanted = new Set(state.selection)
    return state.items.filter((paper) => wanted.has(paper.id))
  }

  function findPaper(id) {
    if (state.details.data && state.details.data.id === id) return state.details.data
    return state.items.find((paper) => paper.id === id) || null
  }

  async function selectPaper(paperId, options) {
    const opts = options || {}
    const tab = opts.tab || (state.details.paperId === paperId ? state.details.tab : 'info')
    if (!paperId) {
      detailSeq += 1
      publish({ details: EMPTY_DETAILS })
      return
    }
    const seq = ++detailSeq
    const same = state.details.paperId === paperId && state.details.data
    publish({
      details: Object.assign({}, state.details, {
        paperId: paperId,
        tab: tab,
        status: same ? 'ready' : 'loading',
        error: null,
        annotations: same ? state.details.annotations : [],
        figures: same ? state.details.figures : [],
      }),
    })
    const [detailResult, annotationsResult, figuresResult] = await Promise.allSettled([
      api('library.get', { id: paperId }),
      api('annotations.list', { paperId: paperId }),
      api('figures.list', { paperId: paperId }),
    ])
    if (seq !== detailSeq) return
    if (detailResult.status === 'rejected') {
      publish({ details: Object.assign({}, state.details, { status: 'error', error: detailResult.reason }) })
      return
    }
    const detail = detailResult.value || null
    publish({
      details: Object.assign({}, state.details, {
        paperId: paperId,
        status: 'ready',
        error: null,
        data: detail,
        annotations: annotationsResult.status === 'fulfilled' ? listOf(annotationsResult.value) : [],
        figures: figuresResult.status === 'fulfilled' ? listOf(figuresResult.value) : [],
        notes: detail ? listOf(detail.notes) : [],
      }),
    })
  }

  function closeDetails() {
    detailSeq += 1
    publish({ details: EMPTY_DETAILS })
  }

  function setDetailTab(tab) {
    publish({ details: Object.assign({}, state.details, { tab: tab }) })
  }

  function setDetailData(paper) {
    if (!paper || !paper.id) return
    publish({
      items: state.items.map((item) => (item.id === paper.id ? Object.assign({}, item, paper) : item)),
      details: Object.assign({}, state.details, { data: paper, notes: listOf(paper.notes) }),
    })
  }

  function patchPaperLocally(id, patch) {
    const items = state.items.map((paper) => (paper.id === id ? Object.assign({}, paper, patch) : paper))
    const details = state.details.data && state.details.data.id === id ? Object.assign({}, state.details, { data: Object.assign({}, state.details.data, patch) }) : state.details
    publish({ items: items, details: details })
  }

  async function updatePaper(id, patch) {
    const revision = state.details.data && state.details.data.id === id ? state.details.data.revision : undefined
    const result = await api('library.update', { id: id, patch: patch, expectedRevision: revision, operationId: opId('update') })
    if (result && result.paper) setDetailData(result.paper)
    else patchPaperLocally(id, patch)
    undo.push({ label: '论文信息更新' })
    return result
  }

  async function setRead(id, read) {
    const result = await api('library.setRead', { id: id, ids: [id], read: Boolean(read), operationId: opId('read') })
    undo.push({ label: read ? '标记为已读' : '标记为未读' })
    patchPaperLocally(id, { read: Boolean(read) })
    return result
  }

  async function refreshTagList() {
    try {
      const result = await api('tags.list', {})
      publish({ tags: listOf(result && result.items), tagsAvailable: true })
    } catch (error) {
      publish({ tags: derivedTags(state.items), tagsAvailable: false })
    }
  }

  async function addTag(id, tag) {
    const value = String(tag || '').trim()
    if (!value) throw new Error('empty tag')
    try {
      const result = await api('library.update', { id: id, patch: { addTags: [value] }, operationId: opId('tag') })
      if (result && result.paper) setDetailData(result.paper)
      else throw new Error('fallback')
    } catch (error) {
      const detail = await api('library.get', { id: id })
      const tags = Array.from(new Set(listOf(detail && detail.tags).concat([value])))
      await api('library.update', { id: id, patch: { tags: tags }, expectedRevision: detail && detail.revision, operationId: opId('tag') })
      setDetailData(Object.assign({}, detail, { tags: tags }))
    }
    await refreshTagList()
  }

  async function removeTag(id, tag) {
    try {
      const result = await api('library.update', { id: id, patch: { removeTags: [tag] }, operationId: opId('untag') })
      if (result && result.paper) setDetailData(result.paper)
      else throw new Error('fallback')
    } catch (error) {
      const detail = await api('library.get', { id: id })
      const tags = listOf(detail && detail.tags).filter((value) => value !== tag)
      await api('library.update', { id: id, patch: { tags: tags }, expectedRevision: detail && detail.revision, operationId: opId('untag') })
      setDetailData(Object.assign({}, detail, { tags: tags }))
    }
    await refreshTagList()
    undo.push({ label: '标签变更' })
  }

  async function refreshCollections() {
    try {
      const value = await api('library.collections.list', {})
      publish({ collections: listOf(value && value.items), collectionsAvailable: true })
    } catch (error) {
      publish({ collections: derivedCollections(state.items), collectionsAvailable: false })
    }
  }

  async function assignCollection(collectionId, paperIds, add) {
    const ids = listOf(paperIds)
      .map(String)
      .filter(Boolean)
    if (ids.length === 0) throw new Error('no papers')
    const result = await api('library.collections.assign', { collectionId: collectionId, paperIds: ids, add: add !== false, operationId: opId('collect') })
    await refreshCollections()
    undo.push({ label: '收藏夹变更' })
    const detailId = state.details.paperId
    if (detailId && ids.indexOf(String(detailId)) >= 0) await selectPaper(String(detailId), { tab: state.details.tab })
    void result
    return result
  }

  async function createCollection(name, color) {
    const result = await api('library.collections.create', { name: String(name || '').trim(), color: color || 'blue', operationId: opId('collection') })
    await refreshCollections()
    return result && result.collection ? result.collection : result
  }

  async function updateCollection(id, patch) {
    const result = await api('library.collections.update', Object.assign({ id: id, operationId: opId('collection') }, patch))
    await refreshCollections()
    return result
  }

  async function deleteCollection(id) {
    const result = await api('library.collections.delete', { id: id, operationId: opId('collection') })
    const filters = state.filters.collectionId === id ? Object.assign({}, state.filters, { collectionId: null, collectionKind: null }) : state.filters
    publish({ filters: filters })
    await refreshCollections()
    return result
  }

  async function trashSelection() {
    const ids = state.selection.slice()
    if (ids.length === 0) throw new Error('no selection')
    await api('library.delete', { ids: ids, operationId: opId('delete') })
    publish({ selection: [] })
    await refresh()
    return ids.length
  }

  async function restoreSelection() {
    const ids = state.selection.slice()
    if (ids.length === 0) throw new Error('no selection')
    await api('library.restore', { ids: ids, operationId: opId('restore') })
    publish({ selection: [] })
    await refresh()
    return ids.length
  }

  async function purgeSelection() {
    const ids = state.selection.slice()
    if (ids.length === 0) throw new Error('no selection')
    await api('library.purge', { ids: ids, operationId: opId('purge') })
    publish({ selection: [] })
    await refresh()
    return ids.length
  }

  async function addTagsToSelection(tags) {
    const values = listOf(tags)
      .map((tag) => String(tag || '').trim())
      .filter(Boolean)
    const ids = state.selection.slice()
    if (values.length === 0 || ids.length === 0) throw new Error('nothing to do')
    let done = 0
    for (const id of ids) {
      for (const tag of values) {
        try {
          await addTag(id, tag)
          done += 1
        } catch (error) {
          console.warn('[pappers-hall] add tag failed', error)
        }
      }
    }
    await refresh()
    return done
  }

  function setUi(patch) {
    const ui = Object.assign({}, state.ui, patch)
    ui.leftWidth = Math.min(320, Math.max(180, Number(ui.leftWidth) || DEFAULT_UI.leftWidth))
    ui.rightWidth = Math.min(480, Math.max(280, Number(ui.rightWidth) || DEFAULT_UI.rightWidth))
    publish({ ui: ui })
    persistUi()
  }

  function toggleLeft() {
    const next = Object.assign({}, state.ui, { leftCollapsed: !state.ui.leftCollapsed })
    publish({ ui: next, mobileLeftOpen: next.leftCollapsed ? false : state.mobileLeftOpen })
    persistUi()
  }

  function toggleRight() {
    const next = Object.assign({}, state.ui, { rightCollapsed: !state.ui.rightCollapsed })
    publish({ ui: next })
    persistUi()
  }

  function toggleMobileLeft() {
    publish({ mobileLeftOpen: !state.mobileLeftOpen, ui: Object.assign({}, state.ui, { leftCollapsed: false }) })
  }

  function setMobileLeftOpen(open) {
    publish({ mobileLeftOpen: Boolean(open) })
  }

  function openContextMenu(menu) {
    publish({ contextMenu: menu || null })
  }

  function closeContextMenu() {
    if (state.contextMenu) publish({ contextMenu: null })
  }

  async function loadDuplicates() {
    publish({ duplicates: { status: 'loading', groups: [], error: null } })
    try {
      const value = await api('library.duplicates', {})
      publish({ duplicates: { status: 'ready', groups: listOf(value && value.groups), error: null } })
    } catch (error) {
      publish({ duplicates: { status: 'error', groups: [], error: error } })
    }
  }

  async function mergeDuplicates(primaryId, duplicateIds, label) {
    const ids = listOf(duplicateIds).map(String).filter((id) => id && id !== String(primaryId))
    if (!primaryId || ids.length === 0) throw new Error('nothing to merge')
    const result = await api('library.merge', { primaryId: String(primaryId), duplicateIds: ids, operationId: opId('merge') })
    undo.push({ label: label || '合并重复文献' })
    await Promise.all([refresh(), loadDuplicates()])
    return result
  }

  async function refreshMetrics(paperIds) {
    const ids = listOf(paperIds).map(String).filter(Boolean)
    const result = await api('metrics.refresh', { paperIds: ids, allowNetwork: true })
    const current = state.details.paperId
    if (current && ids.indexOf(String(current)) >= 0) await selectPaper(String(current), { tab: state.details.tab })
    if (state.filters.sort === 'citations' || state.filters.sort === 'impactFactor') refresh()
    return result
  }

  async function updateMetrics(paperId, fields) {
    const result = await api('metrics.update', { paperId: String(paperId), fields: fields || {} })
    const current = state.details.paperId
    if (current === String(paperId)) await selectPaper(String(paperId), { tab: state.details.tab })
    return result
  }

  async function setReading(paperId, readingStatus, progress) {
    const read = readingStatus === 'read'
    const patch = { read: read }
    if (progress != null) patch.readingProgress = Math.max(0, Math.min(100, Number(progress) || 0))
    const result = await api('library.update', { id: String(paperId), patch: patch, expectedRevision: state.details.paperId === paperId && state.details.data ? state.details.data.revision : undefined, operationId: opId('reading') })
    undo.push({ label: '阅读状态变更' })
    await refresh()
    if (state.details.paperId === String(paperId)) await selectPaper(String(paperId), { tab: state.details.tab })
    return result
  }

  async function setReadingSelection(ids, readingStatus) {
    const list = listOf(ids).map(String).filter(Boolean)
    if (list.length === 0) return { results: [] }
    // v0.15 fix: library.update is a single-paper write (id, patch). The old
    // batch call sent {ids,patch} and the Host rejected it with HTTP 400, so the
    // batch reading dropdown did nothing. Apply the write per paper and surface
    // partial failures instead of pretending success.
    const status = readingStatus === 'read' ? 'read' : readingStatus === 'reading' ? 'reading' : 'to-read'
    const patch = status === 'read'
      ? { read: true, readingProgress: 100 }
      : status === 'reading'
        ? { read: false, readingProgress: 50 }
        : { read: false, readingProgress: 0 }
    const results = []
    for (const id of list) {
      try {
        await api('library.update', { id: id, patch: patch, operationId: opId('reading') })
        results.push({ id: id, ok: true })
      } catch (error) {
        results.push({ id: id, ok: false, error: error })
      }
    }
    const failed = results.filter((entry) => !entry.ok)
    undo.push({ label: '批量阅读状态' })
    await refresh()
    if (failed.length > 0) throw failed[0].error
    return { results: results }
  }

  return {
    getSnapshot() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh: refresh,
    refreshStatus: refreshStatus,
    loadMore: loadMore,
    setView: setView,
    setQuery: setQuery,
    setSort: setSort,
    setSearchMode: setSearchMode,
    toggleTag: toggleTag,
    clearTags: clearTags,
    selectCollection: selectCollection,
    setViewMode: setViewMode,
    setSelection: setSelection,
    toggleSelect: toggleSelect,
    selectAll: selectAll,
    clearSelection: clearSelection,
    selectedPapers: selectedPapers,
    findPaper: findPaper,
    selectPaper: selectPaper,
    closeDetails: closeDetails,
    setDetailTab: setDetailTab,
    updatePaper: updatePaper,
    setRead: setRead,
    setReading: setReading,
    setReadingSelection: setReadingSelection,
    loadDuplicates: loadDuplicates,
    refreshFolders: refreshFolders,
    createFolder: createFolder,
    updateFolder: updateFolder,
    deleteFolder: deleteFolder,
    assignFolder: assignFolder,
    setFavorite: setFavorite,
    setFolderFilter: setFolderFilter,
    setFavoriteFilter: setFavoriteFilter,
    mergeDuplicates: mergeDuplicates,
    refreshMetrics: refreshMetrics,
    updateMetrics: updateMetrics,
    addTag: addTag,
    removeTag: removeTag,
    assignCollection: assignCollection,
    createCollection: createCollection,
    updateCollection: updateCollection,
    deleteCollection: deleteCollection,
    trashSelection: trashSelection,
    restoreSelection: restoreSelection,
    purgeSelection: purgeSelection,
    addTagsToSelection: addTagsToSelection,
    setUi: setUi,
    toggleLeft: toggleLeft,
    toggleRight: toggleRight,
    setMobileLeftOpen: setMobileLeftOpen,
    toggleMobileLeft: toggleMobileLeft,
    openContextMenu: openContextMenu,
    closeContextMenu: closeContextMenu,
  }
}
