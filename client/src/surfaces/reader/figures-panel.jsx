/**
 * Reader "图表" tab: extracted figures/tables with thumbnails. Cards are
 * draggable into the open note (the note drop target reads the shared
 * `application/x-pappers-hall-material` payload).
 */
import React from 'react'
import { dragProps } from '../../core/dnd.js'
import { Btn, Empty, Icon, Spinner } from './shared.jsx'

export function ReaderFiguresPanel(props) {
  const t = props.t
  const [state, setState] = React.useState({ status: 'loading', items: [], error: null })
  React.useEffect(() => {
    let alive = true
    setState({ status: 'loading', items: [], error: null })
    Promise.resolve(props.api('figures.list', { paperId: props.paperId }))
      .then((result) => {
        if (!alive) return
        const items = Array.isArray(result) ? result : Array.isArray(result && result.items) ? result.items : []
        setState({ status: 'ready', items, error: null })
      })
      .catch((error) => {
        if (alive) setState({ status: 'error', items: [], error })
      })
    return () => { alive = false }
  }, [props.api, props.paperId])

  if (state.status === 'loading') return React.createElement('div', { className: 'ph-r-side__loading' }, React.createElement(Spinner, { size: 14 }), t('reader.figures.loading'))
  if (state.status === 'error') return React.createElement(Empty, { icon: 'warning', title: t('reader.figures.failed'), desc: String((state.error && state.error.message) || state.error) })
  if (state.items.length === 0) return React.createElement(Empty, { icon: 'image', title: t('reader.figures.empty'), desc: t('reader.figures.emptyHint') })

  return React.createElement(
    'div',
    { className: 'ph-r-figures' },
    React.createElement('p', { className: 'ph-r-side__hint' }, t('reader.figures.hint')),
    state.items.map((figure) => {
      const material = {
        kind: 'figure',
        id: figure.id,
        figureId: figure.id,
        paperId: figure.paperId || props.paperId,
        page: Number(figure.page) || 1,
        label: figure.label || '',
        title: figure.label || '',
        caption: figure.caption || '',
        paperTitle: (props.paper && (props.paper.titleZh || props.paper.title)) || '',
        imageUrl: figure.imageUrl || '',
        bbox: figure.bbox || null,
      }
      return React.createElement(
        'figure',
        { key: figure.id, className: 'ph-r-figcard', ...dragProps(t, [material], { source: 'reader' }) },
        React.createElement(
          'button',
          { type: 'button', className: 'ph-r-figcard__media', onClick: () => props.onOpenFigure && props.onOpenFigure(figure) },
          React.createElement('img', { src: figure.thumbnailUrl || figure.imageUrl, alt: figure.label || '', loading: 'lazy', draggable: false }),
        ),
        React.createElement(
          'figcaption',
          null,
          React.createElement('strong', null, figure.label || '?'),
          React.createElement('span', null, t('reader.figures.page', { page: Number(figure.page) || 1 })),
        ),
        figure.caption ? React.createElement('p', { className: 'ph-r-figcard__cap' }, figure.caption) : null,
        React.createElement(Btn, { size: 'sm', variant: 'soft', icon: 'plus', onClick: () => props.onOpenNoteInsert && props.onOpenNoteInsert(material) }, t('reader.figures.insertNow')),
      )
    }),
  )
}
