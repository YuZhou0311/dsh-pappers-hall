/**
 * Reader stylesheet.
 *
 * Injected once per document by `ensureReaderStyles()`; every class is prefixed
 * `ph-r-` so it can never collide with the host UI or the library surface. Theme
 * colours come exclusively from `--dsw-alias-*` tokens (plus `color-mix()` for
 * layering); the only hard-coded colours are the five document highlight pens,
 * which are content semantics rather than chrome. All motion is CSS-only and
 * disabled under `prefers-reduced-motion: reduce`.
 */

/** `<style>` element id; one per document. */
const STYLE_ID = 'ph-reader-styles'

export const READER_CSS = `
/* ========================================================================== *
 * Root layout
 * ========================================================================== */
.ph-r-reader {
  --ph-r-rail: 118px;
  --ph-r-side: 372px;
  --ph-r-radius: 10px;
  --ph-r-pen-yellow: #f2c200;
  --ph-r-pen-green: #3faf58;
  --ph-r-pen-blue: #3d7bfd;
  --ph-r-pen-red: #e04b4b;
  --ph-r-pen-purple: #9b59b6;
  display: flex;
  flex-direction: column;
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  height: 100%;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
}
.ph-r-reader *,
.ph-r-reader *::before,
.ph-r-reader *::after { box-sizing: border-box; }
.ph-r-reader button { font-family: inherit; }

/* ========================================================================== *
 * Toolbar
 * ========================================================================== */
.ph-r-toolbar {
  position: relative;
  z-index: 60;
  flex: none;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  transition: background-color 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
}
.ph-r-reader--scrolled .ph-r-toolbar {
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 74%, transparent);
  -webkit-backdrop-filter: saturate(150%) blur(16px);
  backdrop-filter: saturate(150%) blur(16px);
  box-shadow: 0 10px 26px -22px color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent);
}
.ph-r-toolbar__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}
.ph-r-toolbar__row--main {
  height: 54px;
  transition: height 200ms ease;
}
.ph-r-reader--scrolled .ph-r-toolbar__row--main { height: 42px; }
.ph-r-toolbar__row--tools {
  height: 42px;
  gap: 6px;
  border-top: 1px solid transparent;
  transition: height 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease, border-color 160ms ease;
  overflow: hidden;
}
.ph-r-reader--scrolled .ph-r-toolbar__row--tools {
  height: 0;
  opacity: 0;
  border-color: transparent;
  pointer-events: none;
}
/* An open search must stay reachable even when the toolbar collapsed. */
.ph-r-reader--searching .ph-r-toolbar__row--tools,
.ph-r-reader--searching.ph-r-reader--scrolled .ph-r-toolbar__row--tools {
  height: 42px;
  opacity: 1;
  pointer-events: auto;
  border-color: var(--dsw-alias-border-l2);
}
.ph-r-toolbar__back { flex: none; }
.ph-r-toolbar__titles {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  padding: 0 4px;
}
.ph-r-toolbar__titleline {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.ph-r-toolbar__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary);
  transition: font-size 200ms ease;
}
.ph-r-reader--scrolled .ph-r-toolbar__title { font-size: 13px; }
.ph-r-toolbar__badge {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.ph-r-toolbar__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-height: 18px;
  opacity: 1;
  transition: max-height 180ms ease, opacity 140ms ease;
}
.ph-r-reader--scrolled .ph-r-toolbar__meta { max-height: 0; opacity: 0; }
.ph-r-toolbar__meta-sep { opacity: 0.5; }
.ph-r-toolbar__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ph-r-toolbar__spacer { flex: 1 1 auto; }

.ph-r-pager {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.ph-r-pager__input {
  width: 42px;
  height: 26px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  text-align: center;
  outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.ph-r-pager__input:focus {
  border-color: var(--ph-accent-text, #7d2ae8);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);
}
.ph-r-pager__total {
  padding: 0 6px 0 2px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}

.ph-r-zoom {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.ph-r-zoom__value {
  min-width: 52px;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  text-align: center;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  border: none;
  background: transparent;
  transition: background-color 140ms ease, color 140ms ease;
}
.ph-r-zoom__value:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

.ph-r-segment {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  gap: 2px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.ph-r-segment__item {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11.5px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}
.ph-r-segment__item:hover { color: var(--dsw-alias-label-primary); }
.ph-r-segment__item--active {
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 3px -1px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
  font-weight: 600;
}
.ph-r-segment__item:disabled { opacity: 0.45; cursor: default; }

.ph-r-toolbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11.5px;
  height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
}
.ph-r-toolbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ph-r-toolbtn--active {
  color: var(--ph-accent-text, #7d2ae8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 13%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent);
}
.ph-r-toolbtn--icon { padding: 0; width: 28px; justify-content: center; }

/* ========================================================================== *
 * Base controls
 * ========================================================================== */
.ph-r-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  font: inherit;
  font-size: 12.5px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 120ms ease;
}
.ph-r-btn:active:not(:disabled) { transform: scale(0.97); }
.ph-r-btn:disabled { opacity: 0.45; cursor: default; }
.ph-r-btn--md { height: 32px; padding: 0 12px; }
.ph-r-btn--sm { height: 26px; padding: 0 9px; font-size: 11.5px; }
.ph-r-btn--icon.ph-r-btn--md { width: 32px; padding: 0; }
.ph-r-btn--icon.ph-r-btn--sm { width: 26px; padding: 0; }
.ph-r-btn--ghost { background: transparent; color: var(--dsw-alias-label-secondary); }
.ph-r-btn--ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ph-r-btn--soft {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}
.ph-r-btn--soft:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l3); }
.ph-r-btn--solid {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  border-color: transparent;
}
.ph-r-btn--solid:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-state-business-primary)); }
.ph-r-btn--active { color: var(--ph-accent-text, #7d2ae8); }
.ph-r-btn__label { display: inline-block; }

.ph-r-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  appearance: none;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.ph-r-iconbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ph-r-iconbtn:disabled { opacity: 0.4; cursor: default; }
.ph-r-iconbtn--active { color: var(--ph-accent-text, #7d2ae8); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }

.ph-r-spinner {
  display: inline-block;
  border-radius: 50%;
  border: 1.6px solid color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
  animation: ph-r-spin 720ms linear infinite;
  vertical-align: -2px;
}
@keyframes ph-r-spin { to { transform: rotate(360deg); } }

.ph-r-skeleton {
  display: block;
  width: 100%;
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(
    100deg,
    color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent) 20%,
    color-mix(in srgb, var(--dsw-alias-label-primary) 13%, transparent) 38%,
    color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent) 56%
  );
  background-size: 220% 100%;
  animation: ph-r-shimmer 1.5s ease-in-out infinite;
}
@keyframes ph-r-shimmer {
  0% { background-position: 120% 0; }
  100% { background-position: -120% 0; }
}

.ph-r-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 10.5px;
  line-height: 1;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  white-space: nowrap;
}
.ph-r-badge--business { color: var(--ph-accent-text, #7d2ae8); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.ph-r-badge--success { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.ph-r-badge--warn { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); }
.ph-r-badge--error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }

.ph-r-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 28px 18px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
}
.ph-r-empty__icon { color: var(--dsw-alias-label-tertiary); margin-bottom: 2px; }
.ph-r-empty__title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ph-r-empty__desc { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); max-width: 300px; }
.ph-r-empty__action { margin-top: 6px; display: flex; gap: 8px; }
.ph-r-empty--error .ph-r-empty__icon { color: var(--dsw-alias-state-error-primary); }

.ph-r-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex: none;
}
.ph-r-tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  height: 38px;
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  position: relative;
  transition: color 140ms ease;
  white-space: nowrap;
}
.ph-r-tab:hover { color: var(--dsw-alias-label-primary); }
.ph-r-tab--active { color: var(--dsw-alias-label-primary); font-weight: 600; }
.ph-r-tab--active::after {
  content: '';
  position: absolute;
  left: 7px;
  right: 7px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--dsw-alias-state-business-primary);
  animation: ph-r-tab-in 180ms ease;
}
@keyframes ph-r-tab-in { from { transform: scaleX(0.4); opacity: 0; } to { transform: scaleX(1); opacity: 1; } }
.ph-r-tab__count {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
.ph-r-tab--active .ph-r-tab__count { color: var(--ph-accent-text, #7d2ae8); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }

.ph-r-chipwrap { display: inline-flex; align-items: center; max-width: 100%; }
.ph-r-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  max-width: 100%;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
}
.ph-r-chip__label { overflow: hidden; text-overflow: ellipsis; }
button.ph-r-chip { cursor: pointer; }
button.ph-r-chip:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.ph-r-chip--active {
  color: var(--ph-accent-text, #7d2ae8);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
}
.ph-r-chip__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 2px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.ph-r-chip__remove:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

/* ========================================================================== *
 * Body: rail / canvas / side
 * ========================================================================== */
.ph-r-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  position: relative;
}
.ph-r-scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
  overscroll-behavior: contain;
}
.ph-r-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.ph-r-scroll::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2);
  border: 3px solid transparent;
  background-clip: content-box;
  border-radius: 8px;
}
.ph-r-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2); background-clip: content-box; }
.ph-r-scroll::-webkit-scrollbar-track { background: transparent; }

/* ---- thumbnails rail ----------------------------------------------------- */
.ph-r-rail {
  flex: none;
  width: var(--ph-r-rail);
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  border-right: 1px solid var(--dsw-alias-border-l2);
  padding: 8px 0 24px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, var(--dsw-alias-bg-base));
  position: relative;
}
.ph-r-rail__inner { position: relative; }
.ph-r-rail__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 100%;
  padding: 5px 0 7px;
  appearance: none;
  border: none;
  background: transparent;
  cursor: pointer;
}
.ph-r-rail__thumb {
  width: calc(var(--ph-r-rail) - 30px);
  display: block;
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  background: #fff;
  box-shadow: 0 1px 3px -1px color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);
  transition: border-color 140ms ease, box-shadow 160ms ease, transform 160ms ease;
  position: relative;
}
.ph-r-rail__thumb img { display: block; width: 100%; height: auto; }
.ph-r-rail__item:hover .ph-r-rail__thumb { transform: translateY(-1px); box-shadow: 0 4px 10px -4px color-mix(in srgb, var(--dsw-alias-label-primary) 34%, transparent); }
.ph-r-rail__item--active .ph-r-rail__thumb {
  border-color: var(--ph-accent-text, #7d2ae8);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 26%, transparent);
}
.ph-r-rail__num {
  font-size: 10.5px;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  padding: 2px 6px;
  border-radius: 6px;
  transition: color 140ms ease, background-color 140ms ease;
}
.ph-r-rail__item--active .ph-r-rail__num {
  color: var(--ph-accent-text, #7d2ae8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  font-weight: 600;
}
.ph-r-rail__indicator {
  position: absolute;
  left: 0;
  top: 0;
  width: 3px;
  height: 30px;
  border-radius: 0 3px 3px 0;
  background: var(--dsw-alias-state-business-primary);
  transform: translateY(0);
  transition: transform 260ms cubic-bezier(0.3, 0.8, 0.3, 1);
  will-change: transform;
  pointer-events: none;
}
.ph-r-rail__skeleton {
  width: calc(var(--ph-r-rail) - 30px);
  aspect-ratio: 0.752;
  border-radius: 3px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  animation: ph-r-pulse 1.4s ease-in-out infinite;
}
@keyframes ph-r-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

/* ---- page canvas --------------------------------------------------------- */
.ph-r-canvas {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: auto;
  position: relative;
  background:
    radial-gradient(120% 60% at 50% 0%, color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent), transparent 70%),
    var(--dsw-alias-bg-layer-1);
  scroll-behavior: auto;
}
.ph-r-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 18px 24px 48px;
  gap: 16px;
  min-width: min-content;
}
.ph-r-page {
  position: relative;
  flex: none;
  background: #fff;
  border-radius: 2px;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent),
    0 10px 30px -18px color-mix(in srgb, var(--dsw-alias-label-primary) 42%, transparent);
  transition: box-shadow 200ms ease;
}
.ph-r-page--active { box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent),
    0 14px 38px -16px color-mix(in srgb, var(--dsw-alias-label-primary) 46%, transparent); }
.ph-r-page__placeholder {
  width: 100%;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, #fff);
  border-radius: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}
.ph-r-page__img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 2px;
  user-select: none;
  -webkit-user-drag: none;
  opacity: 0;
  transition: opacity 180ms ease;
}
.ph-r-page__img--loaded { opacity: 1; }
.ph-r-page--active .ph-r-page__img--loaded { animation: ph-r-page-fade 220ms ease; }
@keyframes ph-r-page-fade { from { opacity: 0.72; } to { opacity: 1; } }
.ph-r-page__skeleton {
  position: absolute;
  inset: 0;
  border-radius: 2px;
  background: linear-gradient(
    100deg,
    color-mix(in srgb, var(--dsw-alias-label-primary) 5%, #fff) 20%,
    color-mix(in srgb, var(--dsw-alias-label-primary) 10%, #fff) 38%,
    color-mix(in srgb, var(--dsw-alias-label-primary) 5%, #fff) 56%
  );
  background-size: 220% 100%;
  animation: ph-r-shimmer 1.6s ease-in-out infinite;
}
.ph-r-page__chip {
  position: absolute;
  left: 8px;
  top: 8px;
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 7px;
  border-radius: 5px;
  background: color-mix(in srgb, #000 58%, transparent);
  color: #fff;
  font-size: 10.5px;
  line-height: 1;
  opacity: 0;
  transition: opacity 160ms ease;
  pointer-events: none;
  white-space: nowrap;
}
.ph-r-page:hover .ph-r-page__chip { opacity: 0.92; }
.ph-r-page__structure {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border-radius: 5px;
  font-size: 10.5px;
  line-height: 1.2;
  background: color-mix(in srgb, #000 52%, transparent);
  color: #fff;
  opacity: 0.85;
  pointer-events: none;
  max-width: 70%;
}
.ph-r-page__error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--dsw-alias-label-secondary);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, #fff);
}

/* ---- text layer ---------------------------------------------------------- */
.ph-r-textlayer {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  line-height: 1;
  cursor: text;
}
.ph-r-textlayer--static { pointer-events: none; user-select: none; }
.ph-r-word {
  position: absolute;
  display: block;
  margin: 0;
  padding: 0;
  color: transparent;
  background: transparent;
  white-space: pre;
  overflow: hidden;
  line-height: 1;
  font-family: "Times New Roman", "Songti SC", "Noto Serif CJK SC", serif;
  font-weight: 400;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
}
.ph-r-word::selection { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 36%, transparent); color: transparent; }
.ph-r-reader ::selection { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 34%, transparent); }

/* ---- search hits --------------------------------------------------------- */
.ph-r-hits {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  overflow: hidden;
}
.ph-r-hit {
  position: absolute;
  border-radius: 2px;
  background: color-mix(in srgb, var(--ph-r-pen-yellow) 42%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ph-r-pen-yellow) 70%, transparent) inset;
  animation: ph-r-hit-in 160ms ease;
}
.ph-r-hit--active {
  background: color-mix(in srgb, var(--ph-r-pen-yellow) 62%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ph-r-pen-yellow) 88%, transparent) inset;
  animation: ph-r-hit-pulse 900ms ease;
}
@keyframes ph-r-hit-in { from { opacity: 0; transform: scaleY(0.6); } to { opacity: 1; transform: scaleY(1); } }
@keyframes ph-r-hit-pulse { 0% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ph-r-pen-yellow) 88%, transparent) inset; } 60% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--ph-r-pen-yellow) 45%, transparent) inset; } 100% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ph-r-pen-yellow) 88%, transparent) inset; } }

/* ---- annotation marks ---------------------------------------------------- */
.ph-r-marks {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
  overflow: hidden;
}
.ph-r-mark {
  position: absolute;
  border-radius: 2px;
  mix-blend-mode: multiply;
  transition: background-color 160ms ease, box-shadow 160ms ease;
}
.ph-r-mark--yellow { background: color-mix(in srgb, var(--ph-r-pen-yellow) 34%, transparent); }
.ph-r-mark--green { background: color-mix(in srgb, var(--ph-r-pen-green) 30%, transparent); }
.ph-r-mark--blue { background: color-mix(in srgb, var(--ph-r-pen-blue) 26%, transparent); }
.ph-r-mark--red { background: color-mix(in srgb, var(--ph-r-pen-red) 26%, transparent); }
.ph-r-mark--purple { background: color-mix(in srgb, var(--ph-r-pen-purple) 26%, transparent); }
.ph-r-mark--active { box-shadow: 0 0 0 1.5px currentColor inset; }
.ph-r-mark--yellow.ph-r-mark--active { color: var(--ph-r-pen-yellow); box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ph-r-pen-yellow) 85%, transparent) inset; }
.ph-r-mark--green.ph-r-mark--active { color: var(--ph-r-pen-green); box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ph-r-pen-green) 85%, transparent) inset; }
.ph-r-mark--blue.ph-r-mark--active { color: var(--ph-r-pen-blue); box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ph-r-pen-blue) 85%, transparent) inset; }
.ph-r-mark--red.ph-r-mark--active { color: var(--ph-r-pen-red); box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ph-r-pen-red) 85%, transparent) inset; }
.ph-r-mark--purple.ph-r-mark--active { color: var(--ph-r-pen-purple); box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ph-r-pen-purple) 85%, transparent) inset; }
.ph-r-mark--pending { animation: ph-r-mark-pending 900ms ease-in-out infinite alternate; }
@keyframes ph-r-mark-pending { from { opacity: 0.45; } to { opacity: 0.85; } }
.ph-r-mark--area {
  background: transparent;
  border: 1.5px dashed var(--ph-r-pen-blue);
  border-radius: 4px;
  mix-blend-mode: normal;
  opacity: 0.9;
}
.ph-r-mark--area.ph-r-mark--yellow { border-color: var(--ph-r-pen-yellow); }
.ph-r-mark--area.ph-r-mark--green { border-color: var(--ph-r-pen-green); }
.ph-r-mark--area.ph-r-mark--red { border-color: var(--ph-r-pen-red); }
.ph-r-mark--area.ph-r-mark--purple { border-color: var(--ph-r-pen-purple); }
.ph-r-mark--area.ph-r-mark--active { border-width: 2px; opacity: 1; }
.ph-r-mark--note {
  mix-blend-mode: normal;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  background: transparent;
  padding: 1px;
}
.ph-r-note-pin {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50% 50% 50% 2px;
  color: #fff;
  box-shadow: 0 2px 6px -1px color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent);
  transform: rotate(-45deg);
  transition: transform 160ms ease;
}
.ph-r-note-pin svg { transform: rotate(45deg); }
.ph-r-note-pin--yellow { background: var(--ph-r-pen-yellow); color: #4a3b00; }
.ph-r-note-pin--green { background: var(--ph-r-pen-green); }
.ph-r-note-pin--blue { background: var(--ph-r-pen-blue); }
.ph-r-note-pin--red { background: var(--ph-r-pen-red); }
.ph-r-note-pin--purple { background: var(--ph-r-pen-purple); }
.ph-r-mark--note.ph-r-mark--active .ph-r-note-pin { transform: rotate(-45deg) scale(1.12); }

.ph-r-area-drag {
  position: absolute;
  z-index: 8;
  border: 1.5px dashed var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  border-radius: 3px;
  pointer-events: none;
}

/* ---- floating cards (shared look) --------------------------------------- */
.ph-r-card {
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  box-shadow: 0 18px 44px -18px color-mix(in srgb, var(--dsw-alias-label-primary) 42%, transparent),
    0 2px 6px -1px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);
}
.ph-r-float {
  position: absolute;
  z-index: 40;
  animation: ph-r-float-in 190ms cubic-bezier(0.2, 1.25, 0.4, 1);
  transform-origin: 50% 100%;
}
@keyframes ph-r-float-in {
  from { opacity: 0; transform: translateY(5px) scale(0.94); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* selection toolbar */
.ph-r-selbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 10px;
  white-space: nowrap;
}
.ph-r-selbar__sep { width: 1px; height: 18px; margin: 0 3px; background: var(--dsw-alias-border-l2); flex: none; }
.ph-r-pens { display: inline-flex; align-items: center; gap: 3px; padding: 0 2px; }
.ph-r-pen {
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, #000 12%, transparent);
  cursor: pointer;
  transition: transform 130ms ease, box-shadow 130ms ease;
}
.ph-r-pen:hover { transform: scale(1.16); box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 25%, transparent); }
.ph-r-pen--yellow { background: var(--ph-r-pen-yellow); }
.ph-r-pen--green { background: var(--ph-r-pen-green); }
.ph-r-pen--blue { background: var(--ph-r-pen-blue); }
.ph-r-pen--red { background: var(--ph-r-pen-red); }
.ph-r-pen--purple { background: var(--ph-r-pen-purple); }

/* selection translation card */
.ph-r-resultcard {
  width: 300px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ph-r-resultcard__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.ph-r-resultcard__head strong { color: var(--dsw-alias-label-secondary); font-weight: 600; }
.ph-r-resultcard__spacer { flex: 1 1 auto; }
.ph-r-resultcard__body {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  max-height: 220px;
  overflow-y: auto;
}
.ph-r-resultcard__quote {
  margin: 0;
  padding-left: 8px;
  border-left: 2px solid var(--dsw-alias-border-l3);
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
  max-height: 54px;
  overflow: hidden;
}
.ph-r-resultcard__warn { color: var(--dsw-alias-state-warn-label); font-size: 12px; line-height: 1.6; }

/* annotation tooltip + popover */
.ph-r-tip {
  position: absolute;
  z-index: 30;
  max-width: 280px;
  padding: 7px 9px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 96%, transparent);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--dsw-alias-label-primary) 38%, transparent);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
  pointer-events: none;
  white-space: pre-wrap;
  word-break: break-word;
  animation: ph-r-fade 130ms ease;
}
.ph-r-tip__quote { color: var(--dsw-alias-label-primary); white-space: pre-line; }
.ph-r-tip__comment { margin-top: 3px; color: var(--dsw-alias-label-secondary); }
@keyframes ph-r-fade { from { opacity: 0; } to { opacity: 1; } }

.ph-r-popover {
  position: absolute;
  z-index: 40;
  animation: ph-r-float-in 190ms cubic-bezier(0.2, 1.25, 0.4, 1);
  transform-origin: 50% 100%;
  width: 296px;
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transform-origin: 50% 100%;
}
.ph-r-popover__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
}
.ph-r-popover__head strong { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 600; }
.ph-r-popover__spacer { flex: 1 1 auto; }
.ph-r-popover__quote {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  border-left: 2px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 1.6;
  max-height: 84px;
  overflow-y: auto;
  white-space: pre-wrap;
}
.ph-r-popover__textarea {
  width: 100%;
  min-height: 62px;
  max-height: 160px;
  resize: vertical;
  padding: 7px 8px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.ph-r-popover__textarea:focus {
  border-color: var(--ph-accent-text, #7d2ae8);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent);
}
.ph-r-popover__colors { display: flex; align-items: center; gap: 5px; }
.ph-r-popover__row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ph-r-popover__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin-top: 2px;
  flex-wrap: wrap;
}
.ph-r-popover__hint { font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.ph-r-popover__meta { font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.ph-r-popover__busy { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* note composer */
.ph-r-noteform {
  position: absolute;
  z-index: 40;
  width: 280px;
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: ph-r-float-in 190ms cubic-bezier(0.2, 1.25, 0.4, 1);
  transform-origin: 50% 100%;
}
.ph-r-noteform__title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ph-r-noteform__actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }

/* ========================================================================== *
 * Side panel
 * ========================================================================== */
.ph-r-side {
  flex: none;
  width: var(--ph-r-side);
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  transition: width 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease;
  overflow: hidden;
}
.ph-r-side--closed { width: 0; opacity: 0; border-left-color: transparent; }
.ph-r-side__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex: none;
  height: 38px;
}
.ph-r-side__tabs { flex: 1 1 auto; border-bottom: none; padding: 0; height: 100%; }
.ph-r-side__body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.ph-r-side__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.ph-r-side__hint {
  padding: 8px 12px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-caption);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 60%, transparent);
}

/* ---- outline ------------------------------------------------------------- */
.ph-r-outline { padding: 8px 8px 24px; display: flex; flex-direction: column; gap: 1px; }
.ph-r-outline__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  appearance: none;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  transition: background-color 130ms ease, color 130ms ease;
}
.ph-r-outline__item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ph-r-outline__item--active { color: var(--ph-accent-text, #7d2ae8); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent); }
.ph-r-outline__level { flex: none; width: 14px; color: var(--dsw-alias-label-caption); font-size: 10px; text-align: center; font-variant-numeric: tabular-nums; }
.ph-r-outline__label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-r-outline__page { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }

/* ---- annotation list ----------------------------------------------------- */
.ph-r-annotlist { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.ph-r-annotcard {
  padding: 9px 10px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  display: flex;
  flex-direction: column;
  gap: 5px;
  cursor: pointer;
  transition: border-color 140ms ease, box-shadow 160ms ease, transform 140ms ease;
  text-align: left;
  width: 100%;
  font: inherit;
  color: inherit;
  appearance: none;
}
.ph-r-annotcard:hover {
  border-color: var(--dsw-alias-border-l3);
  box-shadow: 0 6px 18px -12px color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent);
  transform: translateY(-1px);
}
.ph-r-annotcard--active { border-color: var(--ph-accent-text, #7d2ae8); box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent); }
.ph-r-annotcard__head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.ph-r-annotcard__swatch { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ph-r-annotcard__page { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.ph-r-annotcard__spacer { flex: 1 1 auto; }
.ph-r-annotcard__quote {
  margin: 0;
  white-space: pre-line;
  padding-left: 8px;
  border-left: 2px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 1.55;
  max-height: 44px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.ph-r-annotcard__comment {
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.ph-r-annotcard__foot { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-caption); font-size: 10.5px; }
.ph-r-annotcard__actions { display: flex; align-items: center; gap: 2px; margin-left: auto; opacity: 0; transition: opacity 140ms ease; }
.ph-r-annotcard:hover .ph-r-annotcard__actions { opacity: 1; }

/* ---- bilingual ----------------------------------------------------------- */
.ph-r-bi { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
.ph-r-bi__head {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.ph-r-bi__titleline { display: flex; align-items: center; gap: 8px; }
.ph-r-bi__title { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ph-r-bi__page { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ph-r-bi__spacer { flex: 1 1 auto; }
.ph-r-bi__prov { font-size: 10.5px; color: var(--dsw-alias-label-caption); display: flex; align-items: center; gap: 5px; }
.ph-r-bi__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 10px 28px; }
.ph-r-bi__list { display: flex; flex-direction: column; gap: 9px; }
.ph-r-bi__card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: var(--dsw-alias-bg-base);
  padding: 9px 11px 10px;
  transition: border-color 140ms ease;
}
.ph-r-bi__card:hover { border-color: var(--dsw-alias-border-l3); }
.ph-r-bi__card--caption { background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, var(--dsw-alias-bg-base)); border-left: 3px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 52%, transparent); }
.ph-r-bi__card--heading { background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 88%, var(--dsw-alias-bg-base)); }
.ph-r-bi__card--footer, .ph-r-bi__card--header { opacity: 0.82; }
.ph-r-bi__role {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 5px;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-caption);
}
.ph-r-bi__original {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.72;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.ph-r-bi__card--heading .ph-r-bi__original { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ph-r-bi__translation {
  margin: 7px 0 0;
  padding-top: 7px;
  border-top: 1px dashed var(--dsw-alias-border-l2);
  font-size: 13px;
  line-height: 1.82;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.ph-r-bi__translation--only { margin-top: 0; padding-top: 0; border-top: none; }
.ph-r-bi__pending {
  margin: 7px 0 0;
  padding-top: 7px;
  border-top: 1px dashed var(--dsw-alias-border-l2);
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}
.ph-r-bi__unavailable {
  margin: 7px 0 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
  font-size: 11.5px;
  line-height: 1.55;
}
.ph-r-bi__skeleton { display: flex; flex-direction: column; gap: 8px; }


/* bilingual progress + marginal-block filter */
.ph-r-bi__progresslabel { font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ph-r-bi__progresslabel--warn { color: var(--dsw-alias-state-warn-label); }
.ph-r-bi__bar {
  height: 3px;
  border-radius: 2px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
}
.ph-r-bi__barfill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--dsw-alias-state-business-primary);
  transition: width 220ms ease;
}
.ph-r-bi__barfill--warn { background: var(--dsw-alias-state-warn-primary); }
.ph-r-bi__filter { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.ph-r-bi__hidden { font-size: 10px; color: var(--dsw-alias-label-caption); }
.ph-r-bi__cached {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
  color: var(--dsw-alias-state-success-primary);
  font-size: 9.5px;
  line-height: 15px;
  vertical-align: 1px;
  white-space: nowrap;
}
/* captions: italic, muted, smaller */
.ph-r-bi__card--caption .ph-r-bi__original {
  font-style: italic;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 1.65;
}
.ph-r-bi__card--caption .ph-r-bi__role { color: var(--dsw-alias-label-tertiary); }

/* ---- AI panel ------------------------------------------------------------ */
.ph-r-ai { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
.ph-r-ai__status {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent);
}
.ph-r-ai__status--ok { color: var(--dsw-alias-label-secondary); }
.ph-r-ai__status--bad { color: var(--dsw-alias-state-warn-label); }
.ph-r-ai__spacer { flex: 1 1 auto; }
.ph-r-ai__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 10px 14px; display: flex; flex-direction: column; gap: 10px; }
.ph-r-ai__empty { padding: 8px 4px; }
.ph-r-ai__suggestions { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.ph-r-ai__suggestion {
  appearance: none;
  text-align: left;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11.5px;
  line-height: 1.5;
  padding: 7px 9px;
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, transform 140ms ease;
}
.ph-r-ai__suggestion:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); transform: translateY(-1px); }
.ph-r-ai__msg { display: flex; flex-direction: column; gap: 5px; animation: ph-r-msg-in 200ms cubic-bezier(0.2, 1.1, 0.4, 1); }
@keyframes ph-r-msg-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
.ph-r-ai__msg--user { align-items: flex-end; }
.ph-r-ai__role { font-size: 10px; color: var(--dsw-alias-label-caption); letter-spacing: 0.03em; }
.ph-r-ai__bubble {
  max-width: 92%;
  padding: 7px 10px;
  border-radius: 10px 10px 3px 10px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.ph-r-ai__answer {
  padding: 9px 11px;
  border-radius: 3px 10px 10px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ph-r-ai__answer--bad { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-tertiary) 45%, var(--dsw-alias-bg-base)); }
.ph-r-ai__answer-text { font-size: 12.5px; line-height: 1.75; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
.ph-r-ai__answer-warn { font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-state-warn-label); }
.ph-r-ai__meta { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--dsw-alias-label-caption); flex-wrap: wrap; }
.ph-r-ai__sources { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ph-r-ai__sourcelabel { font-size: 10px; color: var(--dsw-alias-label-caption); }
.ph-r-ai__source {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 5px;
  cursor: pointer;
}
.ph-r-ai__source:hover { color: var(--ph-accent-text, #7d2ae8); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent); }
.ph-r-ai__answer-actions { display: flex; align-items: center; gap: 4px; }
.ph-r-ai__composer { flex: none; border-top: 1px solid var(--dsw-alias-border-l2); padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; background: var(--dsw-alias-bg-base); }
.ph-r-ai__context { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ph-r-ai__inputrow { display: flex; align-items: flex-end; gap: 6px; }
.ph-r-ai__input {
  flex: 1 1 auto;
  min-height: 54px;
  max-height: 140px;
  resize: none;
  padding: 8px 9px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.6;
  outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.ph-r-ai__input:focus { border-color: var(--ph-accent-text, #7d2ae8); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent); }
.ph-r-ai__input:disabled { opacity: 0.6; }
.ph-r-ai__tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ph-r-ai__toggle {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background-color 140ms ease;
}
.ph-r-ai__toggle:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l3); }
.ph-r-ai__toggle--on {
  color: var(--ph-accent-text, #7d2ae8);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
}
.ph-r-ai__check { width: 12px; height: 12px; border-radius: 3px; border: 1.4px solid currentColor; display: inline-flex; align-items: center; justify-content: center; }
.ph-r-ai__toggle--on .ph-r-ai__check { background: currentColor; color: #fff; }
.ph-r-ai__hint { font-size: 10px; color: var(--dsw-alias-label-caption); }
.ph-r-ai__busy { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; padding: 4px 2px; }
.ph-r-ai__quote { margin: 0; padding: 5px 8px; border-radius: 6px; border-left: 2px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-tertiary); font-size: 10.5px; line-height: 1.55; max-height: 50px; overflow: hidden; }


/* ========================================================================== *
 * Annotation mode hint + mode cursors
 * ========================================================================== */
.ph-r-modehint {
  position: absolute;
  top: 104px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 55;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px 6px 11px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 94%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  color: var(--dsw-alias-label-primary);
  font-size: 11.5px;
  line-height: 1;
  box-shadow: 0 10px 26px -18px color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent);
  animation: ph-r-float-in 180ms cubic-bezier(0.2, 1.2, 0.4, 1);
}
.ph-r-reader--scrolled .ph-r-modehint { top: 92px; }
.ph-r-modehint .ph-r-toolbtn { height: 22px; font-size: 11px; }
.ph-r-page--area,
.ph-r-page--area .ph-r-textlayer { cursor: crosshair; }
.ph-r-page--note,
.ph-r-page--note .ph-r-textlayer { cursor: copy; }
.ph-r-page--area .ph-r-word,
.ph-r-page--note .ph-r-word { cursor: inherit; }

/* ========================================================================== *
 * Toasts
 * ========================================================================== */
.ph-r-toasts {
  position: absolute;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 80;
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  max-width: min(520px, calc(100% - 40px));
}
.ph-r-toast {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 96%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 10px 30px -14px color-mix(in srgb, var(--dsw-alias-label-primary) 48%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 11.5px;
  line-height: 1.45;
  animation: ph-r-toast-in 220ms cubic-bezier(0.2, 1.2, 0.4, 1);
}
@keyframes ph-r-toast-in { from { opacity: 0; transform: translateY(8px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
.ph-r-toast--success { color: var(--dsw-alias-state-success-primary); }
.ph-r-toast--warning { color: var(--dsw-alias-state-warn-label); }
.ph-r-toast--error { color: var(--dsw-alias-state-error-primary); }

/* ========================================================================== *
 * Search bar inside the toolbar
 * ========================================================================== */
.ph-r-find {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  padding: 2px 2px 2px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  animation: ph-r-find-in 160ms ease;
}
@keyframes ph-r-find-in { from { opacity: 0; transform: translateX(6px); } to { opacity: 1; transform: translateX(0); } }
.ph-r-find__icon { color: var(--dsw-alias-label-tertiary); flex: none; }
.ph-r-find__input {
  width: 172px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.ph-r-find__count {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
  white-space: nowrap;
}
.ph-r-find__count--empty { color: var(--dsw-alias-state-warn-label); }

/* ========================================================================== *
 * Reduced motion
 * ========================================================================== */
@media (prefers-reduced-motion: reduce) {
  .ph-r-reader *,
  .ph-r-reader *::before,
  .ph-r-reader *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
  .ph-r-page--active .ph-r-page__img--loaded { animation: none; }
  .ph-r-hit--active { animation: none; }
  .ph-r-mark--pending { animation: none; opacity: 0.7; }
  .ph-r-rail__indicator { transition: none; }
  .ph-r-toolbar,
  .ph-r-toolbar * { transition: none; }
}

/* ========================================================================== *
 * Narrow layout
 * ========================================================================== */
@media (max-width: 1320px) {
  .ph-r-reader { --ph-r-side: 330px; }
}
@media (max-width: 1120px) {
  .ph-r-reader { --ph-r-side: 306px; --ph-r-rail: 104px; }
  .ph-r-find__input { width: 132px; }
}
@media (max-width: 940px) {
  .ph-r-reader { --ph-r-rail: 0px; }
  .ph-r-rail { display: none; }
}
/* ========================================================================== *
 * v0.3 — geometry selection, quick translate, popover, undo, filters
 * ========================================================================== */

/* The page canvas owns selection geometry; the word layer is purely visual. */
.ph-r-textlayer { pointer-events: none; user-select: none; -webkit-user-select: none; }
.ph-r-word { user-select: none; -webkit-user-select: none; cursor: inherit; }
.ph-r-word::selection, .ph-r-reader ::selection { background: transparent; color: transparent; }
.ph-r-page--select { cursor: text; }

.ph-r-selrect { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.ph-r-selrect__box {
  position: absolute;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, transparent);
  border-radius: 2px;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 62%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 26%, transparent);
  animation: ph-r-sel-in 90ms ease;
}
@keyframes ph-r-sel-in { from { opacity: 0.4; } to { opacity: 1; } }
.ph-r-selcount {
  position: absolute;
  z-index: 6;
  transform: translate(-50%, 6px);
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
  color: #fff;
  font-size: 10.5px;
  line-height: 1.35;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 4px 14px -6px color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent);
}
.ph-r-note-ghost {
  position: absolute;
  z-index: 6;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1.4px dashed color-mix(in srgb, var(--dsw-alias-state-warn-label) 70%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 82%, transparent);
  color: var(--dsw-alias-state-warn-label);
  pointer-events: none;
  opacity: 0.9;
}

/* Selection toolbar */
.ph-r-selbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 7px;
  border-radius: 10px;
  white-space: nowrap;
  max-width: min(680px, calc(100vw - 80px));
  overflow-x: auto;
  scrollbar-width: none;
}
.ph-r-selbar::-webkit-scrollbar { display: none; }
.ph-r-selbar__count { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); padding: 0 5px; white-space: nowrap; }
.ph-r-selbar__sep { width: 1px; height: 16px; background: var(--dsw-alias-border-l2); margin: 0 2px; flex: none; }
.ph-r-selbar .ph-r-toolbtn { height: 26px; font-size: 11.5px; }
.ph-r-toolbtn--primary {
  color: var(--ph-accent-text, #7d2ae8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent);
  font-weight: 600;
}
.ph-r-toolbtn--primary:hover {
  color: var(--ph-accent-text, #7d2ae8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);
}

/* Quick-translation result card */
.ph-r-resultcard {
  width: min(340px, calc(100vw - 60px));
  padding: 10px 12px;
  gap: 7px;
}
.ph-r-resultcard__head { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); flex-wrap: wrap; }
.ph-r-resultcard__head strong { color: var(--dsw-alias-label-primary); font-size: 11.5px; font-weight: 600; }
.ph-r-resultcard__meta { font-size: 10px; color: var(--dsw-alias-label-caption); }
.ph-r-resultcard__spacer { flex: 1 1 auto; }
.ph-r-resultcard__body {
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}
.ph-r-resultcard__warn { color: var(--dsw-alias-state-warn-label); font-size: 11.5px; line-height: 1.6; }
.ph-r-resultcard__loading { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.ph-r-resultcard__actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 6px; }
.ph-r-replacecard { width: min(360px, calc(100vw - 60px)); padding: 10px 12px; gap: 6px; }
.ph-r-replacecard__text {
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--dsw-alias-label-primary);
  max-height: 220px;
  overflow-y: auto;
  white-space: pre-wrap;
}

.ph-r-bi__engine {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 14px;
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 9px;
  font-weight: 600;
  vertical-align: middle;
  letter-spacing: 0.2px;
}
.ph-r-bi__engine--cached { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 36%, transparent); }
.ph-r-bi__enginepref { color: var(--dsw-alias-label-tertiary); }
.ph-r-bi__engineused { color: var(--dsw-alias-label-secondary); }
.ph-r-resultcard__engine { font-size: 10px; color: var(--ph-accent-text, #7d2ae8); font-weight: 600; }
.ph-r-resultcard__loading .ph-r-resultcard__meta { margin-left: auto; }

/* v0.3 popover: 340px max, viewport height, internal scroll, compact structure */
.ph-r-popover {
  width: min(340px, calc(100vw - 28px));
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  padding: 10px 12px 12px;
  gap: 7px;
  overscroll-behavior: contain;
}
.ph-r-popover__head { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); flex-wrap: wrap; }
.ph-r-popover__head strong { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 600; }
.ph-r-popover__meta { font-size: 10.5px; color: var(--dsw-alias-label-caption); white-space: nowrap; }
.ph-r-popover__spacer { flex: 1 1 auto; }
.ph-r-popover__quotewrap { position: relative; }
.ph-r-popover__quotewrap--clamped .ph-r-popover__quote { max-height: 74px; overflow: hidden; }
.ph-r-popover__quotewrap--clamped .ph-r-popover__quote::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 22px;
  background: linear-gradient(transparent, var(--dsw-alias-bg-layer-2));
  pointer-events: none;
}
.ph-r-popover__quote {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  border-left: 2px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 1.6;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.ph-r-popover__expand {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--ph-accent-text, #7d2ae8);
  font: inherit;
  font-size: 10.5px;
  padding: 2px 0;
  cursor: pointer;
}
.ph-r-popover__commenthead { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.ph-r-popover__autosave { font-size: 10px; color: var(--dsw-alias-label-caption); }
.ph-r-popover__autosave--ok { color: var(--dsw-alias-state-success-primary); }
.ph-r-popover__textarea {
  width: 100%;
  min-height: 58px;
  max-height: 150px;
  resize: vertical;
  padding: 7px 8px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  outline: none;
}
.ph-r-popover__textarea:focus { border-color: var(--ph-accent-text, #7d2ae8); }
.ph-r-popover__row { display: flex; align-items: center; gap: 8px; }
.ph-r-popover__hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.ph-r-popover__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.ph-r-popover__action {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
  text-align: left;
}
.ph-r-popover__action:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.ph-r-popover__action:disabled { opacity: 0.55; cursor: default; }
.ph-r-popover__translation { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.ph-r-popover__translationtext { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-primary); max-height: 150px; overflow-y: auto; white-space: pre-wrap; }
.ph-r-popover__translationmeta { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--dsw-alias-label-caption); }

/* Annotation color/kind filters */
.ph-r-annotfilters { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ph-r-annotfilters__row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ph-r-annotfilters__chip {
  appearance: none;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.ph-r-annotfilters__chip:hover { color: var(--dsw-alias-label-primary); }
.ph-r-annotfilters__chip--active {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-interactive-bg-hover);
}
.ph-r-annotfilters__swatch {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 1.5px solid transparent;
  padding: 0;
  cursor: pointer;
  opacity: 0.7;
}
.ph-r-annotfilters__swatch--active { opacity: 1; border-color: var(--dsw-alias-label-primary); box-shadow: 0 0 0 1px var(--dsw-alias-bg-layer-2); }
.ph-r-annotfilters__count { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-caption); }
.ph-r-annotlistwrap { display: flex; flex-direction: column; min-height: 0; }

/* AI fast/deep mode segmented control */
.ph-r-ai__modes { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.ph-r-ai__mode {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 7px;
  border-radius: 5px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.ph-r-ai__mode:hover { color: var(--dsw-alias-label-primary); }
.ph-r-ai__mode--active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); font-weight: 600; }
.ph-r-ai__mode:disabled { opacity: 0.55; cursor: default; }
.ph-r-ai__fast {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--ph-accent-text, #7d2ae8);
  font-size: 9.5px;
  font-weight: 600;
}

/* Actionable toast (undo) */
.ph-r-toast__action {
  appearance: none;
  margin-left: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, currentColor 36%, transparent);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;
}
.ph-r-toast__action:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
/* ================================================================ v0.13 AI markdown + translation cards */
.ph-r-resultcard__free {
  display: inline-flex; align-items: center; height: 16px; padding: 0 6px;
  border-radius: 999px; font-size: 9.5px; font-weight: 600; letter-spacing: 0.01em;
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 24%, transparent);
  white-space: nowrap;
}
.ph-r-resultcard__body {
  max-height: none;
  overflow: visible;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ph-r-resultcard { width: min(380px, calc(100vw - 40px)); }
.ph-r-resultcard__warn { color: var(--dsw-alias-state-warn-label); }
.ph-ai-md { white-space: normal; font-size: 12.5px; line-height: 1.72; color: var(--dsw-alias-label-primary); max-width: 760px; overflow-wrap: anywhere; }
.ph-ai-md > :first-child { margin-top: 0; }
.ph-ai-md > :last-child { margin-bottom: 0; }
.ph-ai-md__p { margin: 0 0 8px; }
.ph-ai-md__h { margin: 14px 0 6px; font-weight: 650; line-height: 1.35; color: var(--dsw-alias-label-primary); }
.ph-ai-md__h1 { font-size: 17px; }
.ph-ai-md__h2 { font-size: 15.5px; }
.ph-ai-md__h3 { font-size: 14px; }
.ph-ai-md__h4 { font-size: 13px; }
.ph-ai-md__h5, .ph-ai-md__h6 { font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.ph-ai-md__list { margin: 0 0 8px; padding-left: 20px; }
.ph-ai-md__list li { margin: 2px 0; }
.ph-ai-md__list li::marker { color: var(--dsw-alias-label-tertiary); }
.ph-ai-md__quote { margin: 8px 0; padding: 6px 10px; border-left: 3px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent); border-radius: 0 6px 6px 0; color: var(--dsw-alias-label-secondary); }
.ph-ai-md__quote > :last-child { margin-bottom: 0; }
.ph-ai-md__hr { margin: 12px 0; border: none; border-top: 1px solid var(--dsw-alias-border-l2); }
.ph-ai-md__code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); overflow-wrap: anywhere; }
.ph-ai-md__pre { margin: 8px 0 10px; padding: 9px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); overflow-x: auto; max-width: 100%; }
.ph-ai-md__codeblock { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.6; white-space: pre; display: block; min-width: min-content; color: var(--dsw-alias-label-primary); }
.ph-ai-md__tablewrap { margin: 8px 0 10px; overflow-x: auto; max-width: 100%; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.ph-ai-md__table { border-collapse: collapse; width: 100%; min-width: 320px; font-size: 11.5px; }
.ph-ai-md__table th, .ph-ai-md__table td { border-bottom: 1px solid var(--dsw-alias-border-l1); padding: 5px 8px; text-align: left; vertical-align: top; }
.ph-ai-md__table th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ph-ai-md__table tr:last-child td { border-bottom: none; }
.ph-ai-md a { color: var(--ph-accent-text, #7d2ae8); text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.ph-r-ai__answer-text { white-space: normal; }
.ph-r-ai__answer-text .ph-ai-md { font-size: 12.5px; }
.ph-r-ai__msg--user .ph-r-ai__bubble { max-width: 88%; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); }
.ph-r-ai__body { scroll-behavior: smooth; }
@media (max-width: 560px) {
  .ph-r-resultcard { width: calc(100vw - 24px); }
  .ph-ai-md__table { min-width: 240px; }
}
@media (prefers-reduced-motion: reduce) {
  .ph-ai-md, .ph-ai-md pre, .ph-ai-md__tablewrap { scroll-behavior: auto; }
}

/* v0.15 temporary figure highlight */
.ph-r-fighl {
  position: absolute; z-index: 6; pointer-events: none;
  border: 2px dashed color-mix(in srgb, var(--dsw-alias-state-business-primary) 78%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  animation: ph-fighl-in 220ms var(--ph-ease, ease-out) both, ph-fighl-pulse 1200ms ease-in-out 220ms 2, ph-fighl-out 380ms ease 4.2s forwards;
}
.ph-r-fighl__label {
  position: absolute; left: -2px; top: -24px; display: inline-flex; align-items: center;
  height: 20px; padding: 0 8px; border-radius: 6px; white-space: nowrap;
  font-size: 10.5px; font-weight: 600; color: #fff;
  background: var(--dsw-alias-state-business-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,.16);
}
@keyframes ph-fighl-in { from { opacity: 0; transform: scale(1.015); } to { opacity: 1; transform: scale(1); } }
@keyframes ph-fighl-pulse { 0%, 100% { background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent); } 50% { background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); } }
@keyframes ph-fighl-out { to { opacity: 0; visibility: hidden; } }
@media (prefers-reduced-motion: reduce) {
  .ph-r-fighl { animation: ph-fighl-out 1ms linear 4.2s forwards; }
}

/* ========================================================================== *
 * v0.17 floating annotation tools + first-run tip
 * ========================================================================== */
.ph-r-floattools {
  position: absolute;
  z-index: 55;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  transition: right 200ms cubic-bezier(0.4, 0, 0.2, 1), bottom 200ms cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}
.ph-r-floattools > * { pointer-events: auto; }
.ph-r-floattools__bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 92%, transparent);
  backdrop-filter: blur(10px);
  box-shadow: 0 6px 24px -10px color-mix(in srgb, var(--dsw-alias-label-primary) 42%, transparent),
    0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
}
.ph-r-floattools__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}
.ph-r-floattools__btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  color: var(--dsw-alias-label-primary);
}
.ph-r-floattools__btn:disabled { opacity: 0.45; cursor: default; }
.ph-r-floattools__btn--armed {
  color: var(--ph-accent-text, #7d2ae8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 34%, transparent);
}
.ph-r-floattools__btn--active {
  color: var(--ph-accent-text, #7d2ae8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent);
  font-weight: 600;
}
.ph-r-floattools__label { white-space: nowrap; }
.ph-r-floattools__kbd {
  font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace);
  font-size: 9.5px;
  padding: 1px 4px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 80%, transparent);
  color: var(--dsw-alias-label-caption);
  line-height: 1.3;
}
.ph-r-floattools__sep { width: 1px; height: 18px; margin: 0 3px; background: var(--dsw-alias-border-l1); }
.ph-r-floattools__pens { display: inline-flex; align-items: center; gap: 3px; padding: 0 3px; }
.ph-r-floattools__pen {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid transparent;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #000 16%, transparent);
  cursor: pointer;
  padding: 0;
  transition: transform 120ms ease, box-shadow 120ms ease;
}
.ph-r-floattools__pen:hover { transform: scale(1.12); }
.ph-r-floattools__pen--active { box-shadow: 0 0 0 2px var(--dsw-alias-bg-base), 0 0 0 3.5px currentColor; }
.ph-r-floattools__pen--yellow { background: var(--ph-r-pen-yellow); color: var(--ph-r-pen-yellow); }
.ph-r-floattools__pen--green { background: var(--ph-r-pen-green); color: var(--ph-r-pen-green); }
.ph-r-floattools__pen--blue { background: var(--ph-r-pen-blue); color: var(--ph-r-pen-blue); }
.ph-r-floattools__pen--red { background: var(--ph-r-pen-red); color: var(--ph-r-pen-red); }
.ph-r-floattools__pen--purple { background: var(--ph-r-pen-purple); color: var(--ph-r-pen-purple); }
.ph-r-floattools__help {
  width: 22px;
  height: 22px;
  margin: 0 2px 0 0;
  border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  line-height: 1;
  padding: 0;
}
.ph-r-floattools__help:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-tertiary); }

.ph-r-tools-tip {
  width: 286px;
  padding: 10px 12px 11px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 10px 34px -16px color-mix(in srgb, var(--dsw-alias-label-primary) 52%, transparent);
  animation: ph-r-tools-tip-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
.ph-r-tools-tip__head { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ph-accent-text, #7d2ae8); }
.ph-r-tools-tip__text { margin: 5px 0 8px; font-size: 11.8px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.ph-r-tools-tip__actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
@keyframes ph-r-tools-tip-in { from { opacity: 0; transform: translateY(6px) scale(0.985); } to { opacity: 1; transform: none; } }

/* ========================================================================== *
 * v0.17 translation sheet (replaces the 双语 tab)
 * ========================================================================== */
.ph-r-tr {
  position: absolute;
  bottom: 0;
  z-index: 50;
  height: 46%;
  min-height: 210px;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 96%, transparent);
  backdrop-filter: blur(12px);
  box-shadow: 0 -12px 32px -22px color-mix(in srgb, var(--dsw-alias-label-primary) 48%, transparent);
  border-top-left-radius: 12px;
  border-top-right-radius: 12px;
  animation: ph-r-tr-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}
.ph-r-tr__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.ph-r-tr__title { font-size: 12px; font-weight: 650; white-space: nowrap; }
.ph-r-tr__modes {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
}
.ph-r-tr__mode {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11.5px;
  padding: 2px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.ph-r-tr__mode--active {
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);
}
.ph-r-tr__spacer { flex: 1 1 auto; }
.ph-r-tr__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.ph-r-tr__body .ph-r-bi { height: auto; }
@keyframes ph-r-tr-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  .ph-r-floattools, .ph-r-tools-tip, .ph-r-tr { animation: none; transition: none; }
}
@media (max-width: 1100px) {
  .ph-r-floattools__kbd { display: none; }
  .ph-r-floattools__label { font-size: 11.5px; }
}

/* ========================================================================== *
 * v0.19 design layer — reading-first typography and calmer chrome
 * Consumes the shared tokens from core/styles.css; all structural and
 * geometry rules above (text layer, marks, selection) are left untouched.
 * ========================================================================== */
.ph-r-reader {
  font-size: var(--ph-fs-13, 13px);
  line-height: var(--ph-lh-ui, 1.5);
  background: var(--ph-bg, var(--dsw-alias-bg-base));
}
.ph-r-reader ::selection { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent); }

/* ---- toolbar ------------------------------------------------------------- */
.ph-r-toolbar { border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-r-toolbar__row { padding: 0 var(--ph-s4, 16px); }
.ph-r-toolbar__row--main { height: 56px; transition: height var(--ph-base, 200ms) var(--ph-ease, ease); }
.ph-r-reader--scrolled .ph-r-toolbar__row--main { height: 44px; }
.ph-r-toolbar__row--tools { height: 44px; gap: 7px; border-top-color: var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-r-toolbar__title { font-size: var(--ph-fs-15, 15px); font-weight: var(--ph-fw-semi, 600); letter-spacing: -0.006em; }
.ph-r-reader--scrolled .ph-r-toolbar__title { font-size: var(--ph-fs-13, 13px); }
.ph-r-toolbar__badge { font-size: var(--ph-fs-11, 11px); color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }
.ph-r-toolbar__meta { font-size: var(--ph-fs-11, 11px); color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); gap: 7px; }
.ph-r-reader--scrolled .ph-r-toolbar {
  background: color-mix(in srgb, var(--ph-bg, #fff) 78%, transparent);
  backdrop-filter: saturate(160%) blur(16px);
  -webkit-backdrop-filter: saturate(160%) blur(16px);
  box-shadow: 0 8px 24px -22px rgba(0, 0, 0, 0.18);
}

.ph-r-pager { border-radius: var(--ph-r-sm, 8px); background: var(--ph-surface-2, var(--dsw-alias-bg-layer-2)); padding: 3px; }
.ph-r-pager__input { height: 26px; border-radius: var(--ph-r-xs, 6px); font-size: var(--ph-fs-12, 12px); font-variant-numeric: tabular-nums; }
.ph-r-pager__input:focus { box-shadow: var(--ph-ring, 0 0 0 3px rgba(0, 0, 0, 0.1)); }
.ph-r-pager__total { font-size: var(--ph-fs-11, 11px); }
.ph-r-zoom__value { font-size: var(--ph-fs-12, 12px); border-radius: var(--ph-r-xs, 6px); }
.ph-r-segment { border-radius: var(--ph-r-sm, 8px); padding: 3px; background: var(--ph-surface-2, var(--dsw-alias-bg-layer-2)); }
.ph-r-segment__item { border-radius: var(--ph-r-xs, 6px); font-size: var(--ph-fs-12, 12px); padding: 6px 11px; font-weight: var(--ph-fw-medium, 500); }
.ph-r-segment__item--active { font-weight: var(--ph-fw-semi, 600); box-shadow: var(--ph-shadow-1, 0 1px 2px rgba(0, 0, 0, 0.08)), 0 0 0 0.5px var(--ph-line, rgba(0, 0, 0, 0.08)); }
.ph-r-toolbtn { height: 29px; border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); gap: 6px; }
.ph-r-toolbtn--active { border-color: var(--ph-accent-line, var(--dsw-alias-border-l3)); }
.ph-r-toolbtn--icon { width: 29px; }

/* ---- base controls ------------------------------------------------------- */
.ph-r-btn { border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-13, 13px); font-weight: var(--ph-fw-medium, 500); transition: background-color var(--ph-fast, 140ms) var(--ph-ease, ease), border-color var(--ph-fast, 140ms) var(--ph-ease, ease), color var(--ph-fast, 140ms) var(--ph-ease, ease), box-shadow var(--ph-fast, 140ms) var(--ph-ease, ease); }
.ph-r-btn--md { height: 32px; padding: 0 13px; }
.ph-r-btn--sm { height: 27px; padding: 0 10px; font-size: var(--ph-fs-12, 12px); }
.ph-r-btn--soft { background: var(--ph-surface-2, var(--dsw-alias-bg-layer-2)); border-color: var(--ph-line, var(--dsw-alias-border-l2)); }
.ph-r-btn--soft:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ph-r-btn--solid { box-shadow: var(--ph-shadow-1, none); }
.ph-r-iconbtn { width: 29px; height: 29px; border-radius: var(--ph-r-sm, 8px); transition: background-color var(--ph-fast, 140ms) var(--ph-ease, ease), color var(--ph-fast, 140ms) var(--ph-ease, ease); }
.ph-r-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ph-r-badge { height: 19px; border-radius: var(--ph-r-pill, 999px); font-size: 10.5px; padding: 0 7px; }
.ph-r-spinner { border-width: 1.7px; }
.ph-r-empty__title { font-size: var(--ph-fs-13, 13px); }
.ph-r-empty__desc { font-size: var(--ph-fs-12, 12px); line-height: 1.6; color: var(--ph-ink-3, var(--dsw-alias-label-tertiary)); }
.ph-r-chip { height: 25px; border-radius: var(--ph-r-pill, 999px); font-size: var(--ph-fs-11, 11px); }

.ph-r-tabs { padding: 0 var(--ph-s2, 8px); border-bottom-color: var(--ph-line-soft, var(--dsw-alias-border-l1)); gap: 1px; }
.ph-r-tab { height: 42px; font-size: var(--ph-fs-12, 12px); font-weight: var(--ph-fw-medium, 500); padding: 0 10px; }
.ph-r-tab--active { font-weight: var(--ph-fw-semi, 600); }
.ph-r-tab--active::after { left: 8px; right: 8px; height: 2px; }
.ph-r-tab__count { border-radius: var(--ph-r-pill, 999px); font-size: 10.5px; height: 17px; line-height: 17px; }

/* ---- rail + canvas ------------------------------------------------------- */
.ph-r-reader { --ph-r-rail: 120px; }
.ph-r-rail {
  padding: var(--ph-s2, 8px) 0 var(--ph-s6, 24px);
  border-right: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1));
  background: var(--ph-surface-1, var(--dsw-alias-bg-layer-1));
}
.ph-r-rail__item { padding: 6px 0 8px; gap: 4px; }
.ph-r-rail__thumb { border-radius: 3px; border-color: var(--ph-line, var(--dsw-alias-border-l2)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.ph-r-rail__item:hover .ph-r-rail__thumb { box-shadow: 0 6px 14px -6px rgba(0, 0, 0, 0.28); }
.ph-r-rail__num { font-size: var(--ph-fs-11, 11px); border-radius: var(--ph-r-xs, 6px); min-width: 26px; text-align: center; }
.ph-r-rail__item--active .ph-r-rail__num { font-weight: var(--ph-fw-semi, 600); }
.ph-r-rail__indicator { width: 2.5px; border-radius: 0 3px 3px 0; }

.ph-r-canvas {
  background:
    radial-gradient(120% 55% at 50% 0%, rgba(0, 0, 0, 0.18), transparent 72%),
    var(--ph-surface-1, var(--dsw-alias-bg-layer-1));
}
.ph-r-pages { padding: 22px var(--ph-s6, 24px) 56px; gap: 20px; }
.ph-r-page {
  border-radius: 3px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 8px 24px -16px rgba(0, 0, 0, 0.18);
  transition: box-shadow var(--ph-base, 200ms) var(--ph-ease, ease);
}
.ph-r-page:hover { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 12px 32px -14px rgba(0, 0, 0, 0.18); }
.ph-r-page--active { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 14px 36px -14px rgba(0, 0, 0, 0.18); }
.ph-r-page__chip { border-radius: var(--ph-r-xs, 6px); font-size: 10.5px; background: color-mix(in srgb, #000 56%, transparent); }
.ph-r-page__structure { border-radius: var(--ph-r-xs, 6px); font-size: 10.5px; }

/* ---- floating cards ------------------------------------------------------ */
.ph-r-card {
  border-radius: var(--ph-r-md, 12px);
  border: 1px solid var(--ph-line, var(--dsw-alias-border-l2));
  box-shadow: 0 16px 40px -18px rgba(0, 0, 0, 0.18), 0 2px 6px -1px rgba(0, 0, 0, 0.1);
  background: var(--ph-bg, var(--dsw-alias-bg-base));
}
.ph-r-float { animation: ph-r-float-in var(--ph-base, 190ms) var(--ph-ease-out, ease); }
.ph-r-selbar { border-radius: var(--ph-r-md, 12px); padding: 5px 7px; gap: 3px; }
.ph-r-pen { width: 18px; height: 18px; transition: transform var(--ph-fast, 130ms) var(--ph-ease, ease), box-shadow var(--ph-fast, 130ms) var(--ph-ease, ease); }
.ph-r-pen--current { box-shadow: 0 0 0 2px var(--ph-bg, #fff), 0 0 0 3.5px currentColor; }
.ph-r-resultcard { padding: 12px 14px; gap: 8px; border-radius: var(--ph-r-md, 12px); }
.ph-r-resultcard__head { font-size: var(--ph-fs-11, 11px); }
.ph-r-resultcard__body { font-size: var(--ph-fs-13, 13px); line-height: 1.75; }
.ph-r-resultcard__quote { font-size: var(--ph-fs-12, 12px); line-height: 1.55; }

.ph-r-tip { border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); line-height: 1.6; padding: 8px 10px; }
.ph-r-popover { border-radius: var(--ph-r-md, 12px); padding: 12px 14px 13px; gap: 8px; }
.ph-r-popover__head { font-size: var(--ph-fs-11, 11px); }
.ph-r-popover__head strong { font-size: var(--ph-fs-12, 12px); }
.ph-r-popover__quote { border-radius: var(--ph-r-xs, 6px); font-size: var(--ph-fs-12, 12px); line-height: 1.65; border-left-color: var(--ph-line-strong, var(--dsw-alias-border-l3)); }
.ph-r-popover__textarea { border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); line-height: 1.65; }
.ph-r-popover__textarea:focus { box-shadow: var(--ph-ring, none); }
.ph-r-popover__action { height: 29px; border-radius: var(--ph-r-xs, 6px); font-size: var(--ph-fs-11, 11px); }
.ph-r-popover__translationtext { font-size: var(--ph-fs-12, 12px); line-height: 1.7; }

/* ---- side panel ---------------------------------------------------------- */
.ph-r-side { width: var(--ph-r-side, 372px); border-left: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); transition: width var(--ph-panel, 280ms) var(--ph-ease-out, cubic-bezier(0.16, 1, 0.3, 1)), opacity var(--ph-base, 200ms) var(--ph-ease, ease); }
.ph-r-side__head { height: 42px; padding: 0 6px 0 var(--ph-s3, 12px); border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-r-side__hint { padding: 9px var(--ph-s4, 16px); font-size: var(--ph-fs-11, 11px); color: var(--ph-ink-4, var(--dsw-alias-label-caption)); background: var(--ph-surface-1, var(--dsw-alias-bg-layer-1)); border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }

.ph-r-outline { padding: var(--ph-s2, 8px) var(--ph-s2, 8px) var(--ph-s6, 24px); gap: 1px; }
.ph-r-outline__item { padding: 7px 9px; border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); line-height: 1.5; }
.ph-r-outline__item--active { font-weight: var(--ph-fw-medium, 500); }
.ph-r-outline__level { font-size: var(--ph-fs-11, 11px); }
.ph-r-outline__page { font-size: var(--ph-fs-11, 11px); }

.ph-r-annotlist { padding: var(--ph-s3, 12px); gap: var(--ph-s2, 8px); }
.ph-r-annotcard {
  padding: 10px 11px;
  border-radius: var(--ph-r-sm, 8px);
  gap: 6px;
  transition: border-color var(--ph-fast, 140ms) var(--ph-ease, ease), box-shadow var(--ph-base, 200ms) var(--ph-ease, ease), transform var(--ph-fast, 140ms) var(--ph-ease, ease);
}
.ph-r-annotcard:hover { transform: translateY(-1px); box-shadow: var(--ph-shadow-2, none); }
.ph-r-annotcard__quote { font-size: var(--ph-fs-12, 12px); line-height: 1.6; }
.ph-r-annotcard__comment { font-size: var(--ph-fs-12, 12px); line-height: 1.65; }
.ph-r-annotcard__foot { font-size: var(--ph-fs-11, 11px); }
.ph-r-annotcard__actions { opacity: 0; transition: opacity var(--ph-fast, 140ms) var(--ph-ease, ease); }
.ph-r-annotcard:hover .ph-r-annotcard__actions,
.ph-r-annotcard:focus-within .ph-r-annotcard__actions { opacity: 1; }
.ph-r-annotfilters { padding: 8px var(--ph-s2, 8px) 9px; gap: 5px; border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-r-annotfilters__chip { height: 23px; border-radius: var(--ph-r-pill, 999px); font-size: var(--ph-fs-11, 11px); padding: 0 9px; }

.ph-r-bi__head { padding: var(--ph-s3, 12px) var(--ph-s3, 12px); gap: 7px; border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-r-bi__title { font-size: var(--ph-fs-13, 13px); }
.ph-r-bi__body { padding: var(--ph-s3, 12px) var(--ph-s3, 12px) var(--ph-s8, 32px); }
.ph-r-bi__list { gap: var(--ph-s3, 12px); }
.ph-r-bi__card {
  border-radius: var(--ph-r-sm, 8px);
  border-color: var(--ph-line-soft, var(--dsw-alias-border-l1));
  padding: 11px 13px 12px;
  transition: border-color var(--ph-fast, 140ms) var(--ph-ease, ease), background-color var(--ph-fast, 140ms) var(--ph-ease, ease);
}
.ph-r-bi__card:hover { border-color: var(--ph-line, var(--dsw-alias-border-l2)); }
.ph-r-bi__card--caption { border-left-width: 2.5px; }
.ph-r-bi__role { font-size: 10.5px; letter-spacing: 0.07em; }
.ph-r-bi__original { font-size: 13px; line-height: 1.78; }
.ph-r-bi__translation { font-size: 13.5px; line-height: 1.85; }
.ph-r-bi__card--heading .ph-r-bi__original { font-size: 14px; }
.ph-r-bi__card--caption .ph-r-bi__original { font-size: 12px; line-height: 1.68; }
.ph-r-bi__progresslabel { font-size: var(--ph-fs-11, 11px); }

.ph-r-ai__status { padding: 8px var(--ph-s3, 12px); font-size: var(--ph-fs-11, 11px); background: var(--ph-surface-1, var(--dsw-alias-bg-layer-1)); border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-r-ai__body { padding: var(--ph-s3, 12px) var(--ph-s3, 12px) var(--ph-s4, 16px); gap: var(--ph-s3, 12px); }
.ph-r-ai__suggestion { border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); padding: 9px 11px; line-height: 1.55; }
.ph-r-ai__bubble { border-radius: var(--ph-r-md, 12px) var(--ph-r-md, 12px) 4px var(--ph-r-md, 12px); font-size: var(--ph-fs-12, 12px); line-height: 1.7; padding: 9px 11px; }
.ph-r-ai__answer { border-radius: 4px var(--ph-r-md, 12px) var(--ph-r-md, 12px) var(--ph-r-md, 12px); padding: 10px 12px; gap: 8px; }
.ph-r-ai__answer-text { font-size: var(--ph-fs-13, 13px); line-height: 1.78; }
.ph-r-ai__composer { padding: var(--ph-s2, 8px) var(--ph-s3, 12px) var(--ph-s3, 12px); gap: 7px; border-top: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-r-ai__input { border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); line-height: 1.65; min-height: 58px; }
.ph-r-ai__input:focus { box-shadow: var(--ph-ring, none); }
.ph-r-ai__toggle { height: 25px; border-radius: var(--ph-r-pill, 999px); font-size: var(--ph-fs-11, 11px); padding: 0 9px; }
.ph-r-ai__source { border-radius: var(--ph-r-xs, 6px); font-size: 10.5px; padding: 2px 8px; }
.ph-r-ai__meta { font-size: 10.5px; }
.ph-r-ai__mode { border-radius: var(--ph-r-xs, 6px); }

/* ---- translation sheet --------------------------------------------------- */
.ph-r-tr { border-top-left-radius: var(--ph-r-lg, 14px); border-top-right-radius: var(--ph-r-lg, 14px); border-top: 1px solid var(--ph-line, var(--dsw-alias-border-l2)); box-shadow: 0 -14px 36px -24px rgba(0, 0, 0, 0.18); }
.ph-r-tr__head { height: 42px; padding: 0 var(--ph-s2, 8px) 0 var(--ph-s4, 16px); border-bottom: 1px solid var(--ph-line-soft, var(--dsw-alias-border-l1)); }
.ph-r-tr__title { font-size: var(--ph-fs-12, 12px); }
.ph-r-tr__mode { border-radius: var(--ph-r-xs, 6px); font-size: var(--ph-fs-11, 11px); padding: 3px 11px; }
.ph-r-tr__modes { border-radius: var(--ph-r-sm, 8px); padding: 3px; }

/* ---- floating annotation tools ------------------------------------------ */
.ph-r-floattools__bar { border-radius: var(--ph-r-md, 12px); border-color: var(--ph-line, var(--dsw-alias-border-l2)); box-shadow: 0 8px 26px -12px rgba(0, 0, 0, 0.18), 0 1px 2px rgba(0, 0, 0, 0.08); }
.ph-r-floattools__btn { height: 31px; border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); }
.ph-r-floattools__kbd { border-radius: var(--ph-r-xs, 6px); font-size: 10px; }
.ph-r-tools-tip { border-radius: var(--ph-r-md, 12px); box-shadow: 0 12px 36px -18px rgba(0, 0, 0, 0.18); }
.ph-r-tools-tip__text { font-size: var(--ph-fs-12, 12px); line-height: 1.65; }

/* ---- toasts + find ------------------------------------------------------- */
.ph-r-toast { border-radius: var(--ph-r-sm, 8px); font-size: var(--ph-fs-12, 12px); padding: 8px 12px; }
.ph-r-toast__action { border-radius: var(--ph-r-xs, 6px); font-size: var(--ph-fs-11, 11px); }
.ph-r-find { border-radius: var(--ph-r-sm, 8px); }
.ph-r-find__count { font-size: var(--ph-fs-11, 11px); }
.ph-r-modehint { border-radius: var(--ph-r-md, 10px); font-size: var(--ph-fs-12, 12px); }

/* ---- focus + responsive -------------------------------------------------- */
.ph-r-reader button:focus-visible,
.ph-r-reader [tabindex]:focus-visible,
.ph-r-reader input:focus-visible,
.ph-r-reader textarea:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
@media (max-width: 1320px) { .ph-r-reader { --ph-r-side: 336px; } }
@media (max-width: 1120px) { .ph-r-reader { --ph-r-side: 312px; --ph-r-rail: 108px; } }
@media (max-width: 940px) {
  .ph-r-reader { --ph-r-side: 300px; }
  .ph-r-pages { padding: 16px 16px 40px; gap: 16px; }
}
@media (max-width: 820px) {
  .ph-r-side { position: absolute; right: 0; top: 0; bottom: 0; z-index: 35; box-shadow: var(--ph-shadow-3, 0 0 28px rgba(0, 0, 0, 0.18)); }
  .ph-r-toolbar__row { padding: 0 var(--ph-s3, 12px); }
  .ph-r-toolbar__meta { display: none; }
}
/* toolbar labels collapse to icons before the row can overflow */
@media (max-width: 1240px) {
  .ph-r-toolbar__actions .ph-r-btn__label { display: none; }
  .ph-r-toolbar__actions .ph-r-btn--sm { width: 28px; padding: 0; gap: 0; justify-content: center; }
  .ph-r-toolbar__actions a.ph-r-btn--sm { width: 28px; padding: 0; justify-content: center; }
}
@media (max-width: 860px) {
  .ph-r-toolbar__back .ph-r-btn__label { display: none; }
  .ph-r-toolbar__back { width: 28px; padding: 0; gap: 0; }
  .ph-r-find__input { width: 112px; }
}
/* state overrides must follow the width declarations above */
.ph-r-side--closed { width: 0 !important; opacity: 0; border-left-color: transparent; }
.ph-r-side--closed .ph-r-side__body { visibility: hidden; }
/* ---- v0.22 colour pass: blue reading chrome, purple AI ------------------ */
.ph-r-reader {
  --ph-r-pen-yellow: #ffb020;
  --ph-r-pen-green: #00b894;
  --ph-r-pen-blue: #0d99ff;
  --ph-r-pen-red: #ff5757;
  --ph-r-pen-purple: #9b87f5;
}
.ph-r-toolbar::after { display: none; }
.ph-r-side__head { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 4%, var(--dsw-alias-bg-base)); }
.ph-r-bi__head { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 3%, var(--dsw-alias-bg-base)); }

.ph-r-tab--active::after { background: var(--ph-accent, #3ea6ff); }
.ph-r-rail__indicator { background: var(--ph-accent, #3ea6ff); }
.ph-r-bi__barfill { background: var(--ph-accent, #3ea6ff); }
.ph-r-toolbtn--active,
.ph-r-toolbtn--primary {
  color: var(--ph-accent-text, #0b6fc4);
  background: var(--ph-accent-soft, rgba(62, 166, 255, 0.14));
  border-color: var(--ph-accent-line, rgba(62, 166, 255, 0.4));
}
.ph-r-ai__mode--active { color: var(--ph-soft-text, #655ba1); }

/* AI marks use the light purple secondary accent */
.ph-r-ai__fast {
  background: var(--ph-soft-bg, rgba(155, 135, 245, 0.16));
  color: var(--ph-soft-text, #655ba1);
  font-weight: 600;
}
.ph-r-ai__toggle--on {
  color: var(--ph-soft-text, #655ba1);
  border-color: var(--ph-soft-line, rgba(155, 135, 245, 0.4));
  background: var(--ph-soft-bg, rgba(155, 135, 245, 0.16));
}
.ph-r-ai__status { background: color-mix(in srgb, var(--ph-hue-secondary, #9b87f5) 3%, var(--dsw-alias-bg-base)); }

.ph-r-annotcard:hover { border-color: var(--ph-accent-line, rgba(62, 166, 255, 0.4)); }
.ph-r-outline__item:not(.ph-r-outline__item--active):hover { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 7%, transparent); }
.ph-r-ai__suggestion:hover { border-color: var(--ph-accent-line, rgba(62, 166, 255, 0.4)); }
.ph-r-outline__item--active:hover { background: color-mix(in srgb, var(--ph-accent, #3ea6ff) 10%, transparent); color: var(--ph-accent-text, #0b6fc4); }
`

/** Mounted reader instances currently holding the stylesheet. */
let styleRefCount = 0

/**
 * Inject the reader stylesheet once per document and return a release function.
 * Reference counted so disabling the plugin / unmounting the reader removes the
 * <style> element and leaves no global side effect behind (v0.1 contract §1).
 */
export function ensureReaderStyles() {
  if (typeof document === 'undefined') return () => {}
  styleRefCount += 1
  if (!document.getElementById(STYLE_ID)) {
    try {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = READER_CSS
      const head = document.head || document.documentElement
      if (head) head.appendChild(style)
    } catch {
      /* non-browser test environment: styles are irrelevant */
    }
  }
  let released = false
  return function releaseReaderStyles() {
    if (released) return
    released = true
    styleRefCount = Math.max(0, styleRefCount - 1)
    if (styleRefCount > 0) return
    try {
      const style = document.getElementById(STYLE_ID)
      if (style && style.parentNode) style.parentNode.removeChild(style)
    } catch {
      /* already detached */
    }
  }
}

