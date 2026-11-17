#!/usr/bin/env node
/**
 * Real-browser verification for the Pappers-Hall UI (Lead / verifier only).
 *
 * Drives headless Chrome over the DevTools protocol using the browser session
 * cookie stored by the DSH Desktop application, so screenshots show the actual
 * Harness Web UI with this plugin enabled. Node's built-in WebSocket is used;
 * no npm dependency is required.
 *
 * Usage:
 *   node scripts/browser-shot.mjs --out /tmp/shots --steps sidebar,library
 *   node scripts/browser-shot.mjs --out /tmp/shots --steps all
 *
 * The cookie is read from the Electron cookie store in place; the value is
 * never printed or written to a report.
 */
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.PAPPERS_BASE ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const TOKEN = process.env.PAPPERS_TOKEN ?? ''
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const OUT = arg('--out', '/tmp/pappers-shots')
const STEPS = (arg('--steps', 'all') ?? 'all').split(',').map((s) => s.trim()).filter(Boolean)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(arg('--port', '9333'))

mkdirSync(OUT, { recursive: true })
const profileDir = join(tmpdir(), `pappers-chrome-${process.pid}`)
mkdirSync(profileDir, { recursive: true })

/** Read the freshest authenticated cookie for 127.0.0.1 from the Electron store. */
function readCookie() {
  const base = join(process.env.HOME ?? '', 'Library/Application Support/@deepseek-ai/dsh-desktop')
  const candidates = []
  const walk = (dir, depth) => {
    if (depth < 0) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth - 1)
      else if (entry.name === 'Cookies') candidates.push(full)
    }
  }
  walk(base, 4)
  for (const source of candidates) {
    const copy = join(tmpdir(), `pappers-cookies-${process.pid}-${candidates.indexOf(source)}.db`)
    try { copyFileSync(source, copy) } catch { continue }
    try {
      const db = new DatabaseSync(copy, { readOnly: true })
      const rows = db.prepare(
        'SELECT host_key, name, value, cast(last_access_utc as text) AS accessed FROM cookies WHERE value IS NOT NULL AND length(value) > 0 AND (host_key = ? OR host_key = ? OR host_key LIKE ?) ORDER BY accessed DESC',
      ).all('127.0.0.1', 'localhost', '%127.0.0.1%')
      db.close()
      const row = rows.find((entry) => entry.name && entry.value)
      if (row) return { name: row.name, value: row.value }
    } catch {
      /* encrypted/locked cookie DB: try the next partition */
    }
  }
  throw new Error('no DSH browser cookie found; open the DSH window once')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.console = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.method === 'Runtime.consoleAPICalled') {
        try { this.console.push({ type: message.params.type, args: (message.params.args || []).map((arg) => arg.value || arg.description || '').join(' ').slice(0, 500) }) } catch {}
      }
      if (message.method === 'Runtime.exceptionThrown') {
        try { this.console.push({ type: 'exception', args: message.params.exceptionDetails?.text || '' }) } catch {}
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`))
        else resolve(message.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} -> ${response.status}`)
  return response.json()
}

function launchChrome() {
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  const child = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1586,992',
    '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  return child
}

async function waitForDevTools(timeoutMs = 20_000) {
  const started = Date.now()
  for (;;) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* retry */
    }
    if (Date.now() - started > timeoutMs) throw new Error('Chrome DevTools endpoint did not appear')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const cookie = TOKEN === '' ? readCookie() : null
  const chrome = launchChrome()
  let ws
  try {
    const wsUrl = await waitForDevTools()
    ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const cdp = new Cdp(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1586, height: 992, deviceScaleFactor: 1, mobile: false })
    if (cookie !== null) {
      await cdp.send('Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: false,
        url: BASE,
      })
    }

    const shots = []
    async function shot(name) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const path = join(OUT, `${name}.png`)
      writeFileSync(path, Buffer.from(data, 'base64'))
      shots.push(path)
      console.log(`screenshot: ${path}`)
      return path
    }

    async function evaluate(expression, awaitPromise = false) {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
      if (result.exceptionDetails) throw new Error(`page exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
      return result.result.value
    }

    async function captureButtons(name) {
      const list = await evaluate(`(() => [...document.querySelectorAll('button, [role="button"]')].filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }).map((element) => ({
        label: (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        className: String(element.getAttribute('class') || '').slice(0, 160),
        disabled: element.disabled === true,
        tag: element.tagName,
      })))()`)
      writeFileSync(join(OUT, 'buttons-' + name + '.json'), JSON.stringify(list, null, 2))
      console.log('visible buttons ' + name + ':', list.length)
      return list
    }

    async function waitFor(expression, timeoutMs = 30_000, label = expression) {
      const started = Date.now()
      for (;;) {
        const value = await evaluate(expression)
        if (value) return value
        if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
        await sleep(300)
      }
    }

    await cdp.send('Page.navigate', { url: TOKEN === '' ? BASE + '/' : BASE + '/?token=' + encodeURIComponent(TOKEN) })
    await waitFor("document.readyState === 'complete'", 40_000, 'page load')
    await waitFor("document.querySelector('#root') !== null", 40_000, 'react root')
    await sleep(2500)
    await shot('00-boot')

    // Dismiss the first-run preview notice if this fresh browser session shows it.
    const dismissed = await evaluate(`(() => {
      const labels = ['继续', 'Continue', '知道了', '关闭']
      const buttons = [...document.querySelectorAll('button')]
      const target = buttons.find((button) => labels.includes((button.textContent || '').trim()))
      if (!target) return false
      target.click()
      return true
    })()`)
    if (dismissed) { await sleep(800); await shot('00b-boot-dismissed') }
    console.log('first-run notice dismissed:', dismissed)

    async function ensureLibrary() {
      const already = await evaluate("document.querySelector('.ph-center') !== null")
      if (already) return
      await evaluate(`(() => {
        const candidates = [...document.querySelectorAll('button, a, [role="button"]')]
        const exact = candidates.find((element) => (element.textContent || '').trim() === '论文中心')
        if (exact) { exact.click(); return true }
        const icon = document.querySelector('[class*="ph-panel-icon"], [aria-label="论文中心"]')
        if (icon) { icon.click(); return true }
        return false
      })()`)
      await waitFor("document.querySelector('.ph-center') !== null", 20_000, 'library page')
      await sleep(800)
    }

    async function ensureConversation() {
      const hasHeader = await evaluate("Boolean(document.querySelector('button[aria-label=\"打开论文抽屉\"], button[aria-label=\"Open the paper drawer\"]'))")
      if (hasHeader) return true
      const clicked = await evaluate(`(() => {
        const direct = [...document.querySelectorAll('[data-session-id], [data-dsh-session-id]')]
        if (direct.length > 0) { direct[0].click(); return true }
        const all = [...document.querySelectorAll('button, a, [role="button"], div, li')]
        const candidates = all.filter((element) => /开发 Pappers-Hall 插件并测试|Pappers-Hall 论文内容询问|Reflexion 速记笔记解读/.test((element.textContent || '').trim()))
          .sort((left, right) => (left.textContent || '').length - (right.textContent || '').length)
        if (candidates.length === 0) return false
        candidates[0].click()
        return true
      })()`)
      if (!clicked) return false
      try {
        await waitFor("Boolean(document.querySelector('button[aria-label=\"打开论文抽屉\"], button[aria-label=\"Open the paper drawer\"]'))", 12_000, 'conversation header')
        return true
      } catch { return false }
    }

    const want = (step) => STEPS.includes('all') || STEPS.includes(step)

    if (want('sidebar')) {
      const sidebar = await evaluate(`(() => {
        const text = document.body.innerText || ''
        return { hasPaperCenter: text.includes('论文中心'), text: text.slice(0, 4000) }
      })()`)
      console.log('sidebar text contains 论文中心:', sidebar.hasPaperCenter)
      writeFileSync(join(OUT, 'sidebar-text.txt'), sidebar.text)
      await shot('01-sidebar')
    }

    // Click the sidebar entry (button whose accessible name contains 论文中心).
    if (STEPS.includes('probe-input-actions')) {
      const surface = await evaluate(`(() => {
        const entry = document.querySelector('.ph-composer-entry')
        const props = entry && (entry.__reactProps$ || null)
        const keys = entry ? Object.keys(entry).filter((k) => k.startsWith('__react')) : []
        return { hasEntry: Boolean(entry), keys }
      })()`)
      console.log('probe entry:', JSON.stringify(surface))
      const names = await evaluate(`(() => {
        const node = document.querySelector('.ph-composer-entry')
        const key = Object.keys(node || {}).find((k) => k.startsWith('__reactFiber'))
        if (!key) return null
        let fiber = node[key]
        const seen = []
        for (let i = 0; i < 40 && fiber; i += 1) {
          const props = fiber.memoizedProps
          if (props && typeof props === 'object') {
            const found = Object.keys(props).filter((k) => /inputActions|send|submit|composer/i.test(k))
            if (found.length) seen.push({ tag: typeof fiber.type === 'string' ? fiber.type : (fiber.type && (fiber.type.name || fiber.type.displayName)) || 'fn', keys: found, actionMethods: found.includes('inputActions') && props.inputActions ? Object.keys(props.inputActions) : null })
          }
          fiber = fiber.return
        }
        return seen.slice(0, 6)
      })()`)
      console.log('probe props:', JSON.stringify(names))
      const setDraftTest = await evaluate(`(() => {
        const node = document.querySelector('.ph-composer-entry')
        const key = Object.keys(node || {}).find((k) => k.startsWith('__reactFiber'))
        let fiber = node && node[key]
        let actions = null
        for (let i = 0; i < 40 && fiber; i += 1) {
          if (fiber.memoizedProps && fiber.memoizedProps.inputActions) { actions = fiber.memoizedProps.inputActions; break }
          fiber = fiber.return
        }
        if (!actions) return { ok: false }
        const composer = document.querySelector('[data-composer-input="true"]')
        const before = composer ? composer.innerText : ''
        try { actions.setDraft('probe-draft-xyz') } catch (error) { return { ok: false, error: String(error) } }
        return { ok: true, before: before.slice(0, 80) }
      })()`)
      await sleep(600)
      const after = await evaluate(`(() => { const composer = document.querySelector('[data-composer-input="true"]'); return composer ? composer.innerText.slice(0, 120) : null })()`)
      console.log('setDraft probe:', JSON.stringify(setDraftTest), 'after:', JSON.stringify(after))
    }
    if (STEPS.includes('probe-attachments')) {
      const out = await evaluate(`(() => {
        const node = document.querySelector('.ph-composer-entry')
        const key = Object.keys(node || {}).find((k) => k.startsWith('__reactFiber'))
        let fiber = node && node[key]
        let actions = null
        for (let i = 0; i < 40 && fiber; i += 1) {
          if (fiber.memoizedProps && fiber.memoizedProps.inputActions) { actions = fiber.memoizedProps.inputActions; break }
          fiber = fiber.return
        }
        if (!actions) return { ok: false }
        const results = {}
        try { results.quoteObj = actions.insertQuote({ text: 'quoted', ref: '@论文中心(bn-abc)' }) } catch (e) { results.quoteObjErr = String(e.message || e) }
        try { results.attach = actions.addAttachments([{ name: 'x.txt', content: 'hello' }]) } catch (e) { results.attachErr = String(e.message || e) }
        return results
      })()`)
      await sleep(600)
      const dom = await evaluate(`(() => ({ text: (document.querySelector('[data-composer-input=\"true\"]')?.innerText || '').slice(0, 120), attachments: document.querySelectorAll('[data-composer-attachment], [class*=attachment]').length }))()`)
      console.log('probe attachments:', JSON.stringify(out), JSON.stringify(dom))
    }
    if (STEPS.includes('probe-insert-quote')) {
      const result = await evaluate(`(() => {
        const node = document.querySelector('.ph-composer-entry')
        const key = Object.keys(node || {}).find((k) => k.startsWith('__reactFiber'))
        let fiber = node && node[key]
        let actions = null
        for (let i = 0; i < 40 && fiber; i += 1) {
          if (fiber.memoizedProps && fiber.memoizedProps.inputActions) { actions = fiber.memoizedProps.inputActions; break }
          fiber = fiber.return
        }
        if (!actions) return { ok: false }
        const out = {}
        try { actions.setDraft('') } catch (e) { out.clearErr = String(e) }
        try { out.obj = actions.insertQuote({ source: 'pappers-hall-papers', ref: '@论文中心(paper:ph-9f04b9732334)', label: '全球格点作物模型评估', appearance: 'paper' }) } catch (error) { out.objErr = String(error) }
        return out
      })()`)
      await sleep(700)
      const text = await evaluate(`(() => { const c = document.querySelector('[data-composer-input="true"]'); return c ? { text: c.innerText.slice(0, 200), html: c.innerHTML.slice(0, 400) } : null })()`)
      console.log('insertQuote probe:', JSON.stringify(result), 'composer:', JSON.stringify(text))
    }
    if (STEPS.includes('probe-surround')) {
      await evaluate(`(() => {
        const node = document.querySelector('.ph-composer-entry')
        const key = Object.keys(node || {}).find((k) => k.startsWith('__reactFiber'))
        let fiber = node && node[key]
        let actions = null
        for (let i = 0; i < 40 && fiber; i += 1) {
          if (fiber.memoizedProps && fiber.memoizedProps.inputActions) { actions = fiber.memoizedProps.inputActions; break }
          fiber = fiber.return
        }
        if (actions) actions.setDraft('@论文中心 1 篇论文 + 1 条笔记《Reflexion 速记：不更新权重，只让 Agent 记住教训》\\n\\n补充一句')
        return Boolean(actions)
      })()`)
      await sleep(800)
      const wrapped = await evaluate(`(() => {
        const composer = document.querySelector('[data-composer-input="true"]')
        if (!composer) return { ok: false }
        const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT, null)
        let target = null
        let node = walker.nextNode()
        while (node) {
          if ((node.nodeValue || '').startsWith('@论文中心')) { target = node; break }
          node = walker.nextNode()
        }
        if (!target) return { ok: false, reason: 'no text' }
        const text = target.nodeValue
        const range = document.createRange()
        range.setStart(target, 0)
        const match = text.match(/^@论文中心 [^\\n]*?》/)
        const len = match ? match[0].length : 20
        range.setEnd(target, len)
        const span = document.createElement('span')
        span.className = 'ph-citeblock'
        span.setAttribute('data-ph-citeblock', 'probe')
        range.surroundContents(span)
        return { ok: true, len, wrapped: span.textContent.length }
      })()`)
      await sleep(1200)
      const state = await evaluate(`(() => {
        const composer = document.querySelector('[data-composer-input="true"]')
        return {
          stillThere: Boolean(composer && composer.querySelector('[data-ph-citeblock="probe"]')),
          text: (composer?.innerText || '').slice(0, 140),
        }
      })()`)
      console.log('surround probe:', JSON.stringify(wrapped), JSON.stringify(state))
      await shot('probe-surround')
    }

    if (STEPS.includes('probe-paragraph-split')) {
      await evaluate(`(() => {
        const node = document.querySelector('.ph-composer-entry')
        const key = Object.keys(node || {}).find((k) => k.startsWith('__reactFiber'))
        let fiber = node && node[key]
        let actions = null
        for (let i = 0; i < 40 && fiber; i += 1) {
          if (fiber.memoizedProps && fiber.memoizedProps.inputActions) { actions = fiber.memoizedProps.inputActions; break }
          fiber = fiber.return
        }
        if (!actions) return false
        actions.setDraft('@论文中心 1 篇论文')
        return true
      })()`)
      await sleep(700)
      const split = await evaluate(`(() => {
        const composer = document.querySelector('[data-composer-input="true"]')
        if (!composer) return { ok: false }
        composer.focus()
        const selection = window.getSelection()
        selection.selectAllChildren(composer)
        selection.collapseToEnd()
        document.execCommand('insertParagraph')
        return { ok: true }
      })()`)
      await sleep(700)
      const dom = await evaluate(`(() => {
        const composer = document.querySelector('[data-composer-input="true"]')
        const ps = composer ? [...composer.children].map((child) => ({ tag: child.tagName, text: (child.textContent || '').slice(0, 40), html: child.innerHTML.slice(0, 120) })) : []
        return { paragraphs: ps.length, ps }
      })()`)
      console.log('paragraph split:', JSON.stringify(split), JSON.stringify(dom).slice(0, 700))
      await shot('probe-paragraph-split')
    }

    if (STEPS.includes('probe-wrap-chip')) {
      await evaluate(`(() => {
        const node = document.querySelector('.ph-composer-entry')
        const key = Object.keys(node || {}).find((k) => k.startsWith('__reactFiber'))
        let fiber = node && node[key]
        let actions = null
        for (let i = 0; i < 40 && fiber; i += 1) {
          if (fiber.memoizedProps && fiber.memoizedProps.inputActions) { actions = fiber.memoizedProps.inputActions; break }
          fiber = fiber.return
        }
        if (actions) actions.setDraft('@论文中心 2 篇论文\\n\\n这句是用户补充')
        return Boolean(actions)
      })()`)
      await sleep(900)
      const state = await evaluate(`(() => {
        const composer = document.querySelector('[data-composer-input="true"]')
        const block = composer ? composer.querySelector('[data-ph-citeblock="1"]') : null
        return { text: (composer?.innerText || '').slice(0, 100), blocks: block ? 1 : 0, style: block ? getComputedStyle(block).backgroundColor : null }
      })()`)
      console.log('composer chip:', JSON.stringify(state))
      await shot('probe-composer-chip')
      const typed = await evaluate(`(() => {
        const composer = document.querySelector('[data-composer-input="true"]')
        if (!composer) return false
        composer.focus()
        const selection = window.getSelection()
        selection.selectAllChildren(composer)
        selection.collapseToEnd()
        document.execCommand('insertText', false, '继续打字')
        return true
      })()`)
      await sleep(800)
      const after = await evaluate(`(() => {
        const composer = document.querySelector('[data-composer-input="true"]')
        const block = composer ? composer.querySelector('[data-ph-citeblock="1"]') : null
        return { text: (composer?.innerText || '').slice(0, 120), blocks: block ? 1 : 0 }
      })()`)
      console.log('composer chip after typing:', typed, JSON.stringify(after))
      await shot('probe-composer-chip-typing')
    }

    if (STEPS.includes('probe-theme')) {
      const info = await evaluate(`(() => {
        const keys = []
        try { for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i)) } catch (e) {}
        const attr = document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('class') || ''
        const scheme = getComputedStyle(document.documentElement).colorScheme
        return { keys, attr, scheme, bodyClass: document.body.className }
      })()`)
      console.log('theme probe:', JSON.stringify(info).slice(0, 500))
    }
    if (STEPS.includes('probe-semantic')) {
      await ensureLibrary()
      await sleep(800)
      await evaluate(`(() => {
        window.__phCalls = []
        const original = window.fetch
        window.fetch = function (...args) {
          try {
            const input = args[0]
            const body = args[1] && args[1].body ? String(args[1].body) : ''
            window.__phCalls.push({ url: String(input && input.url ? input.url : input).slice(-40), body: body.slice(0, 120) })
          } catch (error) { /* ignore */ }
          return original.apply(this, args)
        }
        return true
      })()`)
      await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('.ph-searchmode__btn')]
        const semantic = buttons.find((button) => /语义|Semantic/.test((button.textContent || '').trim()))
        if (semantic) semantic.click()
        return true
      })()`)
      await sleep(500)
      await evaluate(`(() => {
        const input = document.querySelector('.ph-center__globalsearch input, input.ph-search__input, .ph-search input')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, 'reasoning agents')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      let waited = 0
      while (waited < 25000) {
        const count = await evaluate("document.querySelectorAll('.ph-sim').length")
        if (Number(count) > 0) break
        await sleep(900)
        waited += 900
      }
      const report = await evaluate(`(() => ({
        calls: (window.__phCalls || []).filter((call) => /semantic|search\.query|library\.list/.test(call.body)).slice(-12),
        modeButtons: [...document.querySelectorAll('.ph-searchmode__btn')].map((b) => ({ label: (b.textContent || '').trim(), active: b.getAttribute('aria-pressed') === 'true' })),
        rows: document.querySelectorAll('.ph-rowitem').length,
        sims: [...document.querySelectorAll('.ph-sim')].map((node) => node.textContent.trim()),
        emptyText: (document.querySelector('.ph-empty')?.textContent || '').slice(0, 120),
        channels: [...document.querySelectorAll('.ph-semchip')].map((chip) => (chip.textContent || '').trim()),
      }))()`)
      console.log('probe-semantic:', JSON.stringify(report).slice(0, 1400))
      await shot('51-semantic-probe')
    }

    if (STEPS.includes('semantic')) {
      await ensureLibrary()
      await sleep(900)
      const toggled = await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('.ph-searchmode__btn')]
        const semantic = buttons.find((button) => /语义|Semantic/.test((button.textContent || '').trim()))
        if (!semantic) return { found: false, buttons: buttons.map((b) => (b.textContent || '').trim()) }
        semantic.click()
        return { found: true, pressed: semantic.getAttribute('aria-pressed') }
      })()`)
      console.log('semantic toggle:', JSON.stringify(toggled))
      await sleep(600)
      const typed = await evaluate(`(() => {
        const input = document.querySelector('.ph-center__globalsearch input, input.ph-search__input, .ph-search input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, 'models that reason and act')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      console.log('typed query:', typed)
      await sleep(4000)
      const state = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('.ph-rowitem')].map((row) => ({
          title: (row.querySelector('.ph-rowitem__title')?.textContent || '').trim().slice(0, 46),
          sim: (row.querySelector('.ph-sim')?.textContent || '').trim(),
        }))
        const chips = [...document.querySelectorAll('.ph-semchip')].map((chip) => (chip.textContent || '').trim())
        const mode = [...document.querySelectorAll('.ph-searchmode__btn')].map((button) => ({ label: (button.textContent || '').trim(), active: button.getAttribute('aria-pressed') === 'true' }))
        return { rows: rows.slice(0, 6), chips, mode, empty: Boolean(document.querySelector('.ph-empty')) }
      })()`)
      console.log('semantic results:', JSON.stringify(state).slice(0, 900))
      await shot('50-semantic-search')
    }

    if (STEPS.includes('onboarding')) {
      const dismissed = await evaluate(`(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"], .ph-modalbackdrop')].filter((dialog) => !dialog.closest('.ph-onbcard') && !dialog.classList.contains('ph-onb'))
        let closed = 0
        for (const dialog of dialogs) {
          const close = dialog.querySelector('button[aria-label*="关闭"], button[aria-label*="Close"], .ph-dialog__head button, button[aria-label*="close"]')
          if (close) { close.click(); closed += 1 }
        }
        return closed
      })()`)
      console.log('app dialogs dismissed:', dismissed)
      await sleep(600)
      await ensureLibrary()
      await sleep(1200)
      const cardState = () => evaluate(`(() => {
        const card = document.querySelector('.ph-onbcard')
        if (!card) return { found: false }
        const rows = [...card.querySelectorAll('.ph-onbtask')].map((row) => ({
          label: (row.querySelector('.ph-onbtask__label')?.textContent || '').trim(),
          done: row.classList.contains('is-done'),
          next: row.classList.contains('is-next'),
          action: (row.querySelector('.ph-iconbtn, .ph-btn')?.getAttribute('aria-label') || '').trim(),
        }))
        return { found: true, count: (card.querySelector('.ph-onbcard__count')?.textContent || '').trim(), rows }
      })()`)
      const before = await cardState()
      console.log('checklist before:', JSON.stringify(before).slice(0, 700))
      await shot('40-checklist')
      const clicked = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('.ph-onbtask')]
        for (const row of rows) {
          if (row.classList.contains('is-done')) continue
          const button = row.querySelector('.ph-iconbtn, .ph-btn')
          if (button) { button.click(); return (button.getAttribute('aria-label') || button.title || 'action') }
        }
        return null
      })()`)
      console.log('clicked first unfinished row action:', clicked)
      await sleep(6000)
      console.log('checklist after import:', JSON.stringify(await cardState()).slice(0, 700))
      await shot('41-checklist-imported')
      const opened = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('.ph-onbtask')]
        for (const row of rows) {
          if (row.classList.contains('is-done')) continue
          const button = row.querySelector('.ph-btn')
          if (button) { button.click(); return (button.textContent || '').trim() }
        }
        return null
      })()`)
      console.log('clicked open action:', opened)
      await sleep(2500)
      const readerState = await evaluate(`(() => ({
        reader: Boolean(document.querySelector('[data-ph-reader]')),
        coach: document.querySelector('.ph-onbcoach__text')?.textContent || null,
      }))()`)
      console.log('reader/coach:', JSON.stringify(readerState))
      await shot('42-reader-coach')
    }

    if (want('library') || want('all')) {
      const clicked = await evaluate(`(() => {
        const candidates = [...document.querySelectorAll('button, a, [role="button"]')]
        const exact = candidates.find((element) => (element.textContent || '').trim() === '论文中心')
        const target = exact || document.querySelector('[aria-label="论文中心"], [class*="ph-panel-icon"]')
        if (!target) return { clicked: false, count: candidates.length }
        target.click()
        return { clicked: true, tag: target.tagName, label: (target.getAttribute('aria-label') || target.textContent || '').trim().slice(0, 80) }
      })()`)
      console.log('sidebar click:', JSON.stringify(clicked))
      await sleep(1500)
      const state = await evaluate(`(() => {
        const text = document.body.innerText || ''
        return { hasImport: text.includes('导入'), hasSearch: text.includes('搜索'), classes: [...new Set([...document.querySelectorAll('[class*="ph-"]')].map((e) => String(e.getAttribute('class') || '').split(' ').filter((c) => c.startsWith('ph-')).join(' ')))].slice(0, 40) }
      })()`)
      console.log('library state:', JSON.stringify(state).slice(0, 1200))
      await shot('02-library')
      await captureButtons('library')
      if (STEPS.includes('library-details')) {
        const selected = await evaluate(`(() => {
          const row = document.querySelector('.ph-rowitem')
          if (!row) return false
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
          return true
        })()`)
        await sleep(700)
        const detail = await evaluate(`(() => ({ hasOpen: document.body.innerText.includes('打开阅读器'), hasMore: document.body.innerText.includes('更多操作'), actionButtons: [...document.querySelectorAll('.ph-detailactions .ph-btn, .ph-detailmore .ph-btn')].map((b) => b.textContent.trim()).slice(0, 12) }))()`)
        console.log('details after row click:', selected, JSON.stringify(detail))
        await shot('02b-details-actions')
        const batch = await evaluate(`(() => {
          const check = document.querySelector('.ph-rowitem input[type=checkbox]')
          if (!check) return false
          check.click()
          return true
        })()`)
        await sleep(500)
        await shot('02c-batch-bar')
      }
    }

    if (want('reader') || want('all')) {
      await ensureLibrary()
      // Open the first paper card in the library grid.
      const opened = await evaluate(`(() => {
        const card = document.querySelector('[data-ph-card="paper"], [data-ph-id]')
        if (!card) return { opened: false, cards: document.querySelectorAll('[data-ph-card="paper"], [data-ph-id]').length }
        card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
        return { opened: true, id: card.getAttribute('data-ph-id') }
      })()`)
      console.log('card click:', JSON.stringify(opened))
      await sleep(2000)
      await shot('03-reader')
      const reader = await evaluate(`(() => {
        const text = document.body.innerText || ''
        return { hasOriginal: text.includes('原文'), hasFigure: text.includes('图表') || text.includes('Figure'), hasAnnotation: text.includes('批注'), snippet: text.slice(0, 2500) }
      })()`)
      console.log('reader state:', JSON.stringify(reader).slice(0, 1500))
      writeFileSync(join(OUT, 'reader-text.txt'), reader.snippet ?? '')
      await captureButtons('reader')
      if (STEPS.includes('reader-figure-page-drag')) {
        // Figures on the page are drag sources; the payload must be a figure
        // material so a drop on a session row or the composer can reference it.
        const regions = await evaluate(`(() => {
          const nodes = [...document.querySelectorAll('.ph-r-figdrag')]
          return { count: nodes.length, ids: nodes.slice(0, 5).map((node) => node.getAttribute('data-ph-figure-drag')), draggable: nodes.every((node) => node.draggable) }
        })()`)
        console.log('page figure regions:', JSON.stringify(regions))
        const payload = await evaluate(`(() => {
          const node = document.querySelector('.ph-r-figdrag')
          if (!node) return { found: false }
          const data = new DataTransfer()
          node.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
          const raw = data.getData('application/x-pappers-hall-material')
          node.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
          return { found: true, types: [...data.types], payload: raw.slice(0, 240) }
        })()`)
        console.log('page figure drag payload:', JSON.stringify(payload))
        if (payload.found && !String(payload.payload || '').includes('figure')) throw new Error('page figure drag published no figure material')
        await shot('03g-reader-figure-page-drag')
      }
      if (STEPS.includes('provider-warning')) {
        const aiTab = await evaluate(`(() => {
          const button = [...document.querySelectorAll('.ph-r-side__tabs button, .ph-r-side__tabs [role="tab"], button')].find((item) => (item.textContent || '').trim() === 'AI')
          if (!button) return false
          button.click()
          return true
        })()`)
        await sleep(800)
        const asked = await evaluate(`(() => {
          const input = document.querySelector('.ph-r-ai__input')
          if (!input) return { input: false }
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          setter.call(input, 'Summarize this paper in one sentence.')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          const send = document.querySelector('.ph-r-ai__inputrow button')
          if (send) send.click()
          return { input: true, send: Boolean(send) }
        })()`)
        await sleep(5000)
        const warning = await evaluate(`(() => ({ text: (document.querySelector('.ph-providerwarning')?.innerText || '').slice(0, 500), buttons: [...document.querySelectorAll('.ph-providerwarning button')].map((button) => button.textContent.trim()) }))()`)
        console.log('provider warning:', aiTab, JSON.stringify(asked), JSON.stringify(warning))
        await shot('03w-provider-warning')
      }
      if (STEPS.includes('reader-figures')) {
        const tab = await evaluate(`(() => {
          const button = [...document.querySelectorAll('.ph-r-side__tabs button, .ph-r-side__tabs [role="tab"]')].find((item) => (item.textContent || '').trim().startsWith('图表'))
          if (!button) return { found: false, text: document.querySelector('.ph-r-side__tabs')?.innerText || '' }
          button.click()
          return { found: true }
        })()`)
        console.log('reader figures tab:', JSON.stringify(tab))
        await sleep(1200)
        await shot('03f-reader-figures')
        const cards = await evaluate(`(() => ({ count: document.querySelectorAll('.ph-r-figcard').length, labels: [...document.querySelectorAll('.ph-r-figcard figcaption strong')].map((e) => (e.textContent || '').trim()), draggable: [...document.querySelectorAll('.ph-r-figcard')].every((e) => e.draggable) }))()`)
        console.log('reader figures cards:', JSON.stringify(cards))
      }
    }

    if (STEPS.includes('route-progress')) {
      const nextPage = await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('.ph-r-toolbar button, .ph-r-pager button')]
        const button = buttons.find((item) => /下一页|next page/i.test((item.getAttribute('title') || '') + ' ' + (item.getAttribute('aria-label') || '') + ' ' + (item.textContent || '')))
        if (!button) return false
        button.click()
        return true
      })()`)
      await sleep(600)
      const pageAfter = await evaluate(`(() => ({ input: document.querySelector('.ph-r-pager__input')?.value || '', route: sessionStorage.getItem('pappers-hall:navigation-route') }))()`)
      console.log('reader page before switching:', JSON.stringify(pageAfter))
      await evaluate(`(() => { const target = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').includes('新会话')); if (target) target.click(); return Boolean(target); })()`)
      await sleep(1400)
      await ensureConversation()
      await sleep(1200)
      const centerClick = await evaluate(`(() => {
        const target = [...document.querySelectorAll('button, a, [role="button"]')].find((element) => (element.textContent || '').trim() === '论文中心')
        if (!target) return false
        target.click()
        return true
      })()`)
      await sleep(1400)
      const restored = await evaluate(`(() => ({ reader: Boolean(document.querySelector('.ph-r-reader')), input: document.querySelector('.ph-r-pager__input')?.value || '', title: (document.querySelector('.ph-r-toolbar__title')?.textContent || '').trim(), route: sessionStorage.getItem('pappers-hall:navigation-route') }))()`)
      console.log('paper center restored:', centerClick, JSON.stringify(restored))
      await shot('03b-reader-restored')
    }

    if (want('drawer') || want('all')) {
      // Return to a conversation: the sidebar's 新会话 button creates/focuses one.
      const toConversation = await evaluate(`(() => {
        const target = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').includes('新会话'))
        if (!target) return false
        target.click()
        return true
      })()`)
      console.log('new session click:', toConversation)
      await sleep(1800)
      await shot('04-conversation')
      const sessionOpened = await ensureConversation()
      console.log('existing session opened:', sessionOpened)
      await sleep(1600)
      const opened = await evaluate(`(() => {
        const target = document.querySelector('button[aria-label="打开论文抽屉"], button[aria-label="Open the paper drawer"]')
        if (!target) return { found: false }
        target.click()
        return { found: true, label: target.getAttribute('aria-label') }
      })()`)
      console.log('drawer button:', JSON.stringify(opened))
      await sleep(2000)
      await shot('05-drawer')
      const drawerState = await evaluate(`(() => {
        const text = document.body.innerText || ''
        return { hasDrawer: text.includes('引用所选') || text.includes('论文'), snippet: text.slice(0, 2000) }
      })()`)
      writeFileSync(join(OUT, 'drawer-text.txt'), drawerState.snippet ?? '')
      console.log('drawer state:', JSON.stringify(drawerState.hasDrawer))
      await captureButtons('drawer')
      if (STEPS.includes('history-token')) {
        await evaluate(`(() => {
          const scrollers = [...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 80 && /auto|scroll/.test(getComputedStyle(el).overflowY))
          scrollers.forEach((el) => { el.scrollTop = 0 })
          return scrollers.length
        })()`)
        await sleep(1500)
        const token = await evaluate(`(() => {
          const nodes = [...document.querySelectorAll('[data-ph-citetoken-history="1"]')]
          const sample = [...document.querySelectorAll('.ph-citetoken-history')][0] || null
          const chain = sample ? { tag: sample.tagName, cls: sample.className, parent: sample.parentElement && sample.parentElement.tagName + '.' + sample.parentElement.className, grand: sample.parentElement && sample.parentElement.parentElement && sample.parentElement.parentElement.tagName + '.' + sample.parentElement.parentElement.className, inChrome: Boolean(sample.closest('.ph-app, .ph-center, .ph-sidebar, .ph-settings, .ph-dock, .ph-refcard')) } : null
          const probe = sample ? { label: sample.getAttribute('data-ph-citetoken-label'), width: Math.round(sample.getBoundingClientRect().width) } : null
          const raw = (document.body.innerText || '').includes('bundle=bn-')
          const rawText = (document.body.innerText || '').match(/⟦Pappers-Hall[^⟧]{0,80}⟧/g) || []
          return {
            count: nodes.length,
            rawInText: raw,
            chain: chain,
            probe: probe,
            rawSamples: rawText.slice(0, 3),
            labels: nodes.slice(0, 3).map((node) => node.getAttribute('data-ph-citetoken-label')),
            visible: nodes.slice(0, 1).map((node) => ({ w: Math.round(node.getBoundingClientRect().width), text: node.innerText.slice(0, 60) })),
          }
        })()`)
        console.log('history citation tokens:', JSON.stringify(token))
        await shot('06-history-token')
      }
      if (STEPS.includes('cite-draft')) {
        const cited = await evaluate(`(() => {
          const button = [...document.querySelectorAll('button[title="引用到对话"]')][0]
          if (!button) return false
          button.click()
          return true
        })()`)
        await sleep(2200)
        const draft = await evaluate(`(() => {
          const composer = document.querySelector('[data-composer-input="true"]')
          const block = composer ? composer.querySelector('[data-ph-citeblock="1"]') : null
          const rect = block ? block.getBoundingClientRect() : null
          return {
            rawText: (composer?.innerText || '').slice(0, 160),
            chipCount: block ? 1 : 0,
            chipText: block ? (block.textContent || '').trim() : null,
            chipBg: block ? getComputedStyle(block).backgroundColor : null,
            chipWidth: rect ? Math.round(rect.width) : 0,
            chipHeight: rect ? Math.round(rect.height) : 0,
          }
        })()`)
        console.log('cite auto draft:', cited, JSON.stringify(draft))
        await shot('04y-cite-auto-draft')
        // Cite a second paper: the draft must end with ONE token describing both.
        await evaluate(`(() => {
          const buttons = [...document.querySelectorAll('button[title="引用到对话"]')]
          const second = buttons.find((button, index) => index === 1) || buttons[1]
          if (second) second.click()
          return Boolean(second)
        })()`)
        await sleep(2400)
        const twice = await evaluate(`(() => {
          const composer = document.querySelector('[data-composer-input="true"]')
          const text = composer ? composer.innerText : ''
          const tokenCount = text.split('@论文中心').length - 1
          return { tokenCount: tokenCount, length: text.length, head: text.slice(0, 120) }
        })()`)
        console.log('second cite draft:', JSON.stringify(twice))
        await shot('04y2-cite-twice')
        // Type right after the chip: the chip must survive.
        await evaluate(`(() => {
          const composer = document.querySelector('[data-composer-input="true"]')
          if (!composer) return false
          composer.focus()
          const selection = window.getSelection()
          selection.selectAllChildren(composer)
          selection.collapseToEnd()
          return true
        })()`)
        await evaluate(`(() => {
          const chip = document.querySelector('[data-composer-input="true"] .ph-citetoken')
          const target = chip ? chip.nextSibling : null
          if (target && target.nodeType === 3) {
            const range = document.createRange()
            range.setStart(target, target.nodeValue.length)
            range.collapse(true)
            const selection = window.getSelection()
            selection.removeAllRanges()
            selection.addRange(range)
          }
          return true
        })()`)
        await sleep(900)
        const afterTyping = await evaluate(`(() => {
          const chips = [...document.querySelectorAll('[data-composer-input="true"] .ph-citetoken')]
          const composer = document.querySelector('[data-composer-input="true"]')
          return { chipCount: chips.length, text: (composer?.innerText || '').slice(0, 200) }
        })()`)
        console.log('chip survives typing:', JSON.stringify(afterTyping))
        await shot('04z-cite-chip-typing')
        // Cancel the reference: the draft must be cleaned.
        await evaluate(`(() => {
          const remove = document.querySelector('.ph-refcard__remove')
          if (remove) remove.click()
          return Boolean(remove)
        })()`)
        await sleep(1600)
        const afterRemove = await evaluate(`(() => {
          const composer = document.querySelector('[data-composer-input="true"]')
          return { text: (composer?.innerText || '').slice(0, 200), chips: document.querySelectorAll('[data-composer-input="true"] .ph-citetoken').length }
        })()`)
        console.log('draft after cancel:', JSON.stringify(afterRemove))
        await shot('04w-cite-cancelled')
      }
      if (STEPS.includes('cite-noflash')) {
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button[title="引用到对话"]')][0]
          if (button) button.click()
          return Boolean(button)
        })()`)
        const samples = []
        for (let i = 0; i < 25; i += 1) {
          await sleep(120)
          const value = await evaluate("document.querySelectorAll('.ph-refcard').length")
          samples.push(value)
        }
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button[title="引用到对话"]')][1]
          if (button) button.click()
          return Boolean(button)
        })()`)
        for (let i = 0; i < 25; i += 1) {
          await sleep(120)
          const value = await evaluate("document.querySelectorAll('.ph-refcard').length")
          samples.push(value)
        }
        console.log('card samples:', JSON.stringify(samples), 'min:', Math.min(...samples))
        await shot('04r-noflash')
      }
      if (STEPS.includes('cite-delete-partial')) {
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button[title="引用到对话"]')][0]
          if (button) button.click()
          return Boolean(button)
        })()`)
        await sleep(2200)
        const before = await evaluate(`(() => ({
          draft: (document.querySelector('[data-composer-input="true"]')?.innerText || '').trim().slice(0, 40),
          cards: document.querySelectorAll('.ph-refcard').length,
        }))()`)
        // Delete only the tail of the mention, like a few Backspace presses.
        const partial = await evaluate(`(() => {
          const entry = document.querySelector('.ph-composer-entry')
          const key = Object.keys(entry || {}).find((k) => k.startsWith('__reactFiber'))
          let fiber = entry && entry[key]
          let actions = null
          for (let i = 0; i < 40 && fiber; i += 1) {
            if (fiber.memoizedProps && fiber.memoizedProps.inputActions) { actions = fiber.memoizedProps.inputActions; break }
            fiber = fiber.return
          }
          if (actions) actions.setDraft('@论文中心 1 篇')
          return Boolean(actions)
        })()`)
        const started = Date.now()
        let elapsed = -1
        for (let i = 0; i < 30; i += 1) {
          await sleep(100)
          const cards = await evaluate("document.querySelectorAll('.ph-refcard').length")
          if (cards === 0) { elapsed = Date.now() - started; break }
        }
        const after = await evaluate(`(() => ({
          draft: (document.querySelector('[data-composer-input="true"]')?.innerText || '').trim().slice(0, 40),
          cards: document.querySelectorAll('.ph-refcard').length,
        }))()`)
        console.log('partial delete:', JSON.stringify(before), partial, 'elapsed_ms:', elapsed, JSON.stringify(after))
        await shot('04q-partial-delete')
      }
      if (STEPS.includes('cite-delete-verify')) {
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button[title="引用到对话"]')][0]
          if (button) button.click()
          return Boolean(button)
        })()`)
        await sleep(2200)
        const before = await evaluate(`(() => ({
          draft: (document.querySelector('[data-composer-input="true"]')?.innerText || '').trim().slice(0, 60),
          cards: document.querySelectorAll('.ph-refcard').length,
          chip: document.querySelectorAll('[data-ph-citeblock="1"]').length,
        }))()`)
        await evaluate(`(() => {
          const entry = document.querySelector('.ph-composer-entry')
          const key = Object.keys(entry || {}).find((k) => k.startsWith('__reactFiber'))
          let fiber = entry && entry[key]
          let actions = null
          for (let i = 0; i < 40 && fiber; i += 1) {
            if (fiber.memoizedProps && fiber.memoizedProps.inputActions) { actions = fiber.memoizedProps.inputActions; break }
            fiber = fiber.return
          }
          if (actions) actions.setDraft('')
          return Boolean(actions)
        })()`)
        await sleep(2200)
        const after = await evaluate(`(() => ({
          draft: (document.querySelector('[data-composer-input="true"]')?.innerText || '').trim().slice(0, 60),
          cards: document.querySelectorAll('.ph-refcard').length,
          chip: document.querySelectorAll('[data-ph-citeblock="1"]').length,
        }))()`)
        console.log('cite then delete:', JSON.stringify(before), JSON.stringify(after))
        await shot('04p-cite-delete')
      }
      if (STEPS.includes('cite-note-chip')) {
        // One paper + one note: the chip must cover the whole mention.
        const seeded = await evaluate(`(async () => {
          const list = await (await fetch('/pappers-hall/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'library.list', params: { limit: 1 } }) })).json()
          const notes = await (await fetch('/pappers-hall/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'notes.list', params: { limit: 1 } }) })).json()
          const paperId = list?.data?.items?.[0]?.id
          const noteId = notes?.data?.items?.[0]?.id
          if (!paperId || !noteId) return { ok: false }
          const commit = await (await fetch('/pappers-hall/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'references.commit', params: { items: [{ kind: 'paper', id: paperId }, { kind: 'note', id: noteId }] } }) })).json()
          const token = commit?.data?.token
          if (!token) return { ok: false }
          const entry = document.querySelector('.ph-composer-entry')
          const key = Object.keys(entry || {}).find((k) => k.startsWith('__reactFiber'))
          let fiber = entry && entry[key]
          let actions = null
          for (let i = 0; i < 40 && fiber; i += 1) {
            if (fiber.memoizedProps && fiber.memoizedProps.inputActions) { actions = fiber.memoizedProps.inputActions; break }
            fiber = fiber.return
          }
          if (!actions) return { ok: false }
          actions.setDraft(token)
          return { ok: true, token }
        })()`)
        await sleep(1400)
        const chip = await evaluate(`(() => {
          const composer = document.querySelector('[data-composer-input="true"]')
          const block = composer ? composer.querySelector('[data-ph-citeblock="1"]') : null
          if (!block) return { ok: false, text: (composer?.innerText || '').slice(0, 80) }
          const pseudo = getComputedStyle(block, '::before')
          const spanWidth = block.getBoundingClientRect().width
          return {
            ok: true,
            text: (block.textContent || '').trim(),
            boxWidth: Math.round(parseFloat(pseudo.width)),
            spanWidth: Math.round(spanWidth),
            covered: Math.round(parseFloat(pseudo.width)) >= Math.round(spanWidth) - 2,
          }
        })()`)
        console.log('note chip:', JSON.stringify(seeded), JSON.stringify(chip))
        await shot('04n-note-chip')
        const cleared = await evaluate(`(() => {
          const composer = document.querySelector('[data-composer-input="true"]')
          if (!composer) return false
          composer.focus()
          document.execCommand('selectAll')
          document.execCommand('delete')
          return true
        })()`)
        await sleep(2000)
        const after = await evaluate(`(() => ({
          draft: (document.querySelector('[data-composer-input="true"]')?.innerText || '').trim().slice(0, 40),
          cards: document.querySelectorAll('.ph-refcard').length,
          chip: document.querySelectorAll('[data-ph-citeblock="1"]').length,
        }))()`)
        console.log('after clearing draft:', cleared, JSON.stringify(after))
        await shot('04o-cleared-draft')
      }
      if (STEPS.includes('cite-typing')) {
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button[title="引用到对话"]')][0]
          if (button) button.click()
          return Boolean(button)
        })()`)
        await sleep(2000)
        const typed = await evaluate(`(() => {
          const composer = document.querySelector('[data-composer-input="true"]')
          if (!composer) return false
          composer.focus()
          const selection = window.getSelection()
          selection.selectAllChildren(composer)
          selection.collapseToEnd()
          document.execCommand('insertText', false, '这篇讲的什么')
          return true
        })()`)
        await sleep(900)
        const state = await evaluate(`(() => {
          const composer = document.querySelector('[data-composer-input="true"]')
          const block = composer ? composer.querySelector('[data-ph-citeblock="1"]') : null
          const rect = block ? block.getBoundingClientRect() : null
          return {
            text: (composer?.innerText || '').slice(0, 120),
            chipCount: block ? 1 : 0,
            chipHeight: rect ? Math.round(rect.height) : 0,
          }
        })()`)
        console.log('cite typing:', typed, JSON.stringify(state))
        await shot('04v-cite-typing')
      }
      if (STEPS.includes('drawer-multi-cite')) {
        const citations = await evaluate(`(() => {
          const buttons = [...document.querySelectorAll('button[title="引用到对话"], button[title="Cite to conversation"]')]
          const chosen = buttons.slice(0, 2)
          chosen.forEach((button) => button.click())
          return { buttons: buttons.length, clicked: chosen.length, labels: chosen.map((b) => (b.getAttribute('title') || '').trim()) }
        })()`)
        await sleep(1600)
        const dock = await evaluate(`(() => ({
          cards: document.querySelectorAll('.ph-refcard').length,
          text: (document.querySelector('.ph-dock-slot')?.innerText || '').slice(0, 500),
          chips: [...document.querySelectorAll('.ph-refcard__chip')].map((chip) => chip.textContent.trim()).slice(0, 8),
          composerEntry: (document.querySelector('.ph-composer-entry')?.innerText || '').trim(),
        }))()`)
        console.log('drawer multi cite:', JSON.stringify(citations), JSON.stringify(dock))
        await shot('04x-multi-cite')
      }
      if (STEPS.includes('drawer-drag-to-chat')) {
        // The drawer no longer has a 图片 tab: figures enter the chat from the
        // paper itself, so this step guards the removal and drags a paper row.
        const sidebarTabs = await evaluate(`(() => [...document.querySelectorAll('.ph-sidebar__tabs button')].map((button) => (button.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))()`)
        console.log('sidebar tabs:', JSON.stringify(sidebarTabs))
        if (sidebarTabs.some((label) => label.includes('图片'))) throw new Error('the drawer still exposes a 图片 tab')
        await sleep(300)
        const dragged = await evaluate(`(() => {
          const source = document.querySelector('.ph-r-figcard, .ph-side-row--paper .ph-side-row__main')
          const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 120 && r.height > 20 })
          const input = inputs[inputs.length - 1]
          if (!source || !input) return { source: Boolean(source), input: inputs.length }
          const dt = new DataTransfer()
          source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
          input.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
          input.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
          source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
          return { source: true, input: inputs.length, types: [...dt.types], text: (dt.getData('text/plain') || '').slice(0, 120) }
        })()`)
        console.log('drawer drag to composer:', JSON.stringify(dragged))
        await sleep(2200)
        const composer = await evaluate(`(() => { const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 120 && r.height > 20 }); return (inputs[inputs.length - 1]?.value || inputs[inputs.length - 1]?.innerText || '').slice(0, 400) })()`)
        console.log('composer after drawer drag:', JSON.stringify(composer))
        await shot('05d-composer-after-drag')
      }
      if (STEPS.includes('drawer-preview')) {
        const opened = await evaluate(`(() => {
          const row = document.querySelector('.ph-side-row--paper .ph-side-row__main')
          if (!row) return false
          row.click()
          return true
        })()`)
        console.log('sidebar paper preview click:', opened)
        await sleep(2400)
        await shot('05b-drawer-paper-preview')
        const paperPreview = await evaluate(`(() => ({
          reader: Boolean(document.querySelector('.ph-side-preview__body .ph-r-reader')),
          title: (document.querySelector('.ph-side-preview__title')?.textContent || '').trim(),
          center: [...document.querySelectorAll('.ph-side-preview__head button')].some((button) => (button.textContent || '').includes('在论文中心查看')),
          translation: (document.querySelector('.ph-r-side__tabs')?.innerText || ''),
        }))()`)
        console.log('sidebar paper preview:', JSON.stringify(paperPreview))
        const back = await evaluate(`(() => { const b = document.querySelector('.ph-side-preview__head button'); if (!b) return false; b.click(); return true })()`)
        console.log('sidebar preview back:', back)
        await sleep(800)
        const noteTab = await evaluate(`(() => {
          const target = [...document.querySelectorAll('.ph-sidebar__tabs button')].find((button) => (button.textContent || '').includes('笔记'))
          if (!target) return false
          target.click()
          return true
        })()`)
        console.log('sidebar notes tab:', noteTab)
        await sleep(900)
        const noteOpened = await evaluate(`(() => {
          const row = document.querySelector('.ph-side-note')
          if (!row) return false
          row.click()
          return true
        })()`)
        console.log('sidebar note preview click:', noteOpened)
        await sleep(1400)
        await shot('05c-drawer-note-preview')
        const notePreview = await evaluate(`(() => ({
          editor: Boolean(document.querySelector('.ph-side-preview__body .ph-n-editor')),
          title: (document.querySelector('.ph-side-preview__title')?.textContent || '').trim(),
          center: [...document.querySelectorAll('.ph-side-preview__head button')].some((button) => (button.textContent || '').includes('在论文中心查看')),
        }))()`)
        console.log('sidebar note preview:', JSON.stringify(notePreview))
      }
    }

    if (want('dock') || want('all')) {
      // Conversation page -> open drawer -> cite one paper -> insert into the draft.
      const toConversation = await evaluate(`(() => {
        const target = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').includes('新会话'))
        if (!target) return false
        target.click()
        return true
      })()`)
      console.log('conversation:', toConversation)
      await sleep(1800)
      await ensureConversation()
      await sleep(1500)
      await evaluate(`(() => { const b = document.querySelector('button[aria-label="打开论文抽屉"], button[aria-label="Open the paper drawer"]'); if (b) b.click(); return Boolean(b); })()`)
      await sleep(1600)
      await evaluate(`(() => { window.__phApiLog = []; const original = window.fetch; window.fetch = async (...args) => { try { const response = await original(...args); const url = String(args[0]); if (url.includes('pappers-hall')) window.__phApiLog.push({ url: url, status: response.status, body: args[1] && args[1].body ? String(args[1].body).slice(0, 300) : null }); } catch (error) { window.__phApiLog.push({ url: String(args[0]), error: String(error) }); } return original(...args); }; return true })()`)
      const selectedRow = await evaluate(`(() => {
        const row = document.querySelector('.ph-side-row--paper .ph-side-row__main') || document.querySelector('.ph-side-row--paper')
        if (!row) return false
        row.click()
        return true
      })()`)
      await sleep(900)
      const cited = await evaluate(`(() => {
        const cite = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').includes('引用所选'))
        if (!cite) return { row: ${JSON.stringify(selectedRow)}, cite: false }
        cite.click()
        return { row: true, cite: true }
      })()`)
      console.log('cite selection:', JSON.stringify(cited))
      await sleep(1500)
      const apiLog = await evaluate('window.__phApiLog || []')
      console.log('api log:', JSON.stringify(apiLog))
      await shot('06-drawer-cite')
      const docked = await evaluate(`(() => {
        const dock = document.querySelector('.ph-dock')
        if (!dock) return { dock: false }
        const add = [...dock.querySelectorAll('button')].find((button) => (button.textContent || '').includes('加入草稿'))
        if (!add) return { dock: true, add: false, text: dock.innerText.slice(0, 300) }
        add.click()
        return { dock: true, add: true }
      })()`)
      console.log('dock insert:', JSON.stringify(docked))
      await sleep(1500)
      const composer = await evaluate(`(() => {
        const editable = document.querySelector('[contenteditable="true"]')
        return { text: editable ? editable.innerText : null }
      })()`)
      console.log('composer text:', JSON.stringify(composer))
      writeFileSync(join(OUT, 'composer-text.txt'), String(composer.text ?? ''))
      await shot('07-dock-inserted')
    }

    if (want('notes') || STEPS.includes('all')) {
      await ensureLibrary()
      const opened = await evaluate(`(() => {
        const note = document.querySelector('.ph-notes-sidebar__note')
        if (!note) return false
        note.click()
        return true
      })()`)
      await sleep(1200)
      const notes = await evaluate(`(() => {
        const text = document.body.innerText || ''
        return { hasEditor: Boolean(document.querySelector('.ph-n-app, .ph-note, [contenteditable="true"]')), hasTitle: text.includes('Reflexion'), snippet: text.slice(0, 1200) }
      })()`)
      console.log('notes opened:', opened, JSON.stringify(notes).slice(0, 500))
      await shot('13-notes')
      if (STEPS.includes('inline-note-progress')) {
        await evaluate(`(() => { const target = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').includes('新会话')); if (target) target.click(); return Boolean(target); })()`)
        await sleep(1200)
        await ensureConversation()
        await sleep(1000)
        await evaluate(`(() => { const target = [...document.querySelectorAll('button, a, [role="button"]')].find((element) => (element.textContent || '').trim() === '论文中心'); if (target) target.click(); return Boolean(target); })()`)
        await sleep(1500)
        const inline = await evaluate(`(() => ({ inline: Boolean(document.querySelector('.ph-n-inline')), note: (document.querySelector('.ph-n-inline__title')?.textContent || '').trim(), text: (document.querySelector('.ph-n-inline')?.innerText || '').slice(0, 160) }))()`)
        console.log('inline note restored:', JSON.stringify(inline))
        await shot('13t-inline-note-restored')
      }
      if (STEPS.includes('notes-reader')) {
        const clicked = await evaluate(`(() => {
          const chip = document.querySelector('.ph-n-chip button, .ph-n-chip [role="button"]')
          if (!chip) return false
          chip.click()
          return true
        })()`)
        console.log('note paper chip click:', clicked)
        await sleep(1800)
        await shot('13r-reader-from-note')
        const toolbar = await evaluate(`(() => {
          const buttons = [...document.querySelectorAll('.ph-r-toolbar__actions button')].map((button) => ({ text: (button.textContent || '').trim(), disabled: Boolean(button.disabled), title: button.getAttribute('title') || '' }))
          return { buttons, reader: Boolean(document.querySelector('[data-ph-reader]')) }
        })()`)
        console.log('reader-from-note toolbar:', JSON.stringify(toolbar))
        writeFileSync(join(OUT, 'notes-reader-toolbar.json'), JSON.stringify(toolbar, null, 2))
        const link = await evaluate(`(() => {
          const button = [...document.querySelectorAll('.ph-r-toolbar__actions button')].find((item) => (item.textContent || '').includes('关联到此笔记'))
          if (!button) return { found: false }
          if (button.disabled) return { found: true, disabled: true, title: button.getAttribute('title') || '' }
          button.click()
          return { found: true, disabled: false }
        })()`)
        console.log('reader note link click:', JSON.stringify(link))
        await sleep(1200)
        await shot('13s-reader-linked-note')
        const toast = await evaluate(`(() => (document.querySelector('.ph-r-toasts, .ph-n-toasts')?.innerText || '').slice(0, 500))()`)
        console.log('reader link toast:', JSON.stringify(toast))
      }
      if (STEPS.includes('notes-reader-other')) {
        const opened = await evaluate(`(() => {
          const row = [...document.querySelectorAll('.ph-n-paperrow')].find((item) => (item.textContent || '').includes('全球格点')) || document.querySelector('.ph-n-paperrow')
          if (!row) return false
          row.click()
          return true
        })()`)
        console.log('other paper opened:', opened)
        await sleep(1800)
        await shot('13t-reader-other-paper')
        const toolbar = await evaluate(`(() => {
          const buttons = [...document.querySelectorAll('.ph-r-toolbar__actions button')].map((button) => ({ text: (button.textContent || '').trim(), disabled: Boolean(button.disabled), title: button.getAttribute('title') || '' }))
          return { buttons, reader: Boolean(document.querySelector('[data-ph-reader]')) }
        })()`)
        console.log('reader-other toolbar:', JSON.stringify(toolbar))
        const link = await evaluate(`(() => {
          const button = [...document.querySelectorAll('.ph-r-toolbar__actions button')].find((item) => (item.textContent || '').trim() === '关联到此笔记')
          if (!button) return { found: false }
          if (button.disabled) return { found: true, disabled: true, title: button.getAttribute('title') || '' }
          button.click()
          return { found: true, disabled: false }
        })()`)
        console.log('reader-other link click:', JSON.stringify(link))
        await sleep(1400)
        await shot('13u-reader-other-linked')
        const toast = await evaluate(`(() => (document.querySelector('.ph-r-toasts')?.innerText || '').slice(0, 400))()`)
        console.log('reader-other link toast:', JSON.stringify(toast))
        const barLink = await evaluate(`(() => {
          const button = [...document.querySelectorAll('.ph-n-embedded-reader__bar button')].find((item) => (item.textContent || '').includes('关联到当前笔记'))
          if (!button) return { found: false, text: (document.querySelector('.ph-n-embedded-reader__bar')?.innerText || '').slice(0, 200) }
          button.click()
          return { found: true }
        })()`)
        console.log('notes paper-bar link:', JSON.stringify(barLink))
        await sleep(1300)
        const barState = await evaluate(`(() => (document.querySelector('.ph-n-embedded-reader__bar')?.innerText || '').slice(0, 250))()`)
        console.log('notes paper-bar after link:', JSON.stringify(barState))
        await shot('13ta-notes-paper-link')
        if (STEPS.includes('inline-paper-progress')) {
          await evaluate(`(() => { const target = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').includes('新会话')); if (target) target.click(); return Boolean(target); })()`)
          await sleep(1200)
          await ensureConversation()
          await sleep(1000)
          await evaluate(`(() => { const target = [...document.querySelectorAll('button, a, [role="button"]')].find((element) => (element.textContent || '').trim() === '论文中心'); if (target) target.click(); return Boolean(target); })()`)
          await sleep(1700)
          const restored = await evaluate(`(() => ({ note: Boolean(document.querySelector('.ph-n-inline')), paper: Boolean(document.querySelector('.ph-n-embedded-reader')), bar: (document.querySelector('.ph-n-embedded-reader__bar')?.innerText || '').slice(0, 120) }))()`)
          console.log('notes inline paper restored:', JSON.stringify(restored))
          await shot('13tb-inline-paper-restored')
        }
        if (STEPS.includes('notes-reader-figure')) {
          const figTab = await evaluate(`(() => {
            const button = [...document.querySelectorAll('.ph-r-side__tabs button, .ph-r-side__tabs [role="tab"]')].find((item) => (item.textContent || '').trim().startsWith('图表'))
            if (!button) return false
            button.click()
            return true
          })()`)
          await sleep(1200)
          await shot('13w-reader-figures-in-note')
          const dragged = await evaluate(`(() => {
            const card = document.querySelector('.ph-r-figcard')
            const target = document.querySelector('.ph-n-editor__content')
            if (!card || !target) return { card: Boolean(card), target: Boolean(target) }
            const dt = new DataTransfer()
            card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
            card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
            return { card: true, target: true, types: [...dt.types], data: dt.getData('application/x-pappers-hall-material').slice(0, 200) }
          })()`)
          console.log('figure drag/drop:', JSON.stringify(dragged))
          await sleep(1400)
          await shot('13x-reader-figure-dropped')
          const toast3 = await evaluate(`(() => (document.querySelector('.ph-r-toasts')?.innerText || '').slice(0, 300))()`)
          console.log('figure drop toast:', JSON.stringify(toast3))
        }
        if (STEPS.includes('notes-reader-quote')) {
          const annotTab = await evaluate(`(() => {
            const button = [...document.querySelectorAll('.ph-r-side__tabs button, .ph-r-side__tabs [role="tab"]')].find((item) => (item.textContent || '').trim().startsWith('批注'))
            if (!button) return false
            button.click()
            return true
          })()`)
          await sleep(900)
          const quoted = await evaluate(`(() => {
            const button = [...document.querySelectorAll('.ph-r-annotcard__actions button')].find((item) => (item.getAttribute('title') || '') === '引用到笔记')
            if (!button) return { found: false, cards: document.querySelectorAll('.ph-r-annotcard').length }
            button.click()
            return { found: true }
          })()`)
          console.log('annotation quote click:', JSON.stringify(quoted), 'tab:', annotTab)
          await sleep(1300)
          await shot('13v-reader-annotation-quoted')
          const toast2 = await evaluate(`(() => (document.querySelector('.ph-r-toasts')?.innerText || '').slice(0, 400))()`)
          console.log('annotation quote toast:', JSON.stringify(toast2))
          console.log('browser console:', JSON.stringify(cdp.console.filter((entry) => /ph-note|insert|quote|error|exception/i.test(entry.args)).slice(-20)))
        }
      }
      if (want('notes-diagram') || want('all')) {
        const opened = await evaluate(`(() => { const button = document.querySelector('.ph-n-doc__diagram-expand'); if (!button) return false; button.click(); return true })()`)
        await sleep(500)
        console.log('diagram expanded:', opened, await evaluate(`Boolean(document.querySelector('.ph-n-doc__diagram-dialog[open]'))`))
        await shot('13g-notes-diagram-expanded')
        await evaluate(`(() => { const button = document.querySelector('.ph-n-doc__diagram-expand'); if (button) button.click(); return Boolean(button) })()`)
      }
      if (want('notes-lightbox') || want('all')) {
        const opened = await evaluate(`(() => { const media = document.querySelector('.ph-n-doc__gallery-media'); if (!media) return false; media.click(); return true })()`)
        await sleep(500)
        console.log('lightbox opened:', opened, await evaluate(`Boolean(document.querySelector('.ph-n-doc__lightbox'))`))
        await shot('13f-notes-lightbox')
        await evaluate(`(() => { const close = document.querySelector('.ph-n-doc__lightbox-actions button:last-child'); if (close) close.click(); return Boolean(close) })()`)
      }
      if (want('notes-form') || want('all')) {
        const typed = await evaluate(`(() => {
          const text = document.querySelector('.ph-n-doc__field input[type="text"]')
          const select = document.querySelector('.ph-n-doc__field select')
          if (text) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            setter.call(text, '验收文本')
            text.dispatchEvent(new Event('input', { bubbles: true }))
            text.dispatchEvent(new Event('change', { bubbles: true }))
          }
          if (select) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
            setter.call(select, [...select.options].at(-1).value)
            select.dispatchEvent(new Event('change', { bubbles: true }))
          }
          return Boolean(text || select)
        })()`)
        await sleep(1600)
        console.log('notes form changed:', typed)
        await shot('13e-notes-form')
      }
      if (want('notes-scroll') || want('all')) {
        for (const [name, ratio] of [['13b-notes-middle', 0.42], ['13c-notes-lower', 0.7], ['13d-notes-bottom', 1]]) {
          await evaluate(`(() => { const el = document.querySelector('.ph-n-editor__cards'); if (el) el.scrollTop = el.scrollHeight * ${ratio}; return Boolean(el) })()`)
          await sleep(350)
          await shot(name)
        }
      }
    }

    if (want('figures') || want('all')) {
      await ensureLibrary()
      const menuOpened = await evaluate(`(() => {
        const wrap = document.querySelector('.ph-menuwrap button, .ph-center__actions .ph-iconbtn')
        if (wrap) wrap.click()
        return Boolean(wrap)
      })()`)
      await sleep(350)
      const opened = await evaluate(`(() => {
        const item = [...document.querySelectorAll('button, [role="menuitem"]')].find((button) => /图片搜索|Figure search/.test((button.textContent || '').trim()))
        if (!item) return false
        item.click()
        return true
      })()`)
      console.log('figure menu:', menuOpened, 'item:', opened)
      await sleep(900)
      const typed = await evaluate(`(() => {
        const input = document.querySelector('.ph-figsearch__bar input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, 'ReAct')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
      console.log('figures tab:', opened, 'typed:', typed)
      await sleep(2500)
      await shot('08-figure-search')
      await captureButtons('figures')
    }

    if (STEPS.includes('probe-settings-dom')) {
      await ensureConversation()
      await sleep(600)
      await evaluate(`(() => { window.__phErrors = []; window.addEventListener('error', (e) => window.__phErrors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__phErrors.push(String(e.reason))); return true })()`)
      await evaluate(`(() => { const b = document.querySelector('button[aria-label="打开论文抽屉"], button[aria-label="Open the paper drawer"]'); if (b) b.click(); return Boolean(b) })()`)
      await sleep(900)
      await evaluate(`(() => { const b = document.querySelector('button[aria-label="设置"], button[aria-label="Settings"]'); if (b) b.click(); return Boolean(b) })()`)
      await sleep(2500)
      const info = await evaluate(`(() => {
        const dialog = document.querySelector('.ph-settings')
        return {
          errors: window.__phErrors,
          text: (dialog?.innerText || '').slice(0, 900),
          cards: dialog ? dialog.querySelectorAll('.ph-card').length : 0,
          skeleton: dialog ? dialog.querySelectorAll('[class*=skeleton], .ph-card__skeleton').length : 0,
          bodyText: (document.querySelector('.ph-settings__body')?.innerText || '').slice(0, 400),
        }
      })()`)
      console.log('settings dom:', JSON.stringify(info))
      await shot('probe-settings-dom')
    }
    if (want('settings') || STEPS.includes('all')) {
      await ensureConversation()
      await sleep(800)
      await evaluate(`(() => { const b = document.querySelector('button[aria-label="打开论文抽屉"], button[aria-label="Open the paper drawer"]'); if (b) b.click(); return Boolean(b); })()`)
      await sleep(1200)
      const settingsOpened = await evaluate(`(() => {
        const b = document.querySelector('button[aria-label="设置"], button[aria-label="Settings"]')
        if (!b) return false
        b.click()
        return true
      })()`)
      await sleep(800)
      await shot('11-settings')
      await evaluate(`(() => { const body = document.querySelector('.ph-settings__body'); if (body) body.scrollTop = body.scrollHeight; return Boolean(body); })()`)
      await sleep(500)
      const backupUi = await evaluate(`(() => ({ text: (document.querySelector('.ph-backup')?.innerText || '').slice(0, 700), buttons: [...document.querySelectorAll('.ph-backup button')].map((button) => button.textContent.trim()), hasInput: Boolean(document.querySelector('.ph-backup input[type=file]')) }))()`)
      console.log('backup UI:', JSON.stringify(backupUi))
      await shot('11b-settings-backup')
      const cacheClicked = await evaluate(`(() => {
        const b = [...document.querySelectorAll('.ph-settings button')].filter((button) => /清空 PDF 预览缓存|Clear PDF preview cache/.test((button.textContent || '').trim())).sort((left, right) => (left.textContent || '').length - (right.textContent || '').length)[0]
        if (!b) return { found: false }
        b.click()
        return { found: true, label: b.textContent.trim() }
      })()`)
      await sleep(1200)
      const toast = await evaluate("document.body.innerText.includes('已清空') || document.body.innerText.includes('Cleared') || document.body.innerText.includes('没有可清理') || document.body.innerText.includes('No PDF preview')")
      console.log('settings opened:', settingsOpened, 'cache clicked:', JSON.stringify(cacheClicked), 'toast:', toast)
      await captureButtons('settings')
      await shot('12-settings-cache-cleared')
    }

    if (want('disabled') || want('all')) {
      const state = await evaluate(`(() => {
        const text = document.body.innerText || ''
        return { hasPaperCenter: text.includes('论文中心'), hasNewChat: text.includes('新会话'), len: text.length }
      })()`)
      console.log('disabled sidebar state:', JSON.stringify(state))
      writeFileSync(join(OUT, 'sidebar-disabled-text.txt'), state.text ?? '')
      await shot('09-disabled-sidebar')
      const opened = await evaluate(`(() => {
        const target = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').includes('新会话'))
        if (!target) return false
        target.click(); return true
      })()`)
      await sleep(1800)
      const native = await evaluate(`(() => {
        const text = document.body.innerText || ''
        return { composer: text.includes('描述你想要构建的内容'), model: text.includes('DeepSeek'), error: /crash|failed to load/i.test(text), hasPaperCenter: text.includes('论文中心') }
      })()`)
      console.log('disabled conversation state:', opened, JSON.stringify(native))
      await shot('10-disabled-conversation')
    }

    console.log(JSON.stringify({ ok: true, shots }, null, 2))
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    chrome.kill('SIGKILL')
  }
}

main().catch((error) => {
  console.error('BROWSER SHOT FAILED:', error?.stack ?? error)
  process.exit(1)
})
