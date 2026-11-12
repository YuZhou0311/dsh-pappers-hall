/**
 * Drag & drop materials (papers / figures / annotations) onto a conversation.
 * Drops target a sidebar session row, the new-conversation button or the
 * composer: session drops queue the bundle for that session's dock, which
 * inserts the token once it mounts. Nothing is ever auto-sent.
 */
import { pendingStore } from './pending.js'
import { defaultApi } from './api.js'
import { notify } from './feedback.js'
import { bus } from './bus.js'

export const MATERIAL_MIME = 'application/x-pappers-hall-material'

function opId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return 'dnd-' + random
}

export function materialsFromEvent(event) {
  const transfer = event && event.dataTransfer
  if (!transfer) return null
  let raw = ''
  try {
    raw = transfer.getData(MATERIAL_MIME)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const payload = JSON.parse(raw)
    return (Array.isArray(payload && payload.materials) ? payload.materials : []).filter((m) => m && m.kind && m.id).slice(0, 50)
  } catch {
    return null
  }
}

function plainSummary(t, materials) {
  const counts = {}
  materials.forEach((material) => { counts[material.kind] = (counts[material.kind] || 0) + 1 })
  return t('dnd.summary') + ' · ' + Object.keys(counts).map((kind) => t('dnd.kind.' + kind) + ' ' + counts[kind]).join(' · ')
}

/** Spread on a draggable React element to publish its materials. */
export function dragProps(t, materials, options) {
  const list = (Array.isArray(materials) ? materials : [materials]).filter((m) => m && m.id)
  if (list.length === 0) return {}
  return {
    draggable: true,
    onDragStart: (event) => {
      try {
        event.dataTransfer.setData(MATERIAL_MIME, JSON.stringify({ version: 1, materials: list, source: (options && options.source) || 'library' }))
        event.dataTransfer.setData('text/plain', plainSummary(t, list))
        event.dataTransfer.effectAllowed = 'copy'
        if (typeof document !== 'undefined') document.body.classList.add('ph-dnd-dragging')
        bus.emit('dnd-start', { materials: list })
      } catch (error) {
        console.warn('[pappers-hall] dragstart failed', error)
      }
    },
    onDragEnd: () => {
      if (typeof document !== 'undefined') document.body.classList.remove('ph-dnd-dragging')
      bus.emit('dnd-end')
    },
    'data-ph-drag': 'material',
  }
}

/* ------------------------------------------------------------------ composer */
let composer = null
export function registerComposerBridge(actions) {
  composer = actions && typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function' ? actions : null
  return () => { composer = null }
}
export function hasComposer() { return Boolean(composer) }
export function insertTokenIntoComposer(token, options) {
  if (!composer || !token) return false
  try {
    const span = composer.captureInsertion()
    // A citation token is a block-level material reference; continue typing on a
    // fresh paragraph instead of appending text directly behind the token.
    const trailing = options && options.newline === false ? '' : '\n\n'
    return composer.insertText(String(token) + trailing, span) !== false
  } catch (error) {
    console.warn('[pappers-hall] composer insertion failed', error)
    return false
  }
}

function commitItem(material) {
  const item = { kind: material.kind, id: String(material.id) }
  if (material.page) item.page = Number(material.page)
  if (material.annotationId) item.annotationId = material.annotationId
  return item
}

/** Commit materials and queue them in the pending store (optionally for a session). */
export async function deliverMaterials(materials, options) {
  const list = (Array.isArray(materials) ? materials : []).filter((m) => m && m.kind && m.id)
  if (list.length === 0) return { ok: false, reason: 'empty' }
  const opts = options || {}
  try {
    const result = await defaultApi('references.commit', {
      items: list.map(commitItem),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      operationId: opId(),
    })
    pendingStore.add(
      result,
      list.map((material) => ({ kind: material.kind, id: material.id, page: material.page, title: material.title || material.quote })),
      { sessionId: opts.sessionId || null, autoInsert: Boolean(opts.sessionId), targetLabel: opts.targetLabel || '' },
    )
    if (!opts.sessionId) {
      const inserted = insertTokenIntoComposer(result.token)
      if (inserted) pendingStore.markAdded(result.bundleId)
      return { ok: true, inserted, bundleId: result.bundleId, result }
    }
    return { ok: true, inserted: false, queued: true, bundleId: result.bundleId, result }
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error), error }
  }
}

/* ------------------------------------------------------------------- overlay */
let overlay = null
function ensureOverlay() {
  if (typeof document === 'undefined') return null
  if (overlay && overlay.isConnected) return overlay
  overlay = document.createElement('div')
  overlay.className = 'ph-dropoverlay'
  overlay.setAttribute('aria-hidden', 'true')
  overlay.innerHTML = '<div class="ph-dropoverlay__card"><span class="ph-dropoverlay__icon"></span><span class="ph-dropoverlay__text"></span><span class="ph-dropoverlay__hint"></span></div>'
  document.body.appendChild(overlay)
  return overlay
}
function setOverlay(visible, text, hint) {
  const node = ensureOverlay()
  if (!node) return
  node.querySelector('.ph-dropoverlay__text').textContent = text || ''
  node.querySelector('.ph-dropoverlay__hint').textContent = hint || ''
  node.classList.toggle('ph-dropoverlay--visible', Boolean(visible))
}

function pluginSurface(target) {
  if (!target || typeof target.closest !== 'function') return null
  if (target.closest('.ph-dropoverlay')) return 'overlay'
  if (target.closest('.ph-center')) return 'center'
  if (target.closest('.ph-drawer')) return 'drawer'
  if (target.closest('.ph-toolcard')) return 'toolcard'
  return null
}
function sessionRowOf(target) {
  if (!target || typeof target.closest !== 'function') return null
  return target.closest('[data-row-key^="session:"]')
}
function newSessionButtonOf(target) {
  if (!target || typeof target.closest !== 'function') return null
  return target.closest('button[aria-label*="新建会话"], button[aria-label*="New chat"], button[aria-label*="New conversation"]')
}
function sessionIdOfRow(row) {
  const key = row && row.getAttribute ? row.getAttribute('data-row-key') : ''
  return key && key.indexOf('session:') === 0 ? key.slice('session:'.length) : ''
}
function labelOfRow(row) {
  return row ? (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : ''
}

let installed = false
/** Install the global drag-to-conversation behaviour once. */
export function installDragToConversation(options) {
  if (installed || typeof document === 'undefined') return () => {}
  installed = true
  const opts = options || {}
  const t = opts.t || ((key) => key)
  let highlighted = null

  function clearHighlight() {
    if (highlighted && highlighted.classList) highlighted.classList.remove('ph-dnd-target')
    highlighted = null
  }
  function resolveTarget(event) {
    if (!event.dataTransfer || Array.prototype.indexOf.call(event.dataTransfer.types, MATERIAL_MIME) < 0) return null
    if (pluginSurface(event.target)) return null
    const row = sessionRowOf(event.target)
    if (row) return { kind: 'session', node: row, sessionId: sessionIdOfRow(row), label: labelOfRow(row) }
    const newButton = newSessionButtonOf(event.target)
    if (newButton) return { kind: 'new', node: newButton, label: t('dnd.newSession') }
    return { kind: 'composer', node: null, label: t('dnd.composer') }
  }

  const onDragStart = () => document.body.classList.add('ph-dnd-dragging')
  const onDragEnd = () => {
    document.body.classList.remove('ph-dnd-dragging')
    clearHighlight()
    setOverlay(false)
  }
  const onDragOver = (event) => {
    const target = resolveTarget(event)
    if (!target) {
      clearHighlight()
      setOverlay(false)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (highlighted !== target.node) {
      clearHighlight()
      highlighted = target.node
      if (highlighted && highlighted.classList) highlighted.classList.add('ph-dnd-target')
    }
    setOverlay(true, t('dnd.drop'), target.kind === 'session' ? t('dnd.dropSession', { title: target.label || '' }) : target.kind === 'new' ? t('dnd.dropNew') : t('dnd.dropHint'))
  }
  const onDragLeave = (event) => {
    if (!event.relatedTarget) {
      clearHighlight()
      setOverlay(false)
    }
  }
  const onDrop = (event) => {
    const target = resolveTarget(event)
    if (!target) {
      setOverlay(false)
      clearHighlight()
      if (event.dataTransfer && Array.prototype.indexOf.call(event.dataTransfer.types, MATERIAL_MIME) >= 0 && pluginSurface(event.target)) {
        event.preventDefault()
        notify('info', t('dnd.wrongTarget'), null, 2600)
      }
      return
    }
    event.preventDefault()
    setOverlay(false)
    clearHighlight()
    document.body.classList.remove('ph-dnd-dragging')
    const materials = materialsFromEvent(event)
    if (!materials || materials.length === 0) {
      notify('warning', t('dnd.unrecognized'), null, 2400)
      return
    }
    if (target.kind === 'session' && target.sessionId) {
      deliverMaterials(materials, { sessionId: target.sessionId, targetLabel: target.label }).then((result) => {
        if (!result.ok) { notify('error', t('dnd.failed', { message: result.reason || '' }), null, 3600); return }
        let navigated = false
        if (opts.uiWorkspace && typeof opts.uiWorkspace.openSession === 'function') {
          try {
            opts.uiWorkspace.openSession(target.sessionId)
            navigated = true
          } catch (error) {
            console.warn('[pappers-hall] openSession failed', error)
          }
        }
        // Fallback: activate the session row exactly like a user click, so the
        // target conversation opens even when the uiWorkspace face is missing.
        if (!navigated && target.node && typeof target.node.click === 'function') {
          try { target.node.click() } catch (error) { console.warn('[pappers-hall] session row click failed', error) }
        }
        notify('success', t('dnd.queuedSession', { title: target.label || '' }), {
          label: t('common.undo'),
          onClick: () => { pendingStore.remove(result.bundleId); notify('info', t('dnd.undone'), null, 2200) },
        }, 9000)
      })
      return
    }
    if (target.kind === 'new' && opts.uiWorkspace && typeof opts.uiWorkspace.startSession === 'function') {
      deliverMaterials(materials, { targetLabel: target.label }).then((result) => {
        if (!result.ok) { notify('error', t('dnd.failed', { message: result.reason || '' }), null, 3600); return }
        const token = result.result && result.result.token ? result.result.token : ''
        const workspaceId = typeof opts.getWorkspaceId === 'function' ? opts.getWorkspaceId() : undefined
        try {
          opts.uiWorkspace.startSession(workspaceId, { prompt: token, whenDraftExists: 'append' })
          pendingStore.remove(result.bundleId)
          notify('success', t('dnd.startedNew'), null, 4000)
        } catch (error) {
          notify('warning', t('dnd.failed', { message: error.message || '' }), null, 3600)
        }
      })
      return
    }
    deliverMaterials(materials, {}).then((result) => {
      if (!result.ok) { notify('error', t('dnd.failed', { message: result.reason || '' }), null, 3600); return }
      notify(result.inserted ? 'success' : 'warning', result.inserted ? t('dnd.inserted', { count: materials.length }) : t('dnd.queued', { count: materials.length }), {
        label: t('common.undo'),
        onClick: () => { pendingStore.remove(result.bundleId); notify('info', t('dnd.undone'), null, 2200) },
      }, 9000)
    })
  }

  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('dragend', onDragEnd, true)
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('dragleave', onDragLeave, true)
  document.addEventListener('drop', onDrop, true)
  return () => {
    installed = false
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('dragend', onDragEnd, true)
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('dragleave', onDragLeave, true)
    document.removeEventListener('drop', onDrop, true)
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    overlay = null
  }
}
