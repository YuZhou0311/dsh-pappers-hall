/**
 * Paragraph-level bilingual view (the v0.2 replacement for the old “whole page
 * pdftotext stream”).
 *
 * Each `reader.page` block becomes one card: a small role badge (body / heading /
 * caption / table / list), the original paragraph, then its translated paragraph
 * once `translate.text` has produced one. Header/table/footer/marginal blocks are
 * hidden by default (they are usually journal metadata / affiliation noise) and
 * can be revealed with one toggle. Per-block state is rendered honestly:
 * untranslated, waiting, translating, translated, or unavailable with the Host's
 * reason plus a per-block retry button. The panel also shows page progress
 * (“已翻译 N/M 段”), a failed count, a cache badge and the translation model.
 */
import React from 'react'
import { Badge, Btn, Empty, Icon, Spinner, arrayOf, cx, firstText, looksLikePageMetadata } from './shared.jsx'
import { engineBadge, engineDetails, engineInitial, engineTitle, providerLabel } from './engines.js'

/** Roles rendered by default: readable content only. */
const DEFAULT_ROLES = new Set(['body', 'heading', 'caption'])
/** Roles the Host can translate; the shell translation pipeline mirrors this set. */
const TRANSLATABLE_ROLES = new Set(['body', 'heading', 'caption'])
const ROLE_KEYS = {
  heading: 'reader.bilingual.role.heading',
  body: 'reader.bilingual.role.body',
  caption: 'reader.bilingual.role.caption',
  table: 'reader.bilingual.role.table',
  list: 'reader.bilingual.role.list',
  header: 'reader.bilingual.role.header',
  footer: 'reader.bilingual.role.footer',
}

/** Order blocks for display: body flow first, header/footer pushed to the end. */
function orderBlocks(blocks) {
  const kept = []
  const marginal = []
  for (const block of blocks) {
    if (!block) continue
    const text = String(block.text || '').trim()
    if (!text) continue
    if (block.role === 'header' || block.role === 'footer') marginal.push(block)
    else kept.push(block)
  }
  return kept.length > 0 ? kept.concat(marginal) : marginal
}

/** One paragraph card (original + translation state + per-block retry). */
function BlockCard(props) {
  const t = props.t
  const block = props.block
  const role = String(block.role || 'body')
  const roleKey = ROLE_KEYS[role] || 'reader.bilingual.role.unknown'
  const entry = props.entry
  const pending = Boolean(props.pending)
  const translationText = entry && entry.status === 'translated' ? firstText(entry.translation) : ''
  const failed = Boolean(entry && entry.status !== 'translated')
  const reason = failed ? firstText(entry.reason, t('reader.ai.reasonFallback')) : ''
  const showOriginal = props.mode !== 'translation'
  const showTranslation = props.mode !== 'original'
  const translatable = TRANSLATABLE_ROLES.has(role)

  let translationBody = null
  if (showTranslation) {
    if (translationText) {
      translationBody = React.createElement(
        'p',
        { className: cx('ph-r-bi__translation', !showOriginal && 'ph-r-bi__translation--only') },
        translationText,
        entry.engine || entry.provider
          ? React.createElement(
              'span',
              {
                className: cx('ph-r-bi__engine', entry.cached && 'ph-r-bi__engine--cached'),
                title: engineDetails(entry.engine, entry.model) + ' · ' + engineBadge(entry.engine, entry.model, entry.latencyMs, entry.cached),
              },
              engineInitial(entry.engine, entry.provider, entry.cached),
            )
          : null,
        entry.cached
          ? React.createElement(
              'span',
              { className: 'ph-r-bi__cached', title: t('reader.bilingual.cached') },
              React.createElement(Icon, { name: 'refresh', size: 9 }),
              React.createElement('span', null, t('reader.bilingual.cached')),
            )
          : null,
      )
    } else if (pending) {
      translationBody = React.createElement(
        'div',
        { className: 'ph-r-bi__pending' },
        React.createElement(Spinner, { size: 11 }),
        React.createElement('span', null, t('reader.bilingual.translating')),
      )
    } else if (failed && translatable) {
      translationBody = React.createElement(
        'div',
        { className: 'ph-r-bi__unavailable' },
        React.createElement('span', null, t('reader.bilingual.blockFailed', { reason })),
        React.createElement(
          Btn,
          { size: 'sm', variant: 'ghost', icon: 'refresh', onClick: () => props.onTranslateBlock(block), disabled: props.pageBusy },
          t('reader.bilingual.retryBlock'),
        ),
      )
    } else if (props.pageBusy && translatable) {
      translationBody = React.createElement(
        'div',
        { className: 'ph-r-bi__pending' },
        React.createElement(Icon, { name: 'clock', size: 11 }),
        React.createElement('span', null, t('reader.bilingual.waiting')),
      )
    } else if (translatable) {
      translationBody = React.createElement(
        'div',
        { className: 'ph-r-bi__pending' },
        React.createElement('span', null, t('reader.bilingual.untranslated')),
        React.createElement(
          Btn,
          { size: 'sm', variant: 'ghost', icon: 'translate', onClick: () => props.onTranslateBlock(block), disabled: props.pageBusy },
          t('reader.bilingual.translateBlock'),
        ),
      )
    }
  }

  return React.createElement(
    'article',
    {
      className: cx('ph-r-bi__card', 'ph-r-bi__card--' + role),
      'data-ph-block': String(block.id != null ? block.id : props.index),
      'data-ph-role': role,
    },
    React.createElement(
      'div',
      { className: 'ph-r-bi__role' },
      React.createElement(Icon, { name: role === 'caption' ? 'figure' : role === 'heading' ? 'book' : 'note', size: 11 }),
      React.createElement('span', null, t(roleKey)),
      React.createElement('span', { className: 'ph-r-bi__spacer' }),
      !translationText && translatable
        ? React.createElement(
            'button',
            {
              type: 'button',
              className: 'ph-r-btn ph-r-btn--ghost ph-r-btn--sm',
              style: { height: 20, padding: '0 6px', fontSize: 10 },
              disabled: props.pageBusy || pending,
              onClick: () => props.onTranslateBlock(block),
              title: t('reader.bilingual.translateBlock'),
            },
            pending ? React.createElement(Spinner, { size: 10 }) : React.createElement(Icon, { name: 'translate', size: 11 }),
            React.createElement('span', null, t('reader.bilingual.translateBlock')),
          )
        : null,
    ),
    showOriginal
      ? React.createElement('p', { className: 'ph-r-bi__original' }, String(block.text || '').trim())
      : null,
    translationBody,
  )
}

/**
 * @param {object} props
 * @param {object} props.t
 * @param {number} props.page
 * @param {number} props.total
 * @param {object|null} props.blocksEntry `{status, data, error}` for reader.page
 * @param {boolean} [props.structurePending] Host is still backfilling the v0.2 layout
 * @param {object|null} props.translation `{status, entries, pending, progress, provenance, cachedAll, reason}`
 * @param {'original'|'compare'|'translation'} props.mode
 * @param {Function} props.onTranslatePage force -> run whole page
 * @param {Function} props.onTranslateBlock block -> retry one segment
 * @param {Function} props.onRetryBlocks reload page structure
 * @param {Function} [props.onRetryLayer]
 */
export function BilingualPanel(props) {
  const t = props.t
  const blocksEntry = props.blocksEntry || null
  const status = blocksEntry ? blocksEntry.status : 'idle'
  const allBlocks = orderBlocks(arrayOf(blocksEntry && blocksEntry.data && blocksEntry.data.blocks))
  const [showMarginal, setShowMarginal] = React.useState(false)
  const visibleBlocks = showMarginal
    ? allBlocks
    : allBlocks.filter(
        (block) =>
          DEFAULT_ROLES.has(String(block.role || 'body')) &&
          String(block.text || '').trim().length >= 2 &&
          !looksLikePageMetadata(block.text),
      )
  const hiddenCount = allBlocks.length - visibleBlocks.length

  const translation = props.translation || null
  const translationStatus = translation ? translation.status : 'idle'
  const entries = (translation && translation.entries) || {}
  const pendingMap = (translation && translation.pending) || {}
  const progress = (translation && translation.progress) || { total: 0, done: 0, failed: 0 }
  const provenance = translation && translation.provenance ? translation.provenance : null
  const pageBusy = translationStatus === 'translating'
  const cachedAll = Boolean(translation && translation.cachedAll)
  const unavailableReason = firstText(translation && translation.reason)
  const structureError =
    status === 'error' ? firstText(blocksEntry && blocksEntry.error && blocksEntry.error.message, 'error') : ''

  let pageButtonLabel = t('reader.bilingual.translatePage')
  if (pageBusy) pageButtonLabel = t('reader.bilingual.translatingProgress', { done: progress.done, total: progress.total })
  else if (translationStatus === 'translated') pageButtonLabel = t('reader.bilingual.retranslate')
  else if (translationStatus === 'partial') pageButtonLabel = t('reader.bilingual.continue')
  const pageButtonForce = translationStatus === 'translated'

  const header = React.createElement(
    'div',
    { className: 'ph-r-bi__head' },
    React.createElement(
      'div',
      { className: 'ph-r-bi__titleline' },
      React.createElement(Icon, { name: 'translate', size: 14 }),
      React.createElement('span', { className: 'ph-r-bi__title' }, t('reader.bilingual.title')),
      React.createElement('span', { className: 'ph-r-bi__page' }, t('reader.bilingual.page', { page: props.page })),
      React.createElement('span', { className: 'ph-r-bi__spacer' }),
      props.mode === 'original'
        ? null
        : React.createElement(
            Btn,
            {
              size: 'sm',
              variant: translationStatus === 'translated' ? 'soft' : 'solid',
              icon: pageBusy ? undefined : 'translate',
              disabled: pageBusy || status !== 'ready' || allBlocks.length === 0,
              onClick: () => props.onTranslatePage(pageButtonForce),
              title: pageButtonLabel,
            },
            pageBusy ? React.createElement(Spinner, { size: 11 }) : null,
            pageButtonLabel,
          ),
      props.mode === 'original' || !props.onAiTranslatePage
        ? null
        : React.createElement(
            Btn,
            {
              size: 'sm',
              variant: 'ghost',
              icon: 'sparkles',
              disabled: pageBusy || status !== 'ready' || allBlocks.length === 0,
              onClick: () => props.onAiTranslatePage(),
              title: t('reader.bilingual.aiTranslateHint'),
            },
            t('reader.bilingual.aiTranslatePage'),
          ),
    ),
    React.createElement(
      'div',
      { className: 'ph-r-bi__prov' },
      progress.total > 0
        ? React.createElement(
            'span',
            { className: cx('ph-r-bi__progresslabel', progress.failed > 0 && 'ph-r-bi__progresslabel--warn') },
            t('reader.bilingual.progress', { done: progress.done, total: progress.total }),
            progress.failed > 0 ? React.createElement('span', null, ' · ' + t('reader.bilingual.progressFailed', { failed: progress.failed })) : null,
          )
        : null,
      props.structurePending
        ? React.createElement(Badge, { tone: 'warn', title: t('reader.bilingual.structureBackfillingHint') }, t('reader.bilingual.structureBackfilling'))
        : null,
      props.providerLabel
        ? React.createElement(
            'span',
            { className: 'ph-r-bi__enginepref', title: t('reader.bilingual.enginePreferenceHint') },
            t('reader.bilingual.enginePreference', { engine: props.providerLabel }),
          )
        : null,
      provenance && provenance.label
        ? React.createElement(
            'span',
            { className: 'ph-r-bi__engineused', title: provenance.model || '' },
            t('reader.bilingual.engineUsed', { engines: provenance.label }),
          )
        : provenance && provenance.model
          ? React.createElement('span', null, t('reader.bilingual.provenance', { model: provenance.model }))
          : null,
      translation && translation.provider === 'llm' ? React.createElement(Badge, { tone: 'business' }, t('reader.bilingual.aiTranslated')) : null,
      cachedAll ? React.createElement(Badge, { tone: 'success' }, t('reader.bilingual.cached')) : null,
      props.mode === 'translation' ? React.createElement(Badge, { tone: 'business' }, t('reader.bilingual.onlyTranslation')) : null,
    ),
    progress.total > 0
      ? React.createElement(
          'div',
          {
            className: 'ph-r-bi__bar',
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': progress.total,
            'aria-valuenow': progress.done,
            'aria-label': t('reader.bilingual.progress', { done: progress.done, total: progress.total }),
          },
          React.createElement('span', {
            className: cx('ph-r-bi__barfill', progress.failed > 0 && 'ph-r-bi__barfill--warn'),
            style: { width: Math.round((progress.done / Math.max(1, progress.total)) * 100) + '%' },
          }),
        )
      : null,
    allBlocks.length > 0
      ? React.createElement(
          'div',
          { className: 'ph-r-bi__filter' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: cx('ph-r-ai__toggle', showMarginal && 'ph-r-ai__toggle--on'),
              onClick: () => setShowMarginal((value) => !value),
              'aria-pressed': showMarginal ? 'true' : 'false',
              title: t('reader.bilingual.showMarginalHint'),
            },
            React.createElement('span', { className: 'ph-r-ai__check' }, showMarginal ? React.createElement(Icon, { name: 'check', size: 8 }) : null),
            React.createElement('span', null, showMarginal ? t('reader.bilingual.hideMarginal') : t('reader.bilingual.showMarginal')),
          ),
          hiddenCount > 0 && !showMarginal
            ? React.createElement('span', { className: 'ph-r-bi__hidden' }, t('reader.bilingual.hiddenCount', { count: hiddenCount }))
            : null,
        )
      : null,
    translationStatus === 'unavailable' && unavailableReason
      ? React.createElement(
          'div',
          { className: 'ph-r-bi__unavailable' },
          t('reader.bilingual.unavailable', { reason: unavailableReason }),
          React.createElement(
            Btn,
            { size: 'sm', variant: 'ghost', icon: 'refresh', onClick: () => props.onTranslatePage(false), style: { marginTop: 6 }, disabled: pageBusy },
            t('reader.bilingual.retry'),
          ),
        )
      : null,
  )

  let body = null
  if (status === 'loading' || status === 'idle') {
    body = React.createElement(
      'div',
      { className: 'ph-r-bi__skeleton', 'aria-busy': 'true' },
      [96, 72, 88, 64].map((percent, index) =>
        React.createElement(
          'div',
          { key: index, className: 'ph-r-bi__card' },
          React.createElement('span', { className: 'ph-r-skeleton', style: { width: '24%', height: 10, marginBottom: 8 } }),
          React.createElement('span', { className: 'ph-r-skeleton', style: { width: percent + '%', height: 11, marginBottom: 5 } }),
          React.createElement('span', { className: 'ph-r-skeleton', style: { width: Math.max(40, percent - 22) + '%', height: 11 } }),
        ),
      ),
    )
  } else if (status === 'error') {
    body = React.createElement(Empty, {
      icon: 'warning',
      tone: 'error',
      title: t('reader.bilingual.structureUnavailable', { reason: structureError || 'error' }),
      desc: t('reader.bilingual.structurePending'),
      action: props.onRetryBlocks
        ? React.createElement(
            Btn,
            {
              size: 'sm',
              variant: 'soft',
              icon: 'refresh',
              onClick: () => {
                if (props.onRetryLayer) props.onRetryLayer()
                if (props.onRetryBlocks) props.onRetryBlocks()
              },
            },
            t('reader.retry'),
          )
        : null,
    })
  } else if (allBlocks.length === 0) {
    body = React.createElement(Empty, {
      icon: 'translate',
      title: t('reader.bilingual.empty'),
      desc: t('reader.page.structurePending'),
      action: props.onRetryBlocks
        ? React.createElement(
            Btn,
            {
              size: 'sm',
              variant: 'soft',
              icon: 'refresh',
              onClick: () => {
                if (props.onRetryLayer) props.onRetryLayer()
                if (props.onRetryBlocks) props.onRetryBlocks()
              },
            },
            t('reader.retry'),
          )
        : null,
    })
  } else if (visibleBlocks.length === 0) {
    body = React.createElement(Empty, {
      icon: 'note',
      title: t('reader.bilingual.onlyMarginal'),
      desc: t('reader.bilingual.onlyMarginalDesc'),
      action: React.createElement(
        Btn,
        { size: 'sm', variant: 'soft', onClick: () => setShowMarginal(true) },
        t('reader.bilingual.showMarginal'),
      ),
    })
  } else {
    body = React.createElement(
      'div',
      { className: 'ph-r-bi__list', 'data-ph-bilingual': 'blocks' },
      visibleBlocks.map((block, index) =>
        React.createElement(BlockCard, {
          key: block.id != null ? 'b-' + block.id : 'b-' + index,
          t,
          block,
          index,
          entry: entries[String(block.id)] || null,
          pending: Boolean(pendingMap[String(block.id)]),
          pageBusy,
          mode: props.mode,
          onTranslateBlock: (target) => props.onTranslateBlock(target),
        }),
      ),
    )
  }

  return React.createElement(
    'div',
    { className: 'ph-r-bi' },
    header,
    React.createElement('div', { className: 'ph-r-bi__body ph-r-scroll' }, body),
  )
}
