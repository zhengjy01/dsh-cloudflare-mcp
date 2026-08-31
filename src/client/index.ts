/**
 * dsh-cloudflare-mcp — browser half. Registers the Cloudflare MCP settings
 * panel into the web settings page (settings.section entry). The panel
 * drives the OAuth authorize flow, shows connection state, and offers
 * one-click test / refresh / clear. Failure policy: registration problems
 * are logged, never thrown — the web shell fails the whole boot when a
 * plugin apply throws, and an external plugin must not take the GUI down.
 */
// Type-only: pulls the settings-surface SlotMap merge (the 'settings.section'
// entry) and the client runtime Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { CloudflareMcpSettingsPanel } from './CloudflarePanel.tsx'

/** Required services. */
export const inject = ['slots']

/**
 * Register the Cloudflare MCP settings page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'cloudflare-mcp',
      order: 320,
      label: () => 'Cloudflare MCP',
    }, CloudflareMcpSettingsPanel))
  } catch (error) {
    console.warn('[dsh-cloudflare-mcp] settings panel registration failed:', error)
  }
}
