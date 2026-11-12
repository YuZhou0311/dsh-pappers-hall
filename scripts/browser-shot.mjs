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

const BASE = process.env.PAPPERS_BASE ?? 'http://127.0.0.1:54731'
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
  const entries = readdirSync(base).filter((name) => name === 'Cookies' || name.startsWith('Cookies'))
  const copy = join(tmpdir(), `pappers-cookies-${process.pid}.db`)
  const source = entries.map((name) => join(base, name)).find((path) => path.endsWith('/Cookies'))
  if (!source) throw new Error('no Electron cookie store found')
  copyFileSync(source, copy)
  const db = new DatabaseSync(copy, { readOnly: true })
  const rows = db.prepare(
    'SELECT name, value, cast(last_access_utc as text) AS accessed FROM cookies WHERE host_key = ? AND value IS NOT NULL AND length(value) > 0 ORDER BY accessed DESC',
  ).all('127.0.0.1')
  db.close()
  if (rows.length === 0) throw new Error('no DSH browser cookie found; open the DSH window once')
  return { name: rows[0].name, value: rows[0].value }
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
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
  const cookie = readCookie()
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
    await cdp.send('Network.setCookie', {
      name: cookie.name,
      value: cookie.value,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      url: BASE,
    })

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

    async function waitFor(expression, timeoutMs = 30_000, label = expression) {
      const started = Date.now()
      for (;;) {
        const value = await evaluate(expression)
        if (value) return value
        if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
        await sleep(300)
      }
    }

    await cdp.send('Page.navigate', { url: BASE + '/' })
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
      await evaluate(`(() => {
        const candidates = [...document.querySelectorAll('button')]
        const exact = candidates.find((element) => (element.textContent || '').trim() === '论文中心')
        if (exact) exact.click()
        return Boolean(exact)
      })()`)
      await waitFor("document.querySelector('.ph-app') !== null", 20_000, 'library page')
      await sleep(800)
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
    if (want('library') || want('all')) {
      const clicked = await evaluate(`(() => {
        const candidates = [...document.querySelectorAll('button, a, [role="button"], li, div')]
        const exact = candidates.find((element) => (element.textContent || '').trim() === '论文中心')
        const target = exact && (exact.closest('button, a, [role="button"]') || exact)
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
    }

    if (want('reader') || want('all')) {
      await ensureLibrary()
      // Open the first paper card in the library grid.
      const opened = await evaluate(`(() => {
        const card = document.querySelector('[data-ph-card="paper"]')
        if (!card) return { opened: false, cards: document.querySelectorAll('[data-ph-card="paper"]').length }
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
      const opened = await evaluate(`(() => {
        const target = document.querySelector('button[aria-label="打开论文抽屉"]')
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
      await evaluate(`(() => { const b = document.querySelector('button[aria-label="打开论文抽屉"]'); if (b) b.click(); return Boolean(b); })()`)
      await sleep(1600)
      await evaluate(`(() => { window.__phApiLog = []; const original = window.fetch; window.fetch = async (...args) => { try { const response = await original(...args); const url = String(args[0]); if (url.includes('pappers-hall')) window.__phApiLog.push({ url: url, status: response.status, body: args[1] && args[1].body ? String(args[1].body).slice(0, 300) : null }); } catch (error) { window.__phApiLog.push({ url: String(args[0]), error: String(error) }); } return original(...args); }; return true })()`)
      const cited = await evaluate(`(() => {
        const row = document.querySelector('.ph-drow')
        if (row) row.click()
        const cite = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').includes('引用所选'))
        if (!cite) return { row: Boolean(row), cite: false }
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

    if (want('figures') || want('all')) {
      await ensureLibrary()
      const opened = await evaluate(`(() => {
        const tab = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').trim() === '图片')
        if (!tab) return false
        tab.click()
        return true
      })()`)
      await sleep(800)
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
