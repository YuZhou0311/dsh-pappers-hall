/**
 * Friendly, actionable provider failure card.
 *
 * DSH provider errors (quota exhausted, expired credential, rate limit) are
 * technical strings; this turns them into one consistent message with a direct
 * route to the model-provider settings.
 */
import React from 'react'
import { Icon } from './shared.jsx'

export function providerIssue(reason) {
  const text = String(reason || '')
  if (text === '') return ''
  if (/insufficient|quota|balance|credit|billing|payment|402|额度|余额|欠费|计费|余额不足/i.test(text)) return 'quota'
  if (/api.?key|credential|unauthor|auth(?:entication|orization)?|401|403|token.*(?:invalid|expired)|登录|认证|密钥/i.test(text)) return 'auth'
  if (/rate.?limit|too many requests|429|限流|请求过多/i.test(text)) return 'rate'
  if (/no llm adapter|not composed|no default model|model.*(?:not found|unavailable|unsupported)|模型.*(?:不可用|不存在)/i.test(text)) return 'config'
  return 'error'
}

function copy(t, issue, reason) {
  const key = 'ai.warning.' + issue
  return {
    title: t(key + '.title'),
    body: reason ? t(key + '.body', { reason: reason }) : t(key + '.bodyPlain'),
  }
}

/**
 * @param {object} props
 * @param {object} props.t translator
 * @param {string} [props.reason] raw provider/host reason
 * @param {string} [props.status] `error` / `unavailable`
 * @param {Function} [props.onOpenSettings] open the model settings
 * @param {Function} [props.onRetry] retry the failed action
 * @param {boolean} [props.compact] use inside a narrow panel
 */
export function ProviderWarning(props) {
  const t = props.t
  const reason = String(props.reason || '').trim()
  if (props.status !== 'error' && props.status !== 'unavailable' && reason === '') return null
  const issue = providerIssue(reason)
  const text = copy(t, issue, reason)
  return React.createElement(
    'div',
    { className: 'ph-providerwarning ph-providerwarning--' + issue, role: 'alert' },
    React.createElement('span', { className: 'ph-providerwarning__icon' }, React.createElement(Icon, { name: 'warning', size: 18 })),
    React.createElement(
      'div',
      { className: 'ph-providerwarning__main' },
      React.createElement('div', { className: 'ph-providerwarning__title' }, text.title),
      React.createElement('div', { className: 'ph-providerwarning__body' }, text.body),
    ),
    React.createElement(
      'div',
      { className: 'ph-providerwarning__actions' },
      props.onOpenSettings
        ? React.createElement('button', { type: 'button', className: 'ph-btn ph-btn--primary ph-btn--sm', onClick: props.onOpenSettings }, t('ai.warning.changeProvider'))
        : null,
      props.onRetry
        ? React.createElement('button', { type: 'button', className: 'ph-btn ph-btn--secondary ph-btn--sm', onClick: props.onRetry }, t('common.retry'))
        : null,
    ),
  )
}
