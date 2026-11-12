/**
 * AI panel (right-hand “AI” tab).
 *
 * Context chips summarise exactly what will be sent (paper, current page,
 * selected quote, optional page image). Answers are rendered honestly: model,
 * latency and clickable sources for success; the Host's reason for
 * `unavailable` / `degraded` / errors — no invented text. “Send to chat” hands
 * structured materials to the shell, which commits a reference bundle into the
 * conversation draft (never auto-sends).
 */
import React from 'react'
import {
  Badge,
  Btn,
  Chip,
  Empty,
  Icon,
  IconBtn,
  Spinner,
  arrayOf,
  copyText,
  cx,
  firstText,
  formatElapsed,
  num,
  useAsync,
} from './shared.jsx'
import { Markdown } from './markdown.jsx'

/** Stable id for one rendered chat message. */
let messageSeq = 0
function nextMessageId() {
  messageSeq += 1
  return 'm' + Date.now().toString(36) + '-' + messageSeq
}

/** Compact paper title for the context chip. */
function paperChipTitle(paper) {
  if (!paper) return ''
  const title = firstText(paper.titleZh, paper.displayTitle, paper.title)
  return title.length > 26 ? title.slice(0, 26) + '…' : title
}

/**
 * One assistant answer block.
 * @param {object} props
 * @param {object} props.t
 * @param {object} props.message `{status, answer, reason, provider, model, elapsedMs, sources, prompt, quote, includeImage}`
 * @param {Function} props.onCopyAnswer
 * @param {Function} props.onCiteAnswer
 * @param {Function} props.onJumpPage
 * @param {Function} props.onDisableImage
 */
function AnswerBlock(props) {
  const t = props.t
  const message = props.message
  const ok = message.status === 'ok'
  const answer = firstText(message.answer)
  const reason = firstText(message.reason, t('reader.ai.reasonFallback'))
  const sources = arrayOf(message.sources)
  const imageHint =
    !ok && message.includeImage && /image|vision|图像|图片/i.test(String(reason))

  return React.createElement(
    'div',
    { className: 'ph-r-ai__msg' },
    React.createElement('div', { className: 'ph-r-ai__role' }, t('reader.ai.title')),
    React.createElement(
      'div',
      { className: cx('ph-r-ai__answer', !ok && 'ph-r-ai__answer--bad') },
      ok
        ? React.createElement('div', { className: 'ph-r-ai__answer-text' }, React.createElement(Markdown, { text: answer || t('reader.ai.noAnswer') }))
        : React.createElement(
            'div',
            { className: 'ph-r-ai__answer-warn' },
            message.status === 'error'
              ? t('reader.ai.error', { message: reason })
              : t('reader.ai.unavailable', { reason }),
          ),
      ok && sources.length > 0
        ? React.createElement(
            'div',
            { className: 'ph-r-ai__sources' },
            React.createElement('span', { className: 'ph-r-ai__sourcelabel' }, t('reader.ai.sources')),
            sources.map((source, index) => {
              const isFigure = source && source.kind === 'figure'
              const page = num(source && source.page, 0)
              const label = firstText(source && source.label, source && source.figureId)
              return React.createElement(
                'button',
                {
                  key: index,
                  type: 'button',
                  className: 'ph-r-ai__source',
                  onClick: () => (page > 0 ? props.onJumpPage(page) : null),
                  title: isFigure ? label : t('reader.ai.source.page', { page }),
                },
                isFigure ? t('reader.ai.source.figure', { label: label || '?' }) : t('reader.ai.source.page', { page }),
              )
            }),
          )
        : null,
      ok
        ? React.createElement(
            'div',
            { className: 'ph-r-ai__meta' },
            message.cached
              ? React.createElement('span', null, t('reader.ai.metaCached', { model: firstText(message.model, message.provider, 'AI') }))
              : message.provider || message.model
                ? React.createElement('span', null, t('reader.ai.meta', {
                    model: firstText(message.model, message.provider, 'AI'),
                    elapsed: num(message.elapsedMs, 0),
                  }))
                : null,
            !message.cached && message.elapsedMs && !message.provider && !message.model
              ? React.createElement('span', null, String(formatElapsed(message.elapsedMs)) )
              : null,
            message.fast
              ? React.createElement(
                  'span',
                  {
                    className: 'ph-r-ai__fast',
                    title: firstText(message.reasoningEffort, t('reader.ai.mode.fastHint')),
                  },
                  t('reader.ai.fastBadge'),
                )
              : null,
          )
        : imageHint
          ? React.createElement(
              'div',
              { className: 'ph-r-ai__answer-actions' },
              React.createElement(
                Btn,
                { size: 'sm', variant: 'soft', icon: 'image', onClick: props.onDisableImage },
                t('reader.ai.imageUnsupported'),
              ),
            )
          : null,
      ok
        ? React.createElement(
            'div',
            { className: 'ph-r-ai__answer-actions' },
            React.createElement(Btn, { size: 'sm', variant: 'ghost', icon: 'copy', onClick: () => props.onCopyAnswer(answer) }, t('reader.ai.answer.copy')),
            React.createElement(Btn, { size: 'sm', variant: 'ghost', icon: 'quote', onClick: () => props.onCiteAnswer(message) }, t('reader.ai.answer.cite')),
          )
        : null,
    ),
  )
}

/** One user message with its captured context. */
function QuestionBlock(props) {
  const t = props.t
  return React.createElement(
    'div',
    { className: 'ph-r-ai__msg ph-r-ai__msg--user' },
    React.createElement('div', { className: 'ph-r-ai__role' }, t('reader.ai.you')),
    props.quote ? React.createElement('blockquote', { className: 'ph-r-ai__quote' }, props.quote.length > 180 ? props.quote.slice(0, 180) + '…' : props.quote) : null,
    React.createElement('div', { className: 'ph-r-ai__bubble' }, props.text),
    props.includeImage
      ? React.createElement('span', { className: 'ph-r-ai__hint' }, '🖼 ' + t('reader.ai.includeImage'))
      : null,
  )
}

/**
 * @param {object} props
 * @param {object} props.t
 * @param {Function} props.api callable API (method, params) -> Promise<data>
 * @param {string|null} props.paperId
 * @param {number} props.page
 * @param {object|null} props.paper
 * @param {object|null} props.selection `{quote, page, rects}`
 * @param {object|null} props.request `{seq, type, prompt?, quote?, auto?}` from the shell
 * @param {Function} props.onJumpPage
 * @param {Function} props.onCiteAnswer
 * @param {Function} props.onClearSelection
 * @param {Function} props.notify
 * @param {string} [props.sessionId] Forwarded to ai.ask so the Host can bind its provider session.
 */
export function AiPanel(props) {
  const t = props.t
  const api = props.api
  const [draft, setDraft] = React.useState('')
  const [messages, setMessages] = React.useState([])
  const [busy, setBusy] = React.useState(false)
  const [includeImage, setIncludeImage] = React.useState(false)
  // v0.3: fast (non-thinking) vs deep (reasoning) answer modes.
  const [mode, setMode] = React.useState('deep')
  const [extraQuote, setExtraQuote] = React.useState('')
  const bodyRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const requestRef = React.useRef(0)
  const mountedRef = React.useRef(true)

  const statusState = useAsync(() => api('ai.status', {}), [props.paperId])

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  React.useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [messages.length, busy])

  const status = statusState.data || null
  const statusUnavailable = statusState.status === 'error' || (status && status.available === false)
  const statusReason = firstText(
    status && status.reason,
    statusState.error && statusState.error.message,
    t('reader.ai.reasonFallback'),
  )
  const maxChars = status && status.limits && status.limits.maxInputChars ? num(status.limits.maxInputChars, 0) : 0

  const selection = props.selection && props.selection.quote ? props.selection : null

  const ask = React.useCallback(
    (promptText, options) => {
      const opts = options || {}
      const prompt = String(promptText || '').trim()
      if (!prompt || busy || !props.paperId) return
      const quote = firstText(
        opts.quote,
        selection && selection.quote,
        !selection ? extraQuote : '',
      )
      const withImage = opts.includeImage != null ? Boolean(opts.includeImage) : includeImage
      if (!selection && extraQuote) setExtraQuote('')
      const displayText = quote ? prompt + '\n\n' + t('reader.ai.quotePrefix', { quote: quote.length > 160 ? quote.slice(0, 160) + '…' : quote }) : prompt
      const answerMode = opts.mode === 'fast' || opts.mode === 'deep' ? opts.mode : mode
      setMessages((previous) =>
        previous.concat([
          { id: nextMessageId(), role: 'user', text: displayText, quote, includeImage: withImage, mode: answerMode },
        ]),
      )
      setDraft('')
      setBusy(true)
      const params = { paperId: props.paperId, page: props.page, prompt, includeImage: withImage, mode: answerMode }
      if (answerMode === 'fast') params.fast = true
      if (quote) params.quote = quote
      if (props.sessionId) params.sessionId = props.sessionId
      let promise
      try {
        promise = api('ai.ask', params)
      } catch (error) {
        promise = Promise.reject(error)
      }
      Promise.resolve(promise)
        .then((result) => {
          if (!mountedRef.current) return
          const data = result || {}
          setMessages((previous) =>
            previous.concat([
              {
                id: nextMessageId(),
                role: 'assistant',
                status: firstText(data.status, 'ok'),
                answer: firstText(data.answer),
                reason: firstText(data.reason),
                mode: answerMode,
                fast: Boolean(data.fast) || answerMode === 'fast',
                reasoningEffort: firstText(data.reasoningEffort),
                provider: firstText(data.provider),
                model: firstText(data.model),
                elapsedMs: num(data.elapsedMs, 0),
                cached: Boolean(data.cached),
                sources: arrayOf(data.sources),
                prompt,
                quote,
                includeImage: withImage,
              },
            ]),
          )
        })
        .catch((error) => {
          if (!mountedRef.current) return
          setMessages((previous) =>
            previous.concat([
              {
                id: nextMessageId(),
                role: 'assistant',
                status: 'error',
                reason: firstText(error && error.message, 'error'),
                prompt,
                quote,
                includeImage: withImage,
                sources: [],
              },
            ]),
          )
        })
        .then(() => {
          if (mountedRef.current) setBusy(false)
        })
    },
    [api, busy, extraQuote, includeImage, mode, props.page, props.paperId, props.sessionId, selection, t],
  )

  // Shell-requested questions (selection “解释”, annotation “问 AI”, figure asks).
  React.useEffect(() => {
    const request = props.request
    if (!request || !request.seq || request.seq === requestRef.current) return
    requestRef.current = request.seq
    if (request.includeImage != null) setIncludeImage(Boolean(request.includeImage))
    const requestMode = request.mode === 'fast' || request.mode === 'deep' ? request.mode : null
    if (requestMode) setMode(requestMode)
    const type = firstText(request.type, 'ask')
    if (type === 'explain') {
      ask(firstText(request.prompt, t('reader.ai.prompt.explain')), { quote: request.quote, includeImage: request.includeImage })
      return
    }
    if (type === 'summary') {
      ask(firstText(request.prompt, t('reader.ai.prompt.summary')), { includeImage: request.includeImage })
      return
    }
    if (type === 'figure') {
      ask(firstText(request.prompt, t('reader.ai.prompt.figure')), { includeImage: true })
      return
    }
    if (request.auto) {
      ask(firstText(request.prompt, t('reader.ai.prompt.explain')), { quote: request.quote, includeImage: request.includeImage })
      return
    }
    if (!selection && request.quote) setExtraQuote(request.quote)
    setDraft(firstText(request.prompt))
    const element = inputRef.current
    if (element && typeof element.focus === 'function') element.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.request && props.request.seq])

  const onSend = () => {
    if (!draft.trim() || busy) return
    ask(draft, { quote: selection && selection.quote })
  }

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onSend()
    }
  }

  const copyAnswer = (text) => {
    copyText(text).then((ok) => props.notify(ok ? 'success' : 'error', ok ? t('reader.ai.answer.copied') : t('reader.toast.copyFailed')))
  }

  const contextChips = React.createElement(
    'div',
    { className: 'ph-r-ai__context' },
    React.createElement(Icon, { name: 'book', size: 12 }),
    props.paper
      ? React.createElement(Chip, { title: paperChipTitle(props.paper) }, paperChipTitle(props.paper) || t('reader.ai.context.paper'))
      : React.createElement(Chip, null, t('reader.ai.context.paper')),
    React.createElement(Chip, { icon: 'pages' }, t('reader.ai.context.page', { page: props.page })),
    selection
      ? React.createElement(Chip, {
          icon: 'highlighter',
          title: selection.quote,
          onRemove: props.onClearSelection,
          removeLabel: t('reader.ai.context.clear'),
        }, t('reader.ai.context.selection') + ' · ' + (selection.quote.length > 14 ? selection.quote.slice(0, 14) + '…' : selection.quote))
      : extraQuote
        ? React.createElement(Chip, {
            icon: 'highlighter',
            title: extraQuote,
            onRemove: () => setExtraQuote(''),
            removeLabel: t('reader.ai.context.clear'),
          }, t('reader.ai.context.selection') + ' · ' + (extraQuote.length > 14 ? extraQuote.slice(0, 14) + '…' : extraQuote))
        : null,
  )

  const empty = messages.length === 0
  const suggestions = [
    { key: 'summary', prompt: t('reader.ai.prompt.summary'), label: t('reader.ai.suggestion.summary') },
    { key: 'figure', prompt: t('reader.ai.prompt.figure'), label: t('reader.ai.suggestion.figure') },
    { key: 'relation', prompt: t('reader.ai.suggestion.relation'), label: t('reader.ai.suggestion.relation') },
  ]

  return React.createElement(
    'div',
    { className: 'ph-r-ai' },
    React.createElement(
      'div',
      {
        className: cx('ph-r-ai__status', statusState.status === 'ready' && status && status.available ? 'ph-r-ai__status--ok' : statusState.status === 'loading' ? '' : 'ph-r-ai__status--bad'),
        title: statusReason,
      },
      statusState.status === 'loading'
        ? React.createElement(Spinner, { size: 11 })
        : React.createElement(Icon, { name: statusUnavailable ? 'warning' : 'sparkles', size: 12 }),
      statusState.status === 'loading'
        ? React.createElement('span', null, t('reader.ai.status.loading'))
        : statusUnavailable
          ? React.createElement('span', null, t('reader.ai.status.unavailable', { reason: statusReason }))
          : React.createElement('span', null, t('reader.ai.status.available', { model: firstText(status && status.model, status && status.provider, 'AI') })),
      statusState.status === 'ready' && status && status.provider && status.model
        ? React.createElement(Badge, null, String(status.provider))
        : null,
      React.createElement('span', { className: 'ph-r-ai__spacer' }),
      statusState.status === 'error' && statusState.reload
        ? React.createElement(IconBtn, { icon: 'refresh', title: t('reader.retry'), onClick: statusState.reload })
        : null,
      messages.length > 0
        ? React.createElement(
            'button',
            { type: 'button', className: 'ph-r-toolbtn', onClick: () => setMessages([]), title: t('reader.ai.newChat') },
            React.createElement(Icon, { name: 'close', size: 12 }),
            React.createElement('span', null, t('reader.ai.newChat')),
          )
        : null,
    ),
    React.createElement(
      'div',
      { ref: bodyRef, className: 'ph-r-ai__body ph-r-scroll', 'data-ph-ai-messages': String(messages.length) },
      empty
        ? React.createElement(
            'div',
            { className: 'ph-r-ai__empty' },
            React.createElement(Empty, { icon: 'sparkles', title: t('reader.ai.title'), desc: t('reader.ai.empty') }),
            React.createElement(
              'div',
              { className: 'ph-r-ai__suggestions' },
              suggestions.map((item) =>
                React.createElement(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    className: 'ph-r-ai__suggestion',
                    disabled: busy || Boolean(statusUnavailable),
                    onClick: () => ask(item.prompt, { includeImage }),
                  },
                  item.label,
                ),
              ),
            ),
          )
        : messages.map((message) =>
            message.role === 'user'
              ? React.createElement(QuestionBlock, { key: message.id, t, text: message.text, quote: message.quote, includeImage: message.includeImage })
              : React.createElement(AnswerBlock, {
                  key: message.id,
                  t,
                  message,
                  onCopyAnswer: copyAnswer,
                  onCiteAnswer: props.onCiteAnswer,
                  onJumpPage: props.onJumpPage,
                  onDisableImage: () => {
                    setIncludeImage(false)
                    props.notify('info', t('reader.ai.imageUnsupported'))
                  },
                }),
          ),
      busy
        ? React.createElement(
            'div',
            { className: 'ph-r-ai__busy' },
            React.createElement(Spinner, { size: 12 }),
            React.createElement('span', null, t('reader.ai.asking')),
          )
        : null,
    ),
    React.createElement(
      'div',
      { className: 'ph-r-ai__composer' },
      contextChips,
      React.createElement(
        'div',
        { className: 'ph-r-ai__inputrow' },
        React.createElement('textarea', {
          ref: inputRef,
          className: 'ph-r-ai__input',
          value: draft,
          rows: 2,
          maxLength: maxChars > 0 ? maxChars : undefined,
          placeholder: t('reader.ai.placeholder'),
          disabled: Boolean(statusUnavailable) || busy,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: onKeyDown,
        }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'ph-r-btn ph-r-btn--solid ph-r-btn--md ph-r-btn--icon',
            onClick: onSend,
            disabled: busy || !draft.trim() || Boolean(statusUnavailable),
            title: t('reader.ai.send'),
            'aria-label': t('reader.ai.send'),
          },
          React.createElement(Icon, { name: 'send', size: 15 }),
        ),
      ),
      React.createElement(
        'div',
        { className: 'ph-r-ai__tools' },
        React.createElement(
          'div',
          { className: 'ph-r-ai__modes', role: 'group', 'aria-label': t('reader.ai.mode.label') },
          ['fast', 'deep'].map((value) =>
            React.createElement(
              'button',
              {
                key: value,
                type: 'button',
                className: cx('ph-r-ai__mode', mode === value && 'ph-r-ai__mode--active'),
                title: t('reader.ai.mode.' + value + 'Hint'),
                'aria-pressed': mode === value ? 'true' : 'false',
                onClick: () => setMode(value),
                disabled: busy,
              },
              value === 'fast' ? React.createElement(Icon, { name: 'sparkles', size: 11 }) : null,
              t('reader.ai.mode.' + value),
            ),
          ),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: cx('ph-r-ai__toggle', includeImage && 'ph-r-ai__toggle--on'),
            onClick: () => setIncludeImage((value) => !value),
            title: t('reader.ai.includeImageHint'),
            'aria-pressed': includeImage ? 'true' : 'false',
          },
          React.createElement('span', { className: 'ph-r-ai__check' }, includeImage ? React.createElement(Icon, { name: 'check', size: 8 }) : null),
          React.createElement('span', null, t('reader.ai.includeImage')),
        ),
        maxChars > 0 ? React.createElement('span', { className: 'ph-r-ai__hint' }, t('reader.ai.limit', { chars: maxChars })) : null,
        React.createElement('span', { className: 'ph-r-ai__spacer' }),
        busy ? React.createElement('span', { className: 'ph-r-ai__hint' }, t('reader.ai.asking')) : null,
      ),
    ),
  )
}
