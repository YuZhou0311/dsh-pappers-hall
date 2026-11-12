/**
 * Host transport for the Pappers-Hall client half.
 *
 * The client and the Host share the desktop Web origin, so a relative POST to
 * `/pappers-hall/api` carries the session cookies the browser already holds.
 * A 404 means the plugin row is disabled or absent (`not_running`); only a
 * transport-layer failure is retried once against the shell's advertised
 * `globalThis.__DSH_TRANSPORT__.streamBaseUrl` (never a 404/500 answer).
 */
import { API_PATH } from './constants.js'

/** Build an Error carrying the contract error code. */
export function apiError(code, message) {
  const error = new Error(message || code || 'error')
  error.code = code || 'internal'
  return error
}

/** Optional absolute transport base published by the desktop shell. */
function transportBaseUrl() {
  try {
    const globals = typeof globalThis !== 'undefined' ? globalThis : undefined
    const transport = globals && globals.__DSH_TRANSPORT__
    const base = transport && transport.streamBaseUrl
    if (typeof base === 'string' && /^https?:\/\//i.test(base)) return base.replace(/\/+$/, '')
  } catch {
    /* the shell global is best-effort */
  }
  return ''
}

/** Run one request and unwrap `{ok,data|error}`. */
function request(method, body, signal) {
  return Promise.resolve()
    .then(() => {
      if (typeof fetch !== 'function') throw apiError('unavailable', 'fetch is unavailable')
      return fetch(method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        credentials: 'same-origin',
        signal: signal,
      })
    })
    .then((response) => {
      return response.text().then((text) => {
        let payload = null
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
        // A JSON contract error (e.g. `not_found` for a stale note id) must keep
        // its real code. Only a bare 404 from the plugin route means the Host is
        // disabled; mapping every 404 to "not running" hid the actual failure.
        if (!response.ok) {
          if (payload && payload.error && typeof payload.error === 'object') {
            const error = payload.error
            const failure = apiError(error.code || 'http_' + response.status, error.message || 'HTTP ' + response.status)
            if (error.detail && typeof error.detail === 'object') failure.detail = error.detail
            throw failure
          }
          if (response.status === 404) throw apiError('not_running', 'Pappers-Hall is not running or is disabled')
          throw apiError('http_' + response.status, 'HTTP ' + response.status)
        }
        if (!payload || typeof payload !== 'object') throw apiError('invalid', 'malformed JSON response')
        if (payload.ok === true) return payload.data
        const error = payload.error && typeof payload.error === 'object' ? payload.error : {}
        const failure = apiError(error.code || 'internal', error.message || 'request failed')
        if (error.detail && typeof error.detail === 'object') failure.detail = error.detail
        throw failure
      })
    })
    .catch((error) => {
      if (error && error.name === 'AbortError') throw error
      if (error && error.code) throw error
      throw apiError('network', error && error.message ? error.message : String(error))
    })
}

/** Transport-layer failure as opposed to a Host answer (404/500 included). */
export function isOffline(error) {
  return Boolean(error) && (error.code === 'not_running' || error.code === 'network')
}

/** `unavailable`/`degraded` answers are expected capability states, not bugs. */
export function isUnavailable(error) {
  return Boolean(error) && (error.code === 'unavailable' || error.code === 'degraded')
}

/** Localized, contract-aware error text. */
export function describeError(t, error) {
  if (!error) return t('common.unknownError')
  switch (error.code) {
    case 'not_running':
      return t('common.offline.title')
    case 'network':
      return t('common.network') + (error.message ? ' (' + error.message + ')' : '')
    case 'unavailable':
    case 'degraded':
      return error.message || t('common.unavailable')
    case 'http_404':
      return t('common.offline.title')
    case 'timeout':
      return t('common.timeout')
    default:
      return error.message || t('common.unknownError')
  }
}

/**
 * Call one Host API method over same-origin HTTP (contract §2).
 * @param {string} method Contract method name, e.g. `library.list`.
 * @param {object|undefined} params Method parameters.
 * @param {{signal?: AbortSignal}|undefined} options Transport options.
 * @returns {Promise<any>} Resolves with the unwrapped `data` payload.
 */
export function createApi() {
  const called = new Set()
  function api(method, params, options) {
    called.add(method)
    const opts = options || {}
    const body = JSON.stringify({ method: method, params: params == null ? {} : params })
    return request(API_PATH, body, opts.signal).catch((error) => {
      if (error && error.name === 'AbortError') throw error
      if (!error || error.code !== 'network') throw error
      const base = transportBaseUrl()
      if (!base) throw error
      let absolute
      try {
        absolute = new URL(API_PATH, base + '/').href
      } catch {
        throw error
      }
      if (absolute === API_PATH) throw error
      return request(absolute, body, opts.signal)
    })
  }
  Object.defineProperty(api, 'methods', {
    enumerable: false,
    get: () => Array.from(called),
  })
  return api
}

/** Shared API callable for surfaces that are not given one through props. */
export const defaultApi = createApi()
