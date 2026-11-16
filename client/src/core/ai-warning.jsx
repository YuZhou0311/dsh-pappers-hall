/**
 * One shared warning card for every AI/provider failure.
 *
 * DSH providers return technical quota/auth/rate-limit messages. Keeping the
 * classification and the “change provider” action here means every AI surface
 * (reader, selection translation, notes, settings) behaves the same way and
 * future provider changes only need one file touched.
 */
import React from 'react'
import { Icon } from './icons.jsx'
import { bus } from './bus.js'

export function providerIssue(reason) {
  const text = String(reason || '')
  if (text === '') return ''
  if (/insufficient|quota|balance|credit|billing|payment|402|额度|余额|欠费|计费|余额不足/i.test(text)) return 'quota'
  if (/api.?key|credential|unauthor|auth(?:entication|orization)?|401|403|token.*(?:invalid|expired)|登录|认证|密钥/i.test(text)) return 'auth'
  if (/rate.?limit|too many requests|429|限流|请求过多/i.test(text)) return 'rate'
  if (/no llm adapter|not composed|no default model|model.*(?:not found|unavailable|unsupported)|模型.*(?:不可用|不存在)/i.test(text)) return 'config'
  return 'error'
}

export function openModelSettings() {
  try { bus.emit('open-settings') } catch (error) { console.warn('[pappers-hall] open settings failed', error) }
}

/** @param {{t:Function, reason?:string, status?:string, onOpenSettings?:Function, onRetry?:Function, compact?:boolean}} props */
export function AiWarning(props) {
  const t = props.t
  const reason = String(props.reason || '').trim()
  if (props.status !== 'error' && props.status !== 'unavailable' && reason === '') return null
  const issue = providerIssue(reason)
  // Reader callers pass a `rt` translator that prefixes keys with `reader.`.
  // Resolve both the global key and its reader message-table fallback so one
  // warning component works in every surface.
  const tr = (key, params) => {
    const direct = t(key, params)
    if (direct && direct !== key && !String(direct).startsWith('reader.')) return direct
    if (direct && String(direct).startsWith('reader.')) {
      const fallback = t(String(direct), params)
      if (fallback && fallback !== direct) return fallback
    }
    return direct
  }
  const title = tr('ai.warning.' + issue + '.title')
  const body = tr('ai.warning.' + issue + '.bodyPlain')
  const open = props.onOpenSettings || openModelSettings
  return React.createElement(
    'div',
    { className: 'ph-providerwarning ph-providerwarning--' + issue + (props.compact ? ' ph-providerwarning--compact' : ''), role: 'alert' },
    React.createElement('span', { className: 'ph-providerwarning__icon' }, React.createElement(Icon, { name: 'warning', size: 18 })),
    React.createElement(
      'div',
      { className: 'ph-providerwarning__main' },
      React.createElement('div', { className: 'ph-providerwarning__title' }, title),
      React.createElement('div', { className: 'ph-providerwarning__body' }, body),
      reason
        ? React.createElement('details', { className: 'ph-providerwarning__details' },
            React.createElement('summary', null, tr('ai.warning.details')),
            React.createElement('code', null, reason),
          )
        : null,
    ),
    React.createElement(
      'div',
      { className: 'ph-providerwarning__actions' },
      props.showSettings === false ? null : React.createElement('button', { type: 'button', className: 'ph-btn ph-btn--primary ph-btn--sm', onClick: open }, tr('ai.warning.changeProvider')),
      props.onRetry ? React.createElement('button', { type: 'button', className: 'ph-btn ph-btn--secondary ph-btn--sm', onClick: props.onRetry }, tr('common.retry')) : null,
      props.extra || null,
    ),
  )
}

export const ProviderWarning = AiWarning
