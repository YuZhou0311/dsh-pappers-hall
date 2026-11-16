/**
 * First-run guide for the paper centre.
 *
 * The guide is a real walkthrough instead of a slideshow: it installs the
 * optional Python component (PyMuPDF + PP-OCRv6 + PP-DocLayout-S) from inside the
 * flow, imports the bundled sample paper (which contains one rasterised page for
 * OCR), and then points at the four daily actions: read, annotate, note, cite.
 *
 * It can be reopened any time from the library toolbar or the settings panel; the
 * settings card for the component remains the fallback entry point.
 */
import React from 'react'
import { h } from '../core/dom.js'
import { Icon } from '../core/icons.jsx'
import { Button, IconButton } from '../core/primitives.jsx'
import { defaultApi, describeError } from '../core/api.js'

const STEPS = ['welcome', 'component', 'sample', 'tour', 'done']

const STEP_ICONS = { welcome: 'sparkles', component: 'cpu', sample: 'book', tour: 'compass', done: 'check' }

/** Bytes → short human string. */
function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  return Math.max(1, Math.round(value / (1024 * 1024))) + ' MB'
}

/** Poll one API method until `done(value)` or the deadline. */
function usePolling(active, run, intervalMs = 1800) {
  React.useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      try { await run() } catch { /* transient */ }
    }
    const timer = setInterval(tick, intervalMs)
    tick()
    return () => { cancelled = true; clearInterval(timer) }
  }, [active, run, intervalMs])
}

export function OnboardingDialog(props) {
  const t = props.t
  const open = props.open === true
  const [status, setStatus] = React.useState(null)
  const [stepIndex, setStepIndex] = React.useState(0)
  const [component, setComponent] = React.useState(null)
  const [installing, setInstalling] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const dialogRef = React.useRef(null)

  const loadStatus = React.useCallback(async () => {
    try {
      const value = await defaultApi('onboarding.status')
      setStatus(value)
      return value
    } catch (failure) {
      setError(describeError(t, failure))
      return null
    }
  }, [t])

  const loadComponent = React.useCallback(async () => {
    try {
      const settings = await defaultApi('settings.get')
      setComponent((settings && settings.models && settings.models.python) || null)
    } catch {
      setComponent(null)
    }
  }, [])

  // Opening the guide: load state, start at the first unfinished step, refresh the
  // component facts and focus the dialog for keyboard users.
  React.useEffect(() => {
    if (!open) return
    setError('')
    setNotice('')
    loadStatus().then((value) => {
      if (value === null || value === undefined) return
      const completed = (value.state && value.state.completedSteps) || []
      const next = STEPS.findIndex((step) => !completed.includes(step))
      setStepIndex(next === -1 ? STEPS.length - 1 : Math.max(0, next))
    })
    loadComponent()
    setTimeout(() => { try { dialogRef.current && dialogRef.current.focus() } catch { /* ignore */ } }, 30)
  }, [open, loadStatus, loadComponent])

  usePolling(open && installing, async () => {
    await loadComponent()
    const value = await loadStatus()
    const installed = component !== null && component !== undefined && component.installed === true
    if (installed || (value && value.state && value.state.completedSteps.includes('component'))) setInstalling(false)
  })

  const completeStep = React.useCallback((step, patch) => {
    defaultApi('onboarding.completeStep', { step })
      .catch(() => {})
      .then(() => (patch ? defaultApi('onboarding.update', { patch }) : null))
      .catch(() => {})
      .then(() => loadStatus())
  }, [loadStatus])

  const close = React.useCallback((dismissed) => {
    if (dismissed === true) {
      defaultApi('onboarding.update', { patch: { dismissedAt: new Date().toISOString() } }).catch(() => {})
    }
    props.onClose()
  }, [props])

  const goto = React.useCallback((index) => {
    setStepIndex(Math.max(0, Math.min(STEPS.length - 1, index)))
    setError('')
  }, [])

  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      } else if (event.key === 'ArrowRight' && event.metaKey !== true) {
        if (event.target && /input|textarea/i.test(event.target.tagName || '')) return
        setStepIndex((previous) => Math.min(STEPS.length - 1, previous + 1))
      } else if (event.key === 'ArrowLeft' && event.metaKey !== true) {
        if (event.target && /input|textarea/i.test(event.target.tagName || '')) return
        setStepIndex((previous) => Math.max(0, previous - 1))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  const startInstall = React.useCallback(() => {
    setError('')
    setNotice('')
    setInstalling(true)
    defaultApi('models.install', { kind: 'python' })
      .then((result) => {
        if (result && result.status === 'queued') setNotice(t('onboarding.component.installStarted'))
      })
      .catch((failure) => {
        setInstalling(false)
        setError(describeError(t, failure))
      })
  }, [t])

  const importSample = React.useCallback(() => {
    const path = status && status.sample ? status.sample.path : null
    if (!path) { setError(t('onboarding.sample.missing')); return }
    setImporting(true)
    setError('')
    defaultApi('library.import', { paths: [path] })
      .then((result) => {
        const accepted = (result && result.acceptedItems) || []
        const paperId = accepted.length > 0 ? accepted[0].paperId : null
        if (paperId === null) {
          const duplicate = (result && result.duplicates) || []
          const existing = duplicate.length > 0 ? duplicate[0].paperId : null
          if (existing === null) throw new Error(t('onboarding.sample.failed'))
          return defaultApi('onboarding.update', { patch: { sampleImported: true, samplePaperId: existing } })
        }
        return defaultApi('onboarding.update', { patch: { sampleImported: true, samplePaperId: paperId } })
      })
      .then(() => { completeStep('sample'); setNotice(t('onboarding.sample.imported')) })
      .catch((failure) => setError(describeError(t, failure)))
      .then(() => { setImporting(false); loadStatus() })
  }, [status, t, completeStep, loadStatus])

  if (!open) return null

  const step = STEPS[stepIndex]
  const completed = (status && status.state && status.state.completedSteps) || []
  const samplePaperId = status && status.state ? status.state.samplePaperId : null
  const pythonInstalled = component !== null && component !== undefined && component.installed === true
  const componentJob = component && component.job ? component.job : null
  const progress = componentJob && componentJob.progress && componentJob.progress.total > 0
    ? Math.round((componentJob.progress.done / componentJob.progress.total) * 100)
    : null

  const featureRows = [
    ['book', t('onboarding.welcome.feature1.title'), t('onboarding.welcome.feature1.body')],
    ['highlighter', t('onboarding.welcome.feature2.title'), t('onboarding.welcome.feature2.body')],
    ['quote', t('onboarding.welcome.feature3.title'), t('onboarding.welcome.feature3.body')],
  ]

  const tourCards = [
    ['book', t('onboarding.tour.read.title'), t('onboarding.tour.read.body')],
    ['highlighter', t('onboarding.tour.annotate.title'), t('onboarding.tour.annotate.body')],
    ['note', t('onboarding.tour.note.title'), t('onboarding.tour.note.body')],
    ['quote', t('onboarding.tour.cite.title'), t('onboarding.tour.cite.body')],
  ]

  const openSample = () => {
    const id = samplePaperId || props.samplePaperId || null
    if (id === null || typeof props.onOpenPaper !== 'function') return
    close(false)
    props.onOpenPaper(id)
  }

  const body = (() => {
    if (step === 'welcome') {
      return h(
        React.Fragment,
        null,
        h('div', { className: 'ph-onb__hero' },
          h('span', { className: 'ph-onb__badge' }, h(Icon, { name: 'sparkles', size: 13 }), t('onboarding.badge')),
          h('h1', { className: 'ph-onb__title' }, t('onboarding.welcome.title')),
          h('p', { className: 'ph-onb__lead' }, t('onboarding.welcome.lead')),
        ),
        h('div', { className: 'ph-onb__features' }, featureRows.map(([icon, title, text]) =>
          h('div', { key: title, className: 'ph-onb__feature' },
            h('span', { className: 'ph-onb__featureicon' }, h(Icon, { name: icon, size: 16 })),
            h('div', null, h('strong', null, title), h('p', null, text)),
          ),
        )),
        h('div', { className: 'ph-onb__meta' }, h(Icon, { name: 'info', size: 13 }), h('span', null, t('onboarding.welcome.meta'))),
      )
    }

    if (step === 'component') {
      return h(
        React.Fragment,
        null,
        h('h2', { className: 'ph-onb__stepTitle' }, t('onboarding.component.title')),
        h('p', { className: 'ph-onb__stepLead' }, t('onboarding.component.lead')),
        h('div', { className: 'ph-onb__install' + (pythonInstalled ? ' ph-onb__install--done' : '') },
          h('div', { className: 'ph-onb__installhead' },
            h('span', { className: 'ph-onb__installicon' }, h(Icon, { name: pythonInstalled ? 'check' : 'cpu', size: 18 })),
            h('div', null,
              h('strong', null, t('onboarding.component.name')),
              h('span', { className: 'ph-caption' }, pythonInstalled ? t('onboarding.component.installedHint') : t('onboarding.component.sizeHint')),
            ),
            pythonInstalled ? h('span', { className: 'ph-onb__pill' }, t('onboarding.component.installed')) : null,
          ),
          h('ul', { className: 'ph-onb__list' }, [
            t('onboarding.component.benefit1'),
            t('onboarding.component.benefit2'),
            t('onboarding.component.benefit3'),
          ].map((line) => h('li', { key: line }, h(Icon, { name: 'check', size: 13 }), h('span', null, line)))),
          installing || componentJob
            ? h('div', { className: 'ph-onb__progress' },
                h('div', { className: 'ph-onb__progressbar' }, h('span', { style: { width: (progress === null ? 12 : Math.max(6, progress)) + '%' } })),
                h('span', { className: 'ph-caption' }, progress === null ? t('onboarding.component.preparing') : t('onboarding.component.progress', { percent: progress })),
              )
            : null,
          h('div', { className: 'ph-onb__actions' },
            pythonInstalled
              ? h(Button, { variant: 'primary', size: 'sm', icon: 'arrowRight', onClick: () => goto(stepIndex + 1) }, t('onboarding.common.next'))
              : h(Button, { variant: 'primary', size: 'sm', icon: 'download', loading: installing, disabled: installing, onClick: startInstall }, installing ? t('onboarding.component.installing') : t('onboarding.component.install')),
            pythonInstalled
              ? null
              : h('button', { type: 'button', className: 'ph-onb__link', onClick: () => goto(stepIndex + 1) }, t('onboarding.component.later')),
          ),
        ),
        h('p', { className: 'ph-onb__fineprint' }, t('onboarding.component.license')),
      )
    }

    if (step === 'sample') {
      return h(
        React.Fragment,
        null,
        h('h2', { className: 'ph-onb__stepTitle' }, t('onboarding.sample.title')),
        h('p', { className: 'ph-onb__stepLead' }, t('onboarding.sample.lead')),
        h('div', { className: 'ph-onb__sample' },
          h('div', { className: 'ph-onb__paper' },
            h('div', { className: 'ph-onb__paperhead' }, h(Icon, { name: 'book', size: 14 }), t('onboarding.sample.paperTitle')),
            h('div', { className: 'ph-onb__pages' }, [1, 2, 3].map((page) =>
              h('div', { key: page, className: 'ph-onb__page' + (page === 3 ? ' ph-onb__page--scan' : '') },
                h('div', { className: 'ph-onb__pagelines' }),
                h('span', null, page),
              ),
            )),
            h('p', { className: 'ph-caption' }, t('onboarding.sample.paperHint')),
          ),
          h('div', { className: 'ph-onb__sampleactions' },
            samplePaperId !== null
              ? h(Button, { variant: 'primary', size: 'sm', icon: 'book', onClick: openSample }, t('onboarding.sample.open'))
              : h(Button, { variant: 'primary', size: 'sm', icon: 'download', loading: importing, disabled: importing, onClick: importSample }, importing ? t('onboarding.sample.importing') : t('onboarding.sample.import')),
          ),
        ),
      )
    }

    if (step === 'tour') {
      return h(
        React.Fragment,
        null,
        h('h2', { className: 'ph-onb__stepTitle' }, t('onboarding.tour.title')),
        h('p', { className: 'ph-onb__stepLead' }, t('onboarding.tour.lead')),
        h('div', { className: 'ph-onb__tour' }, tourCards.map(([icon, title, text], index) =>
          h('div', { key: title, className: 'ph-onb__tourcard' },
            h('span', { className: 'ph-onb__tournum' }, String(index + 1)),
            h('span', { className: 'ph-onb__touricon' }, h(Icon, { name: icon, size: 15 })),
            h('strong', null, title),
            h('p', null, text),
          ),
        )),
        h('div', { className: 'ph-onb__actions' },
          h(Button, { variant: 'primary', size: 'sm', icon: 'book', onClick: openSample, disabled: samplePaperId === null }, t('onboarding.tour.openSample')),
          h(Button, { size: 'sm', icon: 'compass', onClick: () => { close(false); if (typeof props.onOpenDrawer === 'function') props.onOpenDrawer() } }, t('onboarding.tour.openDrawer')),
        ),
      )
    }

    return h(
      React.Fragment,
      null,
      h('div', { className: 'ph-onb__donehead' }, h('span', { className: 'ph-onb__doneicon' }, h(Icon, { name: 'check', size: 20 }))),
      h('h2', { className: 'ph-onb__stepTitle ph-onb__stepTitle--center' }, t('onboarding.done.title')),
      h('p', { className: 'ph-onb__stepLead ph-onb__stepLead--center' }, t('onboarding.done.lead')),
      h('ul', { className: 'ph-onb__checks' }, [
        [t('onboarding.done.check1'), completed.includes('component') || pythonInstalled],
        [t('onboarding.done.check2'), completed.includes('sample') || samplePaperId !== null],
        [t('onboarding.done.check3'), completed.includes('tour')],
      ].map(([label, done]) => h('li', { key: label, className: done ? 'is-done' : '' }, h(Icon, { name: done ? 'check' : 'minus', size: 13 }), h('span', null, label)))),
      h('div', { className: 'ph-onb__meta' }, h(Icon, { name: 'settings', size: 13 }), h('span', null, t('onboarding.done.hint'))),
      h('div', { className: 'ph-onb__actions ph-onb__actions--center' },
        h(Button, { variant: 'primary', size: 'sm', icon: 'check', onClick: () => { completeStep('done'); close(true) } }, t('onboarding.done.finish')),
      ),
    )
  })()

  return h(
    'div', { className: 'ph-onbbackdrop', role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) close(true) } },
    h(
      'div',
      {
        className: 'ph-onb',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('onboarding.title'),
        tabIndex: -1,
        ref: dialogRef,
      },
      h('div', { className: 'ph-onb__rail' },
        h('div', { className: 'ph-onb__brand' }, h(Icon, { name: 'book', size: 15 }), h('span', null, t('onboarding.title'))),
        h('ol', { className: 'ph-onb__steps' }, STEPS.map((name, index) =>
          h('li', {
            key: name,
            className: 'ph-onb__step' + (index === stepIndex ? ' is-current' : '') + (completed.includes(name) ? ' is-done' : ''),
          },
            h('button', { type: 'button', className: 'ph-onb__stepbtn', onClick: () => goto(index), 'aria-current': index === stepIndex ? 'step' : undefined },
              h('span', { className: 'ph-onb__dot' }, completed.includes(name) ? h(Icon, { name: 'check', size: 11 }) : String(index + 1)),
              h('span', { className: 'ph-onb__steplabel' }, t('onboarding.steps.' + name)),
            ),
          ),
        )),
        h('div', { className: 'ph-onb__railfoot' },
          h('span', { className: 'ph-caption' }, t('onboarding.progress', { current: stepIndex + 1, total: STEPS.length })),
          h('button', { type: 'button', className: 'ph-onb__link', onClick: () => close(true) }, t('onboarding.skip')),
        ),
      ),
      h('div', { className: 'ph-onb__main' },
        h('div', { className: 'ph-onb__top' },
          h('span', { className: 'ph-onb__steptag' }, h(Icon, { name: STEP_ICONS[step], size: 13 }), t('onboarding.steps.' + step)),
          h(IconButton, { icon: 'close', title: t('onboarding.close'), onClick: () => close(true) }),
        ),
        h('div', { className: 'ph-onb__body' }, body),
        error !== '' ? h('div', { className: 'ph-onb__error', role: 'alert' }, h(Icon, { name: 'info', size: 13 }), h('span', null, error)) : null,
        notice !== '' && error === '' ? h('div', { className: 'ph-onb__notice' }, h(Icon, { name: 'check', size: 13 }), h('span', null, notice)) : null,
        h('div', { className: 'ph-onb__footer' },
          h(Button, { size: 'sm', icon: 'arrowLeft', disabled: stepIndex === 0, onClick: () => goto(stepIndex - 1) }, t('onboarding.back')),
          h('div', { className: 'ph-onb__footerRight' },
            h('span', { className: 'ph-caption' }, t('onboarding.footerHint')),
            step === 'done'
              ? null
              : h(Button, { variant: 'primary', size: 'sm', icon: 'arrowRight', onClick: () => { completeStep(step); goto(stepIndex + 1) } }, t('onboarding.next')),
          ),
        ),
      ),
    ),
  )
}
