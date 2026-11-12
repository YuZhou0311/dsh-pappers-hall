/**
 * Translation-engine settings sheet (sidebar gear + main panel entry).
 * Reads/writes the shared translationStore; settings apply instantly.
 */
import React from 'react'
import { h } from '../../core/dom.js'
import { Icon } from '../../core/icons.jsx'
import { Badge, Button, Check, IconButton } from '../../core/primitives.jsx'
import { describeError } from '../../core/api.js'
import { translationStore, providerLabel } from '../../core/translation.js'

const TEST_TEXT = 'We propose a general paradigm that combines reasoning and acting.'

export function TranslationSheet(props) {
  const t = props.t
  const snapshot = React.useSyncExternalStore(translationStore.subscribe, translationStore.getSnapshot, translationStore.getSnapshot)
  const [busy, setBusy] = React.useState('')
  const [test, setTest] = React.useState(null)
  const [error, setError] = React.useState('')
  const settings = snapshot.settings || { provider: 'auto', fallback: true }
  const providers = snapshot.providers || []

  React.useEffect(() => {
    if (props.open) translationStore.refresh().catch((err) => setError(describeError(t, err)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open])

  if (!props.open) return null

  const choose = (provider) => {
    if (busy) return
    setBusy(provider)
    setError('')
    translationStore.setProvider(provider)
      .catch((err) => setError(describeError(t, err)))
      .then(() => setBusy(''))
  }
  const runTest = () => {
    if (busy) return
    setBusy('test')
    setError('')
    translationStore.test(TEST_TEXT)
      .then((result) => setTest(result))
      .catch((err) => setError(describeError(t, err)))
      .then(() => setBusy(''))
  }
  const options = [{ id: 'auto', free: true }, { id: 'google', free: true, unofficial: true }, { id: 'mymemory', free: true }, { id: 'llm', free: false }, { id: 'libretranslate', free: true }]
  const providerOf = (id) => providers.find((provider) => provider.id === id) || null

  return h(
    'div',
    { className: 'ph-sheetbackdrop', 'data-ph-sheet': 'translation', onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() } },
    h(
      'div',
      { className: 'ph-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('translation.settings.title') },
      h(
        'div',
        { className: 'ph-sheet__head' },
        h(Icon, { name: 'globe', size: 15 }),
        h('span', { className: 'ph-sheet__title' }, t('translation.settings.title')),
        h(IconButton, { icon: 'close', title: t('common.close'), onClick: props.onClose }),
      ),
      h(
        'div',
        { className: 'ph-sheet__body ph-scroll' },
        h('div', { className: 'ph-sheet__sectionTitle' }, t('translation.settings.engine')),
        h(
          'div',
          { className: 'ph-enginelist', role: 'radiogroup' },
          options.map((option) => {
            const info = providerOf(option.id)
            const active = settings.provider === option.id
            return h(
              'button',
              {
                key: option.id,
                type: 'button',
                role: 'radio',
                'aria-checked': active ? 'true' : 'false',
                className: 'ph-engine' + (active ? ' ph-engine--active' : ''),
                onClick: () => choose(option.id),
                disabled: Boolean(busy),
              },
              h('span', { className: 'ph-engine__dot' + (active ? ' ph-engine__dot--active' : '') }),
              h(
                'span',
                { className: 'ph-engine__main' },
                h('span', { className: 'ph-engine__label' }, providerLabel(t, option.id)),
                h(
                  'span',
                  { className: 'ph-engine__hint' },
                  option.id === 'auto'
                    ? t('translation.settings.autoHint')
                    : option.id === 'google'
                      ? t('translation.settings.googleHint')
                      : option.id === 'mymemory'
                        ? t('translation.settings.myMemoryHint')
                        : option.id === 'llm'
                          ? t('translation.settings.llmHint')
                          : t('translation.settings.libreHint'),
                ),
              ),
              option.unofficial ? h(Badge, { tone: 'warning' }, t('translation.settings.unofficial')) : null,
              option.free ? h(Badge, { tone: 'muted' }, t('translation.settings.free')) : null,
              info && info.lastLatencyMs ? h('span', { className: 'ph-caption' }, info.lastLatencyMs + 'ms') : null,
              info && info.available === false ? h(Badge, { tone: 'error' }, t('translation.settings.unavailable')) : null,
            )
          }),
        ),
        h('div', { className: 'ph-sheet__row' }, h(Check, { checked: settings.fallback !== false, onChange: (value) => translationStore.setFallback(value).catch((err) => setError(describeError(t, err))), label: t('translation.settings.fallback') })),
        h('div', { className: 'ph-caption' }, t('translation.settings.fallbackHint')),
        h('div', { className: 'ph-sheet__sectionTitle' }, t('translation.settings.testTitle')),
        h('div', { className: 'ph-caption' }, TEST_TEXT),
        h(
          'div',
          { className: 'ph-sheet__testrow' },
          h(Button, { size: 'sm', variant: 'primary', icon: 'play', loading: busy === 'test', onClick: runTest }, t('translation.settings.test')),
          busy && busy !== 'test' ? h('span', { className: 'ph-caption' }, t('common.loading')) : null,
        ),
        test
          ? h(
              'div',
              { className: 'ph-testresult' + (test.ok ? '' : ' ph-testresult--error') },
              h('div', { className: 'ph-testresult__head' }, h(Badge, { tone: test.ok ? 'success' : 'error' }, test.ok ? t('translation.settings.testOk') : t('translation.settings.testFailed')), h('span', { className: 'ph-caption' }, (test.ok ? providerLabel(t, test.provider) : test.provider || t('translation.settings.noProvider')) + ' · ' + test.latencyMs + 'ms · ' + (test.cached ? t('translation.settings.cached') : t('translation.settings.live')))),
              test.translation ? h('div', { className: 'ph-testresult__text' }, test.translation) : h('div', { className: 'ph-testresult__text ph-caption' }, test.reason || t('common.unavailable')),
            )
          : null,
        error ? h('div', { className: 'ph-caption ph-caption--error', role: 'status' }, error) : null,
        h('div', { className: 'ph-disclaimer' }, h(Icon, { name: 'warning', size: 13 }), h('span', null, t('translation.settings.disclaimer'))),
      ),
      h(
        'div',
        { className: 'ph-sheet__foot' },
        h('span', { className: 'ph-caption' }, t('translation.settings.current') + ': ' + providerLabel(t, settings.provider) + (snapshot.lastTest ? ' · ' + snapshot.lastTest.latencyMs + 'ms' : '')),
        h('span', { className: 'ph-spacer' }),
        h(Button, { size: 'sm', variant: 'secondary', onClick: (event) => { event.stopPropagation(); props.onClose() } }, t('translation.settings.done')),
      ),
    ),
  )
}
