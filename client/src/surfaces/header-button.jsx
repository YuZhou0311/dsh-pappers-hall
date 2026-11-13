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
  const openDrawerRef = React.useRef(props.openDrawer)
  openDrawerRef.current = props.openDrawer
  const autoOpenedRef = React.useRef(false)
  // The conversation drawer is the default reading surface in a chat. Open it
  // when a conversation header mounts, retrying until the host right sidebar is
  // ready. The ref guard prevents header re-renders from resetting the timer.
  React.useEffect(() => {
    if (!sessionId || autoOpenedRef.current) return undefined
    autoOpenedRef.current = true
    let cancelled = false
    let attempts = 0
    let timer = null
    const tryOpen = () => {
      if (cancelled || attempts >= 12) return
      attempts += 1
      let opened = false
      try { opened = Boolean(openDrawerRef.current && openDrawerRef.current()) } catch { opened = false }
      if (!opened) timer = setTimeout(tryOpen, 500)
    }
    timer = setTimeout(tryOpen, 500)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [sessionId])
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
