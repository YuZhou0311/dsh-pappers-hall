/**
 * Host half of the Pappers-Hall paper center plugin.
 *
 * This file is the only entry the DSH Loader starts. All domain work lives in
 * ./host; this module owns nothing but the plugin lifetime, so enabling,
 * disabling and restarting the plugin mount and unmount exactly one assembled
 * Host service and leave no residue when the row is disabled.
 */
import { applyHost } from './host/apply.js'

/** Loader entry name; must match package.json and cordis.patch.yml. */
export const name = 'dsh-pappers-hall'

/**
 * Required Host services. Everything else (web server, attachments, translator,
 * subprocess) is optional and resolved by applyHost with an explicit degraded
 * state when a profile does not provide it.
 */
export const inject = ['tools', 'timer']

/**
 * No `Config` export on purpose: the row config is validated inside
 * `applyHost` so that a missing or malformed optional field degrades to a
 * default instead of failing the whole plugin row. Supported keys:
 * `dataDir` (absolute path of the plugin-owned library), `fixtureDir`
 * (developer fixtures), `pdfTools` (`{pdfinfo, pdftotext, pdftoppm}` overrides)
 * and `testMode`.
 */

/**
 * Mount the paper center.
 * @param ctx Plugin context owned by the Loader row.
 * @param config Resolved row configuration.
 */
export async function apply(ctx, config = {}) {
  const service = await applyHost(ctx, config ?? {})
  ctx.effect(() => () => service.dispose(), 'pappers-hall: host lifetime')
}
