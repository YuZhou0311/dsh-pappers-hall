/**
 * Composer citation-token decorator (v0.12).
 *
 * The Host inserts a plain-text protocol token such as
 * `@论文中心(3 篇论文 · bn-…)` (the Agent parses the `bn-…` id).
 * We never change that text: a MutationObserver marks the rendered composer
 * span with `ph-citetoken` and a tooltip, and CSS turns it into a soft pill.
 * Lexical may re-render the span at any time, so classification is re-run on
 * mutations (and on a slow interval as a safety net).
 */
// A pill is only valid when the element contains EXACTLY one complete token
// (edges may carry whitespace). Lexical may append user text into the same
// span; in that case the span must lose the pill.
const COMPOSER_SELECTOR = '[data-composer-input="true"]'

/** True only when the element has a *direct* child text node containing the token. */
/**
 * Mark the innermost element that directly owns the token text node (usually
 * Lexical's `<span data-lexical-text="true">`). Never walk up to a paragraph:
 * a `<p>` may also contain unrelated user text, and painting the whole
 * paragraph as a pill is wrong. If no direct owner exists (framework wrapped
 * the text), fall back to the nearest span whose whole text is the token.
 */

/** One complete protocol token anywhere inside a text run. */
const TOKEN_IN_TEXT = /@论文中心\s+[^\n]{1,60}?(?=\s{2}|\n|$)|⟦Pappers-Hall[\s\S]*?⟧/g

/** Chrome owned by this plugin that must never be rewritten. */
const PLUGIN_CHROME = '.ph-app, .ph-center, .ph-sidebar, .ph-settings, .ph-dock, .ph-refcard'

function tokenLabel(tokenText) {
  const raw = String(tokenText || '')
  const inner = raw.startsWith('@论文中心')
    ? raw.replace(/^@论文中心\s*/, '').replace(/\)$/, '')
    : raw.replace(/^⟦Pappers-Hall\s*/, '').replace(/⟧$/, '')
  const summary = inner
    .replace(/\s*·\s*(bundle=)?bn-[a-f0-9]+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (summary === '') return '引用材料'
  return summary.length > 46 ? summary.slice(0, 45) + '…' : summary
}

/**
 * Split one text node so a citation token becomes a chip and every other
 * character stays exactly where it was.
 *
 * The original text node is kept (emptied) so a framework re-render that writes
 * to it still owns a live node; the original order is rebuilt after it. The
 * token's own text is preserved inside the chip, so copy and the model still
 * receive the protocol string.
 *
 * @param {Text} node text node possibly containing one or more tokens.
 * @param {'composer'|'history'} surface where the token is rendered.
 * @returns {boolean} whether the node was rewritten.
 */
function decorateTextNode(node, surface) {
  const text = node.nodeValue || ''
  if (!text.includes('@论文中心') && !text.includes('⟦Pappers-Hall')) return false
  const parent = node.parentElement
  if (!parent) return false
  if (parent.closest(PLUGIN_CHROME)) return false
  if (parent.closest(COMPOSER_SELECTOR)) return false
  if (parent.closest('[data-ph-citetoken="1"], .ph-citetoken-history')) return false
  TOKEN_IN_TEXT.lastIndex = 0
  const spans = []
  let match
  while ((match = TOKEN_IN_TEXT.exec(text)) !== null) spans.push({ start: match.index, end: match.index + match[0].length, token: match[0] })
  if (spans.length === 0) return false
  const pieces = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) pieces.push({ text: text.slice(cursor, span.start) })
    pieces.push({ token: span.token })
    cursor = span.end
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor) })
  node.nodeValue = ''
  let anchor = node
  for (const piece of pieces) {
    let next
    if (piece.token !== undefined) {
      next = document.createElement('span')
      const label = tokenLabel(piece.token)
      if (surface === 'composer') {
        next.className = 'ph-citetoken'
        next.setAttribute('data-ph-citetoken', '1')
        next.setAttribute('title', 'Pappers-Hall 引用 · ' + label)
      } else {
        next.className = 'ph-citetoken-history'
        next.setAttribute('data-ph-citetoken-history', '1')
        next.setAttribute('title', 'Pappers-Hall 引用材料（原文保留，可复制）')
      }
      next.setAttribute('data-ph-citetoken-label', label)
      next.textContent = piece.token
    } else {
      next = document.createTextNode(piece.text)
    }
    anchor.parentNode.insertBefore(next, anchor.nextSibling)
    anchor = next
  }
  return true
}

/** Rewrite tokens in both the composer and read-only history. */
function scanTokens() {
  if (typeof document === 'undefined') return
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  const queue = []
  let node = walker.nextNode()
  while (node) {
    const text = node.nodeValue || ''
    if (text.includes('@论文中心') || text.includes('⟦Pappers-Hall')) {
      const parent = node.parentElement
      // The composer is a Lexical editor: splitting its text nodes corrupts the
      // editor state, so the draft keeps the plain (already compact) token.
      if (parent && !parent.closest(COMPOSER_SELECTOR)) queue.push({ node, surface: 'history' })
    }
    node = walker.nextNode()
  }
  for (const entry of queue) {
    try { decorateTextNode(entry.node, entry.surface) } catch (error) { /* never break host rendering */ }
  }
}

let installed = 0
let observer = null
let timer = null
let frame = null

function schedule() {
  if (frame != null) return
  frame = requestAnimationFrame(() => {
    frame = null
    try { scanTokens() } catch (error) { /* ignore */ }
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
  }
  return () => {
    installed = Math.max(0, installed - 1)
    if (installed > 0) return
    if (observer) { observer.disconnect(); observer = null }
    if (timer) { clearInterval(timer); timer = null }
    if (frame != null) { cancelAnimationFrame(frame); frame = null }
  }
}
