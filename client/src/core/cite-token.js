/**
 * Composer citation-token decorator (v0.12).
 *
 * The Host inserts a plain-text protocol token such as
 * `⟦Pappers-Hall 3 篇论文 · bundle=bn-…⟧` (the Agent parses `bundle=bn-…`).
 * We never change that text: a MutationObserver marks the rendered composer
 * span with `ph-citetoken` and a tooltip, and CSS turns it into a soft pill.
 * Lexical may re-render the span at any time, so classification is re-run on
 * mutations (and on a slow interval as a safety net).
 */
const TOKEN_PATTERN = /bundle=bn-/
// A pill is only valid when the element contains EXACTLY one complete token
// (edges may carry whitespace). Lexical may append user text into the same
// span; in that case the span must lose the pill.
const TOKEN_BLOCK = /^\s*⟦Pappers-Hall[^⟧]*⟧\s*$/
const COMPOSER_SELECTOR = '[data-composer-input="true"]'

/** True only when the element has a *direct* child text node containing the token. */
function ownsTokenDirectly(element) {
  if (!element || element.nodeType !== 1) return false
  for (let i = 0; i < element.childNodes.length; i += 1) {
    const child = element.childNodes[i]
    if (child && child.nodeType === 3 && TOKEN_PATTERN.test(child.nodeValue || '')) return true
  }
  return false
}

/**
 * Mark the innermost element that directly owns the token text node (usually
 * Lexical's `<span data-lexical-text="true">`). Never walk up to a paragraph:
 * a `<p>` may also contain unrelated user text, and painting the whole
 * paragraph as a pill is wrong. If no direct owner exists (framework wrapped
 * the text), fall back to the nearest span whose whole text is the token.
 */
function tokenOwner(node, composer) {
  let element = node && node.nodeType === 3 ? node.parentElement : node
  let fallback = null
  while (element && element !== composer) {
    if (ownsTokenDirectly(element)) return element
    if (!fallback && element.tagName === 'SPAN') fallback = element
    element = element.parentElement
  }
  return fallback && fallback !== composer ? fallback : null
}

function isPureToken(element) {
  if (!element || element.nodeType !== 1) return false
  const text = element.textContent || ''
  return TOKEN_BLOCK.test(text) && TOKEN_PATTERN.test(text)
}

function tokenLabel(text) {
  const match = /^\s*⟦Pappers-Hall\s+(.*?)(?:\s*·\s*bundle=bn-[a-f0-9]+)?⟧\s*$/i.exec(String(text || ''))
  if (!match) return 'Pappers-Hall 引用'
  const summary = match[1].replace(/\bbundle=bn-[a-f0-9]+\b/ig, '').trim()
  return 'Pappers-Hall · ' + summary
}

/** History token regex: one complete protocol token anywhere in a text run. */
const HISTORY_TOKEN = /⟦Pappers-Hall[\s\S]*?⟧/g

/** Chrome owned by this plugin must never be rewritten. */
const PLUGIN_CHROME = '.ph-app, .ph-center, .ph-sidebar, .ph-settings, .ph-dock, .ph-refcard, .ph-citetoken-history'

function historyLabel(tokenText) {
  const inner = String(tokenText || '').replace(/^⟦Pappers-Hall\s*/, '').replace(/⟧$/, '')
  const summary = inner.replace(/\s*·\s*bundle=bn-[a-f0-9]+/i, '').replace(/\s+/g, ' ').trim()
  if (summary === '') return '引用材料'
  // The token already carries a shortened note title; trim it further so the
  // chip stays on one line and the question below keeps the visual weight.
  return summary.length > 46 ? summary.slice(0, 45) + '…' : summary
}

/**
 * Split one text node so a citation token becomes a chip while every other
 * character stays in place. The original text node is reused (its value is
 * shortened), so a host re-render that writes to it still owns a live node
 * instead of a detached one.
 */
function decorateTextNode(node) {
  const text = node.nodeValue || ''
  if (!text.includes('⟦Pappers-Hall') || !text.includes('bundle=bn-')) return false
  const parent = node.parentElement
  if (!parent || parent.closest(COMPOSER_SELECTOR) || parent.closest(PLUGIN_CHROME)) return false
  if (parent.closest('[data-ph-citetoken-history="1"]')) return false
  HISTORY_TOKEN.lastIndex = 0
  const spans = []
  let match
  while ((match = HISTORY_TOKEN.exec(text)) !== null) spans.push({ start: match.index, end: match.index + match[0].length, token: match[0] })
  if (spans.length === 0) return false
  const owner = parent
  const ownerText = owner.textContent || ''
  if (!ownerText.includes('⟦Pappers-Hall')) return false
  const pieces = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) pieces.push({ text: text.slice(cursor, span.start) })
    pieces.push({ token: span.token })
    cursor = span.end
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor) })
  // Keep the original text node in place (empty) so a host re-render still owns
  // a live node, then rebuild the original character order after it.
  node.nodeValue = ''
  let anchor = node
  for (const piece of pieces) {
    let next
    if (piece.token !== undefined) {
      next = document.createElement('span')
      next.className = 'ph-citetoken-history'
      next.setAttribute('data-ph-citetoken-history', '1')
      next.setAttribute('data-ph-citetoken-label', historyLabel(piece.token))
      next.setAttribute('title', 'Pappers-Hall 引用材料（原文仍保留，可复制）')
      next.textContent = piece.token
    } else {
      next = document.createTextNode(piece.text)
    }
    anchor.parentNode.insertBefore(next, anchor.nextSibling)
    anchor = next
  }
  return true
}

/** Decorate citation tokens rendered in read-only history (outside the composer). */
function scanHistory() {
  if (typeof document === 'undefined') return
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  const queue = []
  let node = walker.nextNode()
  while (node) {
    const text = node.nodeValue || ''
    if (text.includes('⟦Pappers-Hall') && text.includes('bundle=bn-')) queue.push(node)
    node = walker.nextNode()
  }
  for (const target of queue) {
    try { decorateTextNode(target) } catch (error) { /* never break host rendering */ }
  }
}

function clearTokenMark(element) {
  if (!element || !element.classList) return
  element.classList.remove('ph-citetoken')
  element.removeAttribute('data-ph-citetoken')
  if (element.getAttribute('title') === '已引用 Pappers-Hall 材料') element.removeAttribute('title')
}

function scan() {
  if (typeof document === 'undefined') return
  const composers = document.querySelectorAll(COMPOSER_SELECTOR)
  composers.forEach((composer) => {
    // Drop stale marks first (Lexical may have replaced the subtree).
    composer.querySelectorAll('.ph-citetoken').forEach((element) => {
      if (!isPureToken(element)) clearTokenMark(element)
    })
    const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT, null)
    let node = walker.nextNode()
    while (node) {
      if (TOKEN_PATTERN.test(node.nodeValue || '')) {
        const owner = tokenOwner(node, composer)
        if (owner && isPureToken(owner)) {
          if (!owner.classList.contains('ph-citetoken')) {
            owner.classList.add('ph-citetoken')
            owner.setAttribute('data-ph-citetoken', '1')
            owner.setAttribute('title', '已引用 Pappers-Hall 材料')
          }
        } else if (owner) {
          clearTokenMark(owner)
        }
      }
      node = walker.nextNode()
    }
  })
}

let installed = 0
let observer = null
let timer = null
let frame = null

let historyFrame = null
function schedule() {
  if (frame != null) return
  frame = requestAnimationFrame(() => {
    frame = null
    try { scan() } catch (error) { /* ignore */ }
    if (historyFrame != null) return
    historyFrame = requestAnimationFrame(() => {
      historyFrame = null
      try { scanHistory() } catch (error) { /* ignore */ }
    })
  })
}

/** Install the decorator once; returns an idempotent disposer. */
export function installCitationTokens() {
  installed += 1
  if (typeof document === 'undefined') {
    return () => { installed = Math.max(0, installed - 1) }
  }
  if (!observer) {
    observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    timer = setInterval(schedule, 1500)
    schedule()
    scanHistory()
  }
  return () => {
    installed = Math.max(0, installed - 1)
    if (installed > 0) return
    if (observer) { observer.disconnect(); observer = null }
    if (timer) { clearInterval(timer); timer = null }
    if (frame != null) { cancelAnimationFrame(frame); frame = null }
    if (historyFrame != null) { cancelAnimationFrame(historyFrame); historyFrame = null }
  }
}
