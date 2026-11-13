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
  // The conversation drawer is the default reading surface in a chat. Open it
  // once per browser session so switching back from notes/papers does not leave
  // the user in a bare chat with a hidden sidebar.
  React.useEffect(() => {
    if (!sessionId || !props.openDrawer) return undefined
    try {
      if (window.sessionStorage.getItem('ph-drawer-autopen') === '1') return undefined
      window.sessionStorage.setItem('ph-drawer-autopen', '1')
    } catch {
      /* storage can be unavailable in a locked-down webview */
    }
    const timer = setTimeout(() => {
      try { props.openDrawer() } catch { /* host sidebar may not be ready yet */ }
    }, 450)
    return () => clearTimeout(timer)
  }, [sessionId, props.openDrawer])
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
