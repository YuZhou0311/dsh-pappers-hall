/**
 * Stable tag colours (Zotero Tag parity). The palette is expressed purely with
 * design tokens via color-mix so it stays readable in light and dark themes.
 */
const PALETTE = 8

/** Deterministic palette index for a tag name. */
export function tagColor(name) {
  const text = String(name || '')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0
  return Math.abs(hash) % PALETTE
}
