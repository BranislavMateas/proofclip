import { OAUTH } from '../config.js'
import { createClient } from './notion.js'

export const oauthConfigured = () => !!(OAUTH.clientId && OAUTH.exchangeUrl)

// "Sign in with Notion": Notion's consent screen, then a tiny server swaps the
// code for a token so the client secret never ships in the extension.
export async function signInWithNotion() {
  const redirectUri = chrome.identity.getRedirectURL('notion')
  const state = crypto.randomUUID()
  const authorize = new URL(OAUTH.authorizeUrl)
  authorize.search = new URLSearchParams({ client_id: OAUTH.clientId, response_type: 'code', owner: 'user', redirect_uri: redirectUri, state })
  const result = await chrome.identity.launchWebAuthFlow({ url: authorize.href, interactive: true })
  const params = new URL(result).searchParams
  if (params.get('error')) throw new Error(`Notion sign-in was cancelled (${params.get('error')}).`)
  if (params.get('state') !== state) throw new Error('Sign-in response did not match the request. Please try again.')
  const res = await fetch(OAUTH.exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: params.get('code'), redirect_uri: redirectUri }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error(`Sign-in failed: ${data.error_description || data.error || res.status}`)
  const apiBase = new URL(OAUTH.authorizeUrl).origin
  return {
    id: data.workspace_id || data.bot_id,
    workspaceName: data.workspace_name || 'Notion',
    workspaceIcon: data.workspace_icon && !/^https?:/.test(data.workspace_icon) ? data.workspace_icon : '',
    token: data.access_token,
    apiBase,
    method: 'oauth',
  }
}

export async function connectWithToken(token, apiBase = 'https://api.notion.com') {
  const me = await createClient({ token, apiBase }).me()
  return { id: me.id, workspaceName: me.bot?.workspace_name || me.name || 'Notion', workspaceIcon: '', token, apiBase, method: 'token' }
}
