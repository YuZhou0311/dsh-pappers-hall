/**
 * Notes surface stylesheet (v0.17): the standalone notes library and the shared
 * note editor used by both the reader side tab and the library workspace.
 *
 * Prefix `ph-n-` keeps every class out of the host UI; colours/radii come only
 * from `--dsw-alias-*` tokens (+ color-mix layering), motion is CSS-only and is
 * disabled under `prefers-reduced-motion: reduce`.
 */

const STYLE_ID = 'ph-notes-styles'

export const NOTES_CSS = `
/* ========================================================================== *
 * Notes workspace shell
 * ========================================================================== */
.ph-n-app {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  height: 100%;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
  position: relative;
  overflow: hidden;
}
.ph-n-app *,
.ph-n-app *::before,
.ph-n-app *::after,
.ph-n-editor,
.ph-n-editor *,
.ph-n-editor *::before,
.ph-n-editor *::after { box-sizing: border-box; }
.ph-n-app button, .ph-n-editor button { font-family: inherit; }

.ph-n-topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  min-height: 48px;
}
.ph-n-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ph-n-brand__mark { color: var(--ph-accent-text, #0071e3); flex: none; }
.ph-n-brand__title { margin: 0; font-size: 15px; font-weight: 650; white-space: nowrap; }
.ph-n-brand__sub { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.ph-n-topbar__spacer { flex: 1 1 auto; }
.ph-n-topbar__search { max-width: 320px; flex: 1 1 220px; }
.ph-n-topbar__actions { display: flex; align-items: center; gap: 6px; flex: none; }

.ph-n-body { flex: 1 1 auto; min-height: 0; display: flex; position: relative; }

/* ---- left: folder tree --------------------------------------------------- */
.ph-n-folders {
  flex: none;
  width: 226px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, var(--dsw-alias-bg-base));
  transition: width 180ms cubic-bezier(0.4, 0, 0.2, 1), opacity 140ms ease;
  overflow: hidden;
}
.ph-n-folders--closed { width: 0; opacity: 0; border-right-color: transparent; }
.ph-n-folders__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 4px 12px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  letter-spacing: 0.02em;
}
.ph-n-folders__head .ph-iconbtn { margin-left: auto; }
.ph-n-folders__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 6px 16px; }
.ph-n-folders__group { margin-top: 8px; padding: 4px 8px 2px; font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.ph-n-tree { display: flex; flex-direction: column; gap: 1px; }
.ph-n-tree__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 3px 6px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: pointer;
  font-size: 12.5px;
  width: 100%;
}
.ph-n-tree__row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.ph-n-tree__row--active {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--ph-accent-text, #0071e3);
  font-weight: 600;
}
.ph-n-tree__icon { flex: none; color: var(--dsw-alias-label-tertiary); display: inline-flex; }
.ph-n-tree__row--active .ph-n-tree__icon { color: inherit; }
.ph-n-tree__label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-tree__count { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ph-n-tree__row--active .ph-n-tree__count { color: inherit; }
.ph-n-tree__drop {
  outline: 2px dashed color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent);
  outline-offset: -2px;
}
.ph-n-tree__tools { display: flex; gap: 2px; margin-left: auto; opacity: 0; }
.ph-n-tree__row:hover .ph-n-tree__tools,
.ph-n-tree__row--active .ph-n-tree__tools { opacity: 1; }
.ph-n-tree__input {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-base);
  color: inherit;
}
.ph-n-folders__empty { padding: 10px 12px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); line-height: 1.6; }

/* ---- middle: note list --------------------------------------------------- */
.ph-n-listpane {
  flex: none;
  width: 304px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  transition: width 180ms cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
.ph-n-listpane__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 6px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.ph-n-listpane__title { font-size: 12.5px; font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-listpane__count { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ph-n-listpane__filter {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent);
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}
.ph-n-listpane__filter .ph-n-chip { max-width: 100%; }
.ph-n-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.ph-n-listrow {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  width: 100%;
}
.ph-n-listrow:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.ph-n-listrow--active {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 34%, transparent);
}
.ph-n-listrow__top { display: flex; align-items: baseline; gap: 6px; }
.ph-n-listrow__title { flex: 1 1 auto; min-width: 0; font-size: 12.8px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-listrow__time { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ph-n-listrow__preview {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ph-n-listrow__meta { display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.ph-n-listrow__folder { display: inline-flex; align-items: center; gap: 3px; min-width: 0; }
.ph-n-listrow__folder span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-listrow__badges { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }

/* ---- main editor column -------------------------------------------------- */
.ph-n-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); }
.ph-n-main__empty { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 24px; }

/* ---- right: paper panel -------------------------------------------------- */
.ph-n-paperpane {
  flex: none;
  width: 372px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 50%, var(--dsw-alias-bg-base));
  transition: width 190ms cubic-bezier(0.4, 0, 0.2, 1), opacity 150ms ease;
  overflow: hidden;
}
.ph-n-paperpane--closed { width: 0; opacity: 0; border-left-color: transparent; }
.ph-n-paperpane__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  min-height: 40px;
}
.ph-n-paperpane__title { font-size: 12.5px; font-weight: 650; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-paperpane__body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.ph-n-paperpane__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px 20px; }
.ph-n-paperpane__search { padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }

/* ---- status strip -------------------------------------------------------- */
.ph-n-statusbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, var(--dsw-alias-bg-base));
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  min-height: 26px;
}
.ph-n-statusbar__spacer { flex: 1 1 auto; }
.ph-n-statusbar__warn { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary)); }

/* ========================================================================== *
 * Shared note editor
 * ========================================================================== */
.ph-n-editor { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; }
.ph-n-editor__head {
  flex: none;
  padding: 10px 14px 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.ph-n-editor--compact .ph-n-editor__head { padding: 8px 10px 4px; gap: 4px; }
.ph-n-editor__titlerow { display: flex; align-items: center; gap: 8px; }
.ph-n-editor__back { flex: none; }
.ph-n-editor__title {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  font-size: 15px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 4px 7px;
  outline: none;
}
.ph-n-editor--compact .ph-n-editor__title { font-size: 13.5px; }
.ph-n-editor__title:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.ph-n-editor__title:focus { border-color: var(--ph-accent-text, #0071e3); background: var(--dsw-alias-bg-base); }
.ph-n-editor__title::placeholder { color: var(--dsw-alias-label-caption); }
.ph-n-editor__actions { flex: none; display: flex; align-items: center; gap: 4px; }
.ph-n-editor__meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 0 2px; min-height: 22px; }
.ph-n-editor__meta-spacer { flex: 1 1 auto; }
.ph-n-savestate { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.ph-n-savestate--error,
.ph-n-savestate--offline { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary)); }
.ph-n-savestate--conflict { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-state-warn-primary)); }
.ph-n-savestate__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.ph-n-savestate__retry { font-size: 11px; }
.ph-n-editor__bars { flex: none; display: flex; flex-direction: column; }
.ph-n-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 11.5px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent);
  color: var(--dsw-alias-label-secondary);
  flex-wrap: wrap;
}
.ph-n-banner--warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 9%, transparent); }
.ph-n-banner--error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 9%, transparent); }
.ph-n-banner__actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }

/* ---- toolbar (view toggle / beautify / history) -------------------------- */
.ph-n-editor__toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex-wrap: wrap;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 45%, transparent);
}
.ph-n-editor--compact .ph-n-editor__toolbar { padding: 4px 8px; }
.ph-n-toolbar__spacer { flex: 1 1 auto; }

/* ---- section strip ------------------------------------------------------- */
.ph-n-sections { border-bottom: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 40%, transparent); }
.ph-n-sections__head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  cursor: pointer;
  text-align: left;
}
.ph-n-sections__head:hover { color: var(--dsw-alias-label-primary); }
.ph-n-sections__hint { color: var(--dsw-alias-label-caption); font-size: 11px; }
.ph-n-sections__list { display: flex; flex-direction: column; gap: 2px; padding: 2px 10px 8px; max-height: 148px; overflow-y: auto; }
.ph-n-sections__row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); padding: 2px 2px; }
.ph-n-sections__heading { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-sections__toggle {
  flex: none;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: inherit;
  border-radius: 999px;
  font-size: 10.5px;
  padding: 1px 8px;
  cursor: pointer;
}
.ph-n-sections__toggle--incomplete {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary));
}

/* ---- content: textarea + cards ------------------------------------------ */
.ph-n-editor__content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.ph-n-editor__textarea {
  flex: 1 1 auto;
  min-height: 140px;
  width: 100%;
  resize: none;
  font: inherit;
  font-size: 13px;
  line-height: 1.72;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: none;
  outline: none;
  padding: 12px 16px 28px;
  tab-size: 2;
}
.ph-n-editor--compact .ph-n-editor__textarea { padding: 10px 12px 24px; font-size: 12.5px; }
.ph-n-editor__textarea::placeholder { color: var(--dsw-alias-label-caption); }
.ph-n-editor__cards { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 16px 32px; display: flex; flex-direction: column; gap: 10px; }
.ph-n-editor__empty { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 24px; }
.ph-n-editor__loading { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }

/* ---- rendered original text (markdown inside notes) --------------------- */
.ph-n-md { max-width: 760px; font-size: 13px; line-height: 1.72; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.ph-n-md > :first-child { margin-top: 0; }
.ph-n-md > :last-child { margin-bottom: 0; }
.ph-n-md .ph-ai-md__p { margin: 0 0 8px; white-space: pre-wrap; }
.ph-n-md .ph-ai-md__h { margin: 12px 0 6px; font-weight: 650; line-height: 1.35; }
.ph-n-md .ph-ai-md__h1 { font-size: 16px; }
.ph-n-md .ph-ai-md__h2 { font-size: 14.5px; }
.ph-n-md .ph-ai-md__h3 { font-size: 13.5px; }
.ph-n-md .ph-ai-md__list { margin: 0 0 8px; padding-left: 20px; }
.ph-n-md .ph-ai-md__quote { margin: 8px 0; padding: 6px 10px; border-left: 3px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent); border-radius: 0 6px 6px 0; color: var(--dsw-alias-label-secondary); }
.ph-n-md .ph-ai-md__code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); }
.ph-n-md .ph-ai-md__pre { margin: 8px 0; padding: 9px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); overflow-x: auto; }
.ph-n-md .ph-ai-md__codeblock { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; white-space: pre; display: block; }
.ph-n-md .ph-ai-md__tablewrap { margin: 8px 0; overflow-x: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.ph-n-md .ph-ai-md__table { border-collapse: collapse; width: 100%; font-size: 12px; }
.ph-n-md .ph-ai-md__table th, .ph-n-md .ph-ai-md__table td { padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); text-align: left; vertical-align: top; }
.ph-n-md .ph-ai-md__table th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.ph-n-md .ph-ai-md__hr { margin: 12px 0; border: none; border-top: 1px solid var(--dsw-alias-border-l2); }

/* ---- beautified card section -------------------------------------------- */
.ph-n-cards { display: flex; flex-direction: column; gap: 10px; max-width: 860px; width: 100%; }
.ph-n-sec {
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 11%, transparent);
  border-radius: 11px;
  background: var(--dsw-alias-bg-base);
  padding: 10px 12px 12px;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
}
.ph-n-sec--original { border-style: dashed; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 45%, transparent); box-shadow: none; }
.ph-n-sec--beautified { background: var(--dsw-alias-bg-base); }
.ph-n-sec--incomplete { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 40%, transparent); }
.ph-n-sec__head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; min-height: 20px; }
.ph-n-sec__heading { font-size: 12px; font-weight: 650; color: var(--dsw-alias-label-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-sec__badges { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex: none; }
.ph-n-sec__body { display: flex; flex-direction: column; gap: 8px; }
.ph-n-card__h { margin: 2px 0 0; font-size: 13px; font-weight: 650; line-height: 1.4; }
.ph-n-card__p { margin: 0; white-space: pre-wrap; }
.ph-n-card__ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 3px; }
.ph-n-card__ul li::marker { color: var(--ph-accent-text, #0071e3); }
.ph-n-card__tablewrap { overflow-x: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.ph-n-card__table { border-collapse: collapse; width: 100%; font-size: 11.8px; }
.ph-n-card__table th, .ph-n-card__table td { padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); text-align: left; vertical-align: top; }
.ph-n-card__table tr:last-child td { border-bottom: none; }
.ph-n-card__table th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.ph-n-card__quote { margin: 0; padding: 6px 10px; border-left: 3px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent); border-radius: 0 6px 6px 0; color: var(--dsw-alias-label-secondary); }
.ph-n-card__callout { display: flex; gap: 8px; padding: 7px 10px; border-radius: 8px; font-size: 12px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent); }
.ph-n-card__callout--warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 8%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 26%, transparent); }
.ph-n-card__callout--success { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 8%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 26%, transparent); }
.ph-n-card__callout-icon { flex: none; margin-top: 1px; color: var(--ph-accent-text, #0071e3); }
.ph-n-card__callout-title { font-weight: 650; margin-bottom: 2px; }
.ph-n-sec__note { margin: 0; font-size: 11px; color: var(--dsw-alias-label-caption); }

/* ---- chips / paper links ------------------------------------------------- */
.ph-n-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 4px 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, transparent);
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.ph-n-chip__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 210px; }
.ph-n-chip button { color: inherit; }
.ph-n-chip--folder { padding-right: 8px; }

/* ========================================================================== *
 * Paper panel (right column: search + page preview + translation + annotations)
 * ========================================================================== */
.ph-n-paperlist { display: flex; flex-direction: column; gap: 2px; }
.ph-n-paperrow {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 7px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  color: inherit;
  cursor: pointer;
  width: 100%;
}
.ph-n-paperrow:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.ph-n-paperrow--active { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent); }
.ph-n-paperrow__thumb { flex: none; width: 30px; height: 38px; border-radius: 3px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); background: #fff; }
.ph-n-paperrow__thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ph-n-paperrow__text { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; }
.ph-n-paperrow__title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-paperrow__meta { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-paperview { display: flex; flex-direction: column; gap: 8px; }
.ph-n-paperview__head { display: flex; align-items: flex-start; gap: 6px; }
.ph-n-paperview__titles { min-width: 0; flex: 1 1 auto; }
.ph-n-paperview__title { font-size: 12.5px; font-weight: 650; line-height: 1.4; }
.ph-n-paperview__meta { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
.ph-n-paperview__pager { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ph-n-paperview__imagewrap { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; overflow: hidden; background: #fff; }
.ph-n-paperview__imagewrap img { display: block; width: 100%; height: auto; }
.ph-n-paperview__section { display: flex; flex-direction: column; gap: 4px; }
.ph-n-paperview__section-title { font-size: 11px; font-weight: 650; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; gap: 5px; }
.ph-n-paperview__trans { display: flex; flex-direction: column; gap: 6px; font-size: 11.8px; line-height: 1.6; }
.ph-n-paperview__trans p { margin: 0; }
.ph-n-paperview__trans .muted { color: var(--dsw-alias-label-tertiary); }
.ph-n-paperview__annot { display: flex; gap: 6px; font-size: 11.5px; line-height: 1.5; padding: 5px 7px; border-radius: 7px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, transparent); border: 1px solid var(--dsw-alias-border-l1); }
.ph-n-paperview__annot-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; }
.ph-n-paperview__annot-text { min-width: 0; flex: 1 1 auto; color: var(--dsw-alias-label-secondary); }

/* ========================================================================== *
 * Modals (beautify consent / history / paper link)
 * ========================================================================== */
.ph-n-modal-backdrop {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent);
  backdrop-filter: blur(2px);
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  animation: ph-n-fade 140ms ease;
}
.ph-n-modal {
  width: min(560px, 94vw);
  max-height: min(82vh, 720px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  box-shadow: 0 24px 64px -24px color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent), 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  overflow: hidden;
  animation: ph-n-pop 160ms cubic-bezier(0.16, 1, 0.3, 1);
}
.ph-n-modal--wide { width: min(700px, 96vw); }
.ph-n-modal__head { flex: none; display: flex; align-items: flex-start; gap: 8px; padding: 14px 16px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ph-n-modal__titles { flex: 1 1 auto; min-width: 0; }
.ph-n-modal__title { margin: 0; font-size: 14.5px; font-weight: 650; }
.ph-n-modal__desc { margin: 3px 0 0; font-size: 11.8px; color: var(--dsw-alias-label-tertiary); line-height: 1.55; }
.ph-n-modal__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.ph-n-modal__foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ph-n-modal__foot .ph-n-spacer { flex: 1 1 auto; }
.ph-n-field { display: flex; flex-direction: column; gap: 6px; }
.ph-n-field__label { font-size: 11.5px; font-weight: 650; color: var(--dsw-alias-label-secondary); }
.ph-n-field__hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
.ph-n-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.ph-n-choice {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.ph-n-choice:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); }
.ph-n-choice--active {
  border-color: var(--ph-accent-text, #0071e3);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent);
}
.ph-n-choice__title { font-size: 12.5px; font-weight: 650; }
.ph-n-choice__desc { font-size: 10.8px; color: var(--dsw-alias-label-tertiary); line-height: 1.45; }
.ph-n-radio-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ph-n-radio { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.ph-n-summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 65%, transparent);
  border: 1px solid var(--dsw-alias-border-l1);
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  line-height: 1.55;
}
.ph-n-summary__icon { flex: none; margin-top: 1px; color: var(--ph-accent-text, #0071e3); }
.ph-n-progress { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ph-n-error { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 9px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 8%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 28%, transparent); font-size: 11.8px; color: var(--dsw-alias-label-secondary); line-height: 1.55; }
.ph-n-revlist { display: flex; flex-direction: column; gap: 6px; }
.ph-n-revrow { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; font-size: 12px; }
.ph-n-revrow__main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ph-n-revrow__label { font-weight: 600; }
.ph-n-revrow__meta { font-size: 10.8px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ph-n-revrow--current { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent); }
.ph-n-paperpick { display: flex; flex-direction: column; gap: 6px; }
.ph-n-paperpick__list { display: flex; flex-direction: column; gap: 2px; max-height: 280px; overflow-y: auto; }
.ph-n-paperpick__row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.ph-n-paperpick__row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.ph-n-paperpick__title { min-width: 0; flex: 1 1 auto; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- dropdown menu ------------------------------------------------------- */
.ph-n-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 40;
  min-width: 168px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 12px 34px -16px color-mix(in srgb, var(--dsw-alias-label-primary) 48%, transparent), 0 1px 3px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  display: flex;
  flex-direction: column;
  animation: ph-n-pop 140ms cubic-bezier(0.16, 1, 0.3, 1);
}
.ph-n-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.ph-n-menu__item:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.ph-n-menu__item:disabled { opacity: 0.5; cursor: default; }
.ph-n-menu__item--danger { color: var(--dsw-alias-state-error-primary, #dc2626); }
.ph-n-menu__label { flex: 1 1 auto; }
.ph-select--sm { height: 24px; font-size: 11.5px; padding: 0 6px; border-radius: 7px; max-width: 170px; }

/* ========================================================================== *
 * v2 continuous document renderer (ph-n-doc)
 * ========================================================================== */
.ph-n-doc {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 820px;
  width: 100%;
}
.ph-n-doc__sec {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
}
.ph-n-doc__sec--plain { padding: 0; }
.ph-n-doc__sec--accent {
  padding: 10px 14px 12px;
  border-left: 3px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent);
  border-radius: 0 10px 10px 0;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent);
}
.ph-n-doc__sec--columns { padding: 2px 0 4px; }
.ph-n-doc__sec--figure {
  padding: 10px 14px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 52%, transparent);
  border: 1px solid var(--dsw-alias-border-l1);
}
.ph-n-doc__sec--original { padding: 2px 0 2px 12px; border-left: 2px dashed color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent); }
.ph-n-doc__sec--incomplete.ph-n-doc__sec--original { border-left-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 45%, transparent); }
.ph-n-doc__eyebrow { display: flex; align-items: baseline; gap: 8px; min-height: 20px; }
.ph-n-doc__heading {
  margin: 0;
  font-size: 14.5px;
  font-weight: 650;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
  letter-spacing: 0.01em;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ph-n-doc__heading--none { font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-caption); letter-spacing: 0.04em; }
.ph-n-doc__badges { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; flex: none; }
.ph-n-doc__badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  height: 18px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 65%, transparent);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
}
.ph-n-doc__badge--ai { color: var(--ph-accent-text, #0071e3); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent); }
.ph-n-doc__badge--warn { color: var(--dsw-alias-state-warn-primary, #d97706); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 34%, transparent); }
.ph-n-doc__toggle {
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-caption);
  border-radius: 999px;
  font: inherit;
  font-size: 10px;
  height: 18px;
  padding: 0 7px;
  cursor: pointer;
  white-space: nowrap;
}
.ph-n-doc__toggle:hover { color: var(--dsw-alias-label-secondary); border-color: var(--dsw-alias-border-l2); }
.ph-n-doc__toggle--warn { color: var(--dsw-alias-state-warn-primary, #d97706); }
.ph-n-doc__body { font-size: 13.2px; line-height: 1.78; color: var(--dsw-alias-label-primary); max-width: 760px; }
.ph-n-doc__sec--accent .ph-n-doc__body { max-width: none; }
.ph-n-doc__body--original { color: var(--dsw-alias-label-secondary); font-size: 12.8px; }
.ph-n-doc__flow { column-count: 2; column-gap: 28px; max-width: none; }
.ph-n-doc__flow .ph-n-doc__block { break-inside: avoid; }
.ph-n-doc__block { margin: 0 0 10px; }
.ph-n-doc__block:last-child { margin-bottom: 0; }
.ph-n-doc__block.ph-n-doc__block--wide { column-span: all; }
.ph-n-doc__p { margin: 0 0 10px; white-space: pre-wrap; }
.ph-n-doc__block:last-child .ph-n-doc__p { margin-bottom: 0; }
.ph-n-doc__h { margin: 12px 0 6px; font-size: 13.6px; font-weight: 650; line-height: 1.4; }
.ph-n-doc__block:first-child .ph-n-doc__h { margin-top: 0; }
.ph-n-doc__ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 3px; }
.ph-n-doc__ul li::marker { color: var(--ph-accent-text, #0071e3); }
.ph-n-doc__quote {
  margin: 0;
  padding: 6px 12px;
  border-left: 3px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 4%, transparent);
  border-radius: 0 8px 8px 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.8px;
}
.ph-n-doc__callout {
  display: flex;
  gap: 8px;
  padding: 7px 11px;
  border-radius: 9px;
  font-size: 12.4px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent);
}
.ph-n-doc__callout--warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 7%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 24%, transparent); }
.ph-n-doc__callout--success { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 7%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 24%, transparent); }
.ph-n-doc__callout-icon { flex: none; margin-top: 2px; color: var(--ph-accent-text, #0071e3); }
.ph-n-doc__callout-title { font-weight: 650; margin-bottom: 2px; }
.ph-n-doc__tablewrap { overflow-x: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; }
.ph-n-doc__table { border-collapse: collapse; width: 100%; font-size: 12px; }
.ph-n-doc__table th, .ph-n-doc__table td { padding: 5px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1); text-align: left; vertical-align: top; }
.ph-n-doc__table tr:last-child td { border-bottom: none; }
.ph-n-doc__table th { background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 80%, transparent); font-weight: 600; }
.ph-n-doc__columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.ph-n-doc__col { min-width: 0; }
.ph-n-doc__col > .ph-n-doc__block:last-child { margin-bottom: 0; }
.ph-n-doc__figure { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.ph-n-doc__figure-media {
  display: block;
  width: 100%;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  overflow: hidden;
  background: #fff;
  cursor: pointer;
  transition: box-shadow 140ms ease, border-color 140ms ease;
}
.ph-n-doc__figure-media:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); box-shadow: 0 8px 24px -16px color-mix(in srgb, var(--dsw-alias-label-primary) 50%, transparent); }
.ph-n-doc__figure-img { display: block; width: 100%; height: auto; }
.ph-n-doc__figure-cap { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); line-height: 1.55; }
.ph-n-doc__figure-label { flex: none; font-weight: 650; color: var(--dsw-alias-label-secondary); }
.ph-n-doc__figure-text { min-width: 0; flex: 1 1 auto; }
.ph-n-doc__figure-jump {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: transparent;
  color: var(--ph-accent-text, #0071e3);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
  padding: 0;
  white-space: nowrap;
}
.ph-n-doc__figure-jump:hover { text-decoration: underline; }
.ph-n-doc__note { margin: 0; font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.ph-n-doc__empty { padding: 20px 0; }

/* ========================================================================== *
 * Auto-beautify controls (边写边美化)
 * ========================================================================== */
.ph-n-autofix { position: relative; display: inline-flex; align-items: center; gap: 6px; }
.ph-n-autofix__toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.ph-n-autofix__toggle:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-tertiary); }
.ph-n-autofix__toggle--on {
  color: var(--ph-accent-text, #0071e3);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 38%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
}
.ph-n-autofix__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.ph-n-autofix__dot--pulse { animation: ph-n-autofix-pulse 1.4s ease-in-out infinite; }
.ph-n-autofix__state { font-size: 10px; opacity: 0.85; }
.ph-n-autofix__select {
  height: 24px;
  font-size: 11px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  padding: 0 4px;
  max-width: 106px;
}
.ph-n-autofix__intro {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 2px 0 0;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 26%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
}
.ph-n-autofix__intro .ph-n-spacer { flex: 1 1 auto; }
.ph-n-autofix__overlay {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 45;
  width: 336px;
  max-width: min(336px, 92vw);
  padding: 10px 11px 11px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 16px 40px -22px color-mix(in srgb, var(--dsw-alias-label-primary) 52%, transparent), 0 2px 6px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  display: flex;
  flex-direction: column;
  gap: 7px;
  animation: ph-n-pop 140ms cubic-bezier(0.16, 1, 0.3, 1);
}
.ph-n-autofix__overlay-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--dsw-alias-label-primary); }
.ph-n-autofix__overlay-sub { font-size: 10.8px; color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
.ph-n-autofix__option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.ph-n-autofix__option:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent); }
.ph-n-autofix__option--recommended { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent); }
.ph-n-autofix__option-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ph-n-autofix__option-label { font-size: 11.8px; font-weight: 650; display: flex; align-items: center; gap: 5px; }
.ph-n-autofix__option-reason { font-size: 10.6px; color: var(--dsw-alias-label-tertiary); line-height: 1.45; }
.ph-n-autofix__option-tag { font-size: 9.5px; font-weight: 600; color: var(--ph-accent-text, #0071e3); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent); border-radius: 999px; padding: 0 5px; height: 15px; line-height: 14px; }
.ph-n-autofix__overlay-foot { display: flex; align-items: center; gap: 6px; }
.ph-n-autofix__overlay-foot .ph-n-spacer { flex: 1 1 auto; }
.ph-n-autofix__status { display: inline-flex; align-items: center; gap: 5px; font-size: 10.8px; color: var(--dsw-alias-label-tertiary); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-autofix__status--warn { color: var(--dsw-alias-state-warn-primary, #d97706); }
.ph-n-autofix__status--ok { color: var(--dsw-alias-state-success-primary, #16a34a); }
@keyframes ph-n-autofix-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }

/* ---- misc ---------------------------------------------------------------- */
.ph-n-muted { color: var(--dsw-alias-label-tertiary); }
.ph-n-caption { color: var(--dsw-alias-label-caption); font-size: 11px; }
.ph-n-nowrap { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ph-n-spacer { flex: 1 1 auto; }
.ph-n-scroll { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent; overscroll-behavior: contain; }
.ph-n-scroll::-webkit-scrollbar { width: 9px; height: 9px; }
.ph-n-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border: 2px solid transparent; background-clip: content-box; border-radius: 8px; }
.ph-n-skeletonrow { height: 52px; border-radius: 9px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); animation: ph-n-pulse 1.3s ease-in-out infinite; }
.ph-n-spin { display: inline-block; width: 13px; height: 13px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent); border-top-color: var(--ph-accent-text, #0071e3); animation: ph-n-rot 720ms linear infinite; flex: none; }

@keyframes ph-n-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ph-n-pop { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes ph-n-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes ph-n-rot { to { transform: rotate(360deg); } }

/* ---- reader side-panel variant ------------------------------------------ */
.ph-r-side__body .ph-n-editor { height: 100%; }
.ph-r-side__body .ph-n-readernotes { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.ph-n-readernotes__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.ph-n-readernotes__title { font-size: 11.5px; font-weight: 650; color: var(--dsw-alias-label-secondary); }
.ph-n-readernotes__list {
  flex: none;
  max-height: 132px;
  overflow-y: auto;
  padding: 4px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ph-n-readernotes__row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 7px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  width: 100%;
}
.ph-n-readernotes__row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.ph-n-readernotes__row--active { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent); }
.ph-n-readernotes__rowtitle { font-size: 11.8px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-n-readernotes__rowmeta { font-size: 10.2px; color: var(--dsw-alias-label-tertiary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (prefers-reduced-motion: reduce) {
  .ph-n-modal-backdrop, .ph-n-modal, .ph-n-spin, .ph-n-skeletonrow { animation: none; }
  .ph-n-folders, .ph-n-listpane, .ph-n-paperpane, .ph-n-choice { transition: none; }
}
@media (max-width: 1180px) {
  .ph-n-paperpane { width: 330px; }
  .ph-n-listpane { width: 280px; }
  .ph-n-choices { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .ph-n-folders { position: absolute; z-index: 30; height: 100%; box-shadow: 12px 0 24px -18px color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); }
  .ph-n-folders--closed { width: 0; }
  .ph-n-paperpane { position: absolute; right: 0; z-index: 30; height: 100%; width: min(340px, 86vw); box-shadow: -12px 0 24px -18px color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); }
}

/* ========================================================================== *
 * v0.19 design layer — typography-first notes surface
 * Reads the shared tokens declared in core/styles.css. Kept as a layer so the
 * structural rules above stay intact; every selector below is the same one
 * the components already use.
 * ========================================================================== */

/* ---- shell --------------------------------------------------------------- */
.ph-n-app {
  background: var(--ph-bg, var(--dsw-alias-bg-base));
  font-size: var(--ph-fs-13, 13px);
  line-height: var(--ph-lh-ui, 1.5);
}
.ph-n-topbar {
  gap: var(--ph-s3, 12px);
  padding: var(--ph-s3, 12px) var(--ph-s5, 20px);
  border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
  min-height: 56px;
}
.ph-n-brand { gap: var(--ph-s2, 8px); }
.ph-n-brand__mark {
  color: var(--ph-accent, var(--dsw-alias-state-business-primary));
  padding: 5px;
  border-radius: var(--ph-r-sm, 8px);
  background: var(--ph-accent-soft, color-mix(in srgb, var(--dsw-alias-state-business-primary) 11%, transparent));
  box-sizing: content-box;
}
.ph-n-brand__title { font-size: var(--ph-fs-15, 15px); font-weight: var(--ph-fw-bold, 650); letter-spacing: -0.01em; }
.ph-n-brand__sub { font-size: var(--ph-fs-12, 12px); color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }

/* ---- folder tree --------------------------------------------------------- */
.ph-n-folders {
  width: 232px;
  background: var(--ph-bg, var(--dsw-alias-bg-base));
  border-right: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
  transition: width var(--ph-panel, 280ms) var(--ph-ease-out, cubic-bezier(0.16, 1, 0.3, 1)), opacity var(--ph-base, 200ms) var(--ph-ease, ease);
}
.ph-n-folders__head {
  padding: var(--ph-s3, 12px) var(--ph-s2, 8px) var(--ph-s1, 4px) var(--ph-s3, 12px);
  font-size: var(--ph-fs-11, 11px);
  font-weight: var(--ph-fw-semi, 600);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ph-ink-3, var(--dsw-alias-label-tertiary));
}
.ph-n-folders__scroll { padding: var(--ph-s1, 4px) var(--ph-s2, 8px) var(--ph-s6, 24px); }
.ph-n-folders__group { margin-top: var(--ph-s3, 12px); padding: 4px 8px 2px; font-size: var(--ph-fs-11, 11px); color: var(--ph-ink-4, var(--dsw-alias-label-caption)); letter-spacing: 0.03em; }
.ph-n-tree { gap: 1px; }
.ph-n-tree__row {
  min-height: 32px;
  padding: 5px 8px;
  border-radius: var(--ph-r-sm, 8px);
  border: none;
  font-size: var(--ph-fs-13, 13px);
  color: var(--ph-ink-2, var(--dsw-alias-label-secondary));
  transition: background-color var(--ph-fast, 140ms) var(--ph-ease, ease), color var(--ph-fast, 140ms) var(--ph-ease, ease);
}
.ph-n-tree__row:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--ph-ink, var(--dsw-alias-label-primary)); }
.ph-n-tree__row--active,
.ph-n-tree__row--active:hover {
  background: var(--ph-accent-soft, color-mix(in srgb, var(--dsw-alias-state-business-primary) 11%, transparent));
  color: var(--ph-accent, var(--dsw-alias-state-business-primary));
  font-weight: var(--ph-fw-semi, 600);
}
.ph-n-tree__icon { color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }
.ph-n-tree__count { font-size: var(--ph-fs-11, 11px); color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }
.ph-n-tree__input {
  border: 1px solid var(--ph-accent, var(--dsw-alias-state-business-primary));
  box-shadow: var(--ph-ring, 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent));
  border-radius: var(--ph-r-xs, 6px);
  padding: 3px 7px;
}

/* ---- note list ----------------------------------------------------------- */
.ph-n-listpane {
  width: 312px;
  border-right: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
  background: var(--ph-bg, var(--dsw-alias-bg-base));
  transition: width var(--ph-panel, 280ms) var(--ph-ease-out, cubic-bezier(0.16, 1, 0.3, 1));
}
.ph-n-listpane__head { padding: var(--ph-s3, 12px) var(--ph-s3, 12px) var(--ph-s2, 8px) var(--ph-s4, 16px); border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-n-listpane__title { font-size: var(--ph-fs-12, 12px); font-weight: var(--ph-fw-bold, 650); letter-spacing: 0.02em; }
.ph-n-listpane__count { font-size: var(--ph-fs-11, 11px); color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }
.ph-n-listpane__filter {
  gap: var(--ph-s2, 8px);
  padding: 7px var(--ph-s3, 12px);
  border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
  background: var(--ph-surface-1, var(--dsw-alias-bg-layer-1));
  font-size: var(--ph-fs-11, 11px);
}
.ph-n-list { padding: var(--ph-s2, 8px); gap: 2px; }
.ph-n-listrow {
  gap: 4px;
  padding: 10px 11px;
  border-radius: var(--ph-r-sm, 8px);
  border: 1px solid transparent;
  transition: background-color var(--ph-fast, 140ms) var(--ph-ease, ease), border-color var(--ph-fast, 140ms) var(--ph-ease, ease);
}
.ph-n-listrow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ph-n-listrow--active {
  background: var(--ph-accent-soft, color-mix(in srgb, var(--dsw-alias-state-business-primary) 11%, transparent));
  border-color: var(--ph-accent-line, color-mix(in srgb, var(--dsw-alias-state-business-primary) 34%, transparent));
}
.ph-n-listrow__top { gap: 7px; }
.ph-n-listrow__title { font-size: var(--ph-fs-13, 13px); font-weight: var(--ph-fw-semi, 600); line-height: 1.4; }
.ph-n-listrow__time { font-size: var(--ph-fs-11, 11px); }
.ph-n-listrow__preview { font-size: var(--ph-fs-12, 12px); line-height: 1.55; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }
.ph-n-listrow__meta { gap: 8px; font-size: var(--ph-fs-11, 11px); }

/* ---- editor header / toolbar -------------------------------------------- */
.ph-n-editor__head {
  padding: var(--ph-s4, 16px) var(--ph-s5, 20px) var(--ph-s2, 8px);
  gap: 7px;
  border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
}
.ph-n-editor--compact .ph-n-editor__head { padding: var(--ph-s3, 12px) var(--ph-s3, 12px) var(--ph-s1, 4px); }
.ph-n-editor__title {
  font-size: var(--ph-fs-17, 17px);
  font-weight: var(--ph-fw-bold, 650);
  letter-spacing: -0.012em;
  border-radius: var(--ph-r-sm, 8px);
  padding: 5px 8px;
  transition: background-color var(--ph-fast, 140ms) var(--ph-ease, ease), border-color var(--ph-fast, 140ms) var(--ph-ease, ease);
}
.ph-n-editor--compact .ph-n-editor__title { font-size: var(--ph-fs-14, 14px); }
.ph-n-editor__title:hover { background: color-mix(in srgb, var(--ph-ink, var(--dsw-alias-label-primary)) 5%, transparent); }
.ph-n-editor__title:focus { border-color: var(--ph-accent, var(--dsw-alias-state-business-primary)); box-shadow: var(--ph-ring, none); }
.ph-n-editor__meta { gap: 8px; min-height: 24px; }
.ph-n-savestate { font-size: var(--ph-fs-11, 11px); }
.ph-n-editor__toolbar {
  gap: 5px;
  padding: 6px var(--ph-s5, 20px);
  border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
  background: var(--ph-surface-1, var(--dsw-alias-bg-layer-1));
}
.ph-n-editor--compact .ph-n-editor__toolbar { padding: 5px var(--ph-s3, 12px); }
.ph-n-sections { background: var(--ph-surface-1, var(--dsw-alias-bg-layer-1)); border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-n-sections__head { padding: 7px var(--ph-s5, 20px); font-size: var(--ph-fs-11, 11px); color: var(--ph-ink-2, var(--dsw-alias-label-secondary)); }
.ph-n-sections__list { padding: 2px var(--ph-s4, 16px) var(--ph-s2, 8px); gap: 3px; }
.ph-n-sections__row { font-size: var(--ph-fs-12, 12px); padding: 3px 2px; }
.ph-n-sections__toggle { border-radius: var(--ph-r-pill, 999px); padding: 2px 9px; font-size: var(--ph-fs-11, 11px); }

/* ---- body: reading rhythm ------------------------------------------------ */
.ph-n-editor__textarea {
  font-size: 13.5px;
  line-height: 1.8;
  padding: var(--ph-s4, 16px) var(--ph-s6, 24px) var(--ph-s8, 32px);
  max-width: 860px;
  width: 100%;
  margin: 0 auto;
  caret-color: var(--ph-accent, var(--dsw-alias-state-business-primary));
  scrollbar-width: thin;
}
.ph-n-editor--compact .ph-n-editor__textarea { padding: var(--ph-s3, 12px) var(--ph-s4, 16px) var(--ph-s6, 24px); font-size: 12.5px; line-height: 1.75; max-width: none; }
.ph-n-editor__cards { padding: var(--ph-s4, 16px) var(--ph-s6, 24px) var(--ph-s8, 32px); gap: var(--ph-s3, 12px); }

/* Markdown preview inside a note */
.ph-n-md { font-size: 13.5px; line-height: 1.8; max-width: 760px; }
.ph-n-md .ph-ai-md__p { margin: 0 0 12px; }
.ph-n-md .ph-ai-md__h { margin: 20px 0 8px; font-weight: var(--ph-fw-bold, 650); letter-spacing: -0.006em; }
.ph-n-md .ph-ai-md__h1 { font-size: 19px; }
.ph-n-md .ph-ai-md__h2 { font-size: 16.5px; }
.ph-n-md .ph-ai-md__h3 { font-size: 14.5px; }
.ph-n-md .ph-ai-md__list { margin: 0 0 12px; padding-left: 22px; }
.ph-n-md .ph-ai-md__quote {
  margin: 12px 0;
  padding: 8px 14px;
  border-left: 2.5px solid var(--ph-accent-line, color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent);
  border-radius: 0 var(--ph-r-sm, 8px) var(--ph-r-sm, 8px) 0;
  color: var(--ph-ink-2, var(--dsw-alias-label-secondary));
}

/* Beautified document — layout first, boxes only where they carry meaning */
.ph-n-cards { gap: var(--ph-s5, 20px); max-width: 880px; }
.ph-n-sec {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
  box-shadow: none;
}
.ph-n-sec + .ph-n-sec { padding-top: var(--ph-s3, 12px); border-top: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-n-sec--original { background: transparent; padding-left: var(--ph-s3, 12px); border-left: 2px dashed var(--ph-line, var(--dsw-alias-border-l2)); }
.ph-n-sec--incomplete { border-top-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 34%, transparent); }
.ph-n-sec__heading { font-size: var(--ph-fs-12, 12px); letter-spacing: 0.04em; text-transform: uppercase; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); font-weight: var(--ph-fw-semi, 600); }
.ph-n-sec__body { gap: var(--ph-s2, 8px); }

.ph-n-doc { gap: var(--ph-s6, 24px); max-width: 860px; }
.ph-n-doc__sec { gap: var(--ph-s2, 8px); }
.ph-n-doc__sec--accent {
  padding: var(--ph-s3, 12px) var(--ph-s4, 16px);
  border-left: 2.5px solid var(--ph-accent-line, color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent));
  border-radius: 0 var(--ph-r-sm, 8px) var(--ph-r-sm, 8px) 0;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 4%, transparent);
}
.ph-n-doc__sec--figure {
  padding: var(--ph-s3, 12px) var(--ph-s4, 16px) var(--ph-s4, 16px);
  border-radius: var(--ph-r-md, 10px);
  background: var(--ph-surface-1, var(--dsw-alias-bg-layer-1));
  border: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
}
.ph-n-doc__eyebrow { gap: var(--ph-s2, 8px); min-height: 22px; }
.ph-n-doc__heading {
  font-size: 15px;
  font-weight: var(--ph-fw-bold, 650);
  letter-spacing: -0.008em;
  line-height: 1.4;
}
.ph-n-doc__heading--none { font-size: var(--ph-fs-11, 11px); letter-spacing: 0.08em; color: var(--ph-ink-4, var(--dsw-alias-label-caption)); text-transform: uppercase; }
.ph-n-doc__badge {
  height: 19px;
  padding: 0 7px;
  border-radius: var(--ph-r-pill, 999px);
  border: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
  background: var(--ph-surface-2, var(--dsw-alias-bg-layer-2));
  font-size: 10.5px;
}
.ph-n-doc__toggle { height: 19px; border-radius: var(--ph-r-pill, 999px); font-size: 10.5px; padding: 0 8px; }
.ph-n-doc__body { font-size: 13.5px; line-height: 1.82; max-width: 748px; color: var(--ph-ink, var(--dsw-alias-label-primary)); }
.ph-n-doc__body--original { font-size: 13px; color: var(--ph-ink-2, var(--dsw-alias-label-secondary)); }
.ph-n-doc__flow { column-gap: 32px; }
.ph-n-doc__block { margin: 0 0 14px; }
.ph-n-doc__p { margin: 0 0 14px; }
.ph-n-doc__h { margin: 18px 0 8px; font-size: 14px; font-weight: var(--ph-fw-bold, 650); }
.ph-n-doc__quote {
  padding: 8px 14px;
  border-left: 2.5px solid var(--ph-accent-line, color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 4%, transparent);
  font-size: 13px;
}
.ph-n-doc__callout,
.ph-n-card__callout { border-radius: var(--ph-r-sm, 8px); font-size: 12.5px; padding: 9px 12px; }
.ph-n-doc__callout-body { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; }
.ph-n-doc__tablewrap,
.ph-n-card__tablewrap { border-color: var(--ph-line, var(--dsw-alias-border-l2)); border-radius: var(--ph-r-sm, 8px); }
.ph-n-doc__table th,
.ph-n-card__table th { background: var(--ph-surface-2, var(--dsw-alias-bg-layer-2)); font-weight: var(--ph-fw-semi, 600); }
.ph-n-doc__figure-media {
  border-radius: var(--ph-r-sm, 8px);
  border-color: var(--ph-line, var(--dsw-alias-border-l2));
  transition: border-color var(--ph-fast, 140ms) var(--ph-ease, ease), box-shadow var(--ph-base, 200ms) var(--ph-ease, ease);
}
.ph-n-doc__figure-media:hover { border-color: var(--ph-accent-line, var(--dsw-alias-border-l3)); box-shadow: var(--ph-shadow-2, 0 2px 8px rgba(0, 0, 0, 0.08)); }
.ph-n-doc__figure-cap { font-size: var(--ph-fs-11, 11px); line-height: 1.55; }
.ph-n-doc__note { font-size: var(--ph-fs-11, 11px); }

.ph-n-chip {
  gap: 5px;
  padding: 3px 5px 3px 9px;
  border-radius: var(--ph-r-pill, 999px);
  border: 1px solid var(--ph-line, var(--dsw-alias-border-l2));
  background: var(--ph-surface-2, var(--dsw-alias-bg-layer-2));
  font-size: var(--ph-fs-11, 11px);
  color: var(--ph-ink-2, var(--dsw-alias-label-secondary));
}

/* ---- paper panel --------------------------------------------------------- */
.ph-n-paperpane {
  width: 368px;
  border-left: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
  background: var(--ph-bg, var(--dsw-alias-bg-base));
  transition: width var(--ph-panel, 280ms) var(--ph-ease-out, cubic-bezier(0.16, 1, 0.3, 1)), opacity var(--ph-base, 200ms) var(--ph-ease, ease);
}
.ph-n-paperpane__head { padding: var(--ph-s2, 8px) var(--ph-s2, 8px) var(--ph-s2, 8px) var(--ph-s3, 12px); border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); min-height: 42px; }
.ph-n-paperpane__title { font-size: var(--ph-fs-12, 12px); font-weight: var(--ph-fw-bold, 650); }
.ph-n-paperpane__scroll { padding: var(--ph-s3, 12px) var(--ph-s3, 12px) var(--ph-s6, 24px); }
.ph-n-paperrow { padding: 8px; border-radius: var(--ph-r-sm, 8px); transition: background-color var(--ph-fast, 140ms) var(--ph-ease, ease), border-color var(--ph-fast, 140ms) var(--ph-ease, ease); }
.ph-n-paperrow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ph-n-paperrow--active { border-color: var(--ph-accent-line, var(--dsw-alias-border-l3)); background: var(--ph-accent-soft, transparent); }
.ph-n-paperrow__thumb { width: 34px; height: 44px; border-radius: 3px; border-color: var(--ph-line-soft, var(--dsw-alias-border-l2)); }
.ph-n-paperrow__title { font-size: var(--ph-fs-12, 12px); }
.ph-n-paperrow__meta { font-size: var(--ph-fs-11, 11px); }
.ph-n-paperview__title { font-size: var(--ph-fs-13, 13px); font-weight: var(--ph-fw-bold, 650); line-height: 1.45; }
.ph-n-paperview__meta { font-size: var(--ph-fs-11, 11px); }
.ph-n-paperview__imagewrap { border-radius: var(--ph-r-sm, 8px); border-color: var(--ph-line, var(--dsw-alias-border-l2)); box-shadow: var(--ph-shadow-1, none); }
.ph-n-paperview__section-title { font-size: var(--ph-fs-11, 11px); letter-spacing: 0.05em; text-transform: uppercase; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); font-weight: var(--ph-fw-semi, 600); }
.ph-n-paperview__trans { font-size: var(--ph-fs-12, 12px); line-height: 1.68; gap: var(--ph-s2, 8px); }
.ph-n-paperview__annot { padding: 7px 9px; border-radius: var(--ph-r-sm, 8px); background: var(--ph-surface-2, var(--dsw-alias-bg-layer-2)); border-color: var(--ph-line-soft, var(--dsw-alias-border-l1)); font-size: var(--ph-fs-11, 11px); line-height: 1.55; }
.ph-n-paperview__actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* ---- status strip -------------------------------------------------------- */
.ph-n-statusbar {
  gap: var(--ph-s2, 8px);
  padding: 5px var(--ph-s4, 16px);
  border-top: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
  background: var(--ph-bg, var(--dsw-alias-bg-base));
  font-size: var(--ph-fs-11, 11px);
  min-height: 28px;
}

/* ---- dialogs, menus, overlays ------------------------------------------- */
.ph-n-modal-backdrop { background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.32)); backdrop-filter: blur(3px); }
.ph-n-modal {
  border-radius: var(--ph-r-lg, 14px);
  border: 1px solid var(--ph-line, var(--dsw-alias-border-l2));
  box-shadow: var(--dsw-elevation-prominent, 0 18px 44px -20px rgba(0, 0, 0, 0.4));
  background: var(--ph-bg, var(--dsw-alias-bg-base));
  animation: ph-n-pop var(--ph-base, 200ms) var(--ph-ease-out, ease);
}
.ph-n-modal__head { padding: var(--ph-s4, 16px) var(--ph-s5, 20px) var(--ph-s3, 12px); border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-n-modal__title { font-size: var(--ph-fs-15, 15px); font-weight: var(--ph-fw-bold, 650); letter-spacing: -0.006em; }
.ph-n-modal__desc { font-size: var(--ph-fs-12, 12px); line-height: 1.6; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }
.ph-n-modal__body { padding: var(--ph-s3, 12px) var(--ph-s5, 20px); gap: var(--ph-s3, 12px); }
.ph-n-modal__foot { padding: var(--ph-s3, 12px) var(--ph-s5, 20px) var(--ph-s4, 16px); border-top: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-n-field__label { font-size: var(--ph-fs-12, 12px); font-weight: var(--ph-fw-semi, 600); }
.ph-n-field__hint { font-size: var(--ph-fs-11, 11px); line-height: 1.55; }
.ph-n-choice { border-radius: var(--ph-r-md, 10px); padding: 10px 11px; transition: border-color var(--ph-fast, 140ms) var(--ph-ease, ease), background-color var(--ph-fast, 140ms) var(--ph-ease, ease); }
.ph-n-choice__title { font-size: var(--ph-fs-13, 13px); }
.ph-n-choice__desc { font-size: var(--ph-fs-11, 11px); line-height: 1.5; }
.ph-n-summary { border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); padding: 9px 11px; background: var(--ph-surface-2, var(--dsw-alias-bg-layer-2)); border-color: var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-n-error { border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); }
.ph-n-revrow { border-radius: var(--ph-r-sm, 8px); padding: 9px 11px; }
.ph-n-menu {
  border-radius: var(--ph-r-md, 10px);
  border: 1px solid var(--ph-line, var(--dsw-alias-border-l2));
  background: var(--ph-surface-2, var(--dsw-alias-bg-base));
  box-shadow: var(--dsw-elevation-prominent, var(--ph-shadow-3, 0 12px 34px -16px rgba(0, 0, 0, 0.4)));
  padding: 5px;
}
.ph-n-menu__item { border-radius: var(--ph-r-xs, 6px); padding: 7px 9px; font-size: var(--ph-fs-12, 12px); }
.ph-n-menu__item:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* autofix — keep the behaviour, calm the surface */
.ph-n-autofix__toggle { height: 26px; padding: 0 10px; border-radius: var(--ph-r-pill, 999px); font-size: var(--ph-fs-11, 11px); transition: all var(--ph-fast, 140ms) var(--ph-ease, ease); }
.ph-n-autofix__select { height: 26px; border-radius: var(--ph-r-xs, 6px); font-size: var(--ph-fs-11, 11px); }
.ph-n-autofix__overlay {
  border-radius: var(--ph-r-md, 10px);
  border: 1px solid var(--ph-line, var(--dsw-alias-border-l2));
  background: var(--ph-surface-2, var(--dsw-alias-bg-base));
  box-shadow: var(--dsw-elevation-prominent, var(--ph-shadow-3, 0 16px 40px -22px rgba(0, 0, 0, 0.4)));
  animation: ph-n-pop var(--ph-base, 200ms) var(--ph-ease-out, ease);
}
.ph-n-autofix__option { border-radius: var(--ph-r-sm, 8px); padding: 8px 9px; border-color: var(--ph-line-soft, var(--dsw-alias-border-l1)); transition: all var(--ph-fast, 140ms) var(--ph-ease, ease); }
.ph-n-autofix__option--recommended { border-color: var(--ph-accent-line, var(--dsw-alias-border-l3)); background: var(--ph-accent-soft, transparent); }

/* reader-side note editor shares the same rhythm */
.ph-n-readernotes__head { padding: 7px var(--ph-s2, 8px) 7px var(--ph-s3, 12px); }
.ph-n-readernotes__title { font-size: var(--ph-fs-11, 11px); letter-spacing: 0.04em; text-transform: uppercase; }
.ph-n-readernotes__row { padding: 6px 8px; border-radius: var(--ph-r-xs, 6px); }
.ph-n-readernotes__rowtitle { font-size: var(--ph-fs-12, 12px); }
.ph-n-readernotes__rowmeta { font-size: var(--ph-fs-11, 11px); }
.ph-n-skeletonrow { border-radius: var(--ph-r-sm, 8px); }

/* ---- responsive ---------------------------------------------------------- */
@media (max-width: 1320px) {
  .ph-n-paperpane { width: 336px; }
  .ph-n-listpane { width: 288px; }
  .ph-n-folders { width: 220px; }
}
@media (max-width: 1120px) {
  .ph-n-paperpane { width: 304px; }
  .ph-n-editor__textarea,
  .ph-n-editor__cards { padding-left: var(--ph-s4, 16px); padding-right: var(--ph-s4, 16px); }
}
@media (max-width: 900px) {
  .ph-n-folders { position: absolute; z-index: 30; height: 100%; width: 240px; background: var(--ph-surface-1, var(--dsw-alias-bg-base)); box-shadow: var(--ph-shadow-3, 0 0 24px rgba(0, 0, 0, 0.18)); }
  .ph-n-paperpane { position: absolute; right: 0; z-index: 30; height: 100%; width: min(340px, 88vw); background: var(--ph-bg, var(--dsw-alias-bg-base)); box-shadow: var(--ph-shadow-3, 0 -0 24px rgba(0, 0, 0, 0.18)); }
  .ph-n-topbar { padding: var(--ph-s2, 8px) var(--ph-s3, 12px); }
  .ph-n-brand__sub { display: none; }
}
@media (max-width: 640px) {
  .ph-n-listpane { position: absolute; z-index: 20; height: 100%; width: min(320px, 88vw); background: var(--ph-bg, var(--dsw-alias-bg-base)); box-shadow: var(--ph-shadow-3, 0 0 24px rgba(0, 0, 0, 0.18)); }
  .ph-n-editor__head { padding: var(--ph-s3, 12px) var(--ph-s3, 12px) var(--ph-s1, 4px); }
}

@media (prefers-reduced-motion: reduce) {
  .ph-n-folders,
  .ph-n-listpane,
  .ph-n-paperpane,
  .ph-n-choice,
  .ph-n-modal,
  .ph-n-menu,
  .ph-n-autofix__overlay,
  .ph-n-tree__row { transition: none !important; animation: none !important; }
}
@media (max-width: 760px) {
  .ph-n-topbar > .ph-btn .ph-btn__label { display: none; }
  .ph-n-topbar > .ph-btn { width: 30px; padding: 0; gap: 0; }
  .ph-n-topbar__search { max-width: none; }
  .ph-n-topbar { gap: 6px; }
}
/* state overrides must follow the width declarations above */
.ph-n-folders--closed { width: 0 !important; opacity: 0; border-right-color: transparent; }
.ph-n-paperpane--closed { width: 0 !important; opacity: 0; border-left-color: transparent; }
.ph-n-folders--closed .ph-n-folders__scroll,
.ph-n-paperpane--closed .ph-n-paperpane__body { visibility: hidden; }
/* incomplete sections keep a quiet warning edge without a full card */
.ph-n-sec--incomplete {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent);
  padding-left: var(--ph-s3, 12px);
}
/* centre the reading column inside wide editor panes */
.ph-n-cards,
.ph-n-doc,
.ph-n-md { margin-inline: auto; }
/* ---- v0.22 colour pass: blue chrome, purple AI -------------------------- */
.ph-n-brand__mark {
  color: #ffffff;
  background: var(--ph-mark, #2b95e8);
  padding: 5px;
  border-radius: 9px;
  box-sizing: content-box;
  box-shadow: 0 3px 12px -4px color-mix(in srgb, var(--ph-mark, #2b95e8) 45%, transparent);
}
/* the gradient hairline from the previous pass is gone — calm flat chrome */
.ph-n-topbar::after { display: none; }
.ph-n-topbar { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 3%, var(--ph-bg, var(--dsw-alias-bg-base))); }
.ph-n-editor__toolbar { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 4%, var(--ph-bg, var(--dsw-alias-bg-base))); }
.ph-n-listpane__head { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 4%, var(--ph-bg, var(--dsw-alias-bg-base))); }
.ph-n-paperpane__head { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 3%, var(--ph-bg, var(--dsw-alias-bg-base))); }

.ph-n-listrow--active,
.ph-n-tree__row--active,
.ph-n-tree__row--active:hover {
  background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 11%, transparent);
  color: var(--ph-accent-text, #0b6fc4);
}
.ph-n-paperrow--active {
  border-color: var(--ph-accent-line, rgba(62, 166, 255, 0.4));
  background: var(--ph-accent-soft, rgba(62, 166, 255, 0.14));
}
.ph-n-doc__ul li::marker,
.ph-n-card__ul li::marker { color: var(--ph-accent, #3ea6ff); }

/* AI authorship keeps the light purple secondary accent */
.ph-n-doc__badge--ai {
  color: var(--ph-soft-text, #655ba1);
  border-color: var(--ph-soft-line, rgba(155, 135, 245, 0.4));
  background: var(--ph-soft-bg, rgba(155, 135, 245, 0.16));
}
.ph-n-autofix__toggle--on {
  color: var(--ph-soft-text, #655ba1);
  border-color: var(--ph-soft-line, rgba(155, 135, 245, 0.4));
  background: var(--ph-soft-bg, rgba(155, 135, 245, 0.16));
}

/* hover feedback follows the blue accent */
.ph-n-listrow:not(.ph-n-listrow--active):hover { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 5%, transparent); }
.ph-n-paperrow:hover { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 6%, transparent); }
.ph-n-tree__row:not(.ph-n-tree__row--active):hover { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 7%, transparent); }

/* keep the active row visible while hovered */
.ph-n-listrow--active:hover { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 14%, transparent); border-color: var(--ph-accent-line, rgba(62, 166, 255, 0.4)); }
.ph-n-paperrow--active:hover { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 14%, transparent); }

/* ---- v0.20 research desk: notes workspace ------------------------------- */
/* Reading and writing get a book face; chrome stays SF Pro. The editor is a
   centred page, the list is a quiet index, and blue is the only accent. */
.ph-n-app {
  --ph-accent: #0071e3;
  --ph-accent-text: color-mix(in srgb, #0071e3 58%, var(--dsw-alias-label-primary, #1d1d1f));
  --ph-accent-soft: color-mix(in srgb, #0071e3 10%, transparent);
  --ph-accent-soft-2: color-mix(in srgb, #0071e3 16%, transparent);
  --ph-accent-line: color-mix(in srgb, #0071e3 28%, transparent);
  font-family: var(--ph-font-ui);
  font-size: 13px;
  background: var(--ph-bg, var(--dsw-alias-bg-base));
}
.ph-n-topbar {
  min-height: 56px;
  padding: 0 18px;
  gap: 12px;
  border-bottom: 1px solid var(--ph-hairline, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--ph-bg, var(--dsw-alias-bg-base)) 88%, transparent);
  -webkit-backdrop-filter: saturate(170%) blur(18px);
  backdrop-filter: saturate(170%) blur(18px);
}
.ph-n-brand { gap: 10px; }
.ph-n-brand__mark {
  width: 30px;
  height: 30px;
  padding: 6px;
  color: #ffffff;
  background: var(--ph-mark, #0071e3);
  border-radius: 9px;
  box-sizing: border-box;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.ph-n-brand__title { font-family: var(--ph-font-display, inherit); font-size: 15px; font-weight: 600; letter-spacing: -0.012em; }
.ph-n-brand__sub { font-size: 11px; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); letter-spacing: 0.004em; }
.ph-n-topbar__search { max-width: 420px; }
.ph-n-topbar__actions { gap: 4px; }

.ph-n-folders {
  width: 220px;
  border-right: 1px solid var(--ph-hairline, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--ph-surface-1, var(--dsw-alias-bg-layer-1)) 34%, var(--ph-bg, var(--dsw-alias-bg-base)));
  transition: width var(--ph-panel, 320ms) var(--ph-ease-out, ease);
}
.ph-n-folders__head {
  padding: 14px 10px 6px 14px;
  color: var(--ph-ink-4, var(--dsw-alias-label-caption));
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.ph-n-folders__head .ph-icon { color: var(--ph-ink-4, var(--dsw-alias-label-caption)); }
.ph-n-tree__row {
  min-height: 30px;
  padding: 0 8px;
  border-radius: 7px;
  border: 0;
  font-size: 12.5px;
  color: var(--ph-ink-2, var(--dsw-alias-label-secondary));
}
.ph-n-tree__row:hover { background: var(--ph-hover, color-mix(in srgb, currentColor 6%, transparent)); }
.ph-n-tree__row--active,
.ph-n-tree__row--active:hover {
  background: var(--ph-accent-soft, color-mix(in srgb, #0071e3 10%, transparent));
  color: var(--ph-ink, var(--dsw-alias-label-primary));
  font-weight: 500;
}
.ph-n-tree__row--active .ph-n-tree__icon { color: var(--ph-accent-text, #0071e3); }
.ph-n-tree__count { font-size: 10.5px; color: var(--ph-ink-4, var(--dsw-alias-label-caption)); }

.ph-n-listpane {
  width: 304px;
  border-right: 1px solid var(--ph-hairline, var(--dsw-alias-border-l1));
  background: var(--ph-bg, var(--dsw-alias-bg-base));
}
.ph-n-listpane__head {
  min-height: 46px;
  padding: 10px 12px 8px 16px;
  border-bottom: 1px solid var(--ph-hairline, var(--dsw-alias-border-l1));
  background: transparent;
}
.ph-n-listpane__title { font-size: 12.5px; font-weight: 600; letter-spacing: 0.004em; }
.ph-n-listpane__count { font-size: 10.5px; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }
.ph-n-list { padding: 8px; gap: 2px; }
.ph-n-listrow {
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  position: relative;
}
.ph-n-listrow:not(.ph-n-listrow--active):hover {
  background: var(--ph-hover, color-mix(in srgb, currentColor 6%, transparent));
}
.ph-n-listrow--active {
  background: var(--ph-accent-soft, color-mix(in srgb, #0071e3 10%, transparent));
  border-color: transparent;
  color: var(--ph-ink, var(--dsw-alias-label-primary));
}
.ph-n-listrow--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--ph-accent, #0071e3);
}
.ph-n-listrow--active:hover { background: var(--ph-accent-soft-2, color-mix(in srgb, #0071e3 16%, transparent)); }
.ph-n-listrow__title { font-size: 13px; font-weight: 600; letter-spacing: -0.004em; }
.ph-n-listrow__preview { font-size: 12px; line-height: 1.5; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }
.ph-n-listrow__time,
.ph-n-listrow__meta { font-size: 10.5px; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }

.ph-n-main { background: var(--ph-bg, var(--dsw-alias-bg-base)); }
.ph-n-editor__head {
  padding: 16px 28px 10px;
  gap: 6px;
  border-bottom: 1px solid var(--ph-hairline, var(--dsw-alias-border-l1));
  background: var(--ph-bg, var(--dsw-alias-bg-base));
}
.ph-n-editor__titlerow { gap: 10px; }
.ph-n-editor__title {
  font-family: var(--ph-font-read, Georgia, serif);
  font-size: clamp(20px, 1.7vw, 26px);
  font-weight: 600;
  letter-spacing: -0.018em;
  line-height: 1.25;
  padding: 3px 2px;
  border-radius: 5px;
  color: var(--ph-ink, var(--dsw-alias-label-primary));
}
.ph-n-editor__title:hover { background: var(--ph-hover, color-mix(in srgb, currentColor 6%, transparent)); }
.ph-n-editor__title:focus { border-color: var(--ph-accent-line, #0071e3); background: var(--ph-bg, transparent); }
.ph-n-editor__meta { font-size: 11.5px; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); padding: 0 4px; }
.ph-n-editor__toolbar {
  padding: 6px 24px;
  border-bottom: 1px solid var(--ph-hairline, var(--dsw-alias-border-l1));
  background: var(--ph-bg, var(--dsw-alias-bg-base));
}
.ph-n-sections { background: color-mix(in srgb, var(--ph-surface-2, var(--dsw-alias-bg-layer-2)) 45%, transparent); }
.ph-n-editor__content { background: var(--ph-bg, var(--dsw-alias-bg-base)); }
.ph-n-editor__textarea {
  width: min(760px, 100%);
  margin-inline: auto;
  padding: 30px 10px 96px;
  font-family: var(--ph-font-read, Georgia, serif);
  font-size: 15.5px;
  line-height: 1.85;
  letter-spacing: 0.002em;
  color: var(--ph-ink, var(--dsw-alias-label-primary));
  caret-color: var(--ph-accent, #0071e3);
}
.ph-n-editor--compact .ph-n-editor__textarea {
  width: 100%;
  padding: 14px 16px 40px;
  font-size: 14px;
  line-height: 1.75;
}
.ph-n-editor--compact .ph-n-editor__title { font-family: var(--ph-font-ui); font-size: 15px; letter-spacing: -0.006em; }
.ph-n-editor__cards { width: min(860px, 100%); margin-inline: auto; padding: 24px 20px 64px; gap: 14px; }
.ph-n-md,
.ph-n-doc__body {
  max-width: 720px;
  font-family: var(--ph-font-read, Georgia, serif);
  font-size: 15px;
  line-height: 1.82;
  letter-spacing: 0.002em;
}
.ph-n-md .ph-ai-md__h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.012em; }
.ph-n-md .ph-ai-md__h2 { font-size: 19px; font-weight: 600; letter-spacing: -0.008em; }
.ph-n-md .ph-ai-md__h3 { font-size: 16px; font-weight: 600; }
.ph-n-md .ph-ai-md__quote {
  border-left-color: var(--ph-accent-line, #0071e3);
  background: var(--ph-accent-soft, transparent);
  border-radius: 0 8px 8px 0;
  color: var(--ph-ink-2, var(--dsw-alias-label-secondary));
}
.ph-n-sec {
  border-color: var(--ph-line-soft, var(--dsw-alias-border-l1));
  border-radius: 12px;
  background: var(--ph-surface-1, var(--dsw-alias-bg-layer-1));
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.02);
  padding: 14px 16px 16px;
}
.ph-n-sec--original { background: color-mix(in srgb, var(--ph-surface-1, var(--dsw-alias-bg-layer-1)) 55%, var(--ph-bg, transparent)); }
.ph-n-sec__heading { font-size: 12px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--ph-ink-4, var(--dsw-alias-label-caption)); }
.ph-n-card__h { font-family: var(--ph-font-read, Georgia, serif); font-size: 17px; font-weight: 600; }
.ph-n-card__ul li::marker { color: var(--ph-accent, #0071e3); }

.ph-n-paperpane {
  width: 320px;
  border-left: 1px solid var(--ph-hairline, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--ph-surface-1, var(--dsw-alias-bg-layer-1)) 34%, var(--ph-bg, var(--dsw-alias-bg-base)));
}
.ph-n-paperpane__head {
  min-height: 46px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--ph-hairline, var(--dsw-alias-border-l1));
  background: transparent;
}
.ph-n-paperpane__title { font-size: 12.5px; font-weight: 600; letter-spacing: 0.004em; }
.ph-n-paperpane__scroll { padding: 12px 12px 24px; }
.ph-n-paperrow { border-radius: 10px; border-color: transparent; }
.ph-n-paperrow:hover { background: var(--ph-hover, transparent); }
.ph-n-paperrow--active { border-color: transparent; background: var(--ph-accent-soft, transparent); }
.ph-n-statusbar {
  min-height: 28px;
  padding: 4px 14px;
  border-top: 1px solid var(--ph-hairline, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--ph-surface-2, var(--dsw-alias-bg-layer-2)) 40%, var(--ph-bg, var(--dsw-alias-bg-base)));
  font-size: 10.5px;
}

/* the editor page settles in instead of snapping */
.ph-n-editor__content { animation: ph-n-page-in 240ms var(--ph-ease, ease) both; }
@keyframes ph-n-page-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.ph-n-listrow { transition: background-color var(--ph-base, 220ms) var(--ph-ease, ease), border-color var(--ph-fast, 150ms) var(--ph-ease, ease); }
.ph-n-listrow:active { transform: scale(0.995); }
.ph-n-savestate__dot { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 12%, transparent); }
.ph-n-savestate--saving { color: var(--ph-accent-text, #0071e3); }
.ph-n-savestate--saving .ph-n-savestate__dot { animation: ph-n-saving 1.4s var(--ph-ease, ease) infinite; }
@keyframes ph-n-saving {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 10%, transparent); }
  50% { opacity: 0.55; box-shadow: 0 0 0 5px color-mix(in srgb, currentColor 6%, transparent); }
}

@media (max-width: 1320px) {
  .ph-n-paperpane { width: 300px; }
  .ph-n-listpane { width: 288px; }
}
@media (max-width: 1120px) {
  .ph-n-folders { width: 200px; }
  .ph-n-paperpane { width: 288px; }
}
@media (max-width: 1120px) {
  /* the paper panel leaves the flow before it can squeeze the writing column */
  .ph-n-paperpane {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 30;
    height: 100%;
    width: min(320px, 86vw);
    background: var(--ph-bg, var(--dsw-alias-bg-base));
    box-shadow: var(--ph-shadow-3, 0 0 28px rgba(0, 0, 0, 0.18));
  }
}
@media (max-width: 1000px) {
  .ph-n-folders {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 31;
    height: 100%;
    width: 240px;
    background: var(--ph-surface-1, var(--dsw-alias-bg-layer-1));
    box-shadow: var(--ph-shadow-3, 0 0 28px rgba(0, 0, 0, 0.18));
  }
}
@media (max-width: 900px) {
  .ph-n-folders { width: 240px; }
  .ph-n-paperpane { width: min(340px, 88vw); }
}
@media (max-width: 760px) {
  .ph-n-editor__head { padding: 12px 16px 8px; }
  .ph-n-editor__title { font-size: 22px; }
  .ph-n-editor__textarea { padding: 22px 16px 72px; font-size: 15px; }
  .ph-n-editor__toolbar { padding: 5px 14px; }
  .ph-n-listpane { width: 100%; }
}
/* the inline note pane in the library is narrower than the full workspace */
.ph-n-inline .ph-n-editor__head { padding: 12px 18px 8px; }
.ph-n-inline .ph-n-editor__title { font-size: 20px; letter-spacing: -0.014em; }
.ph-n-inline .ph-n-editor__toolbar { padding: 5px 14px; }
.ph-n-inline .ph-n-editor__textarea { width: 100%; padding: 22px 18px 56px; font-size: 14.5px; line-height: 1.8; }

@media (prefers-reduced-motion: reduce) {
  .ph-n-editor__content { animation: none; }
}
`

let users = 0
let element = null

/** Inject the stylesheet once per document; returns a ref-counted release. */
export function ensureNotesStyles() {
  if (typeof document === 'undefined') return () => {}
  if (!element || !element.isConnected) {
    element = document.getElementById(STYLE_ID)
    if (!element) {
      element = document.createElement('style')
      element.id = STYLE_ID
      element.setAttribute('data-plugin-css', 'dsh-pappers-hall/notes.css')
      element.textContent = NOTES_CSS
      document.head.appendChild(element)
    }
  }
  users += 1
  let released = false
  return () => {
    if (released) return
    released = true
    users = Math.max(0, users - 1)
    if (users === 0 && element && element.isConnected) {
      element.remove()
      element = null
    }
  }
}
