/**
 * Dependency-free Markdown renderer for AI answers (v0.13).
 *
 * Renders React nodes only (never dangerouslySetInnerHTML), so model output can
 * never inject HTML. Supports headings 1–6, bold/italic, inline code, fenced
 * code blocks, unordered/ordered lists, blockquotes, horizontal rules, links,
 * simple tables and paragraph line breaks. The raw markers are consumed here,
 * so the UI never shows `##` or `**`.
 */
import React from 'react'

const INLINE_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g
const SAFE_URL = /^(https?:\/\/|mailto:)/i

function inlineNodes(text, keyPrefix) {
  const nodes = []
  let rest = String(text == null ? '' : text)
  let index = 0
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g
  let match
  let buffer = ''
  const flush = () => {
    if (!buffer) return
    nodes.push(buffer)
    buffer = ''
  }
  while ((match = pattern.exec(rest)) !== null) {
    if (match.index > index) buffer += rest.slice(index, match.index)
    const token = match[0]
    const key = keyPrefix + '-' + (nodes.length + 1)
    if (token.startsWith('`') && token.endsWith('`')) {
      flush()
      nodes.push(React.createElement('code', { key: key, className: 'ph-ai-md__code' }, token.slice(1, -1)))
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      flush()
      nodes.push(React.createElement('strong', { key: key }, token.slice(2, -2)))
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      flush()
      nodes.push(React.createElement('em', { key: key }, token.slice(1, -1)))
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link && SAFE_URL.test(link[2])) {
        flush()
        nodes.push(React.createElement('a', { key: key, href: link[2], target: '_blank', rel: 'noopener noreferrer' }, link[1]))
      } else {
        buffer += token
      }
    } else {
      buffer += token
    }
    index = pattern.lastIndex
  }
  if (index < rest.length) buffer += rest.slice(index)
  flush()
  return nodes
}

function splitRow(line) {
  return String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(String(line || ''))
}

/** Render Markdown text as React nodes. */
export function renderMarkdown(text, options) {
  const keyPrefix = (options && options.keyPrefix) || 'md'
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let seq = 0
  const nextKey = () => keyPrefix + '-' + (seq += 1)

  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i += 1; continue }

    // fenced code block
    const fence = /^\s*```([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const language = fence[1] || ''
      const code = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1 }
      i += 1
      blocks.push(
        React.createElement(
          'pre',
          { key: nextKey(), className: 'ph-ai-md__pre' },
          React.createElement('code', { className: 'ph-ai-md__codeblock', 'data-language': language || undefined }, code.join('\n')),
        ),
      )
      continue
    }

    // heading
    const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      const level = heading[1].length
      blocks.push(React.createElement('h' + level, { key: nextKey(), className: 'ph-ai-md__h ph-ai-md__h' + level }, inlineNodes(heading[2], nextKey())))
      i += 1
      continue
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(React.createElement('hr', { key: nextKey(), className: 'ph-ai-md__hr' }))
      i += 1
      continue
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i += 1 }
      blocks.push(React.createElement('blockquote', { key: nextKey(), className: 'ph-ai-md__quote' }, renderMarkdown(quote.join('\n'), { keyPrefix: nextKey() })))
      continue
    }

    // table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1 }
      blocks.push(
        React.createElement(
          'div',
          { key: nextKey(), className: 'ph-ai-md__tablewrap' },
          React.createElement(
            'table',
            { className: 'ph-ai-md__table' },
            React.createElement('thead', null, React.createElement('tr', null, header.map((cell, index) => React.createElement('th', { key: index }, inlineNodes(cell, nextKey()))))),
            React.createElement('tbody', null, rows.map((row, rowIndex) => React.createElement('tr', { key: rowIndex }, row.map((cell, cellIndex) => React.createElement('td', { key: cellIndex }, inlineNodes(cell, nextKey())))))),
          ),
        ),
      )
      continue
    }

    // lists (one nesting level)
    const isUnordered = /^\s*[-*+]\s+/.test(line)
    const isOrdered = /^\s*\d+[.)]\s+/.test(line)
    if (isUnordered || isOrdered) {
      const ordered = isOrdered
      const items = []
      while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
        i += 1
      }
      blocks.push(
        React.createElement(
          ordered ? 'ol' : 'ul',
          { key: nextKey(), className: 'ph-ai-md__list' },
          items.map((item, index) => React.createElement('li', { key: index }, inlineNodes(item, nextKey()))),
        ),
      )
      continue
    }

    // paragraph (soft line breaks stay as <br/>)
    const paragraph = [line]
    i += 1
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(#{1,6}\s|```|>\s?|\||[-*+]\s+|\d+[.)]\s+)/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) {
      paragraph.push(lines[i])
      i += 1
    }
    const children = []
    paragraph.forEach((part, row) => {
      const pieces = inlineNodes(part, nextKey())
      pieces.forEach((piece, index) => children.push(React.isValidElement(piece) ? React.cloneElement(piece, { key: nextKey() }) : piece))
      if (row < paragraph.length - 1) children.push(React.createElement('br', { key: nextKey() }))
    })
    blocks.push(React.createElement('p', { key: nextKey(), className: 'ph-ai-md__p' }, children))
  }
  return blocks
}

/** Convenience component: `<Markdown text={answer} />`. */
export function Markdown(props) {
  return React.createElement('div', { className: 'ph-ai-md ' + (props && props.className ? props.className : '') }, renderMarkdown(props && props.text, { keyPrefix: (props && props.keyPrefix) || 'md' }))
}
