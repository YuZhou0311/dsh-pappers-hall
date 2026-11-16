/**
 * Onboarding checklist cards.
 *
 * `OnboardingChecklist` is the docked card in the library: six real tasks whose
 * state comes from the library itself, each row performing the action that gets
 * it done. `OnboardingCoach` is the small in-reader chip that points at the next
 * unfinished action while the sample paper is open.
 */
import React from 'react'
import { h } from '../core/dom.js'
import { Icon } from '../core/icons.jsx'
import { Button, IconButton } from '../core/primitives.jsx'
import { describeError } from '../core/api.js'
import { bus } from '../core/bus.js'
import { onboardingStore } from '../core/onboarding.js'

const TASK_ORDER = ['component', 'sample', 'read', 'annotate', 'note', 'cite']
const TASK_ICONS = { component: 'cpu', sample: 'download', read: 'book', annotate: 'highlighter', note: 'note', cite: 'quote' }

/** Subscribe to the store and poll while mounted. */
function useOnboarding() {
  const snapshot = React.useSyncExternalStore(onboardingStore.subscribe, onboardingStore.getSnapshot, onboardingStore.getSnapshot)
  React.useEffect(() => {
    onboardingStore.startPolling()
    return () => onboardingStore.stopPolling()
  }, [])
  return snapshot
}

/** One row in the checklist. */
function TaskRow(props) {
  const t = props.t
  const { task, isNext, busy, onAction } = props
  const label = t('onboarding.task.' + task.id)
  const hint = t('onboarding.task.' + task.id + '.hint')
  return h(
    'div',
    { className: 'ph-onbtask' + (task.done ? ' is-done' : '') + (isNext ? ' is-next' : ''), title: label + '\n' + hint },
    h('span', { className: 'ph-onbtask__dot', 'aria-hidden': 'true' }, task.done ? h(Icon, { name: 'check', size: 11 }) : null),
    h('span', { className: 'ph-onbtask__label' }, label),
    task.done
      ? null
      : h(IconButton, {
          icon: TASK_ICONS[task.id] || 'arrowRight',
          title: t('onboarding.task.' + task.id + '.action'),
          'aria-label': t('onboarding.task.' + task.id + '.action'),
          disabled: busy === task.id,
          active: isNext,
          onClick: () => onAction(task.id),
        }),
  )
}

export function OnboardingChecklist(props) {
  const t = props.t
  const snapshot = useOnboarding()
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const openPaper = props.onOpenPaper
  const expanded = snapshot.state === null ? true : snapshot.state.expanded !== false
  const tasks = TASK_ORDER.map((id) => {
    const found = (snapshot.tasks || []).find((task) => task.id === id)
    return { id, done: found !== undefined && found.done === true }
  })

  if (snapshot.loaded !== true || snapshot.visible !== true) return null

  const openSample = () => {
    const paperId = snapshot.sample && snapshot.sample.paperId ? snapshot.sample.paperId : null
    if (paperId !== null && typeof openPaper === 'function') { openPaper(paperId, 1); return true }
    return false
  }

  const run = (taskId) => {
    setError('')
    if (taskId === 'component') { bus.emit('open-settings'); return }
    if (taskId === 'sample') {
      setBusy('sample')
      onboardingStore.importSample()
        .then((paperId) => { if (paperId !== null && typeof props.onImported === 'function') props.onImported(paperId) })
        .catch((failure) => setError(describeError(t, failure)))
        .then(() => setBusy(''))
      return
    }
    if (taskId === 'cite') { bus.emit('pappers-hall:open-drawer'); return }
    // read / annotate / note all happen inside the sample paper.
    if (openSample() !== true) {
      setBusy('sample')
      onboardingStore.importSample()
        .then((paperId) => { if (paperId !== null && typeof openPaper === 'function') openPaper(paperId, 1) })
        .catch((failure) => setError(describeError(t, failure)))
        .then(() => setBusy(''))
    }
  }

  const percent = Math.round((snapshot.doneCount / Math.max(1, snapshot.total)) * 100)

  return h(
    'div',
    { className: 'ph-onbcard' + (expanded ? '' : ' ph-onbcard--collapsed'), role: 'region', 'aria-label': t('onboarding.card.title') },
    h('div', { className: 'ph-onbcard__head' },
      h('span', { className: 'ph-onbcard__title' },
        h(Icon, { name: 'compass', size: 14 }),
        h('span', null, t('onboarding.card.title')),
      ),
      h('span', { className: 'ph-onbcard__count' }, t('onboarding.card.count', { done: snapshot.doneCount, total: snapshot.total })),
      h(IconButton, {
        icon: expanded ? 'chevronUp' : 'chevronDown',
        title: expanded ? t('onboarding.card.collapse') : t('onboarding.card.expand'),
        onClick: () => onboardingStore.toggleExpanded(!expanded),
      }),
    ),
    expanded
      ? h(
          React.Fragment,
          null,
          h('div', { className: 'ph-onbcard__tasks' }, tasks.map((task) =>
            h(TaskRow, {
              key: task.id,
              t: t,
              task: task,
              isNext: snapshot.next === task.id,
              busy: busy,
              onAction: run,
            }),
          )),
          h('div', { className: 'ph-onbcard__progress' },
            h('div', { className: 'ph-onbcard__bar' }, h('span', { style: { width: Math.max(4, percent) + '%' } })),
            h('span', { className: 'ph-caption' }, percent + '%'),
          ),
          error !== '' ? h('div', { className: 'ph-onbcard__error', role: 'alert' }, error) : null,
          h('div', { className: 'ph-onbcard__foot' },
            snapshot.allDone
              ? h(Button, { size: 'sm', variant: 'primary', icon: 'check', onClick: () => onboardingStore.finish() }, t('onboarding.card.finish'))
              : h('span', { className: 'ph-caption', title: t('onboarding.card.hint') }, t('onboarding.card.auto')),
            h('button', { type: 'button', className: 'ph-onbcard__link', onClick: () => onboardingStore.dismiss() }, t('onboarding.card.dismiss')),
          ),
        )
      : null,
  )
}

/** Small coach chip shown inside the reader while the guide is active. */
export function OnboardingCoach(props) {
  const t = props.t
  const snapshot = useOnboarding()
  const paperId = props.paperId ? String(props.paperId) : ''
  if (snapshot.loaded !== true || snapshot.visible !== true) return null
  const sampleId = snapshot.sample && snapshot.sample.paperId ? String(snapshot.sample.paperId) : ''
  if (sampleId === '' || paperId !== sampleId) return null
  const next = snapshot.next
  if (next === null || next === 'component' || next === 'sample') return null
  return h(
    'div',
    { className: 'ph-onbcoach', role: 'status' },
    h('span', { className: 'ph-onbcoach__icon' }, h(Icon, { name: TASK_ICONS[next] || 'compass', size: 13 })),
    h('span', { className: 'ph-onbcoach__text' }, t('onboarding.coach.' + next)),
    h('span', { className: 'ph-onbcoach__count' }, t('onboarding.card.count', { done: snapshot.doneCount, total: snapshot.total })),
    h('button', { type: 'button', className: 'ph-onbcoach__close', onClick: () => onboardingStore.dismiss(), 'aria-label': t('onboarding.card.dismiss') }, h(Icon, { name: 'close', size: 12 })),
  )
}
