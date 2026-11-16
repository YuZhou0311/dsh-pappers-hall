/**
 * One reference set per draft.
 *
 * `references.commit` is immutable, so repeatedly calling it produced one
 * composer token and one removable card per citation. While the user is still
 * composing, this helper appends materials to the existing pending bundle and
 * returns the updated single token. Only after a bundle has been inserted into
 * the draft does a later citation create a fresh set.
 */
import { defaultApi } from './api.js'
import { pendingStore } from './pending.js'
import { removeTokenFromComposer, composerHasToken } from './dnd.js'

function itemOf(material) {
  const kind = String((material && material.kind) || 'paper')
  const id = String((material && (material.id || material.paperId)) || '')
  if (!id) return null
  const item = { kind, id }
  if (material.page) item.page = Number(material.page)
  return item
}

function uniqueItems(materials) {
  const seen = new Set()
  const items = []
  for (const material of Array.isArray(materials) ? materials : []) {
    const item = itemOf(material)
    if (!item) continue
    const key = item.kind + ':' + item.id + ':' + (item.page || '')
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  return items
}

/**
 * Commit the citation set into the single pending bundle.
 *
 * @param {Array} materials materials with `{kind,id,page?}`.
 * @param {{sessionId?:string, operationId?:string}} options
 * @returns {Promise<{result:object, created:boolean, previous:object|null}>}
 */
let queue = Promise.resolve()

export function commitReferenceBatch(materials, options) {
  // Citations can be clicked in quick succession; serialize so the second call
  // observes the bundle created by the first instead of creating a second card.
  const run = () => commitReferenceBatchNow(materials, options)
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

async function commitReferenceBatchNow(materials, options) {
  const opts = options || {}
  const fresh = uniqueItems(materials)
  if (fresh.length === 0) throw new Error('no materials selected')
  const snapshot = pendingStore.getSnapshot()
  // A bundle counts as reusable while its token is still in the draft: the user
  // is composing one message, so later citations extend that same set.
  const reusable = snapshot.bundles.filter(
    (bundle) =>
      bundle.token &&
      (!bundle.added || composerHasToken(bundle.token)) &&
      (!opts.sessionId || !bundle.sessionId || bundle.sessionId === opts.sessionId),
  )
  const primary = reusable[0] || null
  const combined = uniqueItems(
    reusable.flatMap((bundle) => bundle.materials || []).concat(materials),
  )
  if (primary) {
    try {
      const result = await defaultApi('references.append', {
        bundleId: primary.bundleId,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        items: combined,
        ...(opts.operationId ? { operationId: opts.operationId } : {}),
      })
      // The bundle now describes more materials, so its draft token changed:
      // strip every stale token first, then let the dock insert the new one.
      reusable.forEach((bundle) => {
        if (bundle.token) removeTokenFromComposer(bundle.token)
        pendingStore.remove(bundle.bundleId)
      })
      pendingStore.add(result, combined, { sessionId: opts.sessionId, autoInsert: true })
      return { result, created: false, previous: primary }
    } catch (error) {
      // A stale bundle should not block the new citation; fall through to a
      // fresh commit and let the dock show the failure only if that also fails.
      console.warn('[pappers-hall] references.append failed, committing a new set', error)
    }
  }
  const result = await defaultApi('references.commit', {
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    items: fresh,
    ...(opts.operationId ? { operationId: opts.operationId } : {}),
  })
  reusable.forEach((bundle) => {
    if (bundle.token) removeTokenFromComposer(bundle.token)
    if (bundle.bundleId !== result.bundleId) pendingStore.remove(bundle.bundleId)
  })
  pendingStore.add(result, materials, { sessionId: opts.sessionId, autoInsert: true })
  return { result, created: true, previous: null }
}

/**
 * Remove the whole pending set: strip its token from the draft, then drop the
 * bundle. Nothing is left behind in the composer.
 */
export async function dropPendingReferences(bundleId) {
  const snapshot = pendingStore.getSnapshot()
  const bundles = snapshot.bundles.filter((bundle) => bundle.bundleId === bundleId)
  if (bundles.length === 0) return { ok: true, removed: 0 }
  for (const bundle of bundles) {
    if (bundle.token) removeTokenFromComposer(bundle.token)
  }
  pendingStore.remove(bundleId)
  return { ok: true, removed: bundles.length }
}

/**
 * Remove one material from the set. The surviving materials get a fresh bundle
 * (and a fresh draft token) so the draft can never reference a stale bundle.
 */
export async function dropPendingMaterial(bundleId, index, options) {
  const opts = options || {}
  const snapshot = pendingStore.getSnapshot()
  const bundle = snapshot.bundles.find((entry) => entry.bundleId === bundleId)
  if (!bundle) return { ok: true }
  const survivors = (bundle.materials || []).filter((material, materialIndex) => materialIndex !== index)
  if (bundle.token) removeTokenFromComposer(bundle.token)
  pendingStore.remove(bundleId)
  if (survivors.length === 0) return { ok: true, remaining: 0 }
  await commitReferenceBatch(survivors, { sessionId: opts.sessionId || bundle.sessionId || undefined })
  return { ok: true, remaining: survivors.length }
}
