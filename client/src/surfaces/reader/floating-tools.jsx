/**
 * Bottom-right floating annotation toolbar (v0.17).
 *
 * Region annotations and sticky notes used to hide inside the toolbar row, which
 * made them hard to find. They now live in a permanent, labelled, keyboard-aware
 * toolbar anchored to the page canvas (never over the text column or the side
 * panel):
 *
 *   - 高亮 becomes enabled as soon as text is selected (drag-select → click);
 *   - 区域 / 便签 toggle the page tool, show a pressed state and an Alt+A / Alt+N
 *     shortcut hint;
 *   - the five pen colours pick the colour used by the next annotation;
 *   - the one-time first-run tip explains "拖选文字高亮；区域/便签在右下角".
 */
import React from 'react'
import { Icon, cx } from './shared.jsx'

/** Palette used by annotations (content semantics, not chrome). */
const PENS = ['yellow', 'green', 'blue', 'red', 'purple']

/**
 * @param {object} props
 * @param {object} props.t reader translator
 * @param {'select'|'area'|'note'} props.tool
 * @param {boolean} props.selectionActive text is selected → highlight is possible
 * @param {string} props.penColor
 * @param {Function} props.onTool `(tool)` toggle a page tool
 * @param {Function} props.onHighlight `(color)` highlight the current selection
 * @param {Function} props.onPen `(color)`
 * @param {boolean} props.showTip
 * @param {Function} props.onDismissTip
 * @param {Function} props.onShowTip
 * @param {boolean} props.sidePanelOpen
 * @param {boolean} props.translationOpen
 */
export function FloatingAnnotationTools(props) {
  const t = props.t
  const selection = Boolean(props.selectionActive)
  const tool = props.tool || 'select'
  const style = {
    right: props.sidePanelOpen ? 'calc(var(--ph-r-side) + 18px)' : '18px',
    bottom: props.translationOpen ? 'calc(46% + 14px)' : '18px',
  }
  return React.createElement(
    'div',
    { className: 'ph-r-floattools', style: style, 'data-ph-floating-tools': 'true' },
    props.showTip
      ? React.createElement(
          'div',
          { className: 'ph-r-tools-tip', role: 'status' },
          React.createElement(
            'div',
            { className: 'ph-r-tools-tip__head' },
            React.createElement(Icon, { name: 'sparkles', size: 14 }),
            React.createElement('strong', null, t('reader.tools.tip.title')),
          ),
          React.createElement('p', { className: 'ph-r-tools-tip__text' }, t('reader.tools.tip.desc')),
          React.createElement(
            'div',
            { className: 'ph-r-tools-tip__actions' },
            React.createElement(
              'button',
              { type: 'button', className: 'ph-r-btn ph-r-btn--ghost ph-r-btn--sm', onClick: props.onShowTip, title: t('reader.tools.help') },
              t('reader.tools.help'),
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'ph-r-btn ph-r-btn--solid ph-r-btn--sm', onClick: props.onDismissTip },
              t('reader.tools.tip.ok'),
            ),
          ),
        )
      : null,
    React.createElement(
      'div',
      { className: 'ph-r-floattools__bar', role: 'toolbar', 'aria-label': t('reader.tools.label') },
      React.createElement(
        'button',
        {
          type: 'button',
          className: cx('ph-r-floattools__btn', selection && 'ph-r-floattools__btn--armed'),
          disabled: !selection,
          onClick: () => props.onHighlight(props.penColor),
          title: selection ? t('reader.tools.highlightReady') : t('reader.tools.highlightHint'),
          'aria-label': t('reader.tools.highlight'),
        },
        React.createElement(Icon, { name: 'highlighter', size: 15 }),
        React.createElement('span', { className: 'ph-r-floattools__label' }, t('reader.tools.highlight')),
        React.createElement('kbd', { className: 'ph-r-floattools__kbd' }, 'Alt+H'),
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: cx('ph-r-floattools__btn', tool === 'area' && 'ph-r-floattools__btn--active'),
          onClick: () => props.onTool(tool === 'area' ? 'select' : 'area'),
          title: t('reader.tools.areaHint'),
          'aria-pressed': tool === 'area' ? 'true' : 'false',
          'aria-label': t('reader.tools.area'),
        },
        React.createElement(Icon, { name: 'area', size: 15 }),
        React.createElement('span', { className: 'ph-r-floattools__label' }, t('reader.tools.area')),
        React.createElement('kbd', { className: 'ph-r-floattools__kbd' }, 'Alt+A'),
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: cx('ph-r-floattools__btn', tool === 'note' && 'ph-r-floattools__btn--active'),
          onClick: () => props.onTool(tool === 'note' ? 'select' : 'note'),
          title: t('reader.tools.noteHint'),
          'aria-pressed': tool === 'note' ? 'true' : 'false',
          'aria-label': t('reader.tools.note'),
        },
        React.createElement(Icon, { name: 'sticky', size: 15 }),
        React.createElement('span', { className: 'ph-r-floattools__label' }, t('reader.tools.note')),
        React.createElement('kbd', { className: 'ph-r-floattools__kbd' }, 'Alt+N'),
      ),
      React.createElement('span', { className: 'ph-r-floattools__sep', 'aria-hidden': 'true' }),
      React.createElement(
        'span',
        { className: 'ph-r-floattools__pens', role: 'group', 'aria-label': t('reader.tools.pen') },
        PENS.map((color) =>
          React.createElement('button', {
            key: color,
            type: 'button',
            className: cx('ph-r-floattools__pen', props.penColor === color && 'ph-r-floattools__pen--active', 'ph-r-floattools__pen--' + color),
            onClick: () => props.onPen(color),
            title: t('reader.annot.color.' + color),
            'aria-label': t('reader.annot.color.' + color),
            'aria-pressed': props.penColor === color ? 'true' : 'false',
          }),
        ),
      ),
      React.createElement(
        'button',
        { type: 'button', className: 'ph-r-floattools__help', onClick: props.onShowTip, title: t('reader.tools.help'), 'aria-label': t('reader.tools.help') },
        '?',
      ),
    ),
  )
}
