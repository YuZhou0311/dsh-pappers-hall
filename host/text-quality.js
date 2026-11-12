/**
 * Text-layer quality assessment and cheap repair helpers (v0.17).
 *
 * Some publisher/TeX PDFs embed fonts without a usable ToUnicode map, so poppler
 * returns glyph codes instead of letters. A whole page can look like
 * "4XHVWLRQ $VLGH IURP WKH $SSOH 5HPRWH" while the rendered page is perfectly
 * readable. Feeding that text to the LLM, annotations, citations or translation
 * silently corrupts scientific content, so every read path that hands paper text
 * to a model goes through this module first.
 *
 * The detector is intentionally conservative and explainable:
 * - Caesar/Type1 artifact words (WKH, DQG, RI, LV, IRU, ZLWK, ...) are a strong
 *   signal that letters were shifted by a constant offset.
 * - A very low ratio of English function words plus many symbol-mixed tokens is
 *   the generic "not real prose" signal.
 * - Very short strings (captions, headings) are never judged as garbage.
 *
 * @module pappers-hall/host/text-quality
 */

/** English function words used as a prose signal (kept small and explicit). */
const FUNCTION_WORDS = new Set([
  'the', 'of', 'and', 'to', 'in', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'for', 'with', 'that', 'this', 'these', 'those', 'we', 'our', 'you', 'it', 'its',
  'as', 'on', 'at', 'by', 'from', 'not', 'can', 'may', 'have', 'has', 'had', 'will',
  'would', 'should', 'could', 'study', 'paper', 'results', 'result', 'method', 'methods',
  'model', 'models', 'data', 'figure', 'table', 'using', 'used', 'show', 'shows', 'shown',
  'between', 'within', 'during', 'than', 'then', 'also', 'such', 'more', 'most', 'other',
  'into', 'over', 'under', 'about', 'which', 'when', 'where', 'while', 'because', 'however',
])

/** Words produced by shifting common English words +3 (the observed artifact). */
const CAESAR_WORDS = new Set([
  'wkh', 'dqg', 'ri', 'lv', 'iru', 'zlwk', 'wklv', 'iurp', 'duh', 'zdv', 'qrw', 'fdq',
  'doo', 'exw', 'kdyh', 'kdv', 'iurp', 'wkuhh', 'wzr', 'rqh', 'zklfk', 'wkhlu', 'wkhuh',
  'pruh', 'prvw', 'rwkhu', 'lqwr', 'ryhu', 'xqghu', 'derxw', 'ehwzhhq', 'zlwklq', 'gxulqj',
])

const SYMBOL_MIX_RE = /[A-Za-z]{3,}[0-9$:()\[\]{}@#%^&*+=]{1,}[A-Za-z]{2,}/

/** Split into alphabetic words. */
function wordsOf(text) {
  return String(text ?? '').match(/[A-Za-z]{2,}/g) ?? []
}

/**
 * Assess whether a text run is usable prose.
 * @param {string} text candidate text.
 * @returns {{ok:boolean, score:number, kind:string|null, reasons:string[], words:number}} verdict.
 */
export function assessTextQuality(text) {
  const value = String(text ?? '').trim()
  const words = wordsOf(value)
  const reasons = []
  if (value.length < 120 || words.length < 20) {
    return { ok: true, score: 1, kind: null, reasons: ['too_short_to_judge'], words: words.length }
  }
  const lower = words.map((word) => word.toLowerCase())
  const functionRatio = lower.filter((word) => FUNCTION_WORDS.has(word)).length / words.length
  const caesarHits = lower.filter((word) => CAESAR_WORDS.has(word)).length
  const caesarRatio = caesarHits / words.length
  const symbolMixed = (value.match(new RegExp(SYMBOL_MIX_RE.source, 'g')) ?? []).length / words.length
  const vowelLess = words.filter((word) => word.length >= 4 && !/[aeiouyAEIOUY]/.test(word)).length / words.length
  if (caesarHits >= 3 || caesarRatio >= 0.02) reasons.push(`caesar_artifact:${caesarHits}`)
  if (symbolMixed >= 0.05) reasons.push(`symbol_mixed:${symbolMixed.toFixed(2)}`)
  if (vowelLess >= 0.18) reasons.push(`vowel_less:${vowelLess.toFixed(2)}`)
  if (functionRatio < 0.06) reasons.push(`few_function_words:${functionRatio.toFixed(3)}`)
  const cipher = caesarHits >= 3 || caesarRatio >= 0.02
  const ok = !cipher && symbolMixed < 0.05 && vowelLess < 0.18 && functionRatio >= 0.06
  return {
    ok,
    score: Number(functionRatio.toFixed(4)),
    kind: cipher ? 'cipher' : ok ? null : 'low_prose',
    reasons,
    words: words.length,
  }
}

/**
 * Cheap deterministic repair for the common "+3 letter shift" font artifact.
 * Digits/symbol substitutions are NOT guessed; the caller must re-assess the
 * result and prefer OCR whenever it is available.
 * @param {string} text candidate text.
 * @returns {string|null} shifted text, or null when shifting does not help.
 */
export function repairCaesarShift(text) {
  const value = String(text ?? '')
  if (value === '') return null
  const shifted = value.replace(/[A-Za-z]/g, (char) => {
    const code = char.charCodeAt(0)
    const base = code >= 97 ? 97 : 65
    return String.fromCharCode(((code - base - 3 + 26) % 26) + base)
  })
  const before = assessTextQuality(value)
  const after = assessTextQuality(shifted)
  if (after.ok === true && before.ok === false) return shifted
  if (after.reasons.length < before.reasons.length && after.score > before.score) return shifted
  return null
}


/**
 * Detect cipher/glyph-code text even for short strings (quotes, figure labels)
 * where {@link assessTextQuality} deliberately abstains from judging.
 * @param {string} text candidate text.
 * @returns {boolean} true when the text looks like shifted/garbled glyph codes.
 */
export function looksLikeCipherText(text) {
  const value = String(text ?? '').trim()
  const words = wordsOf(value)
  if (words.length === 0) return false
  const lower = words.map((word) => word.toLowerCase())
  const caesarHits = lower.filter((word) => CAESAR_WORDS.has(word)).length
  if (caesarHits >= 2) return true
  if (caesarHits >= 1 && words.length <= 12) return true
  if (/[A-Za-z]{3,}[0-9$:()\[\]{}@#%^&*+=]{1,}[A-Za-z]{2,}/.test(value)) return true
  return false
}
