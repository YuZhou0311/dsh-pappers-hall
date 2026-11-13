/**
 * Pappers-Hall Web Client entry — the single lazy-CJS module the DSH loader
 * materializes. Keep this file thin: it owns the plugin definition, locale
 * registration, shared data services and every slot registration; surfaces live
 * in `client/src/surfaces/**`.
 *
 * Build with `node client/build.mjs` (esbuild is a dev-only dependency). The
 * built `client.js` at the package root is what ships and what the loader serves.
 */
import React from 'react'
import { createElement as h } from 'react'

import { NS, PANEL_ID, DRAWER_ID, DRAWER_KIND, DOCK_ID, HEADER_ID } from './core/constants.js'
import { installStyles } from './core/styles.js'
import { createApi } from './core/api.js'
import { createPendingStore } from './core/pending.js'
import { createLibraryController } from './core/library-state.js'
import { withBoundary } from './core/boundary.jsx'
import { PanelIcon } from './surfaces/panel-icon.jsx'
import { PaperCenter } from './surfaces/center.jsx'
import { DrawerBody } from './surfaces/drawer.jsx'
import { DockBody, ComposerEntry } from './surfaces/dock.jsx'
import { HeaderDrawerButton } from './surfaces/header-button.jsx'
import { registerConversationIntegration } from './surfaces/integration/turn-tail.jsx'
import { SettingsHost } from './surfaces/settings/host.jsx'
import { ZH } from './i18n/zh.js'
import { EN } from './i18n/en.js'

/** Client services resolved before `apply` runs. */
export const inject = ['slots', 'locale']

/** Switch the main column to the Paper Center panel. */
export function openLibraryPanel(ctx) {
  const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
  if (!layout || typeof layout.selectPanel !== 'function') return false
  try {
    layout.selectPanel(PANEL_ID)
    return true
  } catch {
    return false
  }
}

/**
 * Open the right-sidebar paper drawer on the current conversation.
 *
 * `sidebarRight.openTab` expands the rail and reports the presentation itself
 * (`ui-sidebar-right` owns `layout.openRightbar`). Reporting layout here would
 * override that report: `openRightbar(false, …)` means "reserve no track", and
 * the frame then hangs the panel over the centre instead of making room for it,
 * which clips the conversation.
 */
export function openPaperDrawer(ctx) {
  const right = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
  if (!right || typeof right.openTab !== 'function') return false
  try {
    right.openTab(DRAWER_KIND)
    return true
  } catch {
    return false
  }
}

/**
 * Contribute every Pappers-Hall surface. Each registration lives inside
 * `ctx.effect`, so disabling the plugin removes the sidebar entry, the main
 * page, the drawer tab, the composer dock and the header button.
 * @param {object} ctx Client plugin context.
 */
export function apply(ctx) {
  installStyles(ctx)

  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'pappers-hall: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = createApi()
  const pending = createPendingStore()
  const library = createLibraryController({ api })

  // 1. Sidebar entry (icon only; the sidebar resolves the label thunk).
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel.title'), locale: NS },
          withBoundary(function PanelEntry(props) {
            return h(PanelIcon, props)
          }, 'sidebar settings host'),
        ),
      ),
    'pappers-hall: sidebar entry',
  )

  // 1b. Frame-wide settings overlay. Mounting inside the sidebar button would
  //     nest interactive content inside a <button>; shell.overlay is outside
  //     every column and scroll container.
  ctx.effect(
    () =>
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'pappers-hall-settings', order: 40, locale: NS },
          withBoundary(function SettingsOverlay(props) {
            return h(SettingsHost, { t: t })
          }, 'settings overlay'),
        ),
      ),
    'pappers-hall: settings overlay',
  )

  // 2. Paper Center main panel: Zotero-like library shell and the reader share
  //    one surface; the reader is entered from an item and returns back.
  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NS },
          withBoundary(function PaperCenterSurface(props) {
            return h(PaperCenter, { ...props, t, api, pending, library })
          }, 'paper center'),
        ),
      ),
    'pappers-hall: main panel',
  )

  // 3. Conversation header button that opens the drawer.
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: HEADER_ID,
            order: 90,
            locale: NS,
            inject: () => ({ openDrawer: () => openPaperDrawer(ctx) }),
          },
          withBoundary(HeaderDrawerButton, 'header button'),
        ),
      ),
    'pappers-hall: header button',
  )

  // 4a. New-conversation composer entry: opens the paper drawer and keeps the
  // insertion bridge available even when the native dock slot is absent.
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'pappers-hall-composer-entry',
            order: 25,
            locale: NS,
            inject: () => ({ openPapers: () => openPaperDrawer(ctx) || openLibraryPanel(ctx) }),
          },
          withBoundary(ComposerEntry, 'composer entry'),
        ),
      ),
    'pappers-hall: composer entry',
  )

  // 4. Composer dock with the pending conversation materials.
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          { name: 'conversation.input.dock', id: DOCK_ID, order: 15, locale: NS },
          withBoundary(DockBody, 'composer dock'),
        ),
      ),
    'pappers-hall: composer dock',
  )

  // 5. Right-sidebar drawer type + body.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
      const slots = scope.get('slots')
      const tabs = scope.get('sidebarRightTabs')
      if (tabs && typeof tabs.register === 'function') {
        scope.effect(
          () => tabs.register({ id: DRAWER_ID, kind: DRAWER_KIND, multiple: false, title: () => t('drawer.title') }),
          'pappers-hall: drawer tab type',
        )
      }
      if (slots && typeof slots.inject === 'function') {
        scope.effect(
          () =>
            slots.inject('sidebar.right.pane.tab', () =>
              slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: DRAWER_ID,
                  locale: NS,
                  inject: () => ({ openLibrary: () => openLibraryPanel(ctx) }),
                },
                withBoundary(DrawerBody, 'conversation drawer'),
              ),
            ),
          'pappers-hall: drawer body',
        )
      }
    })
  }

  // 6. Chat turn-tail source cards for Pappers-Hall tool answers.
  ctx.effect(() => registerConversationIntegration(ctx, { t, api }), 'pappers-hall: conversation integration')
}

export { READER_CSS } from './surfaces/reader/styles.js'
export { Markdown } from './surfaces/reader/markdown.jsx'
export { SelectionResultCard, FigureHighlightOverlay } from './surfaces/reader/page-canvas.jsx'

// v0.17 notes surface (exported for the headless harness; harmless in production)
export { navigation } from './core/navigation.js'
export { createNotesService } from './core/notes-api.js'
export { sectionizeMarkdown, matchSectionCards, parseBeautifyPayload } from './core/notes-model.js'
export { NotesWorkspace } from './surfaces/notes/workspace.jsx'
export { DrawerBody } from './surfaces/drawer.jsx'
export { NoteEditor } from './surfaces/notes/editor.jsx'
export { ReaderNotesPanel } from './surfaces/reader/notes-panel.jsx'
export { FloatingAnnotationTools } from './surfaces/reader/floating-tools.jsx'
export { ZH } from './i18n/zh.js'
export { EN } from './i18n/en.js'

export { NS, PANEL_ID, DRAWER_ID, DOCK_ID, HEADER_ID }
