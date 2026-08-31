/**
 * dsh-cloudflare-mcp smoke tests.
 *
 * Runs against the built lib (node half). Covers the store round-trip, the
 * OAuth provider metadata contract, and — when DSH_CLOUDFLARE_MCP_LIVE=1 —
 * a live OAuth phase-1 run against mcp.cloudflare.com (discovery + dynamic
 * client registration + PKCE authorization URL), which proves the whole
 * auth chain without needing a browser.
 *
 *   DSH_CLOUDFLARE_MCP_CONFIG=/tmp/cf-test.json node tests/smoke.mjs
 *   DSH_CLOUDFLARE_MCP_LIVE=1 DSH_CLOUDFLARE_MCP_CONFIG=/tmp/cf-test.json node tests/smoke.mjs
 */
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { CloudflareMcpStore, OAuthFlow, CloudflareOAuthProvider, mask, MCP_URL, configPath } from '../lib/index.js'

const live = process.env.DSH_CLOUDFLARE_MCP_LIVE === '1'

async function main() {
  // 1. Store round-trip
  const store = new CloudflareMcpStore()
  await store.clearAll()
  const empty = await store.view('http://127.0.0.1:3080/api/dsh-cloudflare-mcp/oauth/callback')
  assert.equal(empty.configured, false)
  assert.equal(empty.authorized, false)
  assert.equal(empty.mcpUrl, MCP_URL)
  const cfg = await store.load()
  cfg.tokens = { access_token: 'tok-1234567890abcdef', refresh_token: 'ref', token_type: 'Bearer' }
  cfg.tokenUpdatedAt = new Date().toISOString()
  cfg.clientInformation = { client_id: 'client-abcdef123456', redirect_uris: ['http://127.0.0.1:3080/api/dsh-cloudflare-mcp/oauth/callback'] }
  await store.save(cfg)
  const full = await store.view('http://127.0.0.1:3080/api/dsh-cloudflare-mcp/oauth/callback')
  assert.equal(full.authorized, true)
  assert.ok(full.clientIdMasked.includes('****'))
  // The public view must never leak secrets.
  assert.ok(!JSON.stringify(full).includes('tok-1234567890abcdef'))
  assert.ok(!JSON.stringify(full).includes('client-abcdef123456'))
  await store.clearAll()

  // 2. Provider contract
  const provider = new CloudflareOAuthProvider(store, 'http://127.0.0.1:3080/api/dsh-cloudflare-mcp/oauth/callback')
  assert.equal(String(provider.redirectUrl), 'http://127.0.0.1:3080/api/dsh-cloudflare-mcp/oauth/callback')
  assert.deepEqual(provider.clientMetadata.redirect_uris, ['http://127.0.0.1:3080/api/dsh-cloudflare-mcp/oauth/callback'])
  assert.equal(provider.clientMetadata.token_endpoint_auth_method, 'none')
  const state = await provider.state()
  assert.ok(state.length >= 16)
  assert.equal(await provider.clientInformation(), undefined)
  await provider.saveClientInformation({ client_id: 'c1' })
  assert.equal((await provider.clientInformation()).client_id, 'c1')

  // 3. Mask helper
  assert.equal(mask(''), '')
  assert.equal(mask('abcdef'), 'ab****')
  assert.equal(mask('client-abcdef123456'), 'clie****3456')

  if (live) {
    // 4. Live OAuth phase 1: discovery + DCR + PKCE → authorization URL
    console.log('[live] testing OAuth phase 1 against', MCP_URL)
    const flow = new OAuthFlow(store)
    const callback = 'http://127.0.0.1:3080/api/dsh-cloudflare-mcp/oauth/callback'
    const { authorizeUrl, state: flowState } = await flow.begin(callback)
    assert.ok(authorizeUrl.startsWith('https://mcp.cloudflare.com/authorize'), authorizeUrl)
    assert.ok(authorizeUrl.includes('client_id='), 'authorize URL carries client_id')
    assert.ok(authorizeUrl.includes('code_challenge='), 'authorize URL carries PKCE challenge')
    assert.ok(authorizeUrl.includes(encodeURIComponent(callback)), 'authorize URL carries redirect_uri')
    assert.ok(flowState.length >= 16)
    const stored = await store.load()
    assert.ok(stored.clientInformation !== null, 'client registration persisted')
    console.log('[live] authorize URL OK (client_id ' + stored.clientInformation.client_id + ')')
    // Cleanup: drop the test client + tokens (flow state is memory-only)
    await store.clearAll()
    console.log('[live] OK')
  }

  console.log('config path used:', configPath())
  console.log('smoke: PASS')
  await rm(configPath(), { force: true })
}

main().catch((error) => {
  console.error('smoke: FAIL', error)
  process.exitCode = 1
})
