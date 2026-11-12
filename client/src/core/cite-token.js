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

function schedule() {
  if (frame != null) return
  frame = requestAnimationFrame(() => { frame = null; try { scan() } catch (error) { /* ignore */ } })
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
