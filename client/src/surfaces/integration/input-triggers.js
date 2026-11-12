/**
 * DSH input-trigger integration: the composer "+" menu (slash) and @ mentions.
 *
 * Both sources are optional: when the `inputTriggers` service is missing the
 * plugin keeps working and nothing throws. Slash picks insert a Chinese
 * instruction template; @ picks insert a paper/folder mention chip whose
 * serialized form is `@论文中心(paper:ph-xxx)` / `@论文中心(folder:cl-xxx)`.
 */
const NS = 'pappers-hall'
const MENTION_SOURCE = 'pappers-hall-papers'

function mentionOf(kind, id) {
  return '@论文中心(' + kind + ':' + id + ')'
}
function parseMention(ref) {
  const text = String(ref || '')
  const match = text.match(/^@论文中心\((paper|folder):([^)]+)\)$/)
  return match ? { kind: match[1], id: match[2] } : null
}

export function registerInputTriggers(ctx, services) {
  let inputTriggers
  try {
    inputTriggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined
  } catch (error) {
    inputTriggers = undefined
  }
  try { if (typeof window !== 'undefined') window.__phTriggerDebug = { hasService: !!inputTriggers, mode: inputTriggers ? typeof inputTriggers.registerSource : null } } catch (error) { /* debug */ }
  if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return null
  const t = services && services.t ? services.t : ((key) => key)
  const api = services && services.api

  const ACTIONS = [
    { name: 'papers-find', icon: 'search', key: 'find', template: '请使用论文中心工具，在我论文库中查找与以下主题相关的文献：\n' },
    { name: 'papers-folder', icon: 'folder', key: 'folder', template: '请使用论文中心工具，帮我整理文献库文件夹（可新建嵌套文件夹并归类）：\n' },
    { name: 'papers-import', icon: 'file', key: 'import-pdf', template: '请使用论文中心工具，把这篇 PDF 加入我的论文中心并自动归类。请先预览并问我是否确认：\n' },
    { name: 'papers-overview', icon: 'book', key: 'overview', template: '请使用论文中心工具，给我一份文献库概览（数量、未读、最近批注、文件夹结构）：\n' },
  ]

  const slash = {
    trigger: '/',
    name: 'papers',
    order: 1,
    showGroupTitle: false,
    candidates() {
      try { if (typeof window !== 'undefined') window.__phSlashDebug = { called: true } } catch (e) { /* debug */ }
      return ACTIONS.map((item) => ({
        name: '/papers ' + item.key,
        description: t('trigger.slash.' + (item.key === 'import-pdf' ? 'importHint' : item.key === 'find' ? 'findHint' : item.key === 'folder' ? 'folderHint' : 'overviewHint')),
        section: t('trigger.slash.group') || '论文中心',
        icon: item.icon,
      }))
    },
    onPick({ candidate }) {
      const value = String((candidate && candidate.name) || '')
      const action = ACTIONS.find((item) => value.indexOf(item.key) >= 0) || ACTIONS[0]
      return { text: action.template }
    },
  }

  const at = {
    trigger: '@',
    name: MENTION_SOURCE,
    order: 3,
    async candidates(session, request) {
      try { if (typeof window !== 'undefined') window.__phAtDebug = { called: true, query: request && request.query } } catch (e) { /* debug */ }
      const query = String((request && request.query) || '').trim()
      const signal = request && request.signal
      const items = []
      try {
        if (api) {
          const [papersResult, foldersResult] = await Promise.allSettled([
            api('search.query', { q: query || ' ', scope: 'papers', limit: 6, ai: false }, { signal: signal }),
            api('library.folders.tree', {}, { signal: signal }),
          ])
          if (signal && signal.aborted) return []
          const papers = papersResult.status === 'fulfilled' && papersResult.value && Array.isArray(papersResult.value.items) ? papersResult.value.items : []
          papers.forEach((hit) => {
            const paperId = hit.paperId || hit.id
            if (!paperId) return
            items.push({
              name: String(hit.titleZh || hit.title || paperId).slice(0, 60),
              description: [hit.year, hit.kind === 'paper' ? '' : hit.kind].filter(Boolean).join(' · ') || t('trigger.at.paper'),
              icon: 'file',
              section: t('trigger.at.papers'),
              value: JSON.stringify({ kind: 'paper', id: paperId, label: hit.titleZh || hit.title || paperId }),
            })
          })
          const folders = foldersResult.status === 'fulfilled' && foldersResult.value && Array.isArray(foldersResult.value.items) ? foldersResult.value.items : []
          const walk = (nodes, depth) => (nodes || []).forEach((node) => {
            items.push({ name: (depth > 0 ? '　'.repeat(depth) + '└ ' : '') + node.name, description: (node.count || 0) + ' ' + t('trigger.at.papersUnit'), icon: 'folder', section: t('trigger.at.folders'), value: JSON.stringify({ kind: 'folder', id: node.id, label: node.name }) })
            if (Array.isArray(node.children) && node.children.length > 0) walk(node.children, depth + 1)
          })
          walk(folders, 0)
        }
      } catch (error) {
        console.warn('[pappers-hall] @ source lookup failed', error)
      }
      try { if (typeof window !== 'undefined') window.__phAtDebug = Object.assign({}, window.__phAtDebug, { items: items.length }) } catch (e) { /* debug */ }
      return items.slice(0, 24)
    },
    onPick({ candidate }) {
      let value = null
      try {
        value = JSON.parse(String((candidate && candidate.value) || ''))
      } catch (error) {
        value = null
      }
      if (!value || !value.id) return { text: '@论文中心 ' }
      const kind = value.kind === 'folder' ? 'folder' : 'paper'
      return {
        insert: {
          source: MENTION_SOURCE,
          ref: mentionOf(kind, value.id),
          label: value.label || value.id,
          appearance: kind,
          clipboardText: mentionOf(kind, value.id),
        },
      }
    },
    openReference(session, reference) {
      const parsed = parseMention(reference && reference.ref)
      if (!parsed) return false
      try {
        if (parsed.kind === 'paper' && services && typeof services.openPaper === 'function') return services.openPaper(parsed.id)
        if (parsed.kind === 'folder' && services && typeof services.openFolder === 'function') return services.openFolder(parsed.id)
      } catch (error) {
        console.warn('[pappers-hall] open reference failed', error)
      }
      return false
    },
    codec: {
      clipboardText: (ref) => String(ref || ''),
      serialize: (ref) => Promise.resolve(String(ref || '')),
    },
  }

  const disposers = []
  // Registration can race the input-trigger module; the caller retries while this
  // returns null so the + menu and @ source appear as soon as the service exists.
  try {
    disposers.push(inputTriggers.registerSource(slash))
  } catch (error) {
    console.warn('[pappers-hall] slash source registration skipped', error)
    try { window.__phTriggerDebug = Object.assign({}, window.__phTriggerDebug, { slashError: String(error && error.message) }) } catch (e) {}
  }
  try {
    disposers.push(inputTriggers.registerSource(at))
  } catch (error) {
    console.warn('[pappers-hall] @ source registration skipped', error)
    try { window.__phTriggerDebug = Object.assign({}, window.__phTriggerDebug, { atError: String(error && error.message) }) } catch (e) {}
  }
  try { if (typeof window !== 'undefined') window.__phTriggerDebug = Object.assign({}, window.__phTriggerDebug, { registered: disposers.length }) } catch (error) { /* debug */ }
  // "+" menu entries: register client command contributions whose action inserts a
  // paper-center instruction template into the current composer. This puts the
  // plugin inside the composer plus menu, not only behind a typed '/'.
  let commandUi
  try { commandUi = typeof ctx.get === 'function' ? ctx.get('commandUi') : undefined } catch (error) { commandUi = undefined }
  if (commandUi && typeof commandUi.register === 'function') {
    for (const action of ACTIONS) {
      try {
        disposers.push(commandUi.register({
          name: action.name,
          icon: action.icon,
          label: () => (t('trigger.plus.' + action.key) || action.name),
          description: () => (t('trigger.slash.' + (action.key === 'import-pdf' ? 'importHint' : action.key === 'find' ? 'findHint' : action.key === 'folder' ? 'folderHint' : 'overviewHint')) || ''),
          available: () => true,
          ui: {
            kind: 'action',
            run: (session) => {
              try {
                const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
                const uiConversation = typeof ctx.get === 'function' ? ctx.get('uiConversation') : undefined
                let shell
                let err = null
                try {
                  shell = conversation && typeof conversation.shell === 'function' ? conversation.shell(session && session.sessionId) : undefined
                } catch (error) { err = String(error && error.message) }
                try { if (typeof window !== 'undefined') window.__phPlusDebug = { hasConversation: !!conversation, hasUiConversation: !!uiConversation, shell: !!shell, error: err, sessionId: session && session.sessionId } } catch (e) {}
                if (shell && typeof shell.appendDraft === 'function') { shell.appendDraft(action.template); return }
                // The public conversation service does not expose the per-session
                // composer shell in every build; fall back to a native paste event on
                // the focused composer, which the DSH editor handles as user input.
                const editor = typeof document !== 'undefined' ? document.querySelector('[data-composer-input="true"]') : null
                if (editor) {
                  editor.focus()
                  const data = new DataTransfer()
                  data.setData('text/plain', action.template)
                  editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
                }
              } catch (error) {
                console.warn('[pappers-hall] plus-menu insert failed', error)
              }
            },
          },
        }))
      } catch (error) {
        console.warn('[pappers-hall] plus-menu contribution skipped', action.name, error)
      }
    }
  }
  if (disposers.length === 0) return null
  return () => disposers.forEach((dispose) => { try { dispose() } catch (error) { /* ignore */ } })
}

export { NS, MENTION_SOURCE, mentionOf, parseMention }
