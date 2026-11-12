/**
 * Plugin-level settings host (v0.11 polish).
 *
 * The settings panel must open from surfaces that are NOT inside the Paper
 * Center (notably the conversation drawer). This host is mounted in a few
 * always-present slots (sidebar entry + composer dock) and elects exactly one
 * renderer via a module-level singleton, so the panel never renders twice.
 * All gears only `bus.emit('open-settings')`.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { bus } from '../../core/bus.js'
import { SettingsPanel } from './panel.jsx'

let hostState = { open: false, hostId: null, nextId: 1, version: 0 }
const listeners = new Set()
function emit() {
  hostState = Object.assign({}, hostState, { version: hostState.version + 1 })
  listeners.forEach((listener) => { try { listener() } catch (error) { /* ignore */ } })
}
function subscribe(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function getSnapshot() {
  return hostState
}

export function openSettings() {
  hostState = Object.assign({}, hostState, { open: true })
  emit()
}
export function closeSettings() {
  hostState = Object.assign({}, hostState, { open: false })
  emit()
}
export function isSettingsOpen() {
  return hostState.open
}

export function SettingsHost(props) {
  const t = props && props.t
  const [id] = React.useState(() => hostState.nextId++)
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  React.useEffect(() => {
    if (hostState.hostId === null) { hostState = Object.assign({}, hostState, { hostId: id }); emit() }
    return () => {
      if (hostState.hostId === id) { hostState = Object.assign({}, hostState, { hostId: null }); emit() }
    }
  }, [id])
  React.useEffect(() => bus.on('open-settings', () => openSettings()), [])
  if (snapshot.hostId !== id || !snapshot.open) return null
  return h(
    'div',
    {
      className: 'ph-settings-host',
      // The host is mounted inside the Paper Center panellist button in one of
      // its slots; without this guard closing the panel also selected that panel
      // and left the conversation. Bubble-phase only, so the panel's own
      // backdrop/close handlers still run first.
      onClick: (event) => event.stopPropagation(),
      onMouseDown: (event) => event.stopPropagation(),
    },
    h(SettingsPanel, { open: true, onClose: closeSettings, t: t }),
  )
}
