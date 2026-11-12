/** Small text helpers shared by every surface. */

/** First non-empty trimmed string. */
export function firstText() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = arguments[index]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

/** Array or empty array. */
export function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

/** Author list line for cards and details. */
export function authorLine(authors) {
  const list = arrayOf(authors)
  if (list.length === 0) return ''
  const names = list
    .map((author) => {
      if (!author || typeof author !== 'object') return ''
      if (author.family) return [author.given, author.family].filter(Boolean).join(' ')
      return author.literal || ''
    })
    .filter(Boolean)
  if (names.length === 0) return ''
  return list.length > 3 ? names.slice(0, 3).join(', ') + ' et al.' : names.join(', ')
}

/** Display title: Chinese metadata first, then display/original title. */
export function paperTitle(t, paper) {
  if (!paper) return t('common.untitled')
  return firstText(paper.titleZh, paper.displayTitle, paper.title) || t('common.untitled')
}

/** Original-language title, hidden when it equals the display title. */
export function paperOriginalTitle(paper) {
  if (!paper) return ''
  const title = firstText(paper.title)
  if (!title) return ''
  return title === firstText(paper.displayTitle) ? '' : title
}

/** `authors · year · venue` line. */
export function metaLine(t, paper) {
  const parts = []
  parts.push(authorLine(paper && paper.authors) || t('common.unknownAuthors'))
  if (paper && paper.year) parts.push(String(paper.year))
  const venue = firstText(paper && paper.venue, paper && paper.containerTitle)
  if (venue) parts.push(venue)
  return parts.join(' · ')
}

/** Processing-state label for one paper. */
export function processingLabel(t, state) {
  const key = 'page.processing.' + (state || 'pending')
  const label = t(key)
  return label === key ? t('page.processing.pending') : label
}

/** Debounce a fast-changing value (search boxes). */
export function useDebounced(value, delay) {
  return useDebouncedImpl(value, delay)
}

import React from 'react'

function useDebouncedImpl(value, delay) {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay == null ? 260 : delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}
