/** Browser file helpers shared by import, export and clipboard actions. */

/** Human byte size. */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return (unit === 0 ? String(Math.round(scaled)) : scaled.toFixed(1)) + ' ' + units[unit]
}

/** Read a browser File as a base64 data URL. */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

/** Strip the `data:*;base64,` prefix the Host contract does not expect. */
export function dataUrlPayload(dataUrl) {
  const text = String(dataUrl || '')
  const comma = text.indexOf(',')
  return comma >= 0 ? text.slice(comma + 1) : text
}

/** Guess the Host import format from a file name. */
export function importFormatOf(name) {
  const lower = String(name || '').toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.bib') || lower.endsWith('.bibtex')) return 'bibtex'
  if (lower.endsWith('.ris')) return 'ris'
  if (lower.endsWith('.json')) return 'csljson'
  return undefined
}

/** Trigger a browser download for exported text without leaking the blob URL. */
export function downloadText(filename, mediaType, content) {
  try {
    const blob = new Blob([String(content == null ? '' : content)], { type: mediaType || 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename || 'pappers-hall-export.txt'
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* nothing to clean up */
      }
    }, 5000)
    return true
  } catch (error) {
    console.error('[pappers-hall] export download failed', error)
    return false
  }
}

/** Copy text to the clipboard, degrading to a resolved false. */
export async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(String(text == null ? '' : text))
      return true
    }
  } catch {
    /* fall through */
  }
  return false
}
