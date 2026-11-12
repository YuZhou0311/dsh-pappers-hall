/**
 * Automatic folder classification for the Pappers-Hall Host half (v0.6).
 *
 * A folder's "profile" is the mean of the multilingual embeddings of the papers
 * directly inside it (an empty folder falls back to the embedding of its name).
 * A new paper is suggested to the most similar folder when the cosine clears the
 * threshold (default 0.32); otherwise the caller is told to create a new folder
 * named after the paper's topic (LLM 2–8 Chinese chars, deterministic fallback).
 *
 * The module only reads; mutations (assign/create + journaling/undo) live in the
 * store so every applied classification is undoable. When the local embedding
 * component is unavailable this reports an honest `unavailable` and never invents
 * a confidence or a folder.
 *
 * @module pappers-hall/host/classify
 */
import { cosine, decodeVector } from './embedding.js'

/** Default cosine threshold for auto-assigning into an existing folder. */
export const DEFAULT_CLASSIFY_THRESHOLD = 0.32

/** Deterministic fallback folder name (never empty). */
const FALLBACK_FOLDER_NAME = '未分类主题'

/** Strip characters that are not suitable inside a folder name. */
function sanitizeFolderName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\s"'“”‘’《》【】()（）[\]{}<>:：,，.。;；!！?？、/\\|-]+/g, '')
    .trim()
  return [...cleaned].slice(0, 24).join('')
}

/** Deterministically derive a 2–16 char topic-ish name from paper metadata. */
export function fallbackFolderName(paper = {}) {
  const titleZh = typeof paper.title_zh === 'string' ? paper.title_zh.trim() : ''
  if (titleZh !== '') {
    const head = titleZh.split(/[：:—–|｜]/)[0].trim()
    const chars = [...head.replace(/\s+/g, '')]
    const name = chars.slice(0, 12).join('')
    if (name.length >= 2) return name
  }
  const title = typeof paper.title === 'string' ? paper.title.trim() : ''
  if (/^(subject|title|document|untitled|paper|article|microsoft word)$/i.test(sanitizeFolderName(title))) {
    // Generic PDF-metadata placeholders are not useful folder names; fall through to venue.
  } else if (title !== '') {
    // English titles: first few significant words (skip stop words).
    const words = title
      .split(/\s+/)
      .filter(
        (word) =>
          word.length > 2 &&
          !/^(the|and|for|with|from|into|using|via|based|toward|towards|under|over|between|through|subject|title|document|paper|article|untitled|microsoft|word|pdf)$/i.test(
            word,
          ),
      )
    if (words.length > 0) return sanitizeFolderName(words.slice(0, 3).join(' ')).slice(0, 24) || FALLBACK_FOLDER_NAME
  }
  const venue = typeof paper.venue === 'string' ? paper.venue.trim() : ''
  if (venue !== '') return sanitizeFolderName(venue).slice(0, 16) || FALLBACK_FOLDER_NAME
  return FALLBACK_FOLDER_NAME
}

/**
 * Create the classifier.
 * @param {object} options dependencies.
 * @param {import('node:sqlite').DatabaseSync} options.db database.
 * @param {object} options.embedding embedding service.
 * @param {object} [options.ai] AI service (optional; folder-name generation).
 * @param {object} [options.config] resolved plugin config.
 * @param {object} [options.logger] logger.
 * @returns {object} classifier service.
 */
export function createClassify({ db, embedding, ai, config = {}, logger }) {
  const threshold = Number.isFinite(Number(config.classifyThreshold)) ? Number(config.classifyThreshold) : DEFAULT_CLASSIFY_THRESHOLD
  /** @type {Map<string, Float32Array>} */
  const paperVectorCache = new Map()
  /** @type {Map<string, {key:string, vector:Float32Array}>} */
  const profileCache = new Map()

  /** Normalize a vector in place (safe for zero vectors). */
  function normalize(vector) {
    let sum = 0
    for (const value of vector) sum += value * value
    const norm = Math.sqrt(sum)
    if (norm > 0) for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
    return vector
  }

  /** Load one paper row. */
  function paperRow(paperId) {
    return db.prepare('SELECT id, title, title_zh, abstract, keywords_json, venue, field, year FROM papers WHERE id = ?').get(paperId)
  }

  /** Text used to embed one paper (metadata only). */
  function paperText(row) {
    let keywords = ''
    try {
      const parsed = typeof row.keywords_json === 'string' ? JSON.parse(row.keywords_json) : row.keywords_json
      if (Array.isArray(parsed)) keywords = parsed.map((item) => String(item ?? '')).filter((item) => item !== '').join(', ')
    } catch {}
    // v0.16: `field` is itself derived from folder classification, so embedding it
    // would feed the previous assignment back into the next one (circular confidence).
    return [row.title, row.title_zh, row.abstract, keywords, row.venue]
      .map((part) => (typeof part === 'string' ? part.replace(/\s+/g, ' ').trim() : ''))
      .filter((part) => part !== '')
      .join('. ')
      .slice(0, 2000)
  }

  /** Current embedding facts (honest availability). */
  function embeddingFacts() {
    if (embedding === null || embedding === undefined) return { available: false, configured: false, reason: 'embedding service is not initialized' }
    if (typeof embedding.facts === 'function') return embedding.facts()
    if (typeof embedding.status === 'function') return embedding.status()
    return { available: false, configured: false, reason: 'embedding service is not initialized' }
  }

  /** Embed one paper, preferring the stored `embeddings(kind='paper')` row. */
  async function paperVector(paperId) {
    const facts = embeddingFacts()
    const cached = paperVectorCache.get(paperId)
    if (cached !== undefined) return cached
    const model = facts.model
    const stored =
      typeof model === 'string' && model !== ''
        ? db.prepare("SELECT vector FROM embeddings WHERE kind = 'paper' AND ref_id = ? AND model = ? ORDER BY id DESC LIMIT 1").get(paperId, model)
        : undefined
    if (stored !== undefined) {
      const vector = normalize(Float32Array.from(decodeVector(stored.vector)))
      paperVectorCache.set(paperId, vector)
      return vector
    }
    const row = paperRow(paperId)
    if (row === undefined) return undefined
    const text = paperText(row)
    if (text === '') return undefined
    const embedded = await embedding.embedTexts([text])
    const vector = normalize(Float32Array.from(embedded.vectors[0]))
    paperVectorCache.set(paperId, vector)
    return vector
  }

  /** List folders as `{id,name,parentId,updatedAt}`. */
  function folderRows() {
    return db.prepare('SELECT id, name, parent_id, updated_at FROM collections ORDER BY sort_order ASC, name ASC').all()
  }

  /** Direct member paper ids of one folder. */
  function memberIds(folderId) {
    return db
      .prepare(
        `SELECT pc.paper_id FROM paper_collections pc JOIN papers p ON p.id = pc.paper_id AND p.state = 'active'
         WHERE pc.collection_id = ? ORDER BY pc.paper_id`,
      )
      .all(folderId)
      .map((row) => row.paper_id)
  }

  /** Mean of member vectors; empty folders embed their own name. */
  async function folderProfile(folder, excludePaperId) {
    const excluded = typeof excludePaperId === 'string' && excludePaperId !== '' ? excludePaperId : ''
    const members = memberIds(folder.id).filter((paperId) => paperId !== excluded)
    const cacheKey = `${folder.name}|${folder.updated_at ?? ''}|${members.join(',')}|exclude:${excluded}`
    const cached = profileCache.get(folder.id)
    if (cached !== undefined && cached.key === cacheKey) return cached.vector
    let vector
    if (members.length === 0) {
      const embedded = await embedding.embedTexts([folder.name])
      vector = normalize(Float32Array.from(embedded.vectors[0]))
    } else {
      const sums = new Float32Array(0)
      let accumulator = null
      let count = 0
      for (const paperId of members.slice(0, 60)) {
        let memberVector
        try {
          memberVector = await paperVector(paperId)
        } catch {
          memberVector = undefined
        }
        if (memberVector === undefined) continue
        if (accumulator === null) accumulator = new Float32Array(memberVector.length)
        for (let index = 0; index < memberVector.length; index += 1) accumulator[index] += memberVector[index]
        count += 1
      }
      if (accumulator === null) {
        const embedded = await embedding.embedTexts([folder.name])
        vector = normalize(Float32Array.from(embedded.vectors[0]))
      } else {
        for (let index = 0; index < accumulator.length; index += 1) accumulator[index] /= count
        vector = normalize(accumulator)
        void sums
      }
    }
    profileCache.set(folder.id, { key: cacheKey, vector })
    return vector
  }

  /** Embed every folder profile (used by suggest and diagnostics). */
  async function profiles(excludePaperId) {
    const results = []
    for (const folder of folderRows()) {
      try {
        const members = memberIds(folder.id).filter((paperId) => paperId !== excludePaperId)
        results.push({ folder, vector: await folderProfile(folder, excludePaperId), memberCount: members.length, profileSource: members.length > 0 ? 'members' : 'name' })
      } catch (error) {
        logger?.debug?.(`pappers-hall: classify folder profile failed for ${folder.id}: ${String(error?.message ?? error)}`)
      }
    }
    return results
  }

  /** Ask the LLM for a 2–8 char Chinese topic, with deterministic fallback. */
  async function suggestFolderName(paper, sessionId) {
    const row = paperRow(paper.id)
    if (row !== undefined && ai !== undefined && typeof ai.suggestFolderName === 'function') {
      try {
        let keywords = []
        try {
          const parsed = typeof row.keywords_json === 'string' ? JSON.parse(row.keywords_json) : row.keywords_json
          if (Array.isArray(parsed)) keywords = parsed.map(String).slice(0, 8)
        } catch {}
        const suggested = await ai.suggestFolderName({
          title: row.title,
          titleZh: row.title_zh,
          venue: row.venue,
          keywords,
          abstract: row.abstract,
          sessionId,
        })
        if (suggested?.status === 'ok' && typeof suggested.name === 'string' && suggested.name.trim() !== '') {
          return { name: sanitizeFolderName(suggested.name) || fallbackFolderName(row), source: 'llm' }
        }
      } catch (error) {
        logger?.debug?.(`pappers-hall: folder-name LLM fallback: ${String(error?.message ?? error)}`)
      }
    }
    return { name: sanitizeFolderName(fallbackFolderName(row ?? paper)) || FALLBACK_FOLDER_NAME, source: 'fallback' }
  }

  /**
   * Suggest a folder for each paper.
   * @param {{paperIds:string[], sessionId?:string}} request request.
   * @returns {Promise<object>} suggestions payload or unavailable.
   */
  async function suggest(request = {}) {
    const paperIds = (Array.isArray(request.paperIds) ? request.paperIds : []).map(String).filter((id) => id !== '')
    if (paperIds.length === 0) return { status: 'error', reason: 'paperIds is required', suggestions: [] }
    const facts = embeddingFacts()
    if (facts.configured !== true || facts.available !== true) {
      return {
        status: 'unavailable',
        reason: 'embedding unavailable',
        detail: facts.lastError ?? null,
        threshold,
        suggestions: [],
      }
    }
    const suggestions = []
    for (const paperId of paperIds) {
      const row = paperRow(paperId)
      if (row === undefined) {
        suggestions.push({ paperId, action: 'none', error: 'not_found' })
        continue
      }
      let vector
      try {
        vector = await paperVector(paperId)
      } catch (error) {
        suggestions.push({ paperId, action: 'none', error: `embedding failed: ${String(error?.message ?? error)}` })
        continue
      }
      if (vector === undefined) {
        suggestions.push({ paperId, action: 'none', error: 'paper has no embeddable text' })
        continue
      }
      // v0.16: leave-one-out scoring. A folder profile normally includes the
      // paper being classified, which makes a paper's own folder score ~1.0 and
      // grossly overstates confidence. Exclude the target while scoring, and
      // report margin/stable so callers can see when a split is unsupported.
      const folderProfiles = await profiles(paperId)
      const ranked = []
      for (const profile of folderProfiles) {
        ranked.push({ folder: profile.folder, score: cosine(vector, profile.vector), memberCount: profile.memberCount, profileSource: profile.profileSource })
      }
      ranked.sort((left, right) => right.score - left.score)
      const best = ranked.length > 0 ? ranked[0] : null
      const second = ranked.length > 1 ? ranked[1] : null
      const margin = best !== null && second !== null ? best.score - second.score : null
      const enoughEvidence = best !== null && best.memberCount >= 1 && best.profileSource === 'members'
      const stable = Boolean(best !== null && best.score >= threshold && enoughEvidence && margin !== null && margin >= 0.08)
      if (best !== null && best.score >= threshold) {
        suggestions.push({
          paperId,
          action: 'assign',
          folderId: best.folder.id,
          folderName: best.folder.name,
          score: Number(best.score.toFixed(4)),
          confidence: Number(best.score.toFixed(4)),
          margin: margin === null ? null : Number(margin.toFixed(4)),
          stable,
          evidence: enoughEvidence ? 'other-members' : 'folder-name-only',
          memberCountExcluding: best.memberCount,
          secondFolderName: second === null ? null : second.folder.name,
          secondScore: second === null ? null : Number(second.score.toFixed(4)),
          threshold,
        })
      } else {
        const naming = await suggestFolderName(row, request.sessionId)
        suggestions.push({
          paperId,
          action: 'create',
          newFolderName: naming.name,
          folderName: naming.name,
          nameSource: naming.source,
          score: best === null ? null : Number(best.score.toFixed(4)),
          confidence: best === null ? null : Number(best.score.toFixed(4)),
          margin: margin === null ? null : Number(margin.toFixed(4)),
          stable: false,
          evidence: 'none',
          threshold,
        })
      }
    }
    return {
      status: 'ok',
      threshold,
      model: facts.model ?? null,
      dims: facts.dims ?? null,
      suggestions,
    }
  }

  /** Invalidate caches (called after folder/paper mutations in tests/tools). */
  function invalidate() {
    paperVectorCache.clear()
    profileCache.clear()
  }

  return { threshold, suggest, profiles, folderProfile, paperVector, suggestFolderName, fallbackFolderName, invalidate, facts: embeddingFacts }
}
