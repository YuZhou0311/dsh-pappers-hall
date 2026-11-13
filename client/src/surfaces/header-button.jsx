/**
 * Conversation header control that opens the paper drawer. The drawer needs the
 * right sidebar; without a session or subsystem the control renders nothing.
 */
import React from 'react'
import { h } from '../core/dom.js'
import { Icon } from '../core/icons.jsx'

export function HeaderDrawerButton(props) {
  const t = props.t
  const sessionId = props.sessionId
  const [failed, setFailed] = React.useState(false)
  // The drawer opens only from this button: mounting a conversation header must
  // not pull the reading sidebar in on its own.
  if (!sessionId) return null
  return h(
    'span',
    { className: 'ph-hbtn-wrap' },
    h(
      'button',
      {
        type: 'button',
        className: 'ph-hbtn',
        title: t('header.open'),
        'aria-label': t('header.open'),
        onClick: () => {
          const opened = props.openDrawer ? props.openDrawer() : false
          setFailed(!opened)
        },
      },
      h(Icon, { name: 'book', size: 15 }),
      h('span', null, t('header.button')),
    ),
    failed ? h('span', { className: 'ph-hbtn__error', role: 'status' }, t('header.failed')) : null,
  )
}
