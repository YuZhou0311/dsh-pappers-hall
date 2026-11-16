/**
 * Plugin settings center (v0.11).
 *
 * Owns the persisted feature switches and the composed `settings.get` payload used
 * by the settings panel: feature flags, model installation state, translation
 * provider switches, index state and diagnostics. Writes are validated (unknown
 * keys are ignored and reported), persisted in the `settings` table, and
 * idempotent per `operationId`.
 *
 * @module pappers-hall/host/settings
 */
import { readSetting, writeSetting } from './db.js'
import { DomainError } from './store.js'

/** Default feature switches (OCR is opt-in: users install and enable it). */
export const DEFAULT_FEATURES = { vectorSearch: true, ocr: false, freeTranslation: true, autoIndex: true }

/** Translation provider ids managed by the settings panel. */
export const TRANSLATION_PROVIDER_IDS = ['tencent', 'google', 'mymemory', 'llm']

/** Human labels for the provider switches. */
const PROVIDER_LABELS = {
  tencent: '腾讯交互翻译（免费、国内稳定）',
  google: 'Google 翻译（非官方免费）',
  mymemory: 'MyMemory（免费额度）',
  llm: 'AI 精译（LLM）',
}

/** Read a JSON setting with a fallback. */
function readJsonSetting(db, key, fallback) {
  const value = readSetting(db, key)
  return value !== undefined && value !== null ? value : fallback
}

/**
 * Create the settings service.
 * @param {object} options dependencies.
 * @param {import('node:sqlite').DatabaseSync} options.db database.
 * @param {object} [options.config] resolved config.
 * @param {object} [options.logger] logger.
 * @param {object} [options.identity] plugin identity (version/host).
 * @param {object} [options.layout] owned paths.
 * @param {object} [options.store] domain store.
 * @returns {object} settings service.
 */
export function createSettings({ db, config = {}, logger, identity = {}, layout }) {
  /** Bound services (assigned after creation to avoid circular wiring). */
  const bound = { embedding: null, translate: null, search: null, store: null, models: null, ocr: null, queue: null }

  /** Current persisted features merged with defaults. */
  function features() {
    const stored = readJsonSetting(db, 'settings.features', {})
    const result = { ...DEFAULT_FEATURES }
    if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const key of Object.keys(DEFAULT_FEATURES)) if (typeof stored[key] === 'boolean') result[key] = stored[key]
    }
    return result
  }

  /** Current persisted translation settings merged with defaults. */
  function translationSettings() {
    const stored = readJsonSetting(db, 'settings.translation', {})
    const providers = {}
    for (const id of TRANSLATION_PROVIDER_IDS) providers[id] = true
    if (stored !== null && typeof stored === 'object' && stored.providers !== null && typeof stored.providers === 'object') {
      for (const id of TRANSLATION_PROVIDER_IDS) if (typeof stored.providers[id] === 'boolean') providers[id] = stored.providers[id]
    }
    const fallbackEnabled = stored !== null && typeof stored === 'object' && typeof stored.fallbackEnabled === 'boolean' ? stored.fallbackEnabled : true
    return { providers, fallbackEnabled }
  }

  /** Whether the v0.11 panel allows degrading to another engine after a failure. */
  function fallbackEnabled() {
    return translationSettings().fallbackEnabled === true
  }

  /** Whether one translation provider is enabled by settings. */
  function providerEnabled(id) {
    const settings = translationSettings()
    if (settings.providers[id] !== true) return false
    // freeTranslation=false turns off the free public engines; the LLM stays.
    if ((id === 'google' || id === 'mymemory') && features().freeTranslation === false) return false
    return true
  }

  /** Whether at least one translation engine remains usable. */
  function anyTranslationProviderEnabled() {
    return TRANSLATION_PROVIDER_IDS.some((id) => providerEnabled(id))
  }

  /** Composed embedding status for `models.embedding`. */
  function embeddingModelStatus() {
    const embedding = bound.embedding
    const facts = embedding !== null && typeof embedding.facts === 'function' ? embedding.facts() : null
    const job = bound.models !== null && typeof bound.models.activeInstallJob === 'function' ? bound.models.activeInstallJob('embedding') : null
    return {
      kind: 'embedding',
      installed: facts !== null && facts.configured === true,
      available: facts !== null && facts.available === true,
      enabled: features().vectorSearch === true,
      configured: facts !== null && facts.configured === true,
      version: facts !== null && typeof facts.model === 'string' ? facts.model : null,
      model: facts !== null ? facts.model : null,
      dims: facts !== null ? facts.dims : null,
      sizeBytes: bound.models !== null && typeof bound.models.embeddingSizeBytes === 'function' ? bound.models.embeddingSizeBytes() : null,
      installable: true,
      supported: true,
      job,
      reason: facts !== null ? facts.lastError ?? null : 'embedding service is not initialized',
      setupScript: 'scripts/setup-embedding.sh',
    }
  }

  /**
   * Composed status of the optional Python component.
   *
   * One install provides three capabilities (PDF extraction, OCR, layout), so
   * the panel shows them together and the Host switches backends automatically.
   */
  function pythonComponentStatus() {
    const models = bound.models
    const bridge = bound.python
    const ocrStatus = bound.ocr !== null && typeof bound.ocr.status === 'function' ? bound.ocr.status() : null
    const facts = models !== null && typeof models.pythonModelFacts === 'function' ? models.pythonModelFacts() : null
    const capabilities = bridge !== null && bridge !== undefined ? bridge.capabilities : { pdf: false, ocr: false, layout: false }
    const installed = bridge !== null && bridge !== undefined && typeof bridge.installed === 'function' ? bridge.installed() : false
    const job = models !== null && typeof models.activeInstallJob === 'function' ? models.activeInstallJob('python') : null
    return {
      kind: 'python',
      installed: installed === true,
      available: installed === true && capabilities.pdf === true,
      engines: {
        pdf: capabilities.pdf === true ? 'PyMuPDF' : null,
        ocr: capabilities.ocr === true ? (ocrStatus?.engine ?? 'PP-OCRv6') : null,
        layout: capabilities.layout === true ? 'PP-DocLayout-S' : null,
      },
      versions: bridge !== null && bridge !== undefined ? bridge.versions : {},
      model: facts !== null && facts.layoutModel !== undefined ? facts.layoutModel.file : null,
      modelSha256: facts !== null && facts.layoutModel !== undefined ? facts.layoutModel.sha256 : null,
      modelUrl: facts !== null && facts.layoutModel !== undefined ? facts.layoutModel.url : null,
      sizeBytes: ocrStatus !== null ? ocrStatus.sizeBytes ?? null : null,
      installedAt: facts !== null ? facts.installedAt : null,
      version: facts !== null ? facts.version : null,
      license: 'PyMuPDF is AGPL-3.0 (Artifex); it is installed by the user into a private virtualenv and never bundled.',
      installable: true,
      supported: true,
      job,
      reason: installed === true ? null : '可选：安装后 PDF 解析改用 PyMuPDF，并为扫描页提供 PP-OCRv6 文字识别与 PP-DocLayout-S 版面分析',
    }
  }

  /** Composed OCR status for `models.ocr`. */
  function ocrModelStatus() {
    const ocr = bound.ocr
    const status = ocr !== null && typeof ocr.status === 'function' ? ocr.status() : null
    const job = bound.models !== null && typeof bound.models.activeInstallJob === 'function' ? bound.models.activeInstallJob('ocr') : null
    return {
      kind: 'ocr',
      installed: status !== null ? status.installed === true : false,
      available: status !== null ? status.available === true : false,
      enabled: features().ocr === true,
      engine: status !== null ? status.engine ?? 'rapidocr-onnxruntime' : 'rapidocr-onnxruntime',
      version: status !== null ? status.version ?? null : null,
      sizeBytes: status !== null ? status.sizeBytes ?? null : null,
      installable: true,
      supported: true,
      job,
      reason: status !== null ? status.reason ?? null : 'OCR service is not initialized',
      layoutModel: status !== null ? status.layoutModel === true : false,
      scanPages: status !== null ? status.scanPages ?? 0 : 0,
      indexedPages: status !== null ? status.indexedPages ?? 0 : 0,
    }
  }

  /** Composed translation settings for the panel. */
  function translationPanel() {
    const settings = translationSettings()
    const info = bound.translate !== null && typeof bound.translate.providers === 'function' ? bound.translate.providers() : null
    const items = info !== null && Array.isArray(info.items) ? info.items : []
    const byId = new Map(items.map((item) => [item.id, item]))
    return {
      providers: TRANSLATION_PROVIDER_IDS.map((id) => {
        const item = byId.get(id) ?? {}
        return {
          id,
          label: item.label ?? PROVIDER_LABELS[id] ?? id,
          free: item.free === true,
          enabled: providerEnabled(id),
          available: item.available === true && providerEnabled(id),
          configured: item.configured !== false,
        }
      }),
      fallbackEnabled: settings.fallbackEnabled,
      order: (info !== null && Array.isArray(info.fallback) ? info.fallback : ['google', 'mymemory', 'llm']).filter((id) => providerEnabled(id)),
    }
  }

  /** Composed index block. */
  function indexBlock() {
    const search = bound.search
    const facts = search !== null && typeof search.indexFacts === 'function' ? search.indexFacts() : { channels: { fts: 'unavailable', vector: 'unavailable' }, paperCount: 0 }
    const embeddingStatus = bound.embedding !== null && typeof bound.embedding.status === 'function' ? bound.embedding.status() : null
    const stored = readJsonSetting(db, 'settings.index', {})
    return {
      ...facts,
      counts: embeddingStatus !== null ? embeddingStatus.counts : null,
      sync: {
        autoIndex: features().autoIndex,
        building: embeddingStatus !== null ? embeddingStatus.building === true : false,
        lastSyncedAt: embeddingStatus !== null ? embeddingStatus.indexBuiltAt ?? null : null,
        lastError: embeddingStatus !== null ? embeddingStatus.lastError ?? null : null,
        model: embeddingStatus !== null ? embeddingStatus.model ?? null : null,
      },
      ...(stored !== null && typeof stored === 'object' ? {} : {}),
    }
  }

  /** Composed diagnostics block (no secrets). */
  function diagnosticsBlock() {
    const store = bound.store
    const base = store !== null && typeof store.diagnostics === 'function' ? store.diagnostics() : {}
    const ocrStatus = bound.ocr !== null && typeof bound.ocr.status === 'function' ? bound.ocr.status() : null
    const capabilities = { ...(base.capabilities ?? {}) }
    capabilities.ocr = ocrStatus !== null && ocrStatus.available === true && features().ocr === true ? 'ready' : 'unavailable'
    capabilities.vector = features().vectorSearch === false ? 'disabled' : capabilities.vector
    return {
      pluginVersion: identity.pluginVersion ?? '0.1.0',
      hostVersion: identity.hostVersion ?? 'unknown',
      schemaVersion: base.schemaVersion ?? null,
      dataDir: layout?.dataDir ?? config.dataDir ?? '',
      counts: base.counts ?? {},
      capabilities,
      embedding: base.embedding ?? null,
      translation: base.translation ?? null,
    }
  }

  /** `settings.get` payload. */
  function get() {
    return {
      features: features(),
      models: { embedding: embeddingModelStatus(), ocr: ocrModelStatus(), python: pythonComponentStatus() },
      translation: translationPanel(),
      index: indexBlock(),
      diagnostics: diagnosticsBlock(),
    }
  }

  /** Validate and normalize one settings patch. */
  function normalizePatch(patch) {
    const applied = []
    const ignored = []
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { features: null, translation: null, applied, ignored }
    const nextFeatures = {}
    if (patch.features !== undefined) {
      if (patch.features === null || typeof patch.features !== 'object' || Array.isArray(patch.features)) {
        ignored.push('features')
      } else {
        for (const key of Object.keys(patch.features)) {
          if (!Object.hasOwn(DEFAULT_FEATURES, key)) {
            ignored.push(`features.${key}`)
            continue
          }
          if (typeof patch.features[key] !== 'boolean') {
            ignored.push(`features.${key}`)
            continue
          }
          nextFeatures[key] = patch.features[key]
          applied.push(`features.${key}`)
        }
      }
    }
    let nextTranslation = null
    if (patch.translation !== undefined) {
      if (patch.translation === null || typeof patch.translation !== 'object' || Array.isArray(patch.translation)) {
        ignored.push('translation')
      } else {
        const current = translationSettings()
        nextTranslation = { providers: { ...current.providers }, fallbackEnabled: current.fallbackEnabled }
        if (patch.translation.providers !== undefined) {
          if (patch.translation.providers === null || typeof patch.translation.providers !== 'object' || Array.isArray(patch.translation.providers)) {
            ignored.push('translation.providers')
          } else {
            for (const id of Object.keys(patch.translation.providers)) {
              if (!TRANSLATION_PROVIDER_IDS.includes(id)) {
                ignored.push(`translation.providers.${id}`)
                continue
              }
              if (typeof patch.translation.providers[id] !== 'boolean') {
                ignored.push(`translation.providers.${id}`)
                continue
              }
              nextTranslation.providers[id] = patch.translation.providers[id]
              applied.push(`translation.providers.${id}`)
            }
          }
        }
        if (patch.translation.fallbackEnabled !== undefined) {
          if (typeof patch.translation.fallbackEnabled !== 'boolean') ignored.push('translation.fallbackEnabled')
          else {
            nextTranslation.fallbackEnabled = patch.translation.fallbackEnabled
            applied.push('translation.fallbackEnabled')
          }
        }
      }
    }
    return { features: Object.keys(nextFeatures).length === 0 ? null : nextFeatures, translation: nextTranslation, applied, ignored }
  }

  /** `settings.update` — persist feature/provider switches idempotently. */
  function update(params = {}) {
    const operationId = typeof params.operationId === 'string' && params.operationId.trim() !== '' ? params.operationId.trim() : ''
    const operationKey = operationId === '' ? null : `settings.op.${operationId}`
    if (operationKey !== null) {
      const previous = readSetting(db, operationKey)
      if (previous !== undefined) return previous
    }
    const { features: nextFeatures, translation: nextTranslation, applied, ignored } = normalizePatch(params.patch)
    const currentFeatures = features()
    const mergedFeatures = nextFeatures === null ? currentFeatures : { ...currentFeatures, ...nextFeatures }
    const mergedTranslation = nextTranslation ?? translationSettings()
    // Validation: at least one translation engine must remain usable.
    const freeTranslation = mergedFeatures.freeTranslation !== false
    const usable = TRANSLATION_PROVIDER_IDS.filter((id) => mergedTranslation.providers[id] === true && (freeTranslation || id === 'llm'))
    if (usable.length === 0) {
      throw new DomainError('invalid', '至少需要保留一个可用的翻译引擎（freeTranslation=false 时请保留 llm）', { applied, ignored })
    }
    if (nextFeatures !== null) writeSetting(db, 'settings.features', mergedFeatures)
    if (nextTranslation !== null) writeSetting(db, 'settings.translation', mergedTranslation)
    const autoIndexEnabled = mergedFeatures.autoIndex === true
    if (autoIndexEnabled && bound.embedding !== null) {
      // Turning autoIndex back on catches up everything changed while it was off.
      Promise.resolve()
        .then(() => {
          if (typeof bound.embedding.syncNow === 'function') return bound.embedding.syncNow()
          if (typeof bound.embedding.syncMissingAnnotations === 'function') return bound.embedding.syncMissingAnnotations()
          return undefined
        })
        .catch((error) => logger?.debug?.(`pappers-hall: embedding catch-up failed: ${String(error?.message ?? error)}`))
    }
    const result = { ...get(), applied, ignored }
    if (operationKey !== null) writeSetting(db, operationKey, result)
    logger?.debug?.(`pappers-hall: settings.update applied ${applied.length} key(s), ignored ${ignored.length}`)
    return result
  }

  const service = {
    get,
    update,
    features,
    translationSettings,
    providerEnabled,
    fallbackEnabled,
    anyTranslationProviderEnabled,
    bind(services = {}) {
      Object.assign(bound, services)
      return service
    },
    bound,
  }
  return service
}
