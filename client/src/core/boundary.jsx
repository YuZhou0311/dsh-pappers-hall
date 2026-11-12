/**
 * Error boundary used around every slot body: a render crash shows a local retry
 * panel instead of blanking the sidebar or the main column.
 */
import React from 'react'
import { h } from '../core/dom.js'
import { EmptyState } from './primitives.jsx'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
    this.retry = this.retry.bind(this)
  }

  static getDerivedStateFromError(error) {
    return { error: error }
  }

  componentDidCatch(error, info) {
    console.error('[pappers-hall] UI crashed in ' + (this.props.surface || 'panel'), error, info)
  }

  retry() {
    this.setState({ error: null })
  }

  render() {
    const t = this.props.t || ((key) => key)
    if (this.state.error) {
      return h(
        'div',
        { className: 'ph-boundary' },
        h(EmptyState, {
          icon: 'warning',
          tone: 'error',
          title: t('common.error.title'),
          desc: t('common.error.desc', {
            message: this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error),
          }),
          action: h(
            'button',
            { type: 'button', className: 'ph-btn ph-btn--secondary ph-btn--sm', onClick: this.retry },
            t('common.error.retry'),
          ),
        }),
      )
    }
    return this.props.children
  }
}

/** Wrap one surface component into an error boundary with localized fallback. */
export function withBoundary(Component, surface) {
  return function PappersHallBoundary(props) {
    return h(ErrorBoundary, { t: props.t, surface: surface || Component.name }, h(Component, props))
  }
}
